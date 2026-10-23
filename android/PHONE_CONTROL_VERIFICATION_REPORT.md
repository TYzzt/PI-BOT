# PI-BOT Android 手机远程控制与右上角入口验证报告

## 1. 基础信息与执行来源
- **执行角色**：Pi Bot（仅负责 `android/` 目录）
- **工程路径**：`/home/zhaotao/pi-bot/bot/PI-BOT`
- **基线分支**：`feat/windows-client`
- **Base Commit**：`00576593bce2215b705f9fb99cb30eb4e437ed94`
- **验证与构建时间**：2026-10-23 14:47:00 (Asia/Shanghai) / 2026-10-23T06:47:00Z (UTC)
- **执行性质**：实际执行完成（已完成代码修复、离线本地测试套件执行与 APK 编译打包），非预定计划。

---

## 2. 变更代码清单（仅限 `android/`）
并行修改保护已核对：未触碰 `desktop/`、`server/`、`packages/` 等任何外部代码，完整保留并行改动。
- `android/app/src/main/java/dev/pibot/android/data/PiBotRepository.kt`：新增 `releasePhoneSessionAsync(deviceId, sessionId)`，在 Repository 全局生命周期的 `NonCancellable + io` 作用域下安全发送释放 RPC。
- `android/app/src/main/java/dev/pibot/android/ui/PhoneControlScreen.kt`：重构租约释放逻辑，将离页（`onDispose`）、退后台（`ON_STOP`）、切设备（`selectDevice`）及迟到接管（late acquire 异常与取消）统一对接 `repository.releasePhoneSessionAsync`；修复切设备清画面与默认只读不 acquire 逻辑。
- `android/app/src/main/java/dev/pibot/android/ui/TimelineScreen.kt`：Bot 聊天右上角挂载手机入口（`CircleAction("手机", onPhone)`）。
- `android/app/src/main/java/dev/pibot/android/ui/AppRoot.kt`：支持 `phone/bot/{botId}` 与 `phone/device/{deviceId}` 导航。
- `android/app/src/main/java/dev/pibot/android/data/PhoneAssociation.kt`：设备关联、多用户 SharedPreferences 隔离及响应校验纯函数。
- `android/app/src/test/java/dev/pibot/android/PhoneControlFlowTest.kt`：新增 5 个专项测试用例，覆盖入口路由、默认只读、切设备清画面、迟到接管释放与离页后台释放。

---

## 3. 发现缺陷与修复记录
- **缺陷表现**：
  原 `PhoneControlScreen` 在 `onDispose` 以及协程 Cancellation 处理中使用 `scope.launch { releaseCurrentLease() }`，该 `scope` 来源于 Compose 局部的 `rememberCoroutineScope()`。在页面导航返回（PopBackStack）或页面销毁时，该 Scope 已处于 Cancelled 状态，导致释放租约的协程无法创建并调度，节点端锁未被主动释放，必须等待 45 秒空闲硬超时。
- **修复方案**：
  在 `PiBotRepository` 中暴露 `releasePhoneSessionAsync`，并在 Android 控制组件卸载与状态迁移中直接调用。由于该 Scope 由 Repository 持有并在 `NonCancellable` 上下文中运行，即便 Compose 视图树已卸载，释放 RPC 请求依然能够可靠送达后端。

---

## 4. 自动化测试证据
全量单元测试执行命令：`./gradlew --offline testDebugUnitTest`  
测试结果：**37 项测试全部通过（0 失败，0 忽略，耗时约 2s）**。

| 测试套件 | 用例数 | 状态 | 覆盖场景 |
| :--- | :---: | :---: | :--- |
| `dev.pibot.android.PhoneControlFlowTest` | 5 | PASS | 聊天入口解析与用户隔离、默认只读不 acquire、切设备清画面与释放、迟到接管（网络迟到/切设备/切后台）释放、离页 onDispose 与后台 ON_STOP 释放 |
| `dev.pibot.android.PhoneAssociationTest` | 6 | PASS | 设备唯一选择、解析容错、用户命名空间隔离、时间戳解析、会话校验防御、迟到 Token 守卫 |
| `dev.pibot.android.RepositoryTest` | 9 | PASS | 包含 `phoneRpcCallsDeviceEndpointWithStrictBearerAuth`（status/acquire/input/preview 端点与鉴权）及基线 API |
| `dev.pibot.android.PiBotFaceTest` | 7 | PASS | 渲染与动画帧一致性 |
| `dev.pibot.android.DomainTest` | 9 | PASS | 消息流、会话合并与领域模型一致性 |
| `dev.pibot.android.ui.A2uiAssetsTest` | 1 | PASS | 静态资产约束校验 |

---

## 5. APK 构建产物信息
构建命令：`./gradlew --offline assembleDebug`
- **产物文件路径**：`/home/zhaotao/pi-bot/bot/PI-BOT/android/app/build/outputs/apk/debug/app-debug.apk`
- **文件大小**：`14,947,166` 字节 (~14.25 MB)
- **SHA-256 哈希值**：`1cd37e403b05baec811192b2648eb83ecf4d13c8cfacc9f3d63c1281ce5dff7e`
- **构建完成时间**：`2026-10-23 14:47:00 CST`

---

## 6. 环境限制与未覆盖项说明
1. **测试运行限制**：
   - 当前宿主为 Linux Headless / 无外接 GUI 桌面环境，且无网络下载外源大型 Robolectric 运行时环境；
   - 本次测试完全基于已缓存 SDK 与工程自带离线测试依赖（JUnit4 + OkHttp MockWebServer + Coroutines Test），通过状态转移仿真与 HTTP 契约断言完成了对 UI 控制流与释放机制的严格验证。
2. **安全红线遵从说明**：
   - **未连接**任何真实 Android 手机或验证用 AVD；
   - **未读取**真实屏幕画面流；
   - **未向**系统或 ADB 注入硬件触控或按键事件；
   - **未绕过**节点文件锁与租约互斥机制；
   - **未发布**或将 APK 安装至用户实体手机；
   - **未重启**中心服务、系统守护进程（`pi-bot.service`）或节点，未覆盖对外下载入口。
