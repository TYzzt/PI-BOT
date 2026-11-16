# 文档附件与内置工具

桌面端和 Android 可上传 PDF、DOCX、XLSX，单份最多 10 MiB，每条消息最多 4 份。支持上传进度、失败重试和取消；桌面端也可拖入文件。附件可单独发送，消息保留文件引用。生成的文件以附件卡片交付，PDF 可预览，Office 文件可下载到本地打开。

内置引擎提供 PDF 文字读取和 DOCX/XLSX 读写，不引入 Office、浏览器打印或 OCR 运行时。PDF 生成方式由模型结合当前执行环境选择；可通过其他工具生成后，用 `document_publish` 的 `path` 发布，没有基于用户措辞或 PDF 写入意图的固定拒绝规则。

## 模型工具

- `document_read`：使用 `artifact_id` 或资料库 `path` 按页、内容块或工作表行读取。`offset` 从 0 起，`limit` 默认 20、最多 100；使用返回的 `next_offset` 继续。单次内容预算约 48000 字符；单项超出预算时返回 JSON 文本片段 `content_fragment`，按 `next_offset` 和 `next_fragment` 续读并拼接，最后一片没有 `next_fragment`。正文按需加载，附件字节不进入聊天上下文。
- `document_write`：DOCX 支持段落、标题、列表和表格；XLSX 支持多个工作表、数据和公式缓存值。原生 Excel 不在运行时中执行，公式没有缓存结果时显示「未计算」，在 Excel 打开时重算。
- `document_edit`：另存修改副本。Word 文本替换要求原文唯一，按纯文本重建，不能保留原表格结构、图片或版式；需要表格时读取内容后通过 `document_write` 重建。Excel 支持指定工作表和单元格修改，复杂图表及高级功能不保证完整保留。
- `document_publish`：将已有文件引用或资料库中的文件路径附到任务回复中，包括其他工具生成的 PDF。

生成和修改文件不会替换任务的文字结论，修改说明和格式保留限制仍会随回答交付。后台回报与同步委托只转交已发布的文件，不会带上未发布草稿；已有附件也可再次发布。续接任务会把此前已发布的文件作为输入，需再次发布才成为新回复的附件。

仅含附件的消息也会保留在后续对话上下文中；`history_search` 可按文件名检索附件引用。Excel 读取覆盖工作表的全部列，宽行超出单次预算时继续使用 JSON 分片读取。

内置 `builtin-pdf`、`builtin-word`、`builtin-excel` 随共享 Agent 发布，通过已有技能目录和加载工具提供操作说明。它们不可覆盖或删除，无需安装第三方 skill，也不引入技能市场。文档正文和公式均作为数据，不改变权限。

扫描 PDF 无可提取文字时会说明；内置工具不含 OCR。原生 Office 处理器支持 DOCX/XLSX，旧 DOC/XLS、宏和加密文件不在其能力范围内。PDF 不承诺恢复原版式；DOCX/XLSX 也不承诺完整保留复杂排版和高级特性。

## 实现和部署

共享 Agent 的文档处理器在独立 Node 子进程运行，堆上限 256 MiB、超时 30 秒，支持取消，不接收服务端凭据。锁定 PDF.js、Mammoth、docx、ExcelJS 和 JSZip 版本。桌面独立运行时与服务端构建均包含文档 worker。

客户端通过能力接口探测新版服务端，分块大小 256 KiB，完成时校验 SHA256。上传和分块可幂等重试，未完成上传和未关联消息的输入附件在 24 小时后清理。附件复用报告文件存储及短期下载票据，按账号、Bot 和消息共享关系校验访问。任务写入及发布仍遵守现有执行权限。

部署需执行 `0026-document-access`、`0027-documents` 数据库迁移，并同步升级服务端、共享 Agent、桌面及 Android。云端生成文件还会写入相应 Bot 的资料库 `documents/` 目录；桌面文件通过现有资料库路径授权访问。无需新增独立文档服务。

## 验证入口

`packages/agent/tests/documents.test.ts` 覆盖中文读写、表格、公式、分页与宽表分片、宏检查、取消，以及外部生成 PDF 的路径发布。`server/tests/documents.test.ts` 使用隔离 PostgreSQL 验证上传、幂等、纯附件历史、隔离、下载、回答保留，以及同步委托、后台回报和续接任务的已发布文件传递。桌面输入/上传回归在 `desktop/tests/timeline-drafts.test.ts`，独立 Windows 文档运行时检查在 `desktop/scripts/smoke-windows-runtime.mjs`。
