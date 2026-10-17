import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { Database } from "../src/db.js";
import { settings } from "../src/config.js";
import { issueLlmToken } from "../src/security.js";
import { buildContext, finishRun } from "../src/bots.js";
import { maintainMemory } from "../src/memory-maintenance.js";
import { memoryKey } from "../src/memory.js";
import {
  TEST_DB,
  resetDatabase,
  tempDir,
  vaultFile,
  mockProvider,
} from "./helpers.js";

const skip = !TEST_DB && "需要独立 PI_BOT_TEST_DATABASE_URL";
let app: Awaited<ReturnType<typeof createApp>>,
  db: Database,
  s: ReturnType<typeof settings>,
  dir: ReturnType<typeof tempDir>,
  provider: Awaited<ReturnType<typeof mockProvider>>;
let token: string, userId: string, a: string, b: string, run: string;
async function api(path: string, body?: object, bearer = token) {
  const r = await app.inject({
    method: body ? "POST" : "GET",
    url: path,
    headers: { authorization: `Bearer ${bearer}` },
    payload: body,
  });
  return { status: r.statusCode, data: r.json() };
}
async function bearer(bot = a) {
  return issueLlmToken({ sub: userId, src: "cloud", bot }, s);
}
async function send(bot: string, text = "测试") {
  return (
    await api(`/bots/${bot}/messages`, { text, request_id: randomUUID() })
  ).data.run.id as string;
}
async function memory(body: object, bot = a, id = run) {
  return api("/agent/memory", { run_id: id, ...body }, await bearer(bot));
}
before(async () => {
  if (skip) return;
  await resetDatabase(TEST_DB!);
  dir = tempDir();
  provider = await mockProvider();
  s = settings({
    PI_BOT_DATABASE_URL: TEST_DB,
    PI_BOT_ADMIN_PASSWORD: "admin-password",
    PI_BOT_JWT_SECRET: "j".repeat(40),
    PI_BOT_VAULT_FILE: vaultFile(dir.path),
    PI_BOT_HISTORY_LIMIT: "4",
    PI_BOT_MEMORY_THRESHOLD: "10",
  });
  db = new Database(TEST_DB!);
  app = await createApp(s, db);
  const login = await api(
    "/auth/login",
    { username: "admin", password: "admin-password" },
    "",
  );
  token = login.data.access_token;
  userId = login.data.user.id;
  await api("/admin/api/models", {
    name: "test",
    base_url: provider.url,
    provider_model: "test",
    api_key: "sk-memory-test",
    context_window: 32000,
    max_tokens: 2000,
  });
  a = (await api("/bots", { name: "协调员" })).data.id;
  b = (await api("/bots", { name: "研究员", persona: "研究项目架构" })).data.id;
  run = await send(a, "请记住我喜欢蓝鲸");
});
after(async () => {
  if (skip) return;
  await app?.close();
  await provider?.close();
  dir?.cleanup();
});

test(
  "memory mutations preserve provenance, enforce revision/ownership, and tombstones defeat relearning",
  { skip },
  async () => {
    const saved = await memory({
      action: "save",
      content: "用户喜欢蓝鲸",
      certainty: "explicit",
    });
    assert.equal(saved.status, 200, JSON.stringify(saved));
    assert.equal(saved.data.certainty, "explicit");
    assert.ok(saved.data.source_message_id);
    assert.equal((await memory({ action: "list", bot_id: b })).status, 422);
    assert.equal((await memory({ action: "list" }, b)).status, 404);
    const rb = await send(b);
    const secret = await memory(
      { action: "save", content: "PRIVATE-B-PREFERENCE" },
      b,
      rb,
    );
    assert.equal(secret.status, 200);
    const ca = await db.tx(async (tx) =>
      buildContext(tx, s, await tx.get("bot_runs", run)),
    );
    assert.ok(ca.memory_context?.includes("用户喜欢蓝鲸"));
    assert.ok(!JSON.stringify(ca).includes("PRIVATE-B-PREFERENCE"));
    assert.equal(
      (
        await memory({
          action: "correct",
          memory_id: saved.data.id,
          expected_revision: 9,
          content: "用户喜欢海豚",
        })
      ).status,
      409,
    );
    const corrected = await memory({
      action: "correct",
      memory_id: saved.data.id,
      expected_revision: 1,
      content: "用户喜欢海豚",
      certainty: "explicit",
    });
    assert.equal(corrected.status, 200);
    assert.equal(
      (await memory({ action: "save", content: "用户喜欢蓝鲸" })).status,
      409,
    );
    assert.equal(
      (
        await memory({
          action: "delete",
          memory_id: corrected.data.id,
          expected_revision: 1,
        })
      ).status,
      200,
    );
    const history = await api(
      "/agent/history/search",
      { run_id: run, query: "蓝鲸" },
      await bearer(),
    );
    assert.equal(history.status, 200);
    assert.equal(history.data.matches.length, 0);
    assert.equal(
      (
        await memory({
          action: "save",
          content: "token=abcdefghijklmnopqrstuv",
        })
      ).status,
      422,
    );
    assert.equal(memoryKey("用户喜欢蓝鲸"), memoryKey("  用户喜欢蓝鲸  "));
  },
);

