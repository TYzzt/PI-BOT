import { execFile as execCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/app.js";
import { createRunner } from "../src/runner.js";
import { Worker } from "../src/worker.js";
import { Database } from "../src/db.js";
import { settings } from "../src/config.js";
const exec = promisify(execCallback),
  root = resolve(import.meta.dirname, "../.."),
  name = `tagent-check-${randomUUID()}`,
  dir = await mkdtemp(join(tmpdir(), "tagent-check-"));
let app: any,
  runner: any,
  worker: Worker | undefined,
  loop: Promise<void> | undefined,
  started = false;
try {
  await exec("docker", [
    "run",
    "-d",
    "--name",
    name,
    "-e",
    "POSTGRES_USER=tagent",
    "-e",
    "POSTGRES_PASSWORD=tagent",
    "-e",
    "POSTGRES_DB=shared_test",
    "-p",
    "127.0.0.1::5432",
    "postgres:16-alpine",
  ]);
  started = true;
  const port = (await exec("docker", ["port", name, "5432"])).stdout
      .trim()
      .split(":")
      .at(-1),
    url = `postgresql://tagent:tagent@127.0.0.1:${port}/shared_test`;
  const db = new Database(url);
  for (let i = 0; i < 100; i++) {
    try {
      await db.pool.query("SELECT 1");
      break;
    } catch {
      if (i === 99) throw new Error("测试数据库未就绪");
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const key = join(dir, "vault.json");
  await writeFile(
    key,
    JSON.stringify({
      active: "test",
      keys: { test: randomBytes(32).toString("base64") },
    }),
    { mode: 0o600 },
  );
  const token = randomBytes(32).toString("hex");
  const s = settings({
    T_AGNET_DATABASE_URL: url,
    T_AGNET_ADMIN_PASSWORD: "shared-test-password",
    T_AGNET_JWT_SECRET: "shared-test-jwt-secret-longer-than-32",
    T_AGNET_SYNC_KEY_FILE: key,
    T_AGNET_RUNNER_TOKEN: token,
    T_AGNET_APPROVAL_TTL_SECONDS: "60",
    T_AGNET_WORKER_LEASE_SECONDS: "15",
  });
  app = await createApp(s, db);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const file =
      process.env.T_AGNET_TEST_FILE ??
      (process.env.T_AGNET_REAL_SYNC === "1"
        ? "tests/shared-real.test.ts"
        : "tests/shared-e2e.test.ts"),
    withWorker =
      file.includes("cloud-chat") || process.env.T_AGNET_WITH_WORKER === "1";
  if (withWorker) {
    runner = await createRunner({ token, dir: join(dir, "runner") });
    await runner.listen({ host: "127.0.0.1", port: 0 });
    s.runnerUrl = runner.listeningOrigin;
    worker = new Worker(db, s);
    loop = worker.runForever();
  }
  const args = file.endsWith(".spec.ts")
    ? [
        resolve(root, "desktop/node_modules/@playwright/test/cli.js"),
        "test",
        file,
      ]
    : ["--import", "tsx", "--test", file];
  const node = resolve(root, "desktop/node_modules/node/bin/node");
  const child = spawn(node, args, {
    cwd: join(root, "desktop"),
    stdio: "inherit",
    env: {
      ...process.env,
      T_AGNET_SHARED_URL: app.listeningOrigin,
      T_AGNET_SHARED_PASSWORD: "shared-test-password",
      T_AGNET_CLOUD_URL: app.listeningOrigin,
      T_AGNET_CLOUD_PASSWORD: "shared-test-password",
      ...(withWorker ? { T_AGNET_CLOUD_WORKER: "1" } : {}),
    },
  });
  process.exitCode = await new Promise<number>((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => done(code ?? 1));
  });
} finally {
  worker?.stop();
  await loop?.catch(() => {});
  await runner?.close();
  await app?.close();
  if (started) await exec("docker", ["rm", "-f", name]);
  await rm(dir, { recursive: true, force: true });
}
