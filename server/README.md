# T-AGNET server

服务端使用 Node.js 24、TypeScript、Fastify 和 PostgreSQL 16。API、队列 Worker 和隔离的 Pi Runner 分别运行；Mac 与 Runner 复用 `packages/agent`，Mac harness 始终在本机执行。

HTTP、WebSocket、设备 Ed25519 签名、任务审批、共享消息与配置接口沿用 `openapi.json`。旧 PostgreSQL 数据和 vault 文件可直接迁移，启动自动升级 Alembic 0001–0005 对应数据库，不需要 Python。升级前备份数据库和 vault；回滚应用时恢复备份。

## 本地开发

在仓库根目录安装依赖并构建：

```sh
npm install
cp server/.env.example server/.env
# 设置管理员密码、JWT 密钥和独立的 Runner token（至少 32 字符）
npm run build
npm run dev --workspace=@t-agnet/server
```

数据库可用 `cd server && docker compose up postgres -d` 启动。云端问答还需要 vault、Runner 和 Worker，分别在三个终端运行：

```sh
node --import tsx server/scripts/vault-key.ts /absolute/path/sync-vault.json
npm run runner --workspace=@t-agnet/server
npm run worker --workspace=@t-agnet/server
```

在 `.env` 设置 `T_AGNET_SYNC_KEY_FILE`，Worker 的 `T_AGNET_RUNNER_URL` 默认指向本机 Runner。Runner 不读取数据库或 vault。直接运行 Runner 适合开发；云端 shell 的隔离边界由部署容器提供。

## 容器部署

```sh
cd server
export T_AGNET_SYNC_KEY_FILE=/absolute/path/sync-vault.json
docker compose -f docker-compose.yml -f docker-compose.sync.yml up --build -d
```

镜像从仓库根目录构建。API 暴露 8000，Runner 仅供内部 Worker 调用；PostgreSQL 本地端口绑定 127.0.0.1。Runner 使用独立持久卷保存会话和工作区，非 root、只读根文件系统、无额外 capabilities。生产入口使用 HTTPS/WSS。

云端 MCP secret 配置见 [CONFIGS.md](../CONFIGS.md)，Pi 生命周期与执行边界见 [CLOUD-CHAT.md](../CLOUD-CHAT.md)。所有环境变量见 `.env.example`；旧 `postgresql+psycopg://` URL 仍兼容。

## 检查

```sh
npm run typecheck
T_AGNET_TEST_DATABASE_URL=postgresql://tagent:tagent@127.0.0.1:5432/tagent npm test
npm run test:shared
T_AGNET_TEST_FILE=tests/cloud-e2e.test.ts node --import tsx server/scripts/check-shared.ts
T_AGNET_TEST_FILE=tests/cloud-chat-e2e.test.ts node --import tsx server/scripts/check-shared.ts
T_AGNET_TEST_FILE=tests/configs-e2e.test.ts node --import tsx server/scripts/check-shared.ts
```

集成测试创建独立临时数据库；`check-shared.ts` 自动启动临时 PostgreSQL 和 API，云端问答测试另外启动 Runner/Worker。模拟设备：`node --import tsx server/scripts/fake-device.ts --demo`。客户端：`node --import tsx server/scripts/shared-client.ts`，密码交互输入。

`openapi.json` 是路由、输入验证和客户端契约的共同来源，修改后运行 `node --import tsx server/scripts/export-openapi.ts`。旧 PHASE 文档保留历史验收记录，不代表当前运行架构。
