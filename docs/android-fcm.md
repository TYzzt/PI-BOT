# Android FCM 通知

Android 使用 Google FCM 接收 Bot 最终回复（含失败结果）、任务公开回报、目标进展和待审批。正在查看的会话不弹通知，其他会话正常提醒。前台 WebSocket 保持原有行为；通知点击进入 Bot 会话并重新加载服务端状态，不直接执行审批。

FCM 推送本身免费，不需要为推送开通 Firebase 付费套餐。普通 Android FCM 需要 Google Play 服务和能连接 Google 的网络，不包含国内厂商通道，在中国大陆网络环境不保证可达。强行停止 App、关闭通知权限、设备长期离线都会影响提醒；会话记录仍以服务端为准。

## 创建 Firebase 项目

1. 在 [Firebase 控制台](https://console.firebase.google.com/) 创建项目；Google Analytics 可不启用。
2. 添加 Android 应用，包名填写 **`dev.pibot.android`**。单纯接收 FCM 不要求填写 SHA 指纹。
3. 下载 `google-services.json`，保存到 `android/app/google-services.json`。配置已被 Git 忽略；缺少文件的安装包仍正常构建和聊天，但不启用推送。放入或更新后重新构建 APK。
4. 在项目设置的 Cloud Messaging 中确认 **Firebase Cloud Messaging API (V1)** 已启用。使用 HTTP v1，不使用旧版 server key。
5. 在服务账号页面生成仅供服务端使用的 JSON 私钥。运行账号需有目标项目的 FCM 发送权限，例如 `roles/firebasecloudmessaging.admin`。文件保存在仓库外或被忽略的 `.local/` 中，不放进 Android 工程或镜像。

参考：[Android 接入](https://firebase.google.com/docs/cloud-messaging/android/client)、[HTTP v1 授权](https://firebase.google.com/docs/cloud-messaging/auth-server)。

## 服务端

API 和 Worker 都设置 `PI_BOT_FCM_PROJECT_ID`，以便在业务事务内生成推送。仅 API 进程需要服务账号凭据、Google 网络访问和发送权限：

```dotenv
PI_BOT_FCM_PROJECT_ID=your-firebase-project-id
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/.local/firebase-service-account.json
```

API 启动时校验凭据文件可读且结构、私钥可解析；实际项目权限和网络通过真实发送验证。未配置项目 ID 时不发送、不积压新通知；显式配置项目 ID 但缺失或损坏凭据时启动报错。升级 API、Worker 后自动应用 `0017-push` 迁移。

本地 Docker Compose 可使用可选覆盖文件，命令在仓库根目录运行：

```sh
# 在 server/.env 中设置 PI_BOT_FCM_PROJECT_ID 和绝对宿主机密钥路径：
# PI_BOT_FCM_CREDENTIALS_FILE=/absolute/path/to/.local/firebase-service-account.json
docker compose --env-file server/.env -f server/docker-compose.yml -f server/deploy/fcm.compose.example.yml up -d --build
```

Ubuntu 部署将第一个 `-f` 换为 `server/deploy/ubuntu/compose.yml`，并使用该部署的 env 文件。覆盖文件只向 API 只读挂载密钥，Worker 只需要项目 ID。普通 `docker compose up` 不要求密钥文件。

## 行为与接口

- 登录后说明通知用途并申请权限，拒绝不影响聊天；设置页可查看状态并打开系统通知设置。
- 每部手机有安装 UUID，每次登录有新绑定标识。Token 更新、恢复登录和前台恢复会重新注册，网络失败由 WorkManager 重试。会话到期后停止推送，需要重新登录。
- `PUT /push/installations/:id` 使用用户 Bearer，正文为 `{ "fcm_token": "...", "binding_id": "UUID" }`，返回 `{ "ok": true, "enabled": true }`。有效期来自已认证 JWT，不接受客户端自报。
- `DELETE /push/installations/:id?binding_id=UUID` 只删除当前用户且标识匹配的绑定，幂等返回 `{ "ok": true }`。迟到的注销不会删除新登录。
- 高优先级 data 消息包含 `event_id`、`kind`、`user_id`、`binding_id`、`bot_id`、`message_id` 或 `approval_id`、`title`、`body`、`expires_at`。所有值为字符串，不含认证凭据；摘要最多 120 个 Unicode 字符，审批只发送原因，不发送独立的文件路径字段。摘要会经由 Google，锁屏遵循系统隐私设置。
- 公开助手回复终结时入队。内部任务、静默检查、流式片段、取消和语音纪要不推送，任务结果和目标进展通过公开回报触发一次。纯交互回复使用通用提示。
- 数据库队列与业务事务一起提交，API 重启会恢复发送；普通消息 24 小时过期，审批受自身到期时间限制。临时失败指数退避重试，永久错误停止，失效 Token 停用。队列按事件/安装去重，客户端另有持久去重记录，不承诺 FCM 实际送达。
- 退出立即过滤旧绑定并清除业务通知，服务端注销尽力执行。断网退出后即使服务端暂未注销，客户端也不显示旧消息。
- FCM 控制台的标准通知测试不能验证这条 data 消息链路，请使用真实业务触发。

## 验证

```sh
node --import tsx --test server/tests/push.test.ts
# 指向可清空的独立 PostgreSQL 测试库，运行注册、事务、队列、重试和隔离测试：
PI_BOT_TEST_DATABASE_URL=postgresql://... node --import tsx --test --test-concurrency=1 server/tests/push.test.ts
cd android
./gradlew :app:testDebugUnitTest :app:assembleDebug
```

用同一项目配置的 API、Worker 和带 Google Play 服务的真机验证：正常回复、任务结果、目标进展及审批；前台当前会话不弹、其他会话弹；后台和普通进程回收后接收；冷启动及热启动点击进入正确会话；查看会话后通知清除；关闭权限、退出、切换用户或服务器后不显示旧通知；过期审批不提醒。最后检查服务账号权限、到达延迟及重复情况。未提供真实 Firebase 配置时，自动化测试不代表真实 FCM 送达已通过。
