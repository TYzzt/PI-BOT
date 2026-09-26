# T-AGNET 端侧需求

目标平台：macOS，首版优先 Apple Silicon。

## 完整架构

请先阅读本目录的 [ARCHITECTURE.md](ARCHITECTURE.md)。三个端均保存同一份完整架构，本文补充端侧职责与实施清单。

## 技术栈

- Electron + React + TypeScript + Vite：桌面界面，Electron Forge 打包。
- 独立 Node.js LTS 常驻服务 + Pi coding-agent SDK：任务执行。
- 用户级 launchd LaunchAgent：登录启动与运行管理。
- SQLite：任务、事件、配置、outbox；Pi 原生会话文件：私有上下文。
- macOS Keychain：模型、MCP 与设备密钥。
- child_process / node-pty / xterm.js：普通命令、交互式 CLI、终端展示。
- 官方 MCP TypeScript SDK + Pi 工具适配器；Chrome DevTools MCP 操作 Chrome。

## 职责

1. 管理真实项目目录、模型配置、Skills 与 MCP。
2. 提供问答、编程规划、编程执行、浏览器操作。
3. 接收手机经云端派发的本地任务，生成结构化 Plan。
4. 校验具体版本的审批后执行，回传计划、进度与可共享摘要。
5. 本机保存源码、diff、完整日志和 Pi 私有会话。
6. 支持窗口关闭后继续运行、断网事件缓存与重连回放。

## 功能清单

### 项目与配置

- 注册项目生成 project_id；真实路径仅保存在 LocalProjectBinding。
- 云端仅同步项目名称、设备和可用状态，远程请求不能指定任意 cwd。
- 模型配置包含 provider、API 类型、base_url、model_id、推理参数和连接测试。
- 本地 Ask、Plan、Execute 可分别指定模型；密钥存 Keychain。
- Skills 支持文件包、版本、启停、作用域、依赖与 local_only。
- MCP 支持 stdio/Streamable HTTP、工具列表、连接测试、超时和权限配置。
- 配置模板与设备路径、秘密分离；显示 desired_version/applied_version；运行固定配置快照。

### 模式与执行

- Ask 默认纯问答，可显式开放只读项目工具。
- Plan 只读项目并调用 update_plan；禁止任意 shell、安装、构建、测试和有副作用 MCP。
- Execute 才启用编辑、Shell/PTY 和授权工具；遵守当前用户的 macOS 权限。
- Browser 使用 Chrome DevTools MCP；默认独立 profile，已有会话须按 Chrome 要求授权。
- 一项目工作区同时只有一个写任务；保留用户已有修改，不自动 reset。
- 实现 cwd、PATH、环境诊断、stdout/stderr、退出码、超时和受管进程取消。
- sudo、系统权限、验证码和登录需要本机交互时，发送 waiting_for_local_action。

### Plan 审批

- Plan 包含目标、范围、稳定 step_id、影响模块、验证方案、权限要求与版本/hash。
- 本机记录 HEAD、dirty/untracked 与相关文件指纹。
- 执行前校验审批、计划版本、配置快照、设备、项目及工作区状态。
- 审批后工作区变化进入 needs_replan；重复命令返回原 run_id。
- 模型表示完成不能代替测试结果；未跑测试显示未验证。

### 同步与界面

- UI 经受限 preload IPC 和主进程连接本地服务，renderer 不直接访问 shell。
- 本地服务通过主动出站 WSS 连接云端，不开放公网执行接口。
- SQLite outbox 持久化事件；使用 event_id/command_id 去重，cursor 补传。
- 同步公开聊天、Plan、步骤和测试摘要；不直接上传 Pi JSONL 或原始工具结果。
- 提供会话、项目、Plan 审阅、执行进度、本地 diff/日志、配置、设备状态页面。
- 明确区分关闭窗口、退出 UI、停止后台服务。

## 对外契约

输入：项目计划请求、指定计划审批、补充消息、取消命令、配置版本。
输出：项目目录元数据、设备状态、共享消息、Plan、步骤事件、执行结果、配置应用结果。
使用整体架构中的 Task/Run/Plan/Approval/Command/Event 模型；Pi session_id 仅为内部映射。

## 首批开发任务

1. 验证固定 Pi SDK 版本、工具注册、模式隔离、事件和取消行为。
2. 实现 daemon、SQLite、项目登记及单机 Plan—审批—执行闭环。
3. 对接云端设备配对、任务投递、双端审批与事件回放；配置同步留到后续阶段。
4. 实现模型/Skills/MCP 配置和 Chrome 操作。
5. 打包独立 Node runtime、launchd 服务与签名公证，验证 UI 退出后可执行。

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 第一阶段 | 工程骨架与 Pi 问答接入 | 已完成 |
| 第二阶段 | 本地编程闭环 | 已完成 |
| 第三阶段 | 接入云端：配对、项目共享、云端任务本地规划与执行、双端审批、脱敏进度回传 | 已实现，待 Mac 验收 |
| 同步扩展阶段 | 共享聊天、模型/API Key 同步、远程 Ask 与读代码 | 已实现，见 ../SYNC.md |
| 第四阶段 | Skills、MCP、Chrome 操作 | 未开始 |
| 第五阶段 | launchd、独立 runtime、安装包签名公证、UI 退出后继续执行 | 未开始 |

## 重点验收

- 未审批前项目没有写入；Ask/Plan 的写入尝试被执行层拒绝。
- 重复批准只有一个执行；过期审批和工作区变化不能直接执行。
- UI 退出后仍接收手机任务；断网重连不丢事件、不重复执行。
- Pi 崩溃后显示 interrupted，不盲目重复有副作用命令。
- 代码和私有执行记录默认留在 Mac；手机能看计划和执行摘要。

## 分阶段实施

- [第一阶段：工程骨架与 Pi 问答接入](PHASE-1.md)

- [第二阶段：本地编程闭环（已实现与验收）](PHASE-2.md)

- [第三阶段：接入云端（已实现，待 Mac 验收）](PHASE-3.md)
