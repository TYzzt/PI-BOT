# 共享聊天、模型配置与远程续聊

本阶段实现 Mac 与云端同步。执行仍由会话所属 Mac 的 Pi 完成，不迁移 Pi 私有上下文。后续已接入：Android 应用可查看共享会话并继续提问（见 `android/`）；DeepAgents 云端问答见 [CLOUD-CHAT.md](CLOUD-CHAT.md)。

## 使用规则

- Mac 所有已有及新增问答、项目资料和项目对话自动同步，不提供共享开关。未配对时仍可本机使用，配对后自动补同步。
- 项目在本机登记后自动注册到云端，登记请求支持幂等重试。普通问答无工具；远程项目提问只有读取、列目录、搜索和 Git 状态工具，不生成计划、不写文件、不运行 shell。
- 完整用户消息和助手回答会同步，包含回答中引用的代码片段。源码文件、diff、原始工具输出、Pi JSONL 不上传。
- 全端删除需联网并停止运行，云端 tombstone 阻止旧数据恢复。已同步模型的本机删除也需联网，云端接受删除后才移除本机配置；有引用时必须选择替代模型。
- 所有已有和新增模型配置及 API Key 自动同步，默认只绑定来源 Mac。普通查询无法取回密钥；配置表显示云端版本、本机应用版本、冲突和错误。
- 有冲突时可使用云端版本，或在云端最新版本上重新提交本地修改。远程请求等待冲突解决和配置应用，不静默选择其中一份。
- 云端可排队远程问题，Mac 恢复后先上传本机离线历史，再继续远程请求。同一会话只接收一个未完成远程请求；所有会话共享 Mac 的单个活动模型槽位。
- 生成中的文本每个同步周期（至少一秒）发送累计快照，最终文本必须成功上传后才报告远程运行完成。
- Mac 退出后不接收请求；已开始的运行在重启后中断，不自动重跑。未开始的队列可继续处理。

## 启用加密凭据同步

服务端必须先配置独立的加密密钥文件。没有文件时，已有任务调度仍可用，凭据写入/下载返回 503；Mac 显示待同步，绝不降级为明文。

```sh
cd ~/T-AGNET/server
uv sync
mkdir -p "$HOME/Library/Application Support/T-AGNET/server-secrets"
uv run python scripts/vault_key.py "$HOME/Library/Application Support/T-AGNET/server-secrets/sync-vault.json"
export T_AGNET_SYNC_KEY_FILE="$HOME/Library/Application Support/T-AGNET/server-secrets/sync-vault.json"
```

按 `server/.env.example` 配置管理员密码和 JWT secret，然后启动：

```sh
docker compose -f docker-compose.yml -f docker-compose.sync.yml up -d --build
```

本机直接运行 uvicorn 时，同样设置 `T_AGNET_SYNC_KEY_FILE` 为绝对路径，并使用项目现有数据库配置。公网访问需在反向代理配置 HTTPS/WSS；Mac 只允许 loopback 使用 HTTP。

Mac 启动：

```sh
cd ~/T-AGNET/desktop
npm ci
npm run dev
```

在「设置 → 云端同步」配对。已有配对升级后自动声明 `shared_v1` 能力并同步模型和历史会话。解除配对删除设备私钥并暂停同步，保留本地记录和同步映射。重新验证管理员密码并配对同一服务器时轮换设备密钥、恢复原设备身份和自动同步；切换服务器时重新建立映射。

本版需配套更新服务器：项目创建新增可选 `request_id`；配对新增可选 `previous_device_id`，恢复设备身份同时要求管理员 Bearer 认证和有效的单次配对码。旧客户端可继续使用原请求格式。

## 密钥备份与轮换

云端采用 AES-256-GCM；认证附加数据绑定配置 UUID 与凭据版本。数据库只保存密文、随机 nonce 和 key_id。主密钥文件权限为 0600，不能提交仓库，备份应与数据库分离。仅备份数据库不能恢复密钥。

```sh
uv run python scripts/vault_key.py "$T_AGNET_SYNC_KEY_FILE" --rotate
```

轮换保留旧解密密钥并切换新写入密钥；Docker 文件挂载在原子替换后需重新创建 API 容器。旧配置修订仍可能使用旧密钥，不能直接删除旧 key_id。密钥文件与数据库共同泄漏可以解密凭据，这不是端到端加密。撤销设备仅阻止未来访问，不能抹除它已经保存的离线副本。

