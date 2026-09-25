# 第二阶段目标：持久任务、计划审批与设备投递

状态：自动化测试已通过。所属项目：T-AGNET server。日期：2026-09-25。

## 可直接交给开发智能体的目标

在第一阶段的认证、设备和项目目录之上，做通“用户提交需求 → 云端持久化任务 → 投递给 Mac → Mac 发布计划版本 → 用户审批 → 下发执行授权 → Mac 回报进度 → 云端更新状态投影”。设备通过 WebSocket 接收命令，用户通过 WebSocket 接收事件；两者都能用 REST 按 cursor 补拉，断线不丢数据。

## 交付范围

1. 迁移：`tasks`、`plans`、`plan_feedback`、`approvals`、`runs`、`commands`、`events`、`device_event_sequences`。不建会话、消息、配置表。
2. 任务：用户用幂等键创建任务，只入队，不在请求内执行。任务、命令和事件在同一事务写入。
3. 计划：设备发布不可变版本，服务端按固定规范重算 `content_hash`。新版本发布后旧版本标记为 superseded。
4. 审批：批准绑定计划版本、hash、设备、项目和有效期；approval、execute run 与 execute 命令同一事务创建。支持拒绝、修改意见和取消。
5. 投递：命令持久化后经 WebSocket 推送，也可 REST 拉取；至少一次投递，设备 ack 后结束。过期命令不再投递。
6. 事件：`events` 表按 `server_cursor` 严格递增，`event_id` 去重，`producer_seq` 发现设备事件缺口。设备事件更新 run 和 task 的状态投影。
7. 实时：`/ws/device`（签名握手）与 `/ws/events`（JWT），PostgreSQL `LISTEN/NOTIFY` 唤醒，推送内容始终从数据库读取。
8. 契约：更新 `openapi.json`，WebSocket 消息 JSON Schema 放在 components。提供 `scripts/fake_device.py` 模拟设备。

## 本阶段定下的接口边界

- 任务状态：`queued`、`waiting_for_device`、`planning`、`awaiting_review`、`approved`、`running`、`waiting_for_input`、`waiting_for_local_action`、`needs_replan`、`interrupted`、`completed`、`failed`、`cancelled`、`rejected`。
- 执行结果只能由设备事件推动。用户接口不能把任务设为完成；云端不因超时或设备离线把任务改为失败。
- 取消：设备已经收到正在进行的工作时，只记录取消请求并下发 cancel 命令，显示待送达；设备回报后才变为 `cancelled`。设备还没收到任何工作时直接取消。
- 批准过期后任务回到 `awaiting_review`，可以重新批准；已被取代的版本和已拒绝的计划不能批准。
- 设备事件 payload 只允许步骤 ID、标题、摘要、工具名、状态、退出码、验证结论、耗时和成果引用；源码、diff、路径和原始输出字段返回 422。
- 计划 hash：`sha256(canonical_json({task_id, version, project_id, device_id, body, workspace_fingerprint, config_snapshot_id}))`，canonical JSON 为 key 排序、无空白、UTF-8、不转义非 ASCII。
- 云端 JSON 继续使用 snake_case。计划正文字段与桌面端 `planBodySchema` 对应：`goal`、`scope`、`non_goals`、`modules`、`steps[].step_id/title/description`、`commands`、`external_actions`、`verification`、`acceptance`、`questions`。

## 验收标准

| 编号 | 验收动作 | 通过条件 |
| --- | --- | --- |
| S2-01 | 同一幂等键重复创建任务；设备离线时创建；项目不可用时创建 | 只有一个任务；离线为 `waiting_for_device`；不可用返回 409 |
| S2-02 | 设备连接 WebSocket；ack 前断开再重连；重复 ack | 收到 plan_request；重连后重新投递；重复 ack 无副作用 |
| S2-03 | 发布 v1；hash 不符、别的设备、带源码字段；改写已发布版本 | 任务变为 `awaiting_review`；错误请求被拒绝；已发布版本不能改写 |
| S2-04 | 并发两次批准；批准旧版本、篡改 hash、过期批准 | 只有一个 approval、run 和 execute 命令；其余被拒绝，过期命令不投递 |
| S2-05 | 提交修改意见，设备发布 v2 | 下发 plan_revise；v1 被标记 superseded 且不能再批准 |
| S2-06 | 重复 event_id、跳号 producer_seq、run 完成、用户尝试设为完成 | 重复忽略；缺口被标出；任务完成来自设备事件；用户无此接口 |
| S2-07 | 设备离线时取消执行中的任务，再重连 | 显示待送达；重连后收到 cancel；设备回报后才 `cancelled` |
| S2-08 | 用户 WebSocket 带 cursor 断线重连 | 回放加实时推送不缺失、不重复，与 `/events` 分页一致 |
| S2-09 | 撤销在线设备 | WebSocket 立即断开，命令不再投递，签名请求失败 |
| S2-10 | 检查数据库文本和日志 | 没有源码、diff 或原始工具输出，tool 事件只含摘要 |
| S2-11 | 对比运行中的 OpenAPI 与 `openapi.json` | 一致；包含 `/tasks`、`/plans`、`/events`，不含 `/conversations`、`/configs` |

S2-01 至 S2-11 由 `uv run pytest` 覆盖（`tests/test_phase2.py`），2026-09-25 全部测试结果为 20 passed（含第一阶段 9 项），连续三次运行结果一致。同一天用 Compose 启动后请求 `/health` 返回 `{"ok":true}`，并用 `scripts/fake_device.py --demo` 通过真实 WebSocket 走完创建任务 → 计划 v1 → 修改意见 → v2 → 批准 → 执行 → 完成，事件 cursor 连续。

## 阶段边界

共享消息和 `/conversations` 属于第三阶段，事件表届时扩展到消息。DeepAgents 问答属于第四阶段。配置包、备份和可选推送属于第五阶段。桌面端和 Android 接入在各自阶段完成，本阶段用模拟设备验收。

## 最终演示

启动 Compose → 配对模拟设备并连接 `/ws/device` → 用户订阅 `/ws/events` → 创建任务 → 设备收到 plan_request 并发布 v1 → 用户提修改意见 → 设备发布 v2 → 批准 → 设备收到 execute → 上报步骤与完成 → 用户端看到完整事件流 → 断线重连后按 cursor 补齐。
