# Pi Bot for Mac 架构

```
┌──────────── Electron (Pi Bot.app) ────────────┐        ┌──────────── Pi Bot 云端 ────────────┐
│ UI (React + @pi-bot/bot-face)                 │        │ API (Fastify)                        │
│   │ window.agent.call / subscribe             │        │   /ws/device  ← 设备签名握手          │
│ main.ts ── Unix socket RPC (IPC token) ──┐    │        │   /llm/v1     ← 模型代理（短期令牌）   │
└──────────────────────────────────────────┼────┘        │   REST       ← 设备签名或用户令牌      │
                                           ▼             │ Worker / Runner（Mac 离线时的云端运行） │
┌──────── 本地服务 (packages/service) ───────────┐        └─────────────────────────────────────┘
│ Application  账号、设备身份、CloudSocket         │──WS──▶ run / cancel / approval / rpc / event
│ Executor     每个 run 一个 Pi agent            │──HTTP─▶ /llm/v1/chat/completions
│ library.ts   资料库沙箱与工具                   │
└──────────────────── ~/pi-bot/<slug>/ ─────────┘
```

## 进程

- **Electron 主进程**（`apps/desktop/src/main.ts`）：窗口、菜单、`shell.openPath` 打开资料库。打包应用里由它拉起本地服务；开发时由 `scripts/dev.mjs` 单独拉起。主进程只转发 RPC，不持有任何令牌。
- **本地服务**（`packages/service/src/server.ts`）：Unix socket 上的 JSON 行协议。连接后先用 `~/Library/Application Support/Pi Bot/ipc-token` 认证，然后可以 `call(method, input)` 并接收事件。方法和事件的类型在 `packages/protocol`，输入由 zod 校验。
- **UI**（`apps/desktop/ui`）：Bot 列表、时间线、新建/编辑 Bot、审批卡片、设置。角色用共享的 `@pi-bot/bot-face` Canvas 渲染。

## 身份与鉴权

1. 登录：`POST /auth/login` 拿用户令牌，本地生成 Ed25519 设备密钥，`POST /devices/register` 绑定设备（同一账号的旧设备被吊销并踢下线）。用户令牌用完即弃。
2. 之后所有云端请求都用设备私钥签名：`x-pibot-device-id / timestamp / nonce / signature`，签名内容是 `${ts}.${nonce}.${METHOD}.${path}.${sha256(body)}`。服务端的 `actor` 鉴权同时接受用户令牌和设备签名，所以 Mac 端调用 `/bots`、`/bots/:id/messages` 等与手机共用同一套 API。
3. 模型调用：Executor 用 `POST /device/llm-token` 换取 30 分钟的代理令牌，每 10 分钟刷新一次（`AgentHandle.setApiKey`）。请求里的 `model` 是 Pi Bot 模型 ID，真实的服务商地址、模型名和 API Key 只在服务端。
4. 收到 401 或 WebSocket 以 4401 关闭时，状态变为 `revoked`，需要重新登录；4409 表示被同账号的新连接替换，至少等 5 秒再重连。

## 运行

服务端在用户发消息时检查该用户的 Mac 是否在线（单副本 API 的内存 Hub）：

- **在线**：事务提交后经 `/ws/device` 下发 `{type:'run', run}`，`run` 里带 Bot 的人设、记忆摘要和最近的历史。
- **离线**：run 留在队列里由云端 Worker 认领，Runner 用同一个 `@pi-bot/agent` 跑，只有 `web_search`。

Mac 上的 Executor：

1. `libraryDir(root, slug)` 创建并解析资料库（拒绝符号链接作为资料库本身）。
2. `createBotAgent` 建立内存中的 Pi 会话（历史作为种子），工具来自 `libraryTools(new Sandbox(dir))`。
3. 回传 `run_event`：`started`、`text`（150ms 节流的完整文本）、`tool`（运行中/完成/失败，带一行摘要）、`approval`、`done`。服务端把文本按秒落库并推送给手机。
4. 取消：服务端下发 `cancel`，Executor 中止 agent 和正在执行的命令（杀进程组）。
5. Mac 断线时服务端把它的运行中 run 标为失败，提示「Mac 已离线，可重新发送（将在云端运行）」。

## 资料库沙箱

`Sandbox` 维护一组允许的根目录（初始只有资料库）：

- 路径先展开 `~`、相对路径以资料库为基准；然后对「最近的已存在祖先」取 realpath 再拼回剩余部分，因此符号链接和尚未创建的文件都不能逃出允许的根。
- `request_outside_access(path, reason)` 发出 `approval` 事件 → 服务端创建审批并回 `approval_created` → 用户在 Mac 或手机上批准/拒绝 → 服务端推送 `approval` → 工具返回结果。批准只加入当前 run 的 Sandbox；拒绝整个磁盘或整个家目录。审批默认 15 分钟过期（`PI_BOT_APPROVAL_TTL_SECONDS`），过期视为拒绝。
- 手机浏览资料库走 `rpc`：服务端转发 `files.list` / `files.read`，Mac 用 `previewList` / `previewRead` 只读资料库内的内容（文本 ≤512KB、图片 ≤4MB）。

## 状态与事件

- `account`：`signed_out | connecting | online | offline | revoked`，以及服务器地址、用户、设备名、资料库根目录。
- `bots` / `bot` / `delta`：云端经 `/ws/device` 转发的变更（来源是服务端的 `pibot_changes` LISTEN/NOTIFY），UI 据此刷新列表和流式文本。
- `activity` / `bot.mood`：本机正在执行的工具和对应表情。`bot.mood` 也给桌面硬件（ESP32 屏幕）用。

## 本地存储

本机没有数据库。`account.json` 保存服务器地址、用户、设备 ID 和设备名；设备私钥在钥匙串（或开发模式下的 `secrets.json`）。消息、记忆、审批、用量都在云端。