test(
  "directory finds a knowledgeable peer beyond the first page without exposing its facts",
  { skip },
  async () => {
    for (let i = 0; i < 21; i++) await api("/bots", { name: `Bot-${i}` });
    await db.tx((tx) =>
      tx.rows(
        "UPDATE bots SET knowledge_topics=ARRAY['编译器诊断'],knowledge_updated_at=now() WHERE bot_id=$1",
        [b],
      ),
    );
    const r = await api(
      "/agent/directory",
      { run_id: run, query: "编译器" },
      await bearer(),
    );
    assert.equal(r.status, 200);
    assert.equal(r.data.agents[0].id, b);
    assert.ok(!JSON.stringify(r).includes("PRIVATE-B-PREFERENCE"));
    await db.tx((tx) =>
      tx.rows("UPDATE bots SET archived_at=now() WHERE bot_id=$1", [b]),
    );
    assert.equal(
      (
        await api(
          "/agent/directory",
          { run_id: run, query: "编译器" },
          await bearer(),
        )
      ).data.agents.length,
      0,
    );
    await db.tx((tx) =>
      tx.rows("UPDATE bots SET archived_at=NULL WHERE bot_id=$1", [b]),
    );
  },
);

test(
  "checkpoint belongs to executor and resume is manual, versioned, linked and idempotent",
  { skip },
  async () => {
    const created = await api(
      "/agent/tasks",
      {
        run_id: run,
        kind: "background",
        task: "整理材料",
        wait: false,
        request_id: "start-one",
      },
      await bearer(),
    );
    assert.equal(created.status, 200, JSON.stringify(created));
    const old = await db.tx((tx) => tx.get("agent_tasks", created.data.id));
    const cp = {
      goal: "整理材料",
      completed: ["核实已有文件"],
      findings: ["外部发布状态未知"],
      artifacts: ["notes.md"],
      blockers: ["发布状态待核实"],
      next_steps: ["检查状态再决定是否发布"],
    };
    const request = {
      run_id: old.child_run_id,
      checkpoint: cp,
      expected_version: 0,
    };
    assert.equal(
      (await api("/agent/checkpoint", request, await bearer(b))).status,
      404,
    );
    assert.equal(
      (await api("/agent/checkpoint", request, await bearer())).status,
      200,
    );
    assert.equal(
      (await api("/agent/checkpoint", request, await bearer())).status,
      409,
    );
    assert.equal(
      (
        await api(
          "/agent/checkpoint",
          {
            ...request,
            expected_version: 1,
            checkpoint: {
              ...cp,
              findings: [
                ...cp.findings,
                ...Array.from({ length: 19 }, () => "核实内容".repeat(200)),
              ],
            },
          },
          await bearer(),
        )
      ).status,
      200,
    );
    const boundedContext = await db.tx(async (tx) =>
      buildContext(tx, s, await tx.get("bot_runs", old.child_run_id)),
    );
    assert.ok(boundedContext.memory_context!.length <= 12500);
    assert.match(boundedContext.memory_context!, /检查点已截断/);
    assert.equal(
      (
        await api(
          "/agent/tasks/resume",
          { run_id: run, task_id: old.task_id, request_id: "resume-one" },
          await bearer(),
        )
      ).status,
      409,
    );
    await db.tx((tx) => finishRun(tx, old.child_run_id, "failed", "执行中断"));
    const resume = {
      run_id: run,
      task_id: old.task_id,
      request_id: "resume-one",
      text: "继续，先确认发布是否完成",
    };
    const first = await api("/agent/tasks/resume", resume, await bearer());
    assert.equal(first.status, 200, JSON.stringify(first));
    const again = await api("/agent/tasks/resume", resume, await bearer());
    assert.equal(again.data.id, first.data.id);
    const next = await db.tx((tx) => tx.get("agent_tasks", first.data.id));
    assert.equal(next.resumed_from, old.task_id);
    assert.match(next.task, /发布状态未知/);
    assert.match(next.task, /旧审批不继承/);
    assert.equal(
      (await api("/agent/tasks/resume", resume, await bearer(b))).status,
      404,
    );
  },
);

