# 共享 Skills 与 MCP 配置

Skills 包和 MCP 服务配置保存在云端，Mac 和手机都可以查看、编辑。Mac 拉取后只做静态依赖检查，把"可用 / 不可用及原因"回报给云端，其他端随即显示。**同步来的任何内容都不会被执行**：安装提示只是文字，包内脚本作为不可执行的文本文件保存，MCP 命令不会启动。

对应整体架构的验收项 A11：修改共享 skill/MCP 配置，其他端显示新版本；Mac 缺依赖时明确失败且不自动运行安装脚本。

## 当前范围

- 已实现：服务端存储和版本管理；Mac 端查看、编辑、依赖检查、本机 secret；Android 端查看和编辑；各设备的检查结果全端可见。
- 未实现：把 Skills 加载进 Pi、连接或启动 MCP 服务（MCP 工具清单因此暂不显示）、云端 DeepAgents Worker 加载。运行环境选"仅云端"的条目在 Mac 上显示为"不在本机运行"，界面注明"云端暂未加载"。
- 不需要新的数据库迁移（服务端复用 `shared_documents`，`device_id` 为空）；Android Room 从 3 升到 4，新增 `config_docs` 缓存表。

## 数据模型

每条配置是一份带版本号的共享文档，`kind` 为 `skill` 或 `mcp_server`。每次修改写一条 revision，并发出 `skill.changed` 或 `mcp_server.changed` 事件。

Skill：

| 字段 | 说明 |
|---|---|
| `name` | 字母、数字、`.`、`_`、`-`，同类唯一 |
| `content` | SKILL.md 正文 |
| `files` | 包内文本文件，最多 20 个，单个 200KB，整包 1MB；只允许包内相对路径，不能是 `SKILL.md`，不能含 `..` |
| `runtime` | `mac` / `cloud` / `both` |
| `requires.commands` | 需要的系统命令，只能是单个可执行文件名 |
| `requires.platforms` | `darwin` / `linux` / `win32`，留空表示不限 |
| `requires.scripts` | 必须出现在 `files` 中 |
| `requires.mcp` | 依赖的 MCP 名称 |
| `install_hint` | 安装说明，只展示 |

MCP：`transport`（`stdio` 需要 `command`，`http` 需要 `url`）、`args`、`timeout_ms`、`env`、`runtime`、`enabled`、`disabled_tools`。`env` 每项二选一：明文 `value` 或 `secret_ref`。名称含 KEY / TOKEN / SECRET / PASSWORD / CREDENTIAL 的变量不允许写明文值。secret 的值只保存在各台 Mac 的 Keychain（账户名 `mcp-secret:<名称>`），从不上传。

`content_hash` 由服务端对配置的规范化 JSON 计算 sha256。

## 版本与生效状态

- 写入必须带 `expected_version`（新建为 0）和 `request_id`。版本不一致返回 409 并附当前版本，客户端刷新后提示"已被其他端修改"，不会覆盖别人的修改。已删除的配置返回 410。
- 每台 Mac 检查后调用 `POST /device/configs/{skills|mcp-servers}/{id}/applied`，提交 `{version, hash, state, reasons}`。
- 服务端为每台设备记录 `checked_version`、`state`、`reasons`、`applied_version`、`applied_hash`。设备还没检查最新版本时显示 `pending`（待检查）。
- `available` 或 `not_applicable` 时，`applied_version` 更新为该版本；`unavailable` 或 `failed` 时保留上一个可用版本。Mac 本地也保留上一可用版本的技能目录。

## Mac 依赖检查

`desktop/packages/service/src/cloud/configs.ts` 每 5 秒拉取一次 `GET /device/configs/bundle`，内容变化或点击"重新检查"时重新评估。检查只读文件系统，文件里没有引用 `child_process`，测试也会拦截所有子进程调用：

| 原因码 | 条件 |
|---|---|
| `command_missing` | 在 PATH、`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`、`/bin` 中找不到可执行文件（含 stdio MCP 的命令） |
| `platform_unsupported` | `requires.platforms` 不包含本机平台 |
| `script_missing` | 声明的脚本不在包内 |
| `mcp_missing` | 依赖的 MCP 不存在 |
| `mcp_unavailable` | 依赖的 MCP 已停用、只在云端运行，或自身不可用 |
| `secret_missing` | 本机 Keychain 没有对应的 secret |
| `invalid_config` | 命令是相对路径、URL 无效等 |
| `write_failed` | 技能目录写入失败 |

可用的 Skill 写入 `~/Library/Application Support/T-AGNET/skills/<id>/<hash>/`，文件权限 0644。新版本可用后删除旧目录；不可用时旧目录保留。服务端删除后，本地目录也会删除。

缺依赖时，界面列出原因和安装提示，并注明"不会自动执行"。用户手动安装后点击"重新检查"。

## 接口

| 方法 | 路径 | 调用方 |
|---|---|---|
| GET | `/configs/skills`、`/configs/mcp-servers` | 手机（JWT） |
| PUT | `/configs/skills/{id}`、`/configs/mcp-servers/{id}` | 手机 |
| POST | `/configs/{skills,mcp-servers}/{id}/delete` | 手机 |
| GET | `/configs/{skills,mcp-servers}/{id}/revisions` | 手机 |
| GET | `/device/configs/bundle` | Mac（设备签名） |
| PUT / POST | `/device/configs/...` 同上的写入与删除 | Mac |
| POST | `/device/configs/{skills,mcp-servers}/{id}/applied` | Mac |

完整契约见 `server/openapi.json`。

## 验收

自动化：

```sh
cd server && uv run pytest tests/test_configs.py
cd desktop && node_modules/node/bin/node --import tsx --test tests/configs.test.ts
cd server && T_AGNET_TEST_FILE=tests/configs-e2e.test.ts uv run python scripts/check_shared.py   # 真实服务端，手机编辑到 Mac 检查
cd android && ./gradlew testDebugUnitTest --tests dev.tagent.android.ConfigRulesTest
```

手动（真实 Mac + 手机）：

1. 手机「配置」页新建 Skill：`requires.commands` 填一个 Mac 上没有的命令，安装提示填 `touch /tmp/should-not-exist`。
2. Mac「Skills 与 MCP」页出现该 Skill，显示"不可用：缺少命令 …"和安装提示；`/tmp/should-not-exist` 不存在。
3. 手机上同一条目显示"Mac：v1 最新 / 未生效 · 不可用 · 缺少命令 …"。
4. 在 Mac 上手动安装该命令，点击"重新检查"：Mac 显示可用，手机显示 `v1 生效`。
5. 在 Mac 上编辑 SKILL.md 并保存：手机刷新后看到 v2 和新内容。两端同时编辑同一版本时，后保存的一端提示"已被其他端修改"。
6. MCP 的 env 使用 secret 引用：Mac 显示"缺少 secret"；在 Mac 本机 secret 区保存后变为可用，手机和服务端都看不到 secret 的值。
