# T-AGNET server

云端第二阶段：单用户认证、设备配对、项目目录，加上持久任务、不可变计划版本、审批、设备命令投递和任务事件回放。FastAPI、PostgreSQL 16、Ed25519 设备签名、WebSocket。本阶段没有共享聊天、配置同步或 DeepAgents。为配合桌面端第三阶段，另加了设备签名的审批接口和审批 `actor` 字段（迁移 `0003`）。

阶段目标和验收标准见 [PHASE-2.md](./PHASE-2.md)，第一阶段见 [PHASE-1.md](./PHASE-1.md)。

## 启动

前置：Docker Desktop、可访问镜像仓库。在 `server` 目录：

```sh
cp .env.example .env
# 把 T_AGNET_ADMIN_PASSWORD 和 T_AGNET_JWT_SECRET 换成自己的值。
# JWT 密钥至少 32 个字符，可用 openssl rand -hex 32 生成。
docker compose up --build
```

API 只监听本机 `127.0.0.1:8000`。数据库口令是 Compose 里的本地默认值 `tagent`，端口只绑定 `127.0.0.1:5432`。本地 Compose 只包含 API 和 PostgreSQL。将来部署到 Kubernetes 时，入口和 HTTPS/WSS 由集群 Ingress 承担；Ingress 需要放行 WebSocket 升级。

健康检查：

```sh
curl http://127.0.0.1:8000/health
```

返回 `{"ok":true}` 表示 API 和数据库都可用。

本地不打镜像、只跑 API 时，先 `docker compose up postgres -d`，再：

```sh
uv sync
PYTHONPATH=src uv run --env-file .env uvicorn tagent_server.main:create_app --factory --host 127.0.0.1 --port 8000
```

`.env` 里的 `T_AGNET_DATABASE_URL` 指向 `localhost`。Compose 里的 API 容器会改用主机名 `postgres`，不用这份地址。

用模拟设备走一遍完整流程（配对、登记项目、创建任务、修改意见、批准、执行、事件回放）：

```sh
PYTHONPATH=src uv run python scripts/fake_device.py --password <管理员密码> --demo
```

不加 `--demo` 时只扮演设备，一直在线处理命令，可以配合其他客户端手动操作。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `T_AGNET_DATABASE_URL` | SQLAlchemy URL，驱动为 `postgresql+psycopg` |
| `T_AGNET_ADMIN_PASSWORD` | 至少 8 位。用户表为空时写入 Argon2id 哈希，之后重启不覆盖 |
| `T_AGNET_JWT_SECRET` | 至少 32 位，用于 HS256 |
| `T_AGNET_JWT_TTL_SECONDS` | 访问令牌有效期，默认 3600。没有刷新令牌，过期后重新登录；`/ws/events` 在令牌过期时断开 |
| `T_AGNET_PAIRING_TTL_SECONDS` | 配对码有效期，默认 600 |
| `T_AGNET_PRESENCE_TTL_SECONDS` | 心跳在线窗口，默认 60。设备 WebSocket 保持连接期间自动刷新 |
| `T_AGNET_SIGNATURE_SKEW_SECONDS` | 设备签名时间偏差，默认 300 |
| `T_AGNET_APPROVAL_TTL_SECONDS` | 批准有效期，也是 execute 命令的过期时间，默认 900 |
| `T_AGNET_COMMAND_TTL_SECONDS` | plan_request、plan_revise、cancel 命令的过期时间，默认 86400 |

## 接口

用户 JWT 放在 `Authorization: Bearer`。设备请求不使用这个头，改用下文的签名头。

身份、设备、项目（第一阶段）：

- `POST /auth/login`：`{"password":"..."}`，返回 `access_token`、`expires_in`
- `POST /devices/pairing-codes`：发放一次性配对码
- `POST /devices/pair`：`pairing_code`、`public_key`、`label`、可选 `capabilities`
- `GET /devices`：设备列表，含由心跳算出的 `presence`
- `POST /devices/{device_id}/heartbeat`：设备签名，刷新 `last_seen_at`
- `POST /devices/{device_id}/revoke`：撤销。再次调用不改变原来的 `revoked_at`；在线的设备 WebSocket 立即断开
- `POST /projects`：设备登记项目，只接受 `display_name` 和可选 `availability`
- `GET /projects`：用户查看目录
- `PATCH /projects/{project_id}`：用户可改显示名、可用状态，或把项目改绑到未撤销设备。设备只能改自己项目的显示名和可用状态

