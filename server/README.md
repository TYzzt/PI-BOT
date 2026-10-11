# Pi Bot server

Node.js 24 + TypeScript + Fastify 5 + PostgreSQL 16。包含 API（含管理后台 `/admin/` 和模型代理 `/llm/v1`）、Worker（Mac 离线时的云端运行、长期记忆压缩）和 Runner（隔离执行 Pi agent）。整体设计见 [ARCHITECTURE.md](ARCHITECTURE.md)，需求与验收见 [REQUIREMENTS.md](REQUIREMENTS.md)。

## 本地开发

在仓库根目录：

```sh
npm ci
cp server/.env.example server/.env      # 改管理员口令、JWT 密钥、Runner token
node --import tsx server/scripts/vault-key.ts "$PWD/server/vault.json"   # 模型 Key 加密文件，路径填进 PI_BOT_VAULT_FILE
(cd server && docker compose up postgres -d)
npm run build                            # 构建 admin 和 server
npm run dev --workspace=@pi-bot/server   # API，默认 http://127.0.0.1:8000
```

首次启动时，如果库里还没有管理员，就用 `PI_BOT_ADMIN_USERNAME` / `PI_BOT_ADMIN_PASSWORD` 创建一个。打开 `http://127.0.0.1:8000/admin/` 登录后：

1. 「模型」添加一个 OpenAI 兼容模型（地址、服务商模型名、API Key），点「测试」确认连通；第一个模型自动成为默认模型。
2. 「用户」创建普通用户。没有注册入口。
3. 用户在 Mac 或手机上用这个账号登录。

Mac 离线时的云端回复需要 Worker 和 Runner，各开一个终端：

```sh
npm run build --workspace=@pi-bot/server
npm run runner --workspace=@pi-bot/server
npm run worker --workspace=@pi-bot/server
```

`PI_BOT_TAVILY_API_KEY` 不填时云端回复不联网。所有环境变量见 [.env.example](.env.example)。

管理后台开发：`npm run admin:dev`（Vite 把接口代理到 `PI_BOT_SERVER`，默认 `http://127.0.0.1:8000`）。

## 部署

- 单机：`cd server && docker compose up --build -d`（需要先生成 `server/vault.json`，并在环境里设置 `PI_BOT_ADMIN_PASSWORD`、`PI_BOT_JWT_SECRET`、`PI_BOT_RUNNER_TOKEN`）。
- 集群：[deploy/pibot.yaml](deploy/pibot.yaml)。入口 `https://aicloud-app.lenovo.com.cn/pibot`，后台 `/pibot/admin/`；镜像由 GitHub Actions 推到 `registry.cn-beijing.aliyuncs.com/liuhx/pi-bot-server:latest`。应用前修改 `pibot` Secret 里的口令，并创建 `pibot-vault` Secret（见清单顶部注释）。

API 只能单副本：Mac 的长连接、在线状态和资料库 RPC 都在进程内存里。Worker 可以多副本。Runner 只供 Worker 在内网调用。生产入口必须是 HTTPS/WSS。

## 检查

```sh
npm run typecheck                                   # 仓库根目录，覆盖 server/admin/desktop/packages
PI_BOT_TEST_DATABASE_URL=postgresql://pibot:pibot@127.0.0.1:5432/pibot npm test
```

集成测试会清空测试库，请用专门的数据库。接口契约导出在 `openapi.json`，修改路由后运行 `npm run openapi --workspace=@pi-bot/server`。
