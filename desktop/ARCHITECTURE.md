# Pi Bot 整体架构

> 本文在 `desktop/`、`server/`、`android/` 三处内容一致，修改时三份一起改。各端的具体需求在各自的 `REQUIREMENTS.md`。

Pi Bot 是多用户的个人 Bot 平台。每个用户有若干个 Bot，每个 Bot 有名字、人设、形象和一条连续的时间线；用户的 Mac 是 Bot 干活的电脑（harness），手机用来随时和 Bot 说话、批准请求、看 Bot 的资料库。

```
                         ┌──────────────── Pi Bot 云端（单副本 API） ─────────────────┐
  浏览器 ── /admin ─────▶│ Fastify API                                                │
  （管理员）              │   REST：/auth /me /bots /runs /approvals /models ...      │
                         │   /admin/api   用户、模型、设备、用量                       │
  Android ── HTTPS ─────▶│   /ws/events   给手机推送变更（用户令牌）                   │
          ◀── WSS ───────│   /ws/device   Mac 的长连接（设备签名）                     │
                         │   /llm/v1      OpenAI 兼容模型代理（短期令牌）              │
  Mac ───── 签名 HTTPS ─▶│   内存 Hub：在线 Mac、事件订阅、文件 RPC                    │
      ◀──── WSS ─────────│                                                           │
                         │ Worker ── Runner（Mac 离线时在云端运行，仅对话 + 联网搜索）  │
                         │ PostgreSQL 16（LISTEN/NOTIFY pibot_changes）               │
                         └──────────────────────────┬────────────────────────────────┘
                                                    │ 服务商 API Key 只在这里
                                                    ▼
                                         OpenAI 兼容的模型服务
```

## 概念

| 概念 | 说明 |
|---|---|
| 用户 | 管理员在后台创建，没有注册入口。角色为 `admin` 或 `user`，可被禁用 |
| Mac 设备 | 每个用户最多一台。Mac 登录时生成 Ed25519 密钥并绑定，新绑定会吊销旧设备 |
| Bot | 属于一个用户：名字、人设、模型（为空则跟随默认模型）、形象（造型/颜色/深浅色）、资料库 `slug`。改名不改 `slug`；归档不删 Mac 上的文件 |
| 时间线 | 每个 Bot 一条，消息按 `seq` 递增。没有「会话」或「项目」 |
| 运行（run） | 一条用户消息触发一次运行，执行者是 `mac` 或 `cloud`。同一个 Bot 同时只能有一个运行 |
| 长期记忆 | 时间线超过阈值后，Worker 把较早的消息压缩成摘要（`bot_memories`），运行时作为系统提示的一部分 |
| 审批 | Mac 上的 Bot 想访问资料库以外的路径时创建，用户在 Mac 或手机上批准/拒绝，默认 15 分钟过期 |
| 模型 | 管理员配置的 OpenAI 兼容模型（地址、服务商模型名、API Key、上下文长度），其中一个是默认模型 |

## 组成

| 目录 | 内容 |
|---|---|
| `server/` | Fastify API、Worker、Runner、数据库迁移、部署清单 |
| `admin/` | 管理后台（Vite + React），构建后由 API 在 `/admin/` 提供 |
| `desktop/` | Pi Bot for Mac：Electron + 本地服务 + React UI |
| `android/` | Pi Bot Android：Kotlin + Jetpack Compose |
| `packages/agent` | 基于 Pi SDK 的 Bot agent（`createBotAgent`），Mac 和云端 Runner 共用 |
| `packages/bot-face` | 角色规格 `spec.json`、动画引擎、Canvas 渲染器；Android 有一份 Compose 移植 |
| `boards/` | ESP32 桌面小屏，跟随 Mac 上 Bot 的表情 |

## 云端

### 进程

- **API**（`server/src/main.ts`）：REST、WebSocket、模型代理、管理后台静态文件。**必须单副本**：Mac 的 `/ws/device` 连接、在线状态和文件 RPC 都在进程内存里（`hub.ts`）。数据库变更通过 `NOTIFY pibot_changes` 广播，API 收到后推送给该用户的订阅者。
- **Worker**（`server/src/worker.ts`）：认领 `executor='cloud'` 的运行，签发代理令牌后交给 Runner 执行；带租约，Worker 崩溃后超时的运行标为失败。同时负责长期记忆压缩。
- **Runner**（`server/src/runner.ts`）：无数据库、无 vault，只接受带 `PI_BOT_RUNNER_TOKEN` 的请求，用 `createBotAgent` 跑一次运行；工具只有 `web_search`（配置了 Tavily 时）。容器只读根文件系统、去掉全部 capabilities。

### 数据

一份基线迁移 `server/migrations/0001-baseline.sql`：`users`、`devices`、`device_nonces`、`models`、`bots`、`bot_runs`、`bot_messages`、`bot_memories`、`approvals`、`usage_logs`。模型 API Key 用 vault 文件（`PI_BOT_VAULT_FILE`，`scripts/vault-key.ts` 生成，可轮换）加密后入库。

### 鉴权