任务与审批（用户）：

- `POST /tasks`：`project_id`、`requirement`、`idempotency_key`。只入队，同一事务写任务、plan_request 命令和事件。同一幂等键重复提交返回原任务，内容不同返回 409。项目不可用或设备已撤销返回 409。设备不在线时状态为 `waiting_for_device`
- `GET /tasks`、`GET /tasks/{task_id}`：任务快照，详情包含计划版本、运行列表、`device_presence`、`cancel_requested`
- `POST /tasks/{task_id}/cancel`：`{}`。设备还没确认接手的工作直接取消；已经在设备上运行的只记录取消请求并下发 cancel 命令（`cancel_requested: true`，待送达），设备回报 `run.cancelled` 后才变为 `cancelled`
- `GET /plans/{plan_id}`：计划正文
- `POST /plans/{plan_id}/approve`：`version`、`content_hash`、`idempotency_key`。必须是任务最新且未被取代的版本、hash 一致、任务处于 `awaiting_review`、设备未撤销、项目仍绑定在该设备。approval、execute run 和 execute 命令同一事务创建；重复批准返回同一个 approval 和 run
- `POST /plans/{plan_id}/reject`：`idempotency_key`。任务变为 `rejected`，不能再批准
- `POST /plans/{plan_id}/revise`：`feedback`、`idempotency_key`。下发 plan_revise 命令，设备发布新版本后旧版本标记为 superseded
- `GET /events?after=&limit=&task_id=`：按 `server_cursor` 升序分页，`next_cursor` 作为下一页的 `after`

设备：

- `GET /device/commands`：拉取未过期、未 ack 的命令（WebSocket 之外的兜底）
- `POST /device/commands/{command_id}/ack`：确认接收。**设备必须拿到成功的 ack 后才开始执行**；过期或已失效的命令返回 409
- `POST /tasks/{task_id}/plans`：发布计划版本，字段 `run_id`、`version`、`content_hash`、`body`、`workspace_fingerprint`、`config_snapshot_id`。版本号必须连续；同一版本同一 hash 重复发布返回原计划，不同内容返回 409
- `POST /device/events`：批量上报（最多 100 条）`run.*`、`step.*`、`tool.*`、`artifact.available`。`event_id` 去重，响应中的 `gaps` 标出 `producer_seq` 跳号。`run.*` 事件更新运行和任务状态
- `POST /device/plans/{plan_id}/approve`、`/reject`、`/revise`：请求体与用户接口相同，用设备签名代替 JWT，供 Mac 端直接审阅云端任务。只有任务的执行设备可以调用，其他设备返回 403。校验规则、幂等键和事务与用户接口共用同一套实现：用户和设备谁先批准谁生效，后到的重复批准返回同一个 approval 和 run，不会产生第二次执行

审批和修改意见记录 `actor`（`user` 或 `device`），`ApprovalPublic.actor` 返回该值，`approval.recorded`、`approval.rejected`、`plan.revision_requested` 事件的 payload 里也带上。批准有效期 `T_AGNET_APPROVAL_TTL_SECONDS` 最小为 60 秒。

任务状态：`queued`、`waiting_for_device`、`planning`、`awaiting_review`、`approved`、`running`、`waiting_for_input`、`waiting_for_local_action`、`needs_replan`、`interrupted`、`completed`、`failed`、`cancelled`、`rejected`。执行结果只能由设备事件推动，用户接口没有设置完成的入口；云端不会因为超时或设备离线把任务改成失败。批准过期（execute 命令在 ack 前到期）时任务回到 `awaiting_review`，可以重新批准。

请求体 `additionalProperties: false`。路径、源码、diff、stdout 等额外字段返回 422，响应里不回显提交内容。设备事件的 `payload` 只接受 `step_id`、`title`、`summary`（≤2000 字）、`tool_name`、`status`、`exit_code`、`verification`、`duration_ms`、`artifact_id`、`visibility`。

OpenAPI 在 `openapi.json`，也可从运行中的 `/openapi.json` 读取。WebSocket 消息格式在 components 的 `Ws*` 模型中。更新契约：

```sh
PYTHONPATH=src uv run python scripts/export_openapi.py
```

`/conversations`、`/configs` 本阶段不提供。

## 计划 hash

设备和服务端都按下面的规范计算，服务端收到计划时重算，不一致返回 400：

