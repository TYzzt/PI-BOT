# Android FCM 通知：统一 APK，Server 分发配置

Android 使用 Google FCM 接收 Bot 最终回复（含失败结果）、任务公开回报、目标进展和待审批。正在查看的会话不弹通知，其他会话正常提醒；点击进入 Bot 会话并拉取最新状态。前台 WebSocket 保持原有行为。

**部署者只配置 Server，用户安装同一个 APK、登录并允许通知即可。Android 工程不需要放入 `google-services.json`，也不使用 Google Services Gradle 插件。** 各自部署可以使用各自的 Firebase 项目，不需要项目方运营统一推送网关。互相信任的两个 Server 也可以使用同一项目，建议分别创建发送服务账号，以便独立撤销权限。

FCM 推送本身免费，不要求 Firebase 付费套餐。接收依赖 Google Play 服务和能连接 Google 的网络，本次不包含国内厂商通道；中国大陆网络环境不保证可达。系统强行停止、关闭通知权限和长期离线会影响提醒，聊天记录以服务端为准。

## 1. 创建 Firebase 项目，下载两份 JSON

1. 在 [Firebase 控制台](https://console.firebase.google.com/) 创建项目，Google Analytics 可不启用。
2. 添加 Android 应用，包名填写 **`dev.pibot.android`**；FCM 本身不要求 SHA 指纹。如果为客户端 API Key 增加 Android 应用限制，需要登记实际发行 APK 的签名指纹，并允许 Firebase Installations 等必要 API。
3. 下载 Android 应用的 **`google-services.json`**，保存到 **Server 宿主机**，例如 `/opt/pibot/.local/google-services.json`。这是 Android 的公共项目配置，不是发送密钥，不放进 Android 工程。Server 会按包名选取配置并验证项目 ID、Sender ID、应用 ID 和 API Key。
4. 在项目设置的 Cloud Messaging 中确认 **Firebase Cloud Messaging API (V1)** 已启用；使用 HTTP v1，不使用旧 server key。
5. 创建发送服务账号，授予目标项目 FCM 发送权限，例如 `roles/firebasecloudmessaging.admin`，生成服务账号 JSON，保存为 `/opt/pibot/.local/firebase-service-account.json`。**这份含私钥的文件始终留在 API 服务端，不发给手机、不放进 APK、镜像或仓库。**

参考：[Android 接入](https://firebase.google.com/docs/cloud-messaging/android/client)、[HTTP v1 授权](https://firebase.google.com/docs/cloud-messaging/auth-server)。

## 2. 配置 Server

API 和 Worker 都设置项目 ID，以便业务事务生成待发通知。只有 API 需要两份 JSON、Google 网络和发送权限，Worker 不需要读取文件。

直接运行 Node 时，API 环境变量：

```dotenv
PI_BOT_FCM_PROJECT_ID=your-firebase-project-id
PI_BOT_FCM_ANDROID_CONFIG_FILE=/opt/pibot/.local/google-services.json
GOOGLE_APPLICATION_CREDENTIALS=/opt/pibot/.local/firebase-service-account.json
```

Worker 设置同一个 `PI_BOT_FCM_PROJECT_ID`。API 启动时读取并校验两份文件；Android 配置中的项目 ID 必须匹配该变量，包名必须匹配 `dev.pibot.android`。配置修改后重启 API；项目 ID 修改时也更新并重启 Worker。实际发送权限和网络需通过送达验收验证。

未配置项目 ID 时不发送、不积压新通知，配置接口返回关闭状态。显式启用但文件缺失、格式损坏或 Android 项目/包名不匹配时，API 启动报错。升级自动执行 `0017-push` 迁移。

### Docker Compose

在 `server/.env` 中增加以下三项；这里两份文件的路径都是**宿主机绝对路径**：

```dotenv
PI_BOT_FCM_PROJECT_ID=your-firebase-project-id
PI_BOT_FCM_ANDROID_CONFIG_FILE=/opt/pibot/.local/google-services.json
PI_BOT_FCM_CREDENTIALS_FILE=/opt/pibot/.local/firebase-service-account.json
```

在仓库根目录启动：

```sh
docker compose --env-file server/.env \
  -f server/docker-compose.yml \
  -f server/deploy/fcm.compose.example.yml up -d --build
```

覆盖文件只向 API 只读挂载两个文件，并自动设置容器内的 `PI_BOT_FCM_ANDROID_CONFIG_FILE` 和 `GOOGLE_APPLICATION_CREDENTIALS`；不用手动填写容器路径。Worker 只接收项目 ID。Ubuntu 部署把第一个 `-f` 换成 `server/deploy/ubuntu/compose.yml`，并使用该部署的 env 文件。普通 Compose 启动不要求 Firebase 文件。

## 3. Android 使用与配置更新

- 安装统一发布的 APK，填写自己的 Server 地址并登录。App 请求经过用户认证的 `GET /push/config`，取得公共字段，缓存并使用 `FirebaseOptions` 初始化默认 FirebaseApp，然后注册 Token。权限说明在成功获得启用配置后显示；拒绝权限不影响聊天。
- 缓存绑定 Server 地址、用户和本次登录标识；普通进程回收后，`Application.onCreate` 在 MessagingService 回调前恢复配置，不依赖启动时联网取配置。退出立即清除缓存和旧账号通知，并禁止旧绑定注册。
- 首次启用和同一配置的 Server 切换不需要重启。**切换到不同 Firebase 项目、应用 ID、Sender ID 或 API Key 时，App 保存新配置，停止旧配置的注册并提示“重新启动应用”。** 点击后重新建立主进程，使用缓存的新配置初始化及注册；也可稍后在设置页操作。重启会中断当前 App 中的操作，请先保存尚未提交的输入并结束本机语音通话。
- SDK 默认 FirebaseApp 每个进程只初始化一次，不直接热删除或替换；重启前聊天仍可用，当前新项目的推送尚未注册。若切回当前进程已初始化的配置，可直接恢复。
- 前台恢复、Token 更新和注册重试时重新读取配置，部署者更新 Server 后不需要重新打包 APK。旧 Server 没有 `/push/config` 时按不支持推送处理，聊天兼容。
- 设置页展示推送状态、系统通知设置入口，以及需要时的重启入口。手机无需接触服务账号私钥。

## 接口与发送行为

`GET /push/config` 使用用户 Bearer，设置 `Cache-Control: no-store`，启用时只返回以下白名单字段，不返回原始文件、OAuth 信息、服务账号、私钥或凭据路径：

```json
{
  "enabled": true,
  "firebase": {
    "project_id": "your-firebase-project-id",
    "application_id": "1:123456789:android:0123456789abcdef",
    "sender_id": "123456789",
    "api_key": "<google-services.json 中的 Android API Key>",
    "package_name": "dev.pibot.android"
  }
}
```

未启用时返回 `{ "enabled": false, "firebase": null }`。公共 API Key 是 Firebase 客户端标识，不能用于向设备发送推送。

- `PUT /push/installations/:id` 使用用户 Bearer，正文为 `{ "fcm_token": "...", "binding_id": "UUID", "firebase_project_id": "your-firebase-project-id" }`，返回 `{ "ok": true, "enabled": true }`。有效期来自认证 JWT；项目不匹配返回 409，客户端重新读取配置。
- `DELETE /push/installations/:id?binding_id=UUID` 只删除当前用户且标识匹配的绑定，幂等返回 `{ "ok": true }`。迟到的注销不会删除新登录。
- 高优先级 data 消息包含 `event_id`、`kind`、`user_id`、`binding_id`、`bot_id`、`message_id` 或 `approval_id`、`title`、`body`、`expires_at`，不含认证凭据。摘要最多 120 个 Unicode 字符，审批只发送原因，不发送独立文件路径字段。摘要经由 Google，锁屏遵循系统隐私设置。
- 仅公开助手回复终结和待审批入队。内部任务、静默检查、流式片段、取消和语音纪要不推送；任务和目标通过公开回报触发。纯交互回复使用通用提示。
- 队列与业务事务一起提交，API 重启后恢复发送。普通消息有效期 24 小时，审批受自身到期时间限制；临时失败退避，永久错误停止，失效 Token 停用。服务端按事件/安装去重，客户端另有持久去重，不承诺 FCM 实际送达。
- 退出后即使网络不通、旧 Server 暂未注销，旧账号的迟到消息也会被客户端过滤。FCM 控制台标准通知测试无法验证这条 data 消息链路，请触发真实业务。

## 验证与升级

```sh
# 指向可清空的独立 PostgreSQL 测试库：
PI_BOT_TEST_DATABASE_URL=postgresql://... node --import tsx --test --test-concurrency=1 server/tests/push.test.ts
cd android
./gradlew :app:testDebugUnitTest :app:assembleDebug
```

API、Worker、Android 一起升级。旧版在 APK 中固定 Firebase 配置的客户端不再适用于此分发方式；升级为统一 APK 后首次登录/前台恢复会获取配置。缓存损坏或获取失败时可重试，聊天不受影响。

真机验收需带 Google Play 服务的设备：验证普通回复、任务、目标和审批；前台当前会话免打扰、其他会话提醒；后台、锁屏、普通进程回收后接收；冷/热启动跳转；权限拒绝、退出、换号；两个 Server 使用相同和不同 Firebase 项目时的切换与重启；Server 配置更新后的重新注册；过期审批过滤。未提供真实凭据和设备时，自动化测试不代表真实送达、跨项目切换或重启 UI 已通过真机验收。系统“强行停止”后的接收不作为保证条件。
