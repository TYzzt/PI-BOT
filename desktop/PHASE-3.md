# 第三阶段：接入云端

状态：2026-09-26 已实现。自动化测试和对本地 Compose 服务器的端到端测试通过；真实 Keychain、Electron 界面和真实模型需要在 Mac 上验收，见文末「验证记录」。

本阶段让这台 Mac 成为云端的执行设备：手机或网页在云端创建任务，Mac 本地读代码、生成计划；手机或 Mac 任一方批准后在本地执行，进度以脱敏事件回传云端。代码、diff、命令输出、Pi 会话和聊天记录都留在本机。

## 使用流程

1. 先按 [server/README.md](../server/README.md) 启动云端服务器。
2. 在「模型设置」页底部的「云端同步」面板填写服务器地址（只写协议、主机和端口，例如 `https://agent.example.com`）、设备名称和管理员密码，点击「配对设备」。
3. 在「项目与编程」的项目卡片上勾选「在云端显示并接收任务」。开关默认关闭；开启后云端只收到项目名称，不包含路径。关闭开关或移除项目登记后，云端项目标为不可用。
4. 在云端对该项目创建任务后，Mac 自动用**默认模型**新建一个「改代码」任务并开始只读规划。会话列表中出现该任务，标题旁显示「来自云端」。
5. 计划生成后自动发布到云端。可以在云端批准，也可以在 Mac 的「计划与审阅」点击「批准并执行」；两边校验规则相同，先到达云端的决定生效，重复批准只执行一次。「拒绝计划」和「要求修改 / 重新规划」同样经过云端，保证两边版本一致。
6. 执行在本机进行，和第二阶段相同：工作区变化、配置变化或批准过期都会进入「需要重新规划」，不会直接执行。
7. 云端取消任务时，本机停止对应运行，并在确认停止后回报；只有设备回报后，云端才把任务标为已取消。

云端任务上的「提问」仍是本地只读问答，不经过云端。本机自己创建的任务不会同步到云端。

离线时，Mac 端的审批按钮不可用，并提示「审批需要连接云端」；已产生的进度事件在本机排队，恢复连接后按顺序补发。

## 配对与凭据

- 管理员密码和登录得到的 JWT 只存在于配对这一次调用中，不写入 SQLite、日志或 Keychain，也不返回给界面。
- 配对时本机用 `node:crypto` 生成 Ed25519 密钥对。私钥存入 macOS Keychain，service 为 `dev.t-agnet.device`；云端只登记 32 字节原始公钥。之后所有设备请求和 `/ws/device` 握手都用私钥签名，签名格式见 server README。
- 「解除配对」删除本机私钥和全部云端映射数据，本地项目、任务和聊天记录不受影响。它**不会**在云端吊销设备，需要时请在云端撤销该设备。正在运行云端任务时不能解除配对。
- 设备被云端撤销或本机时间偏差过大时，面板显示「设备认证失败」，此时需解除配对后重新配对。

## 连接与命令

- 本地服务主动向云端建立 `wss /ws/device` 连接（Node 自带 WebSocket 不能设置签名请求头，因此使用 `ws` 依赖），每 15 秒心跳，断线按 1 秒到 30 秒指数退避重连。
- 收到的命令先写入 `cloud_commands`，调用 `POST /device/commands/{id}/ack` 成功后才处理；ack 返回 404 或 409 的命令直接丢弃。以 `command_id` 去重，云端重复投递不会重复执行。
- 本机正在生成或测试连接时，`plan_request`、`plan_revise`、`execute` 按到达顺序排队，空闲后依次处理；`cancel` 立即处理，并丢弃同一运行仍在排队的命令。
- `plan_request`：项目未开启同步、已移除或本机没有模型时回报 `run.failed`。
- `execute`：先核对批准未过期、云端计划版本和哈希与本机发布记录一致，再走第二阶段的本地批准检查（工作区指纹、配置哈希、计划没有未决问题）。任一不通过则回报 `run.needs_replan`，不执行。
- 服务重启时，未结束的云端运行回报 `run.interrupted`，不会自动重跑；已 ack 但尚未处理的命令会继续处理。

## 计划与事件

- 本地计划转换为云端的 snake_case 正文后发布。云端版本号由本机单独计数，只统计已发布的计划，因此本地因 `request_replan` 产生、未发布的版本不会让云端版本跳号。
- 计划哈希按 server README 的规范计算，`config_snapshot_id` 使用本地计划的配置哈希。服务端和桌面端测试共用同一个测试向量 `server/tests/fixtures/plan_hash_vector.json`。
- 事件只包含固定摘要、步骤 ID 与标题、工具名、状态、退出码、验证结果和耗时。不上传命令文本、命令输出、文件路径、diff 或模型生成的文字。
- 事件写入本地 `cloud_outbox`，入队时分配单调递增的 `producer_seq`，按顺序每批最多 100 条发送。网络错误、401、408、429 和 5xx 退避重试；其他 4xx 会先拆成单条重发，定位到被拒绝的那一条后标为失败，后面的事件继续发送。计划发布被拒绝时额外回报 `run.failed`。失败的条目在面板中列出，点击「立即重试」重新入队。

## 数据

SQLite 从 v2 事务迁移到 v3，保留全部已有数据；旧代码拒绝打开 v3 以上的数据库。新增表：

