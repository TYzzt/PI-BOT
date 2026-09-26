# T-AGNET

个人跨端智能体项目。当前已实现 Mac 本地问答/编程、云端任务控制、共享聊天、模型与密钥同步及远程续聊；Android 可查看共享聊天并继续提问；DeepAgents 云端问答在 Mac 离线时也能回答，并支持把共享会话转到云端继续；Skills 与 MCP 配置可在手机和 Mac 上编辑，Mac 检查依赖并显示不可用原因，不自动安装。

- 同步部署与使用说明：[SYNC.md](SYNC.md)
- 云端问答（Worker 部署、Tavily、使用与验收）：[CLOUD-CHAT.md](CLOUD-CHAT.md)
- 共享 Skills 与 MCP 配置（依赖检查、不自动安装、验收）：[CONFIGS.md](CONFIGS.md)

| 目录 | 框架 | 本端需求 | 整体架构 |
|---|---|---|---|
| desktop（端侧） | Electron + React + Node.js + Pi SDK | [本端需求](desktop/REQUIREMENTS.md) | [整体架构与完整需求](desktop/ARCHITECTURE.md) |
| server（云端） | FastAPI + DeepAgents + PostgreSQL | [本端需求](server/REQUIREMENTS.md) | [整体架构与完整需求](server/ARCHITECTURE.md) |
| android（手机端） | Kotlin + Jetpack Compose | [本端需求](android/REQUIREMENTS.md) | [整体架构与完整需求](android/ARCHITECTURE.md) |

三个目录内的整体架构文档内容一致，均包含总体架构图、计划审批流程图、数据与同步规则及验收标准。后续架构变更须同步更新这三份；各端具体实现需求维护在REQUIREMENTS.md。

建议顺序：Mac 单机闭环 → 云端任务与同步 → Android 审阅 → DeepAgents 云端问答 → 配置、Chrome 与故障恢复打磨。
