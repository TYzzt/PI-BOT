# DeepAgents 云端问答

云端问答由服务器上的 DeepAgents Worker 执行，不依赖任何一台 Mac 在线。手机和 Mac 都可以新建云端会话；也可以把一个已共享的 Mac 会话"转到云端继续"。

## 能做什么，不能做什么

- 可以：模型对话、多轮上下文（LangGraph Postgres checkpoint）、Tavily 联网搜索（服务端配置 Key 后）、DeepAgents 自带的待办规划与虚拟文件。虚拟文件只存在于该会话的 agent 状态里，不写真实磁盘；没有 shell。
- 不可以：读取 Mac 上的项目、文件、终端或浏览器；调用设备命令；使用云端 MCP 或 Skills；多用户；推送。
- 转到云端：新建一个云端会话，只复制原会话已共享的聊天记录（最近 40 条、合计不超过 60000 字，超长的旧消息被丢弃），原 Mac 会话不受影响。不支持同一会话在 Mac 和云端之间来回切换。

## 部署

Worker 与 API 使用同一镜像，读取同一个数据库和同一个加密文件。云端模型的 API Key 用与模型同步相同的 vault 加密，因此必须启用加密文件：

```sh
cd server
cp .env.example .env            # 设置管理员密码和 JWT 密钥
uv run python scripts/vault_key.py /absolute/path/sync-vault.json   # 首次部署生成
export T_AGNET_SYNC_KEY_FILE=/absolute/path/sync-vault.json
export T_AGNET_TAVILY_API_KEY=tvly-...    # 可选；不设置则不联网
docker compose -f docker-compose.yml -f docker-compose.sync.yml up --build
```

Compose 会启动 `postgres`、`api` 和 `worker`。Worker 在 API 健康后启动，首次启动时创建 LangGraph checkpoint 表。可以启动多个 Worker 进程并行处理不同会话；同一个 run 只会被领取一次。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `T_AGNET_SYNC_KEY_FILE` | 无 | 必填，云端模型密钥的加密文件 |
| `T_AGNET_TAVILY_API_KEY` | 空 | 设置后注册 `tavily_search` 工具；空值时系统提示会告诉模型没有联网 |
| `T_AGNET_WORKER_LEASE_SECONDS` | 60 | 租约时长；续租间隔为租约的四分之一（1–15 秒） |
| `T_AGNET_WORKER_POLL_SECONDS` | 1 | 空闲时轮询队列的间隔 |

本地不用 Docker 时：`PYTHONPATH=src uv run --env-file .env python -m tagent_server.worker`。

## 使用

1. **准备云端模型**：在 Mac「模型设置」的模型卡片上点"复制到云端"。服务器在内部把已同步的 Mac 模型密钥解密并重新加密成云端模型，密钥不经过任何客户端。也可以用 `PUT /cloud/models/{id}` 直接创建（需要提交 `api_key`）。
2. **Mac**：侧栏"☁ 云端问答"中新建会话、选择云端模型、提问、停止。页面打开时每秒刷新；云端会话不写入本机 SQLite。
3. **Android**：聊天页"新建云端会话"；云端会话标为"云端问答"，不显示 Mac 在线状态，Mac 离线也能发送。Mac 共享会话详情页有"转到云端继续"。
4. **转到云端继续**：Mac 的共享问答会话标题栏，或 Android 的共享会话详情页。只对已共享、且已同步到云端的会话开放。

## 执行语义

- 发送与取消沿用 `POST /conversations/{id}/messages` 和 `POST /chat-runs/{id}/cancel`。云端会话的 run 直接进入 `queued`，由 Worker 领取；同一会话同时只能有一个未结束的请求。
- Worker 领取时写入 `worker_id` 与 `lease_until`，状态变为 `running`，用户消息分配序号，同时创建空的助手消息。
- 流式输出每秒最多写一次累计快照，每次都递增 `version` 并触发 `message.changed`，结束时写最终文本和终态。
- 取消：排队中的 run 立即变为 `cancelled`。运行中的 run 会在下一次写快照或续租时（约一秒内）停下，状态为 `cancelled`，已生成的部分回答保留。重复取消是幂等的。
- 中断：Worker 被强杀后，租约过期的 run 由其他 Worker（或重启后的自己）标为 `interrupted`，保留部分回答，不自动重跑。
- 上下文：checkpoint 线程为 `会话ID:代次`。完成的对话继续使用同一线程；取消、失败或中断后代次加一，下一次提问用共享消息历史重建新线程，避免半截工具调用污染后续对话。
- 错误：只写固定文案（例如"模型请求失败，请检查云端模型配置后重试"），不写供应商原始错误、URL 或密钥。

