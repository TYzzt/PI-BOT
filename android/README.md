# Pi Bot Android

手机上的 Pi Bot：看 Bot 们在干什么、发消息、批准访问请求、浏览 Mac 上的资料库、新建和编辑 Bot。整体设计见 [ARCHITECTURE.md](ARCHITECTURE.md)，需求与验收见 [REQUIREMENTS.md](REQUIREMENTS.md)。

## 构建

需要 JDK 17 和 Android SDK（compileSdk 37）。在 `android/local.properties` 写 `sdk.dir=/path/to/android-sdk`，然后：

```sh
cd android
./gradlew :app:testDebugUnitTest   # 单元测试
./gradlew :app:assembleDebug       # app/build/outputs/apk/debug/app-debug.apk
```

构建会把 `packages/bot-face/spec.json` 复制进 APK 的 `assets/bot-face/`，角色规格只维护那一份。

## 使用

1. 登录页的服务器地址默认是 `https://aicloud-app.lenovo.com.cn/pibot`。账号由管理员在后台创建。
2. 首页是 Bot 网格，点进去是这个 Bot 的时间线；右上角「资料库」在 Mac 在线时可用。
3. 有审批时 Bot 卡片出现红点，时间线最下方出现审批卡片。

调试本地服务器：debug 构建允许 HTTP 连接本机、模拟器（`http://10.0.2.2:8000`）和局域网地址；release 只允许 HTTPS。

A2UI 交互工具显示在 Bot 回复中；输入会保存，提交后进入正常任务流程。构建会自动打包 `packages/a2ui` 的 Web 渲染器，需要先在仓库根目录运行 `npm ci`；桥接仅处理交互事件，不在页面中提供账号凭据。

异步任务模式：对话持续接话，每个 Bot 最多并行执行两个后台任务，其余排队；用聊天查询进度、补充要求或取消，结果完成后另发。两端需与 API、Worker、Runner 同步升级，服务端自动应用 `0007-async-tasks`；升级前结束旧运行。详情见 [整体架构](ARCHITECTURE.md)。


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
