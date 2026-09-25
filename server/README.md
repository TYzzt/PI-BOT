# T-AGNET server

云端第一阶段：单用户认证、设备配对和项目目录。FastAPI、PostgreSQL 16、Ed25519 设备签名。本阶段没有任务队列、聊天、WebSocket、配置同步或 DeepAgents。

## 启动

前置：Docker Desktop、可访问镜像仓库。在 `server` 目录：

```sh
cp .env.example .env
# 把 T_AGNET_ADMIN_PASSWORD 和 T_AGNET_JWT_SECRET 换成自己的值。
# JWT 密钥至少 32 个字符，可用 openssl rand -hex 32 生成。
docker compose up --build
```

API 只监听本机 `127.0.0.1:8000`。数据库口令是 Compose 里的本地默认值 `tagent`，端口只绑定 `127.0.0.1:5432`。本地 Compose 只包含 API 和 PostgreSQL。将来部署到 Kubernetes 时，入口和 HTTPS 由集群 Ingress 承担。

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

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `T_AGNET_DATABASE_URL` | SQLAlchemy URL，驱动为 `postgresql+psycopg` |
| `T_AGNET_ADMIN_PASSWORD` | 至少 8 位。用户表为空时写入 Argon2id 哈希，之后重启不覆盖 |
| `T_AGNET_JWT_SECRET` | 至少 32 位，用于 HS256 |
| `T_AGNET_JWT_TTL_SECONDS` | 访问令牌有效期，默认 3600。没有刷新令牌，过期后重新登录 |
| `T_AGNET_PAIRING_TTL_SECONDS` | 配对码有效期，默认 600 |
| `T_AGNET_PRESENCE_TTL_SECONDS` | 心跳在线窗口，默认 60 |
| `T_AGNET_SIGNATURE_SKEW_SECONDS` | 设备签名时间偏差，默认 300 |

## 接口

用户 JWT 放在 `Authorization: Bearer`。设备请求不使用这个头。

- `POST /auth/login`：`{"password":"..."}`，返回 `access_token`、`expires_in`
- `POST /devices/pairing-codes`：发放一次性配对码
- `POST /devices/pair`：`pairing_code`、`public_key`、`label`、可选 `capabilities`
- `GET /devices`：设备列表，含由心跳算出的 `presence`
- `POST /devices/{device_id}/heartbeat`：设备签名，刷新 `last_seen_at`
- `POST /devices/{device_id}/revoke`：撤销。再次调用不改变原来的 `revoked_at`
- `POST /projects`：设备登记项目，只接受 `display_name` 和可选 `availability`
- `GET /projects`：用户查看目录
- `PATCH /projects/{project_id}`：用户可改显示名、可用状态，或把项目改绑到未撤销设备。设备只能改自己项目的显示名和可用状态

请求体 `additionalProperties: false`。路径、源码、diff 等额外字段返回 422，响应里不回显提交内容。已撤销设备上的项目读出来是 `unavailable`。

OpenAPI 在 `openapi.json`，也可从运行中的 `/openapi.json` 读取。更新契约：

```sh
PYTHONPATH=src uv run python scripts/export_openapi.py
```

`/tasks`、`/conversations`、`/events`、`/configs` 本阶段不提供。

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

表：`users`、`pairing_codes`、`devices`、`device_nonces`、`projects`。`device_nonces` 只用于签名重放保护。配对码只存 SHA-256。项目没有路径或源码列。

日志只记固定事件，例如登录成功或失败、已发放配对码、设备已配对。不记录密码、配对码明文、令牌或私钥。

## 检查

```sh
uv sync
uv run pytest
```

测试会拉起临时 PostgreSQL 16。Docker 需要处于运行状态。

## 阶段边界

任务入队、计划审批、共享消息、事件回放、配置和 skill 同步、WebSocket、DeepAgents 都不在本阶段。云端不保存代码目录，也不把设备在线状态写成任务状态。
