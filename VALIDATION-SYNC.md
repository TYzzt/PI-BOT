# 聊天、模型同步与远程续聊验收记录

验收日期：2026-09-26（Asia/Shanghai）。本次交付为源码、数据库迁移、桌面界面、冻结 OpenAPI、独立客户端和部署说明；未更新用户正在运行的正式云端或桌面进程。

## 已实现

- 配对后的新会话默认共享，旧会话手动批量共享；Ask、只读代码问答以及编程对话的用户消息和助手正文同步。
- SQLite 消息写入事务同步递增修订号，云端拒绝旧版本及终态回退；共享开关、历史导入、tombstone 删除、cursor 补齐。
- 远程会话/问题由固定 Mac 执行；同会话忙碌拒绝、跨会话排队、稳定消息 ID、事务化运行映射、取消、重启中断及未开始队列恢复。
- 所有模型自动同步，版本冲突需显式选择，空闲后应用；API Key 云端 AES-256-GCM 加密，Mac Keychain 保存，独立主密钥文件和轮换脚本。
- 配置引用替换、云端删除回执、已同步模型联网删除；云端计划包含未回答问题时不能批准，拒绝/取消状态重连对账；修复 WebSocket 测试清理异常。
- 三端架构文档、SYNC.md、独立 REST 客户端及隔离联调启动器。

## 自动化验证

| 命令/测试 | 结果 | 覆盖重点 |
|---|---|---|
| desktop `npm run typecheck` | 通过 | 桌面、共享协议、服务、测试类型 |
| desktop `npm run build` | 通过 | Electron/preload、本地服务、中文 UI |
| desktop `npm test` | 18 通过，4 按环境跳过 | Pi 实际 SDK、工具隔离、SQLite 迁移、幂等运行映射、旧聊天/编程回归 |
| server `uv run pytest -q` | 31 通过 | 配置密文/版本/归属、凭据下载、轮换与篡改、共享消息、取消、审批与 WebSocket |
| server `uv run python scripts/check_shared.py` | 通过 | 真实 HTTP + PostgreSQL + Pi SDK，可控模型端点，离线队列、冲突、模型双向删除、只读代码、流式取消与历史恢复 |
| desktop `npm run test:ui` | 3 通过，1 按环境跳过 | 原有 Electron Ask、项目与编程流程 |
| `T_AGNET_TEST_FILE=tests/shared-desktop.spec.ts uv run python scripts/check_shared.py` | 通过 | 真实 Electron + Keychain：配对、模型应用状态、历史共享、新会话仅本机、解除配对 |
| `T_AGNET_TEST_FILE=tests/cloud-e2e.test.ts uv run python scripts/check_shared.py` | 通过 | 既有远程计划/审批/执行、离线回放、取消、重启回归 |
| `git diff --check` | 通过 | 补丁格式 |

常规测试跳过的云端联调、共享联调和真实模型验收已分别执行。Keychain 单项 CRUD 测试未在这次普通测试命令中启用；共享 UI 和真实模型测试均实际调用 Keychain 保存、读取、更新和清理临时凭据。服务端仍有 Starlette 关于 httpx TestClient 的弃用提示，不影响本次测试结果。

## 真实模型与 Keychain

命令：`T_AGNET_REAL_SYNC=1 uv run python scripts/check_shared.py`。

- 模型：用户已有配置 `qwen38-27b`。测试复制配置到独立模型 UUID，输出上限设为 4096；未修改用户原始模型配置或凭据。
- 时间：2026-09-26 05:48:24–05:49:03（Asia/Shanghai）；约 39.8 秒。
- 使用真实 Pi SDK、用户兼容端点和 macOS Keychain；云端使用隔离 PostgreSQL 容器与真实 FastAPI HTTP 进程，地址为 loopback。不是模拟云端，但也不代表正式公网部署已验收。
- 本地历史共享后，独立 JWT 客户端远程提问可以回答之前的口令，确认沿用原 Mac 上下文。
- 从云端修改配置与凭据，确认写回 Mac Keychain。
- 停止 Mac 云连接，在云端排队问题、本地继续聊天；服务重启后先同步本机历史，再执行排队问题，随后继续远程追问。
- 观察到生成中非空正文快照（43 字符），再取消并确认终态与部分回答均保留。
- 在独立 Git 测试项目中，通过远程只读会话让真实模型调用 `read_file`，返回随机文件标识符；没有生成计划，没有写入工具，文件内容未变化。

报告：`desktop/work/shared-real-report.json`。不含 API Key 或完整对话；临时数据库、模型 Keychain 条目与设备私钥已清理。

另一次长计数请求在 90 秒内未观察到正文增量，验收失败；诊断报告保存在 `desktop/work/shared-real-stream-timeout.json`。随后改用约 2000 字的故事请求及有限输出上限，通过流式与取消验收。不能据此承诺所有模型端点的首字延迟；这次失败没有被计入通过结果。

## 部署边界和后续验证

- 本次未配置或部署正式云端的加密主密钥，也未对正式 HTTPS/WSS 地址执行整套验收。按 SYNC.md 部署后应再验证反向代理、TLS、密钥挂载与正式设备配对。
- 共享请求当前每秒轮询设备快照，WSS 用于现有任务投递和用户变更通知；没有后台常驻或安装包。（本次验收时尚无 Android 应用和 DeepAgents；两者已在后续阶段交付，DeepAgents 验收见 CLOUD-CHAT.md。）
- 新增配置只绑定一个来源 Mac；多设备密钥分发管理界面尚未实现。
- 共享会话全端删除和已同步模型删除需要联网；断线时可继续本地问答和编辑模型，冲突恢复后显式处理。
- 未做大规模历史容量、长时间网络抖动或性能压测。现有结果支持单用户、单 Mac 的开发试用，正式部署验收仍单独记录。