## 接口

用户 JWT：`GET /cloud/models`、`PUT /cloud/models/{id}`、`POST /cloud/models/{id}/delete`、`POST /cloud/models/from-mac`、`PUT /cloud/conversations/{id}`、`POST /cloud/conversations/{id}/handoff-from/{mac_conversation_id}`。

设备签名（Mac 使用）：`GET /device/cloud/models`、`POST /device/cloud/models/from-mac`（只能复制本机模型）、`GET/PUT /device/cloud/conversations[/{id}]`、`POST /device/cloud/conversations/{id}/handoff-from/{id}`（只能转本机会话）、`GET/POST /device/cloud/conversations/{id}/messages`、`GET /device/cloud/chat-runs/{id}`、`POST /device/cloud/chat-runs/{id}/cancel`。

云端文档仍存放在 `shared_documents`，`device_id` 为空（迁移 `0005`）。`/conversations` 列表同时返回 Mac 与云端会话，字段 `target` 为 `mac` 或 `cloud`，`handoff` 记录来源会话和带入的消息数。云端会话不会出现在任何设备的 `/device/shared/*` 快照或变更里，设备也不能 ack 云端 run。完整冻结接口见 `server/openapi.json`。

## 验收记录

自动化验收均在本仓库完成：服务端用 testcontainers PostgreSQL 和本地假 OpenAI 兼容 SSE 端点直接驱动 Worker 循环；桌面端联调通过 `server/scripts/check_shared.py` 启动真实的 API 与 `python -m tagent_server.worker` 进程。

| 编号 | 内容 | 结果 | 证据 |
|---|---|---|---|
| C-01 | Mac 完全离线（未配对）时新建云端会话并得到回答 | 通过 | `test_cloud_answer_without_mac_and_checkpoint_context` |
| C-02 | 至少一次非空中间快照，最终文本完整 | 通过 | `test_streaming_snapshots_and_cancel`、`test_streaming_full_text` |
| C-03 | 第二个问题用到上一轮上下文，且只发送新问题（来自 checkpoint） | 通过 | 同 C-01 |
| C-04 | 配置搜索时调用搜索；未配置时不注册工具、提示未联网 | 通过 | `test_search_tool_registered_only_with_key` |
| C-05 | 取消后为 `cancelled`、保留部分回答，重复取消幂等 | 通过 | `test_streaming_snapshots_and_cancel`、`test_queued_cancel_never_reaches_worker` |
| C-06 | Worker 崩溃后租约过期标为 `interrupted`，不重跑，下一问正常 | 通过 | `test_lease_expiry_interrupts_without_rerun` |
| C-07 | 六个 Worker 并发领取三个 run，每个只被领取一次 | 通过 | `test_concurrent_workers_claim_once` |
| C-08 | handoff 只复制共享消息，原会话不变；设备不能 ack 云端 run，也收不到云端变更 | 通过 | `test_handoff_copies_shared_messages_only` |
| C-09 | API、事件、修订、数据库文档和日志中没有模型 Key、Tavily Key 或供应商错误 | 通过 | `test_keys_never_leak_and_model_errors_are_fixed_text` |
| C-10 | 原有测试与 `check_shared.py` 回归；迁移 0005 保留已有数据并可回退 | 通过 | 服务端 `pytest` 43 项；桌面端 `npm test`；`check_shared.py`；`test_migration_0005_keeps_data` |

桌面端：`tests/cloud-chat.test.ts`（映射、请求体、未配对、离线、未同步提示）；`tests/cloud-chat-e2e.test.ts` 覆盖复制模型、提问、流式后取消、转到云端，以及确认云端能引用交接的历史。运行方式：

```sh
cd server && T_AGNET_TEST_FILE=tests/cloud-chat-e2e.test.ts uv run python scripts/check_shared.py
```

Android：`CloudChatTest`（空 `device_id` 解码、标签、handoff 规则、接口请求体）与原有单元测试共 28 项通过；`assembleDebug` 成功。Room 版本升到 3，迁移只为 `conversations` 增加 `target` 和 `handoffCount` 两列，已与 Room 生成的建表语句核对一致。

尚未完成、需要在你的环境里做一次：

- 使用真实模型 Key 与真实 Tavily Key 跑一次云端问答（带搜索）并记录结果。
- Android 真机安装：从旧版本升级，确认迁移后原有共享会话仍在；然后在 Mac 关机状态下新建云端会话提问。
- Mac 界面验收（本仓库的 Electron UI 测试只能在 macOS 上运行；这里只在 Chromium 中用模拟数据检查了页面渲染）。
