# 第一阶段验收记录

验证日期：2026-09-25（Asia/Shanghai）

历史记录：本文件保留第一阶段初次交付时的验证状态。用户随后确认第一阶段完成并配置了真实模型；第二阶段最新验收见 [VALIDATION-PHASE-2.md](./VALIDATION-PHASE-2.md)。

## 环境

- macOS / Apple Silicon
- 项目 Node.js 24.21.0（独立本地安装，未替换系统 Node）
- Electron 44.4.5，Electron Forge 7.11.2，Pi SDK 0.87.1
- 实际 macOS Keychain + Swift helper

## 已执行

| 检查 | 结果与证据 |
| --- | --- |
| `npm run dev` 启停 | 通过：Forge 启动 Electron；终止开发启动器后服务及 UI 子进程均退出 |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过：Swift helper、Electron、服务及 Vite UI 产物 |
| `npm test` | 4 项通过，1 项真实 Keychain 测试按设计跳过 |
| `npm run test:keychain` | 1 项通过：真实保存、读取、更新、删除；测试凭据清理 |
| `npm run test:ui` | 1 项综合端到端用例通过；真正 Electron + Node + Pi + Keychain，本机可控模型端点 |
| Pi 事件适配 | 文本定稿不重复；中间 turn 结束不提前完成；完成、取消、错误映射 |
| Pi 隔离 | 实际请求 tools 为空；资源加载器为空；斜杠文本不触发命令 |
| 持久化 | 会话隔离、完整重启后上下文恢复、幂等发送、未完成运行转 interrupted |
| 凭据隔离 | 前端快照与 SQLite 不包含测试密钥；供应商回显密钥不写入 Pi 原生会话 |
| 模型与会话 | 新建、配置测试、重命名、模型替代约束、删除会话清理 Pi 文件 |
| UI 异常路径 | 首次无配置引导、停止且保留文本、错误凭据提示、服务断连和重连 |
| 界面审查 | 明暗模式聊天和模型设置截图，位于 `work/chat-light.png`、`work/chat-dark.png`、`work/settings.png` |

测试源文件在 `tests/`。模型测试端点由 `tests/helpers.ts` 创建，返回固定内容，故这些结果只证明协议和应用行为，不证明真实供应商兼容性或模型能力。

## 真实模型验收（未执行）

尚未获得用户配置的真实端点和凭据。API Key 应在应用「模型设置」输入，不记录到本文件或聊天。

| 验收项 | 时间 / 模型 / 结果 |
| --- | --- |
| 真实连接测试 | 待填 |
| 连续两轮对话，上下文正确 | 待填 |
| 长回复中取消并保留部分内容 | 待填 |
| 退出并重新启动，继续原会话 | 待填 |

完成以上四项后再将第一阶段标为全部验收。

## 依赖审计与边界

2026-09-25 锁文件：`npm audit --omit=dev` 为 0 项；完整审计为 23 项（3 low、19 high、1 critical），来自 Forge 等开发工具的间接依赖，包括 tar、tmp、extract-zip 链路。尚未通过跨主版本 overrides 强行替换；正式分发前需升级或替换受影响工具链并复测。详情保存在本次工作目录 `work/dependency-audit.json`。

本阶段没有提供签名安装包、后台常驻、工具执行、编程模式、云端或 Android 实现。现有架构与需求文档保留后续阶段规划，不代表已实现。
