# Pi Bot A2UI

Mac 和 Android 共用的 A2UI v0.9 协议、目录、计算函数和渲染器。官方库固定为 `@a2ui/react` / `@a2ui/web_core` 0.13.0。

- 官方基础目录：Text、Button、TextField、Row、Column、List、Image、Icon、Video、AudioPlayer、Card、Divider、CheckBox、Slider、DateTimeInput、ChoicePicker、Tabs、Modal。
- 注册扩展：Grid（响应式布局 / 列表模板）、Metric、Chart（环形 / 柱状 / 折线）、DataTable。
- 注册函数：calculate（受限算术，无 eval）、numberValue、displayNumber，以及官方校验 / 格式化 / 布尔函数。openUrl 不开放，媒体使用内联 data: 资源。
- `get_ui_catalog` 返回准确目录和单个组件 / 函数 schema，不提供预置界面。
- `show_ui` 接收必填的协议消息数组，模型按用户当前需求组合受支持组件。普通问答和解释默认使用文字，已有界面的追问不重复创建界面。

界面保存为消息上的有界快照。每条回复最多 4 个 surface、每个 200 个定义、展开后最多 1500 个节点，数据列表最多 100 项。数据模型按版本保存；并发编辑返回 409，不覆盖其他设备的输入。提交操作使用 request_id 去重，Server 验证已发布按钮并从当前状态重新计算操作参数。表单校验在客户端和 Server 都执行。按钮使用绝对路径绑定；相对路径可用于列表内容，但动作参数请使用绝对路径。

聊天只显示可读的操作描述。完整交互输入单独存储，仅在构造 Agent 上下文时注入。界面提交不直接执行文件或系统操作，继续通过原有任务和审批流程。

Mac 使用 `UiView`；Android 在隔离 WebView 中加载 APK 内的固定渲染器，桥接仅支持状态保存和交互提交，不暴露账号 token、文件或通用原生接口，不加载外部页面。

## 构建与检查

需要仓库指定的 Node.js 24。

```sh
npm run a2ui:build
npm run typecheck
npm test
(cd android && ./gradlew :app:testDebugUnitTest :app:assembleDebug)
```

Android Gradle 会自动构建并复制 Web 渲染器。Mac 打包和 Server 构建包含共享协议与正确的运行时依赖。

正式 Mac 时间线的浏览器验证入口（本地服务测试替身，不连接真实账号）：

```sh
node_modules/.bin/vite --host 127.0.0.1 --port 5188
# http://127.0.0.1:5188/desktop/tests/a2ui-browser/index.html
```

## 升级

Server 启动时应用 `0006-message-ui` 迁移，为 `bot_messages` 添加 `ui`、`ui_action`；API、Worker、Runner 和客户端需一起更新。旧消息保持原样。新客户端能在 Mac 在线和离线时使用交互工具。