| 模式 | 凭据 | 用于 |
|---|---|---|
| `user` | `Authorization: Bearer <JWT>`，默认 7 天 | 手机、管理后台 |
| `admin` | 同上，且角色为 `admin` | `/admin/api/*` |
| `device` | Ed25519 签名头 `x-pibot-device-id / timestamp / nonce / signature` | Mac |
| `actor` | `user` 或 `device` 任一 | Bot、消息、审批等 Mac 和手机共用的接口 |
| `llm` | 模型代理令牌（JWT，`src=mac` 或 `cloud`） | `/llm/v1/*` |

设备签名内容为 `${ts}.${nonce}.${METHOD}.${path}.${sha256(body)}`，时间偏差 ≤300 秒，nonce 不可重放。用户被禁用或设备被吊销后，相应请求立即 401，WebSocket 以 4401 关闭。

### 模型代理

`/llm/v1/chat/completions` 与 OpenAI 兼容。请求里的 `model` 是 Pi Bot 模型 ID，代理换成服务商模型名、注入服务商 API Key 后转发，流式透传，并从响应里解析 token 用量写入 `usage_logs`。Mac 用 `POST /device/llm-token` 换取令牌（默认 15 分钟，运行中每 10 分钟刷新）；Worker 为每次云端运行签发覆盖运行时长的令牌。用户令牌不能调用代理，客户端永远拿不到服务商地址和 Key。

### 实时事件

- `/ws/events?token=`：连接后先收到 `{type:'hello', mac_online}`，之后是 `{type:'event', event}`，`event.type` 为 `delta`（流式文本）、`bot`（某个 Bot 变了，重新拉详情）、`bots`（列表变了）、`presence`（Mac 上下线）。
- `/ws/device`：握手带设备签名。云端下发 `run`、`cancel`、`approval`、`approval_created`、`rpc`，以及与手机相同的变更事件；Mac 回传 `run_event` 和 `rpc_result`。同一用户的新连接会以 4409 关闭旧连接。

## 运行路由

用户发消息（`POST /bots/:id/messages`，带 `request_id` 幂等）时，API 在同一事务里写入用户消息、空的助手消息和运行：

- **Mac 在线**：`executor='mac'`，事务提交后经 `/ws/device` 下发 `run`，内容包括 Bot 信息、模型、系统提示（人设 + 长期记忆 + 资料库位置）、最近的历史和本条消息。如果下发时 Mac 刚好掉线，运行改为云端执行。
- **Mac 离线**：`executor='cloud'`，Worker 认领后交给 Runner。系统提示会告诉模型 Mac 离线、看不到资料库。

Mac 回传的 `run_event`：`started`、`text`（完整文本，API 每秒最多落库一次并推送 `delta`）、`tool`（工具名、状态、一行摘要）、`approval`、`done`。

- **停止**：`POST /runs/:id/cancel`。Mac 运行转发 `cancel` 给 Mac；排队中的云端运行直接取消，执行中的由 Worker 检测后中止 Runner。
- **Mac 中途掉线**：它的运行全部标为失败，保留已生成的文本，提示「Mac 已离线，可重新发送（将在云端运行）」。API 重启后，残留的 Mac 运行同样标为失败。
- **审批**：Mac 发 `approval` → API 创建审批、运行变为 `waiting_approval`、回 `approval_created` → 用户 `POST /approvals/:id` → API 把决定下发给 Mac → 运行继续。过期或重复决定返回 409。
- **资料库浏览**：`GET /bots/:id/files?path=`、`/files/content?path=` 经 `rpc` 转给 Mac，Mac 离线返回 503，超时返回 504。

## Mac 端

```
┌──────────── Electron (Pi Bot.app) ────────────┐
│ UI (React + @pi-bot/bot-face)                 │
│   │ window.agent.call / subscribe             │
│ main.ts ── Unix socket RPC (IPC token) ──┐    │
└──────────────────────────────────────────┼────┘
                                           ▼
┌──────── 本地服务 (packages/service) ───────────┐
│ Application  账号、设备身份、CloudSocket         │──WSS──▶ /ws/device
│ Executor     每个 run 一个 Pi agent            │──HTTPS─▶ /llm/v1/chat/completions
│ library.ts   资料库沙箱与工具                   │
└──────────────────── ~/pi-bot/<slug>/ ─────────┘
```

