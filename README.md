# Pi Bot

多用户的个人 Bot 平台。每个 Bot 有自己的名字、人设、形象和一条连续的时间线，会记住你们聊过的事；你的 Mac 是 Bot 们干活的电脑，手机随时可以和 Bot 说话、批准请求、看它们产出的文件。

- **云端**：管理员在后台创建用户、配置模型和 Key；所有模型调用都经云端代理，客户端拿不到 Key。Mac 离线时，Bot 在云端回复（对话、联网搜索和交互工具）。
- **Mac**：登录即绑定为你的 harness。每个 Bot 的资料库是 `~/pi-bot/<slug>/`，Bot 在里面读写文件、执行命令；要碰资料库以外的路径必须先经你批准。
- **手机**：Bot 网格、时间线、审批、资料库浏览、新建和编辑 Bot。
- **角色**：一份共享的角色规格（8 种造型、10 种颜色、9 种表情），表情跟着 Bot 的运行状态变化。

| 目录 | 技术栈 | 说明 |
|---|---|---|
| [server](server/README.md) | Node.js 24 + Fastify + PostgreSQL | API、管理后台、模型代理、Worker、Runner |
| [admin](admin) | Vite + React | 管理后台，由 API 在 `/admin/` 提供 |
| [desktop](desktop/README.md) | Electron + React + Pi SDK | Pi Bot for Mac |
| [android](android/README.md) | Kotlin + Jetpack Compose | Pi Bot Android |
| [packages/agent](packages/agent) | Pi SDK | Mac 和云端共用的 Bot agent |
| [packages/bot-face](packages/bot-face) | TypeScript Canvas | 角色规格、动画引擎、渲染器 |
| [boards](boards/esp32-s3-touch-lcd-2.8c/README.md) | ESP32-S3 + LVGL | 跟随 Bot 表情的桌面小屏 |

整体架构见 [ARCHITECTURE.md](server/ARCHITECTURE.md)（`server/`、`desktop/`、`android/` 三处内容一致），各端需求见各自的 `REQUIREMENTS.md`。

## 快速开始

```sh
npm ci
cp server/.env.example server/.env        # 设置管理员口令、JWT 密钥、Runner token、vault 路径
node --import tsx server/scripts/vault-key.ts "$PWD/server/vault.json"
(cd server && docker compose up postgres -d)
npm run build && npm start                # API + 管理后台：http://127.0.0.1:8000/admin/
npm run desktop:dev                       # 另一个终端：Pi Bot for Mac
```

在后台添加模型和用户后，用该用户登录 Mac 和手机。详细步骤见 [server/README.md](server/README.md)。

## 检查

```sh
npm run typecheck
PI_BOT_TEST_DATABASE_URL=postgresql://pibot:pibot@127.0.0.1:5432/pibot npm test   # 会清空该库
(cd android && ./gradlew :app:testDebugUnitTest)
```

## 交互工具（A2UI）

可以让 Bot 按当前需求生成可操作的表单、计算器和图表。Mac 和 Android 使用同一套 A2UI 目录，输入会保存，点击提交后 Bot 继续处理。普通问答和解释默认使用文字，不提供预置界面。

升级时需同时更新 API、Worker、Runner、Mac 和 Android；Server 自动应用 `0006-message-ui` 迁移。实现和构建说明见 [packages/a2ui](packages/a2ui/README.md)。

异步任务模式：对话持续接话，每个 Bot 最多并行执行两个后台任务，其余排队；用聊天查询进度、补充要求或取消，结果完成后另发。两端需与 API、Worker、Runner 同步升级，服务端自动应用 `0007-async-tasks`；升级前结束旧运行。详情见 [整体架构](server/ARCHITECTURE.md)。


## 长期委托与自主巡检

全部 Bot 默认具备自主巡检，空闲时逐步降低检查频率，最多六小时检查一次。自动工作只在登录且保持运行的 Mac 上执行；Mac 离线、退出应用或休眠时等待，重连后合并检查。云端仍可接受聊天、保存和管理计划。

直接在聊天中使用：

- “每十分钟检查一下这个任务，有重要变化再告诉我。”
- “每天上午九点整理一次，按上海时间。”
- “现在有哪些自动工作？最近检查出了什么？”
- “暂停自主巡检。” / “恢复自主巡检，每两小时一次。”
- “停止这个长期委托。” / “停止全部自动工作。”

无重要变化不发消息。重要成果、风险和需要决策的事项在原时间线另发；同一状态不重复回报。普通巡检只读自己的资料，不会擅自修改文件或执行命令；明确委托沿用原有权限，资料库外访问仍需审批。中断时操作结果无法确认会暂停并请你核实。

首次升级需同步更新 API、Worker、Runner 和 Mac，服务端自动应用 `0009-always-on`；旧 Mac 不启动自动轮次。Android 无需新增配置，不提供系统后台推送。
