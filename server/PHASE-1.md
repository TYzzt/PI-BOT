# 第一阶段目标：云端身份、设备与项目目录

状态：已完成。所属项目：T-AGNET server。日期：2026-09-25。当前进入第二阶段，详见 [PHASE-2.md](./PHASE-2.md)。

## 可直接交给开发智能体的目标

在 T-AGNET/server 中提供可重复启动的 FastAPI 服务和 PostgreSQL。完成单用户登录、设备一次性配对、Ed25519 签名、心跳在线状态、撤销与重配，以及不含代码路径的项目目录。固定 OpenAPI 契约和数据库迁移。

## 交付范围

1. 工程：`uv` 锁定依赖，Docker Compose 启动 API 和 PostgreSQL 16。入口和 HTTPS 留到将来的 Kubernetes Ingress。
2. 迁移：`users`、`pairing_codes`、`devices`、`device_nonces`、`projects`。不建任务、计划、审批、命令或事件表。
3. 认证：首次启动用 `T_AGNET_ADMIN_PASSWORD` 写入 Argon2id 哈希；`POST /auth/login` 签发短期 JWT。
4. 设备：配对码单次使用、十分钟过期、只存哈希。心跳更新 `last_seen_at`，`presence` 由时间窗口算出。撤销是终态，重配得到新的 `device_id`。
5. 项目：只保存 `project_id`、`device_id`、`display_name`、`availability`。额外字段直接拒绝。
6. 契约：`openapi.json`。预留路径 `/tasks`、`/conversations`、`/events`、`/configs` 不出现在契约里。

## 本阶段定下的接口边界

- 云端 JSON 使用 snake_case：`device_id`、`project_id`、`display_name`。桌面端本机 IPC 的 camelCase 不直接当作云端字段。
- 设备公钥可返回给已登录用户。私钥、密码、配对码明文不入库、不写日志。
- 在线状态和任务状态分开。本阶段没有任务表，离线只表现为 `presence: offline`。
- 用户可以把项目改绑到未撤销设备。设备不能改绑，也不能修改别人的项目。
- 已撤销设备名下的项目，读取时的 `availability` 为 `unavailable`。

## 验收标准

| 编号 | 验收动作 | 通过条件 |
| --- | --- | --- |
| S1-01 | 按 README 用 Compose 启动并请求 `/health` | 返回 `{"ok":true}` |
| S1-02 | 登录、发放配对码、配对、心跳、列出设备 | 心跳后 `presence` 为 `online`；同一配对码第二次配对失败 |
| S1-03 | 撤销设备后再心跳，并用新配对码登记 | 旧心跳失败；新 `device_id` 与旧设备不同；旧设备保持撤销 |
| S1-04 | 登记项目时附带 `absolute_path` 或源码字段 | 422，响应不回显提交内容；表结构没有这些列 |
| S1-05 | 撤销设备后查看项目，再改绑到新设备 | 撤销后读到 `unavailable`；改绑到未撤销设备后恢复原可用状态 |
| S1-06 | 重复提交同一设备签名 | 第二次心跳失败 |
| S1-07 | 检查数据库文本和日志 | 没有管理员密码明文和配对码明文 |
| S1-08 | 对比运行中的 OpenAPI 与 `openapi.json` | 路径一致，且不含任务、会话、事件、配置路径 |

S1-02 至 S1-08 由 `uv run pytest` 覆盖，2026-09-25 结果为 9 passed。S1-01 在同一天用 Compose 启动后请求本机 `/health` 确认。

## 阶段边界

持久任务、计划版本、审批投递属于第二阶段。共享消息和事件回放属于第三阶段。DeepAgents 问答属于第四阶段。配置包、备份和可选推送属于第五阶段。

## 最终演示

启动 Compose → `/health` → 登录 → 发放配对码 → 设备配对 → 心跳后列表显示在线 → 登记项目 → 带路径的请求被拒绝 → 撤销后心跳失败 → 新配对得到新设备 → 把项目改绑过去。