- **Electron 主进程**（`apps/desktop/src/main.ts`）：窗口、菜单、在 Finder 中打开资料库。打包应用里由它拉起本地服务，开发时由 `scripts/dev.mjs` 单独拉起。主进程只转发 RPC，不持有令牌。
- **本地服务**（`packages/service/src/server.ts`）：`/tmp/pi-bot-<uid>-<hash>/service.sock` 上的 JSON 行协议，先用数据目录里的 `ipc-token` 认证。方法和事件类型在 `packages/protocol`。
- **登录**：`POST /auth/login` 拿用户令牌 → 本地生成 Ed25519 密钥 → `POST /devices/register` 绑定 → 丢弃用户令牌。之后所有云端请求都用设备签名，Mac 和手机调用同一套 `actor` 接口。私钥在钥匙串（`dev.pi-bot.device`），开发模式下在 0600 的 `secrets.json`。收到 401 或 4401 进入 `revoked`，需要重新登录；4409 后至少等 5 秒再重连。
- **Executor**：`libraryDir(root, slug)` 创建资料库（拒绝符号链接作资料库本身）→ `createBotAgent` 用历史作种子建立内存会话，工具来自 `libraryTools(new Sandbox(dir))` → 回传 `run_event`（文本 150ms 节流）。取消时中止 agent 并结束命令的整个进程组。
- **工具**：`list_files`、`read_file`、`search_files`、`write_file`、`edit_file`、`run_command`（zsh，默认 2 分钟超时，输出保留尾部 30KB）、`request_outside_access`。
- **沙箱**：`Sandbox` 维护允许的根目录（初始只有资料库）。路径展开 `~`、相对路径以资料库为基准，再对最近的已存在祖先取 realpath，符号链接和尚未创建的文件都逃不出允许的根。`request_outside_access` 批准后只对当前运行有效；拒绝授权 `/` 和整个家目录。`run_command` 只限制工作目录，命令本身不做隔离。
- **文件预览**：`files.list` / `files.read` RPC 只读资料库内的内容（文本 ≤512KB，图片 ≤4MB）。
- **本地事件**：`account`、`bots` / `bot` / `delta`（云端转发）、`activity` 与 `bot.mood`（本机正在执行的工具和表情，`boards/` 的桥接程序也订阅它）。
- **本地存储**：没有数据库。`account.json` 存服务器地址、用户、设备 ID 和设备名；消息、记忆、审批都在云端。

## Android 端

- 单 Activity + Compose Navigation：登录、Bot 网格、新建/编辑 Bot、时间线、资料库浏览、设置。
- `PiBotApi`（OkHttp + kotlinx.serialization）调用与 Mac 相同的 REST 接口；`PiBotRepository` 用 StateFlow 保存会话、Bot 列表、Mac 状态和各 Bot 的时间线，没有本地数据库。
- 应用在前台时连接 `/ws/events`：`delta` 直接合并进时间线，`bot` 事件 200ms 内合并成一次刷新，断线按 1、2、4…30 秒退避重连，重连后补拉列表和已打开的时间线；4401 或 401 退出登录。
- 会话（服务器地址、用户、令牌）存在 EncryptedSharedPreferences。服务器地址必须是 HTTPS；debug 构建允许局域网和模拟器地址用 HTTP。
- 消息按 `seq` 分页（每页 50 条），滚到顶部加载更早的消息。

## 角色

`packages/bot-face/spec.json` 是唯一的角色规格：8 种造型、10 种颜色（浅/深两套渐变）、9 种表情（待命、开心、思考、工作、搜索、等待、庆祝、出错、睡觉）。

- `engine.ts`：与绘制无关的状态机（弹簧、眨眼、视线、`bounce` / `burst` / `spin`、粒子），用 Mulberry32 随机数，可在 Node 里测试；尊重「减少动态效果」。
- `render.ts`：Canvas 2D 渲染，`react.tsx` 提供 `<BotFace>`，Mac 端和管理后台使用。
- `status.ts`：运行状态 → 表情。运行中按工具区分思考/搜索/工作，等待审批为 `waiting`，刚完成或失败短暂庆祝/出错，3 天无活动睡觉并显示天数。
- Android 的 `face/` 是逐行移植：构建时把 `spec.json` 复制进 assets，单元测试用同一份规格和同一组随机数参考值校验两端一致。

## 部署

- 本地完整栈：`server/docker-compose.yml`（Postgres、API、Worker、Runner）。
- 集群：`server/deploy/pibot.yaml`（命名空间 `n-88`，入口 `https://aicloud-app.lenovo.com.cn/pibot`，管理后台在 `/pibot/admin/`）。镜像 `registry.cn-beijing.aliyuncs.com/liuhx/pi-bot-server`。需要先创建 `pibot` 与 `pibot-vault` 两个 Secret。
- API 单副本；Worker 可多副本（`FOR UPDATE SKIP LOCKED` 认领）；Runner 只在内网可达。

## 验收

1. 管理员用环境变量里的口令登录后台，创建用户、添加模型并测试连通；普通用户访问后台接口返回 403，看不到模型地址和 Key。
2. 用户在 Mac 登录，新建 Bot，`~/pi-bot/<slug>/` 出现；让 Bot 写文件，Finder 和手机资料库里都能看到。
3. Bot 申请访问 `~/Desktop`：手机和 Mac 都出现审批卡片，任一端批准后运行继续，下一次运行需要重新申请。
4. Mac 退出后，手机发消息由云端回复（无资料库、可联网搜索）；运行中的 Mac 掉线时该运行失败并提示可重发。
5. 时间线超过阈值后长期记忆生效，较早提过的事情仍能被回答。
6. 两个用户的 Bot、消息、文件、审批、Mac 在线状态互不可见。
7. 管理员禁用用户或吊销设备后，对应客户端立即被登出。
