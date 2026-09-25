# T-AGNET desktop

macOS 个人智能体桌面应用：本地 Ask + 项目代码问答 + Git 项目编程闭环。Electron + React + TypeScript + Vite / Electron Forge，独立 Node.js 24 服务，真实 Pi SDK，SQLite 和 macOS Keychain。

**当前状态：第二阶段已实现并完成自动化与真实模型验收。** 支持项目管理、直接读代码问答、只读计划、审阅批准、代码编辑、非交互命令、diff 和验证记录。Skills、MCP、Chrome、交互终端和三端同步尚未开放。

编程使用说明见 [PHASE-2.md](./PHASE-2.md)，验收证据见 [VALIDATION-PHASE-2.md](./VALIDATION-PHASE-2.md)。

## 启动

前置条件：macOS（已在 Apple Silicon 验证）、可用的 npm、Xcode Command Line Tools（`xcrun swiftc --version` 可执行）、可访问 npm 和 Electron 下载源。首次安装需要联网。

```sh
cd ~/T-AGNET/desktop
npm ci
npm run dev
```

项目固定 Node.js `24.21.0`，安装在 `node_modules/node/bin/node`；npm scripts 使用项目运行时，不替换系统 Node。Electron 安装脚本通过根项目 `postinstall` 下载对应二进制，不要使用 `--ignore-scripts`。Swift helper 在构建时编译。

`npm run dev` 先构建，再启动独立服务和 Forge 管理的 Electron。此阶段为一次性构建后启动；修改源码后重新执行命令，不提供热更新。终端 `Ctrl+C` 会停止启动器、服务及 Electron 进程树；`Cmd+Q` 退出应用也会让启动器停止服务。关闭窗口在 macOS 上保留应用，点击 Dock 图标可重新打开。未注册 launchd，不承诺启动器退出后继续执行。

## 第一次使用

1. 在「模型设置」添加名称、Base URL、模型 ID、API Key；高级设置可填写上下文长度及输出上限。
2. Base URL 填服务商的 **API 根地址**，例如 `https://your-provider.example/v1`，不包含 `/chat/completions`。不会自动追加 `/v1`，也不调用 `/models`。只支持 OpenAI 兼容 Chat Completions 文本流式接口。
3. 保存后密钥输入框清空，只显示已配置；编辑时留空保留原密钥。无需认证的本地服务可填写占位值。
4. 点击「测试连接」：Pi 发出一次真实的小型生成请求，可能产生少量费用。成功后点击「新建会话」，发送问题。
5. Enter 发送，Shift+Enter 换行。停止会保留部分回复；重启后可继续正常完成的历史对话。

默认模型用于新会话；已有会话保持原配置绑定。配置修改在下一次运行生效，运行或测试期间禁止改配置。删除被引用的模型须选择替代模型。全局只允许一个生成或连接测试；生成期间可以浏览其他会话。

## 项目代码问答

打开「项目与编程」并选择 Git 项目，默认使用「读代码」：直接输入问题即可获得回答，无需计划或批准。回答流式显示在「对话与结果」，历史按时间保存，重启后可继续追问。「阅读记录」只展示读取、搜索等工具过程。

需要修改时选择「改代码」，或在已有项目对话输入需求并点击「生成修改计划」；审阅批准后才执行。普通「提问」始终只读，即使当前会话已经有修改计划。

## 模块与边界

```mermaid
flowchart LR
  UI[React renderer] -->|白名单 preload API| Main[Electron main]
  Main -->|Unix socket + 握手令牌| Service[Node 24 service]
  Service --> Store[(SQLite: UI 历史 / 配置 / 运行)]
  Service --> Pi[Pi adapter: Ask / Read / Plan / Execute]
  Pi --> Sessions[(应用专属 Pi sessions)]
  Service --> Coding[项目 / Plan 版本 / 批准 / 基线 diff]
  Coding --> Tools[按模式注册工具 / 非交互命令监控器]
  Tools --> Repo[本地 Git 工作区]
  Pi -->|Chat Completions| Model[用户配置的模型端点]
  Service -->|stdin / stdout| Helper[Swift helper]
  Helper --> Keychain[macOS Keychain]
```

- `apps/desktop`：Electron 主进程、preload、React 界面和 Forge 配置。
- `packages/service`：socket 服务、串行命令管理、运行协调、SQLite、凭据与 Pi 适配器。
- `packages/protocol`：应用自己的请求/事件和 Zod 输入校验，不向 renderer 暴露 Pi 对象。
- `native`：Keychain helper；`scripts`：构建和开发启动器；`tests`：适配器、存储、凭据和 Electron 测试。

