# Windows x64 客户端开发与测试

## 当前状态（2026-10-20）

此分支是 **Windows 首轮实现，尚未通过 Windows 原生 CI、安装器或实机验收**。不要据此宣布项目已正式支持 Windows。Linux 构建成功不代表 Windows 安装包可用。

目标为 Windows 11 x64，系统 PowerShell 5.1，用户级安装。Windows 10、ARM64、自动更新、Windows Service、后台常驻和签名公开发行不在本轮支持承诺内。客户端退出后本机执行端离线。

### 已写入的代码

- 服务端注册接受 `win32`；新增 `0011-windows-devices.sql`，不修改历史迁移。桌面、Admin、Android 展示 Windows，未知平台不误标 macOS。
- `%LOCALAPPDATA%\Pi Bot` 私有数据目录；资料库仍为 `%USERPROFILE%\pi-bot\<slug>`。`con/prn/aux/nul/com1…/lpt1…` Bot slug 映射为 `_bot_<slug>`，不修改云端 slug。
- Windows 本地磁盘路径策略：拒绝 UNC、设备命名空间、ADS、盘符相对路径、保留文件名及尾部点/空格。路径工具继续检查已有祖先的 realpath；junction 越界默认拒绝。手机/搜索返回的资料库相对路径统一 `/`。
- 非交互 PowerShell EncodedCommand，UTF-8 输出，错误/退出码处理；不添加 ExecutionPolicy Bypass。受 Windows 进程命令行长度限制，过长命令明确失败，请先写脚本文件再调用。旧原生程序可能输出 OEM/GBK，不保证自动识别。
- 窄 Win32 helper：DPAPI CurrentUser 加密凭据；当前用户与 SYSTEM 的私有 DACL；Job Object 挂起创建/入 Job/恢复进程，关闭 Job 清理子孙进程。命令取消、超时、服务崩溃，通过继承 stdin 的 EOF 租约结束 Job。禁止把租约句柄继承给任务。
- Electron 随包 `node.exe`、helper，隐藏控制台，显示服务启动错误，只关闭自己启动的服务。正常退出先释放服务租约并等待关停。
- Forge Squirrel 用户级测试安装器与 ZIP（构建输出使用短目录 `.w/`、临时目录 `.t-*`，规避旧版 NuGet 的 MAX_PATH 限制）；独立 runtime 依赖锁；打包前原生测试和离开仓库目录的独立运行时 smoke gate；生成 SHA256SUMS。

**上列 Windows 原生实现尚未编译/执行验证，不能把源码存在当成能力已验收。** Android 仅修改平台文案，尚未 Android 构建验证。

## ADR：Windows beta IPC 使用 loopback TCP

原计划优先命名管道，但 Node `net` 默认管道权限不足以直接证明满足当前用户 DACL / 远程拒绝要求。本轮明确采用另一种窄实现，而不是跳过管道权限检查：

1. 仅监听字面量 `127.0.0.1`，不监听 `0.0.0.0` 或网络地址，不开放远程连接。
2. 根据用户名和规范化数据目录计算固定端口（20000–59999），仅用于发现，不作为认证秘密。
3. 每个数据目录生成独立 256-bit 随机 token；token 文件通过 native helper 显式设置受限 DACL，不把 chmod 当作 Windows 权限保护。认证仍使用长度检查与恒时比较。
4. 认证前不接受任何 RPC；保留 5 秒认证超时、消息大小及并发限制。
5. 端口被占用时直接失败，不清理/接管对方服务、不换用未认证端点。客户端只把认证成功的服务视为已有实例。
6. 不保护同用户恶意进程、管理员或被攻陷系统；本地其他用户可能占用端口造成拒绝服务，但不可仅凭端口调用 RPC。若本地策略禁止 loopback 通信，应显示失败，不默默放宽监听地址。