test(
  "failed compaction never advances the cursor and concurrent workers cannot consume the same prefix",
  { skip },
  async () => {
    const bot = (await api("/bots", { name: "长记忆" })).data.id;
    for (let i = 0; i < 8; i++) {
      const id = await send(bot, `历史${i}，用户喜欢蓝鲸`);
      await db.tx((tx) => finishRun(tx, id, "completed", null, "已记录"));
    }
    // Keep unrelated bots out of the maintenance candidate set.
    await db.tx((tx) =>
      tx.rows("UPDATE bots SET archived_at=now() WHERE bot_id<>$1", [bot]),
    );
    await db.tx((tx) =>
      tx.rows("UPDATE models SET base_url='http://127.0.0.1:1/v1'"),
    );
    assert.equal(await maintainMemory(db, s, randomUUID()), true);
    let stored = await db.tx((tx) => tx.get("bot_memories", bot));
    assert.equal(stored.through_seq, 0);
    assert.equal(stored.failures, 1);
    await db.tx(async (tx) => {
      await tx.rows("UPDATE models SET base_url=$1", [provider.url]);
      await tx.rows("UPDATE bot_memories SET retry_after=now()");
    });
    const results = await Promise.all([
      maintainMemory(db, s, randomUUID()),
      maintainMemory(db, s, randomUUID()),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    stored = await db.tx((tx) => tx.get("bot_memories", bot));
    assert.ok(stored.through_seq > 0);
    assert.match(stored.summary, /蓝鲸/);
    const id = await send(bot, "过去说过什么？");
    const ctx = await db.tx(async (tx) =>
      buildContext(tx, s, await tx.get("bot_runs", id)),
    );
    assert.match(ctx.system, /蓝鲸/);
    const work = await api(
      "/agent/tasks",
      {
        run_id: id,
        kind: "background",
        task: "整理海洋动物知识",
        wait: false,
        request_id: "learn-completion",
      },
      await bearer(bot),
    );
    const task = await db.tx((tx) => tx.get("agent_tasks", work.data.id));
    await db.tx((tx) =>
      finishRun(
        tx,
        task.child_run_id,
        "completed",
        null,
        "已核实海洋动物资料，结论有来源",
      ),
    );
    assert.equal(await maintainMemory(db, s, randomUUID(), true), true);
    const refreshed = await db.tx((tx) => tx.get("bots", bot));
    assert.deepEqual(refreshed.knowledge_topics, ["海洋知识"]);
    assert.equal(refreshed.knowledge_dirty, false);
    const facts = await db.tx((tx) =>
      tx.rows("SELECT * FROM memory_entries WHERE bot_id=$1", [bot]),
    );
    assert.ok(facts.length > 0);
    assert.equal(facts[0].certainty, "inference");
    assert.ok(facts[0].source_message_id);
    await db.tx(async (tx) => {
      await tx.rows(
        "UPDATE bot_memories SET learned_seq=(SELECT next_seq-1 FROM bots WHERE bot_id=$1) WHERE bot_id=$1",
        [bot],
      );
      await tx.rows("UPDATE bots SET knowledge_dirty=true WHERE bot_id=$1", [
        bot,
      ]);
    });
    const before = await db.tx((tx) => tx.get("bot_memories", bot));
    assert.equal(
      await maintainMemory(db, s, randomUUID(), true),
      true,
      "a memory-only change refreshes the directory without new messages",
    );
    assert.equal(
      (await db.tx((tx) => tx.get("bot_memories", bot))).learned_seq,
      before.learned_seq,
    );
    assert.equal(
      (await db.tx((tx) => tx.get("bots", bot))).knowledge_dirty,
      false,
    );
  },
);

test(
  "summary cursor stops before an unfinished earlier response even when later runs finish",
  { skip },
  async () => {
    const bot = (await api("/bots", { name: "并行摘要" })).data.id;
    await db.tx((tx) =>
      tx.rows("UPDATE bots SET archived_at=now() WHERE bot_id<>$1", [bot]),
    );
    for (let i = 0; i < 5; i++) {
      const id = await send(bot, `已完成历史${i}`);
      await db.tx((tx) => finishRun(tx, id, "completed", null, "已确认"));
    }
    const pending = await send(bot, "尚未完成的问题");
    const boundary = await db.tx(async (tx) => {
      const r = await tx.get("bot_runs", pending);
      return (await tx.get("bot_messages", r.assistant_message_id)).seq;
    });
    for (let i = 0; i < 2; i++) {
      const id = await send(bot, `更晚完成${i}`);
      await db.tx((tx) => finishRun(tx, id, "completed", null, "更晚结果"));
    }
    assert.equal(await maintainMemory(db, s, randomUUID()), true);
    const stored = await db.tx((tx) => tx.get("bot_memories", bot));
    assert.ok(stored.through_seq < boundary);
    assert.ok(
      !JSON.stringify(provider.requests.at(-1)?.body.input).includes(
        "更晚结果",
      ),
    );
    await db.tx((tx) =>
      finishRun(tx, pending, "completed", null, "延迟完成的回复"),
    );
  },
);
