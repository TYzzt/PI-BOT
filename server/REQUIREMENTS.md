# T-AGNET 云端需求

定位：共享状态与任务控制服务，加上独立 DeepAgents 云端问答 Worker。

## 完整架构

请先阅读本目录的 [ARCHITECTURE.md](ARCHITECTURE.md)。三个端均保存同一份完整架构，本文补充云端职责与实施清单。

## 技术栈

- Python + FastAPI：认证、REST API、WebSocket 与设备连接。
- DeepAgents / LangGraph：独立云端问答 Worker。
- PostgreSQL：共享消息、任务、审批、配置版本、事件与持久队列。
- LangGraph PostgreSQL checkpoint：云端 agent 执行状态。
- 本地 Docker Compose 启动 API 与 PostgreSQL。正式部署到 Kubernetes，入口和 HTTPS 由 Ingress 承担。
- OpenAPI + JSON Schema：三端接口契约。

## 职责

1. 保存共享聊天、项目元数据、Plan、审批、执行状态投影和共享配置。
2. 认证用户和设备，接受 Mac 主动连接并持久化派发命令。
3. 将本地编程请求直接路由到 Mac，不要求 DeepAgents 再规划。
4. 运行 DeepAgents 承接云端问答和已配置云端工具。
5. 对 Android 与 Mac 提供一致的事件回放和配置同步。

## 功能清单

### 用户、设备、项目

- 首版单用户；保留 device_id，支持一次性配对、设备凭据、撤销与重配。
- 维护设备在线状态与最后同步时间，设备状态与任务状态分开。
- 保存 project_id、display_name、device_id 与可用状态；不保存代码目录内容。
- Mac 离线时接受任务并进入 waiting_for_device，支持取消与命令过期。

### 任务与审批

- REST 创建任务仅入队，不能在请求连接生命周期内执行长任务。
- 使用幂等键，事务内写任务/命令/事件，然后投递给设备。
- Plan 不可变版本存储，审批绑定 hash、版本、设备、项目、配置快照和有效期。
- 记录批准、拒绝、修改请求、取消及输入；设备端再次核验后执行。
- 云端不凭超时把本地任务改成失败，不在 Mac 上失联时自动重试执行。
- 云端不把“消息已投递”当成“执行已完成”。

### 聊天与执行位置

- conversation_id 是共享主键，run 固定 harness 与执行位置。
- 云端问答由 DeepAgents Worker 运行，可加载云端模型、共享 skills 与可用 cloud MCP。
- 本地代码问题派给 Pi；DeepAgents 默认不能读取本地私有代码。
- 切换执行端仅共享可分享历史和 handoff 摘要，不搬运 Pi 内部会话。
- 云端 checkpoint 恢复必须核对工具副作用，不能盲目重放外部动作。

### 同步和存储

- 持久化共享 Message/Task/Run/Plan/Approval/ConfigRevision/Command/Event。
- event_id 去重，server_cursor 增量回放，producer_seq 检测来源事件缺口。
- WSS 用于实时通知；REST 提供快照与 cursor 补拉，关键命令先持久化。
- 保存本地执行事件投影，权威执行事实来自 Mac；不能由 UI 直接宣告完成。
- 保存共享 skill 包的内容与 hash；local_only skill 只保存可分享元数据。
- 模型/MCP 配置采用版本和 expected_version 乐观锁；删除用 tombstone。
- 共享模板与各环境绑定、秘密分离；Mac 路径不自动在 Linux 执行。
- 记录 desired_version 与设备 applied_version，展示应用失败状态。
- 源码、diff、Pi JSONL、浏览器 cookie、原始终端输出默认不接收入库。

### 安全与运行

- HTTPS/WSS、认证、设备撤销、命令完整性、授权校验；服务端是可信边界，不宣称端到端加密。
- 云端 API 不提供任意 Mac shell 入口，设备任务受审批与执行策略控制。
- 云端模型/MCP 密钥仅在运行服务中保存，不返回客户端明文。
- 独立 API 与 Worker 进程；数据库备份、日志脱敏、运行耗时/用量/错误记录。
- 推送只做可选通知加速，事件数据库与客户端补拉才是可靠依据。

## 接口分组

- /devices：配对、撤销、在线状态；/projects：元数据目录。
- /conversations、/messages：共享历史与消息发送。
- /tasks、/runs：创建、详情、取消与补充输入。
- /plans、/approvals：版本读取、修改意见、批准并执行、拒绝。
- /configs：模型、Skills、MCP 版本与包内容。
- /events：cursor 增量回放；WebSocket：设备命令与客户端事件。

路径为设计建议，开发时在 OpenAPI 中固定。字段和事件名称遵循整体架构，不直接暴露 harness 的原生对象。

## 首批开发任务

1. 固定协议与数据库迁移，完成认证、设备配对和项目目录。
2. 完成持久任务队列、版本审批、设备投递与幂等执行记录。
3. 完成共享消息、事件回放和状态投影。
4. 接入 DeepAgents Worker、checkpoint 与云端问答。
5. 配置/skill 包同步（已实现，见 ../CONFIGS.md）、故障恢复、备份和可选推送。

## 重点验收

- 手机重复发送不会创建重复执行；旧计划或过期批准不能执行。
- Mac 离线时问答正常、本地任务等待；恢复后正确投递。
- 事件重复到达不重复显示，断线后 cursor 回放完整。
- 配置冲突被明确返回，运行中的配置不被静默替换。
- 服务端存储与日志中没有默认禁止上传的本地代码和秘密。