Pi SDK 固定为 `0.87.1`。Ask 显式禁用所有工具，项目会话按 Read / Plan / Execute 注册不同工具集；所有模式禁用自动资源发现。不会加载用户原有 Pi 配置、项目 AGENTS 文件、Skills、扩展或命令模板。输入的 `/` 前缀按普通文本处理。运行结束依据 SDK 最终生命周期；中间 turn 结束不会提前将任务标为完成。禁用自动重试和自动上下文压缩，服务恢复不会自动重发模型请求。

renderer 使用 sandbox、contextIsolation、无 Node 权限；导航和新窗口禁用。Markdown 禁用原始 HTML、远程图片；HTTP(S) 外部链接交给系统浏览器。所有模型网络请求都由本地服务执行，界面不直接联网。

## 数据与凭据

默认目录：`~/Library/Application Support/T-AGNET/`

| 位置 | 内容 |
| --- | --- |
| `app.sqlite` 及 WAL/SHM | 非敏感模型配置、会话、消息、任务/运行状态、Pi 路径映射 |
| `pi/sessions/<conversation-id>/` | Pi 原生上下文，每个会话独立 |
| `pi/empty-workspace/` | 隔离工作目录 |
| `electron/` | Electron 本地用户数据 |
| `ipc-token` | 仅当前用户可读的本机握手令牌 |
| `logs/service.log` | 仅固定服务事件及时间；超过 1 MB 保留一个轮转文件 |

API Key 保存在 Keychain，service 为 `dev.t-agnet.models`，account 为模型配置 UUID；不放入命令参数、SQLite 或前端返回对象。供应商错误不直接展示或记录，并在 Pi 会话写入前遮蔽当前密钥。日志不包含消息、请求头或原始供应商错误。

Unix socket 放在 `/tmp/t-agnet-<uid>-<data-dir-hash>/service.sock`，避开 macOS socket 路径长度限制；目录 0700，socket 和令牌 0600。主进程断线后每秒重连，恢复后刷新状态。启动时遗留运行标为 `interrupted`，保留内容，不自动重新调用模型。发送使用幂等 UUID，同一请求重复提交返回原运行。

删除会话同时删除对应 Pi 会话文件。编程任务还保存工作区基线、工具日志和批准记录；均仅存本机。消息目前标记 `local_only`，仅预留共享字段。历史数据未加密，依赖当前 macOS 用户的文件访问权限。聊天内容会发往你配置的模型提供商。

测试可通过 `T_AGNET_DATA_DIR` 使用隔离数据目录，通过 `T_AGNET_KEYCHAIN_HELPER` 指定构建后的 helper。

## 检查

```sh
npm run typecheck
npm test
npm run build
npm run test:keychain
npm run test:ui
```

新增的编程测试会在临时 Git 仓库运行真实本机命令，并在结束后清理。`npm test` 默认跳过真实 Keychain 测试；`test:keychain` 显式运行并删除临时凭据。`test:ui` 需要先 build，启动真正 Electron、Node 服务和 Pi SDK，但模型端点为本机可控测试替身，不能代替真实模型验收。截图输出到 `work/`，Playwright 输出到 `test-results/`。

`npm run build` 生成运行所需的 UI、主进程、服务和 helper，不生成签名安装包。第一阶段历史记录见 [VALIDATION.md](./VALIDATION.md)，当前第二阶段验收见 [VALIDATION-PHASE-2.md](./VALIDATION-PHASE-2.md)。

## 已知限制

- 支持单用户、单 Mac、文本 Ask 与 Git 项目编程。没有 OAuth、Responses、Anthropic 原生接口、自动模型发现或推理参数配置。
- 上下文过长时需新建会话或调整配置；当前没有自动压缩。取消/异常运行的部分内容保留，完整多轮恢复已由正常完成的对话测试覆盖。
- Keychain 若锁定或访问被拒绝，需在本机解锁或重新保存配置。开发 helper 未签名，尚未覆盖正式分发和权限迁移。
- 不保证所有标为 OpenAI-compatible 的第三方接口行为一致，需要用自己的端点验收。
- 当前锁文件的运行时依赖审计为 0 项；Forge 开发依赖链仍有安全公告，详见验收记录。正式打包前需处理并重新验证。