| 表 | 内容 |
| --- | --- |
| `cloud_link` | 服务器地址、云端设备 ID、设备名、公钥、Keychain account、`producer_seq` 计数、最近同步时间 |
| `cloud_projects` | 本地项目与云端项目的映射及开关状态 |
| `cloud_tasks` | 本地任务与云端任务、运行、已发布计划（版本、哈希、云端计划 ID）的映射 |
| `cloud_commands` | 收到的命令及处理状态 |
| `cloud_outbox` | 待发送的计划和事件，含失败原因 |

未配对时不发起任何网络请求，第一、二阶段的功能保持不变。

## 服务端配套改动

- 新增设备签名接口 `POST /device/plans/{plan_id}/approve|reject|revise`，只有任务的执行设备可以调用，与用户接口共用校验和事务。
- 迁移 `0003`：`approvals` 和 `plan_feedback` 增加 `actor` 列（`user` / `device`），事件 payload 同样携带。

## 测试

```sh
npm run typecheck
npm test
```

`tests/cloud.test.ts` 纳入 `npm test`，覆盖计划哈希向量、设备签名、v2 到 v3 迁移（并拒绝打开 v4）、未配对时不联网、outbox 顺序与失败隔离。

`tests/cloud-e2e.test.ts` 对真实服务器跑完整链路，只在设置了环境变量时运行。模型使用本机假端点，服务器前面加了一个本地 TCP 中继，用来模拟断网：

```sh
cd ../server
export T_AGNET_ADMIN_PASSWORD=e2e-admin-password
export T_AGNET_JWT_SECRET=e2e-jwt-secret-must-be-32-characters-long
export T_AGNET_APPROVAL_TTL_SECONDS=60
docker compose up -d --build
cd ../desktop
T_AGNET_CLOUD_URL=http://127.0.0.1:8000 T_AGNET_CLOUD_PASSWORD=e2e-admin-password \
  node_modules/node/bin/node --import tsx --test tests/cloud-e2e.test.ts
```

测试会在服务器上创建配对设备和项目，请使用专门的测试库；若管理员账号已用其他密码初始化，先 `docker compose down -v`。

## 验收对照

| 编号 | 内容 | 证据 |
| --- | --- | --- |
| D3-01 | 配对成功；密码和 JWT 不出现在任何本地存储中 | e2e（配对后及结束时扫描 SQLite 和数据目录） |
| D3-02 | 项目开关只上传项目名，不上传路径 | e2e |
| D3-03 | 计划本地生成并发布，云端哈希校验通过 | e2e、`cloud.test.ts` 哈希向量 |
| D3-04 | Mac 端审批记录 actor 为 `device` 并在本地执行；离线时拒绝审批 | e2e |
| D3-05 | 云端用户审批可用；重复审批只产生一次 run；过期批准不执行；工作区变化进入 `needs_replan` | e2e |
| D3-06 | 云端修订和 Mac 端修订后云端版本号连续 | e2e |
| D3-07 | 步骤、工具和验证结果到达云端；用标记字符串扫描，没有源码、diff、输出、路径或模型文本 | e2e |
| D3-08 | 设备回报后取消才完成 | e2e |
| D3-09 | 离线积压重放后无重复，`producer_seq` 无断档 | e2e |
| D3-10 | 重启后运行标为 `interrupted`；已 ack 的命令继续处理；重复投递不重复执行 | e2e |
| D3-11 | 忙时排队 | e2e |
| D3-12 | 第一、二阶段测试仍通过；v2 到 v3 迁移保留数据；未配对不联网 | `npm test` |

## 验证记录

2026-09-26，Linux 云端开发环境（非 Mac）：

- 服务端 `uv run pytest`：26 项通过，包括新增的 `test_phase3.py`（设备审批、非目标设备 403、与用户审批并发只产生一次 run、actor 字段、哈希向量）。
- 桌面端 `npm run typecheck` 通过；`npm test` 17 项通过，跳过 2 项（需设置变量的 cloud-e2e、需真实 Keychain 的测试）。
- `cloud-e2e.test.ts` 对本地 Docker Compose 服务器运行通过，约 69 秒，覆盖 D3-01 到 D3-11。
- 界面：用模拟的 preload 接口在 Chromium 中渲染构建后的页面，检查了配对表单、已配对状态、项目开关、「来自云端」标记和离线时禁用审批。

以下只能在 Mac 上验证，尚未完成：

- 真实 Keychain 保存与删除设备私钥（`npm run test:keychain` 以及实际配对、解除配对）。
- `npm run build` 与 `npm run test:ui`：构建需要 `xcrun swiftc`，Playwright 用例固定使用 macOS 的 Electron 可执行文件。
- 在真实 Electron 窗口中完成配对、开启项目、云端下发任务、Mac 端批准执行、取消和断网恢复。
- 使用真实模型跑一次云端任务的规划与执行。

## 本阶段明确限制

- 一台 Mac 只能配对一个云端服务器；云端任务固定使用本机默认模型规划和执行。
- 不同步本机创建的任务、聊天记录、模型配置、Skills 或 MCP 配置。
- 解除配对不吊销云端设备。
- 应用退出后不再接收云端任务；launchd 常驻属于第五阶段。
- Skills、MCP、Chrome 操作属于第四阶段；安装包、签名和公证属于第五阶段。
