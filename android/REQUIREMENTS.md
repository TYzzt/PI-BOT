# Pi Bot Android 需求与验收

整体架构见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 定位

手机是随身的 Bot 遥控器：看 Bot 们在干什么、给 Bot 发消息、批准访问请求、浏览 Mac 上的资料库、新建和编辑 Bot。手机本身不运行 agent，不配置模型，也没有本地数据库。

## 技术栈

- Kotlin 2.3、Jetpack Compose（Material 3）、Navigation Compose，minSdk 26。
- OkHttp 5（REST + 前台 WebSocket）、kotlinx.serialization、Coroutines/StateFlow。
- EncryptedSharedPreferences 保存会话。
- 角色：`face/` 是 `packages/bot-face` 的 Compose Canvas 移植，`spec.json` 在构建时复制进 assets。

## 功能需求

| 编号 | 需求 | 验收 |
|---|---|---|
| A1 | 用服务器地址 + 管理员创建的账号登录 | 地址可带路径前缀（如 `/pibot`）；release 只允许 HTTPS；错误密码、连不上服务器有中文提示 |
| A2 | Bot 网格：角色动画、名字、状态一句话、待审批红点、Mac 在线状态 | 运行中显示「工作中…」（云端运行为「在云端思考…」），等审批显示「等你批准…」，失败显示「出错了」，空闲时显示最近一条消息的首行，3 天以上无活动显示「睡着了 · N 天」；下拉刷新；Mac 离线时顶部提示消息会在云端回复 |
| A3 | 新建 / 编辑 / 归档 Bot：名字、人设、模型、造型、颜色、深浅色 | 预览实时变化，可「随机换一个」；模型可选「跟随默认」；归档前二次确认 |
| A4 | 时间线：一条连续的对话，流式回复、Markdown（标题、列表、引用、代码、表格）、工具记录 | 回复逐字出现；滚到顶部加载更早消息；运行中可停止 |
| A5 | 审批卡片 | 显示 Bot 想访问的路径和理由；批准或拒绝后卡片消失、运行继续 |
| A6 | 资料库浏览（Mac 在线时） | 逐级进入目录、返回上一级；文本和 Markdown 预览、图片预览；Mac 离线时提示不可用 |
| A7 | 设置：账号、服务器、实时连接状态、Mac 设备与在线状态、修改密码、退出登录 | 新密码至少 8 位；退出后回到登录页 |
| A8 | 实时更新 | 前台时保持 WebSocket，断线退避重连并补拉；后台时断开；会话失效自动回到登录页 |

## 非功能需求

- 令牌只存在加密存储里；不保存密码。
- 界面中文，固定浅色主题；系统关闭动画（动画时长缩放为 0）时角色保持静止。
- 不依赖 Google Play 服务。

## 自动化测试

`./gradlew :app:testDebugUnitTest`：

- `PiBotFaceTest`：规格列表、Mulberry32、`avatarFor`、轮廓平滑、引擎逐帧数值与 TypeScript 参考值一致、减少动态效果、运行状态到表情的映射。
- `DomainTest`：时间线合并与 `delta`、运行中工具、状态一句话（含去掉 Markdown 标记）、服务器地址解析、Markdown 块与行内解析。
- `RepositoryTest`（MockWebServer）：登录与路径前缀、错误信息、Bot/消息/发送/流式合并/分页、编辑时总是带上 `model_id`、资料库路径编码与 503 提示、401 自动登出。
