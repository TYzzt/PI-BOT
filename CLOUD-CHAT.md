# Pi 云端问答

云端问答由 Node.js Worker 调度隔离 Pi Runner。Mac 和云端复用 `packages/agent` 的模型适配、会话、流式事件和 Skills/MCP 加载代码，各自在自己的宿主运行。Mac 问答、项目工具、终端与浏览器仍由本机 harness 执行；云端 Runner 使用自己的工作区。

## 运行边界

- API 负责认证、共享文档、任务、审批和消息契约。
- Worker 领取队列、解密指定模型密钥、续租、写流式快照和终态。
- Runner 接收单次任务需要的模型密钥，运行 Pi、文件工具、shell、可选 Tavily `web_search` 与配置的插件。Runner 没有数据库和 vault 访问权。
- 云端工作区按会话隔离保存在 Runner 持久卷，文件工具拒绝绝对路径、越界和符号链接。shell 由容器限制权限和资源；一个 Runner 当前串行执行，增加 Worker 不会增加其执行并发。
- “转到云端继续”创建新云端会话，复制已共享历史中最近最多 40 条、60000 字。Mac 原会话和本机目录不受影响。

## 部署

见 [server/README.md](server/README.md)。API/Worker 使用相同 vault 文件，Runner 只配置独立 `T_AGNET_RUNNER_TOKEN` 和数据目录。Worker 与 Runner token 必须一致且至少 32 字符。可选 `T_AGNET_TAVILY_API_KEY` 在 Worker 配置；未配置时不注册搜索工具。

Runner 内部端口 8001 不公开。Compose 提供非 root、只读根目录、资源限制和独立 volume；Kubernetes 示例在 `server/deploy/tagent.yaml`。执行外部 MCP 或 shell 的权限以 Runner 容器为边界。

## 生命周期

发送和取消继续使用 `/conversations/{id}/messages`、`/chat-runs/{id}/cancel`。Worker 领取时原子写用户消息、助手消息和租约；累计文本每秒最多落库一次。取消保留已生成文本，排队任务直接取消，运行任务在续租或快照时中止。

Worker 崩溃后，过期租约标为 `interrupted`，不自动重放工具执行。Pi 会话按会话 ID 和代次存储，正常完成继续原会话；取消、失败和中断递增代次，下次从共享消息重建。旧 LangGraph checkpoint 表保留，旧消息仍可作为 Pi 上下文，不再依赖 Python/LangGraph。

模型/MCP secret 在持久会话和文本输出中脱敏，固定错误文案不含供应商错误。插件状态按配置版本回报，可在配置界面查看。配置与 secret 部署见 [CONFIGS.md](CONFIGS.md)。

## 验证

```sh
npm test
T_AGNET_TEST_FILE=tests/cloud-chat-e2e.test.ts node --import tsx server/scripts/check-shared.ts
```

测试使用本地模型协议模拟端点验证 Pi 多轮历史、取消和密钥隔离；桌面端联调覆盖共享会话交接。真实模型、联网搜索及生产容器部署需要对应环境提供服务与凭据。
