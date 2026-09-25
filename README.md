# T-AGNET

个人跨端智能体项目。当前阶段：需求与架构，尚未生成应用代码。

| 目录 | 框架 | 本端需求 | 整体架构 |
|---|---|---|---|
| desktop（端侧） | Electron + React + Node.js + Pi SDK | [本端需求](desktop/REQUIREMENTS.md) | [整体架构与完整需求](desktop/ARCHITECTURE.md) |
| server（云端） | FastAPI + DeepAgents + PostgreSQL | [本端需求](server/REQUIREMENTS.md) | [整体架构与完整需求](server/ARCHITECTURE.md) |
| android（手机端） | Kotlin + Jetpack Compose | [本端需求](android/REQUIREMENTS.md) | [整体架构与完整需求](android/ARCHITECTURE.md) |

三个目录内的整体架构文档内容一致，均包含总体架构图、计划审批流程图、数据与同步规则及验收标准。后续架构变更须同步更新这三份；各端具体实现需求维护在REQUIREMENTS.md。

建议顺序：Mac 单机闭环 → 云端任务与同步 → Android 审阅 → DeepAgents 云端问答 → 配置、Chrome 与故障恢复打磨。