```text
sha256(canonical_json({
  "task_id", "version", "project_id", "device_id",
  "body", "workspace_fingerprint", "config_snapshot_id"
}))
```

`canonical_json` 为 key 排序、`,` 与 `:` 两侧无空白、UTF-8、不转义非 ASCII 字符；ID 使用小写带连字符的 UUID 字符串。`workspace_fingerprint` 是 64 位小写十六进制的哈希，云端不接收指纹原文。计划正文字段：`goal`、`scope`、`non_goals`、`modules`、`steps[].step_id/title/description`、`commands`、`external_actions`、`verification`、`acceptance`、`questions`。

## WebSocket

投递语义为至少一次，客户端按 `command_id` / `event_id` 去重。所有消息都是 JSON 文本帧。

`/ws/device`：握手请求带四个设备签名头，签名覆盖 `GET` 方法、路径 `/ws/device` 和空请求体，nonce 同样不能重用。认证失败以关闭码 4401 拒绝。

- 服务端 → 设备：`{"type":"command","command_id","command_type","task_id","run_id","payload","expires_at","created_at"}`。连接后先推送所有未 ack、未过期的命令，之后实时推送。未 ack 的命令在重连后会再次推送
- 设备 → 服务端：`{"type":"ack","command_id"}`，服务端回 `{"type":"ack_result","command_id","ok","detail"}`；`{"type":"ping"}` 回 `{"type":"pong"}`
- 连接期间自动刷新在线状态。设备被撤销后以 4401 关闭

`/ws/events`：握手带 `Authorization: Bearer <JWT>`。连接后 30 秒内发送 `{"type":"subscribe","after":<cursor>}`，服务端先回放 `after` 之后的事件，再实时推送 `{"type":"event","event":{...}}`，`event` 与 `/events` 返回的条目一致。断线后用最后收到的 `server_cursor` 重新订阅即可补齐。

实时唤醒使用 PostgreSQL `LISTEN/NOTIFY`，通知不携带数据，每个连接收到通知后回数据库按 cursor 读取，多副本部署也适用。所有写入任务、计划、审批、命令和事件的事务先取同一把事务级 advisory lock，事件提交顺序与 `server_cursor` 一致，按 cursor 补拉不会跳过晚提交的事件。

## 设备签名

公钥是 32 字节 Ed25519 原始公钥的标准 Base64（带填充）。私钥只留在设备上。

每个设备请求带四个头：

- `X-TAgnet-Device-Id`
- `X-TAgnet-Timestamp`：Unix 秒
- `X-TAgnet-Nonce`：16 到 128 个字符，窗口内不可重用
- `X-TAgnet-Signature`：签名的标准 Base64

待签名字节是下面这一行的 UTF-8，签名覆盖的是原始请求体，不是重新格式化后的 JSON：

```text
{timestamp}.{nonce}.{METHOD}.{path}.{sha256_hex(body)}
```

`path` 只包含路径，例如 `/devices/{device_id}/heartbeat`。撤销后签名立即失效。同一公钥在未撤销设备上不能登记第二次；撤销后可以用它登记一台新设备，`device_id` 不同。

## 数据

表：`users`、`pairing_codes`、`devices`、`device_nonces`、`projects`、`tasks`、`plans`、`plan_feedback`、`approvals`、`runs`、`commands`、`events`、`device_event_sequences`。`device_nonces` 只用于签名重放保护。配对码只存 SHA-256。项目没有路径或源码列；计划只存结构化正文和工作区指纹哈希；事件只存摘要字段。

任务需求、修改意见和计划正文是用户与智能体可共享的文本，会存入数据库。源码、diff、Pi 会话、原始终端输出不接收入库。

日志只记固定事件，例如登录成功或失败、已发放配对码、设备已配对。不记录密码、配对码明文、令牌或私钥。

## 检查

```sh
uv sync
uv run pytest
```

测试会拉起临时 PostgreSQL 16。Docker 需要处于运行状态。

## 阶段边界

共享消息与 `/conversations`、DeepAgents 云端问答、模型/Skills/MCP 配置和 skill 同步都不在本阶段。云端不保存代码目录，也不把设备在线状态写成任务状态。

桌面端已在其第三阶段接入（见 [desktop/PHASE-3.md](../desktop/PHASE-3.md)）：配对、项目目录、计划发布、双端审批、命令执行和脱敏事件回传。桌面端的 `desktop/tests/cloud-e2e.test.ts` 可以对着本地 Compose 跑完整链路。Android 的接入在其自身阶段完成。