这是 Windows beta 的设计变更，不是“已实现安全命名管道”的声明。仍需 Windows CI 和第二普通用户测试确认 ACL、认证及端口占位行为。数据目录的大小写/分隔符会规范化，但不同盘符映射或短文件名别名不作为多 profile 同时运行的支持范围。

参考：[Node net](https://nodejs.org/api/net.html)、[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[CryptProtectData](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)。

## 构建（Windows 开发机或 CI）

需要 Node 24 x64、npm、MSVC C++17 x64 Developer shell。目标用户的安装环境不需要这些开发工具，helper 使用 `/MT`。

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm rebuild electron
npm run pack:win --workspace=pi-bot-desktop
```

`pack:win` 在非 Windows/x64 上拒绝执行，不伪造可用安装包。流程为：helper/桌面构建 → Windows 测试 → runtime `npm ci` → 独立 runtime smoke → Forge Squirrel/ZIP → SHA256。

预期（仅在成功构建后存在）的产物位于：

```text
.w/make/**/Pi-Bot-Windows-x64-Setup.exe
.w/make/**/*.zip
.w/make/SHA256SUMS.txt
```

GitHub Actions `Desktop platforms` 新增 `windows-2022` 作业，产物名 `pi-bot-windows-x64-UNSIGNED-TEST`。它同时保留 Ubuntu/macOS 作业。当前未推送/触发该工作流，也未生成以上 exe。

服务端必须先部署包含 `0011` 的兼容版本，否则旧后端会拒绝 Windows 设备注册。迁移测试覆盖历史升级、重复 migrate、三平台插入和非法平台拒绝；没有测试数据库时明确跳过，不视为通过。这里不自动部署服务器或执行生产数据库迁移。

## 实机验证步骤

拿到真实安装包、校验和及对应提交后，再进行以下操作：

1. 在 Windows 11 x64 普通账号下核对 `Get-FileHash <Setup.exe> -Algorithm SHA256`。这是未签名的内部测试包；若 Windows 或单位安全策略阻止运行，停止并反馈提示，不需要关闭 Defender/SmartScreen 或全局降低执行策略。
2. 首装并打开；确认无额外控制台窗口。填写已升级的测试服务器地址，登录并绑定 Windows 设备；确认各端平台显示正确。
3. 在 Bot 资料库创建、读取、修改、搜索中文文件；测试带空格路径；从手机预览；打开资源管理器。测试一次库外拒绝和一次批准，不应越权。
4. 让 Bot 用 PowerShell 输出中文、执行一个非零退出命令，并运行长任务后取消。确认任务及其子孙进程结束。命令的 cwd 限制不是 OS 沙箱，仍不要运行不可信命令。
5. 关闭客户端，确认服务及任务不遗留；重新启动后可恢复账号。测试断网重连、休眠唤醒，以及 Windows/Linux 设备切换，不应自动重放不确定副作用。
6. 升级前主动退出客户端并结束运行任务，再手动安装新版。卸载后默认保留资料库/账号数据；卸载、重装、无管理员权限和数据保留仍需人工验收。
7. 用第二普通账号验证不能读取第一个账号的 token、不能解密其 DPAPI 凭据、不能通过本地 IPC 发起 RPC。此项不能被同一账号下的 CI 代替。

反馈请提供：系统版本、安装包 SHA256、复现步骤、错误提示/截图和是否存在残留进程。不要发送密码、IPC token、设备私钥或完整凭据文件。

## 尚未通过的门槛

- MSVC 编译、DPAPI/DACL、Job Object/PowerShell、原生路径与 IPC 自动测试。
- Windows 安装/升级/卸载、GUI、Defender/企业策略、第二用户权限及真实服务端注册。
- 数据库测试（本地未配置测试数据库；CI Ubuntu PostgreSQL 作业负责）。
- Windows 10 兼容性、正式签名和可信公开发布流程。

以上门槛通过前不作完成交付声明、不发布正式版、不承诺未验证的平台。
