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