Mac 使用真实 Keychain；本地发送队列只存不可变 Keychain 条目的引用，同步后清理。运行使用启动时的配置；模型更新等待空闲再应用，API Key 更新也会使旧计划批准失效。

## 接口与同步机制

契约以 `server/openapi.json` 为准，用户使用 JWT，设备使用现有 Ed25519 签名。

| 接口 | 用途 |
|---|---|
| `GET /conversations`，`PUT /conversations/{id}` | 列表、创建、版本化重命名/共享开关/删除 |
| `GET /conversations/{id}/messages?after=&limit=` | 按 Mac 执行顺序分页；尚未执行的消息单列为 pending_messages |
| `POST /conversations/{id}/messages` | 幂等发送，返回稳定消息 ID、运行 ID 和 queued 状态 |
| `GET /chat-runs/{id}`，`POST /chat-runs/{id}/cancel` | 运行状态与取消；执行中的取消等待设备确认 |
| `GET /configs/models`，`PUT /configs/models/{id}` | 配置查询及版本化写入；api_key 为只写输入，可留空保留 |
| `POST /configs/models/{id}/delete` | 带替代配置的 tombstone 删除 |
| `/device/conversations/{id}` 及 `/messages` | 所属设备上传元数据、消息版本 |
| `/device/configs/models/{id}`、`/credential`、`/applied` | 配置上传、受限密钥下载和应用回执 |
| `/device/chat-runs/{id}/ack`、`/result` | 持久化确认与执行回报 |
| `/device/shared/changes?after=&limit=` | 设备作用域的持久化 cursor 增量读取 |
| `/device/shared/snapshot` | 所属会话、配置、请求与任务状态对账 |

共享请求使用独立持久化的 chat_run 记录作为设备问答队列，不混入原有编程审批命令。Mac 当前每秒在在线时拉取一次；用户端可以用现有 `/ws/events` 订阅变更通知后重新读取记录。设备 cursor 与缓存更新同一事务，定期快照用于状态对账。

共享会话固定设备和项目。消息保留原 UUID，远程输入使用云端预分配 UUID，并映射到本地运行；SQLite 触发器在消息写入事务中递增同步版本。云端忽略旧版本，终态不能退回生成中。所有同步写入受事务锁保护，游标顺序与提交顺序一致。

模型配置使用 expected_version；失败回执不含密钥。版本修订不可变，密文可以出现在配置修订表中，普通 API 返回由白名单响应类型过滤。默认模型按执行设备保存。新设备不自动获得其他设备密钥。

独立客户端（密码交互输入，不放在命令参数）：

```sh
cd ~/T-AGNET/server
uv run python scripts/shared_client.py http://127.0.0.1:8000
uv run python scripts/shared_client.py http://127.0.0.1:8000 --models
uv run python scripts/shared_client.py http://127.0.0.1:8000 --conversation <UUID> --text "继续解释这个问题" --watch
```

## 验证命令

```sh
cd ~/T-AGNET/desktop
npm run typecheck
npm test
npm run build
npm run test:ui
cd ../server
uv run pytest
uv run python scripts/check_shared.py
T_AGNET_TEST_FILE=tests/shared-desktop.spec.ts uv run python scripts/check_shared.py
T_AGNET_TEST_FILE=tests/cloud-e2e.test.ts uv run python scripts/check_shared.py
```

后三条分别创建独立临时 PostgreSQL 和 HTTP 服务；模型为可控端点，不碰实际云端库。桌面界面测试使用真实 Electron 与 Keychain，完成后清理临时凭据。

真实验收需要已有可用模型、已构建的 Swift helper，会消耗模型额度：

```sh
T_AGNET_REAL_SYNC=1 uv run python scripts/check_shared.py
```

报告保存到 `desktop/work/shared-real-report.json`，不包含密钥和完整聊天内容。数据库迁移为 SQLite v4、Alembic 0004；升级前备份，旧应用不能打开新版 SQLite。安装包不属于本次交付；Android 应用与 DeepAgents 云端问答在后续阶段交付（后者新增 Alembic 0005，见 CLOUD-CHAT.md）。

验证结果、已知限制及尚未完成的部署验收见 [VALIDATION-SYNC.md](VALIDATION-SYNC.md)。
