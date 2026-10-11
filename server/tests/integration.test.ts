import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { settings, type Settings } from "../src/config.js";
import { Database } from "../src/db.js";
import { Worker } from "../src/worker.js";
import { createRunner } from "../src/runner.js";
import { SseUsage } from "../src/llm.js";
import { deviceKeys, eventually, mockProvider, resetDatabase, socket, TEST_DB, tempDir, vaultFile } from "./helpers.js";

const skip = !TEST_DB && "需要 PI_BOT_TEST_DATABASE_URL";
let app: Awaited<ReturnType<typeof createApp>>, base: string, s: Settings;
let provider: Awaited<ReturnType<typeof mockProvider>>, dir: ReturnType<typeof tempDir>;
let runner: Awaited<ReturnType<typeof createRunner>>, worker: Worker, workerDb: Database, workerLoop: Promise<void>;
const RUNNER_TOKEN = "r".repeat(40);

async function api(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const r = await fetch(base + path, {
    method,
    headers: {
      ...(payload ? { "content-type": "application/json" } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    body: payload,
  });
  const text = await r.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json };
}

before(async () => {
  if (skip) return;
  await resetDatabase(TEST_DB!);
  dir = tempDir();
  provider = await mockProvider();
  runner = await createRunner({ token: RUNNER_TOKEN, dir: dir.path });
  await runner.listen({ port: 0, host: "127.0.0.1" });
  const runnerUrl = `http://127.0.0.1:${(runner.server.address() as any).port}`;
  const env = {
    PI_BOT_DATABASE_URL: TEST_DB,
    PI_BOT_ADMIN_PASSWORD: "admin-password",
    PI_BOT_JWT_SECRET: "j".repeat(40),
    PI_BOT_VAULT_FILE: vaultFile(dir.path),
    PI_BOT_RUNNER_TOKEN: RUNNER_TOKEN,
    PI_BOT_RUNNER_URL: runnerUrl,
    PI_BOT_MEMORY_THRESHOLD: "10",
    PI_BOT_WORKER_POLL_SECONDS: "0.05",
    PI_BOT_RPC_TIMEOUT_MS: "1500",
  };
  s = settings(env);
  app = await createApp(s);
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  s = settings({ ...env, PI_BOT_INTERNAL_URL: base });
  workerDb = new Database(TEST_DB!);
  worker = new Worker(workerDb, s);
});
after(async () => {
  if (skip) return;
  worker?.stop();
  await workerLoop;
  await workerDb?.close();
  await app?.close();
  await runner?.close();
  await provider?.close();
  dir?.cleanup();
});

const state: Record<string, any> = {};

test("admin bootstraps from env, creates users and models; users cannot reach admin API", { skip }, async () => {
  const bad = await api("POST", "/auth/login", { body: { username: "admin", password: "wrong" } });
  assert.equal(bad.status, 401);
  const admin = await api("POST", "/auth/login", { body: { username: "admin", password: "admin-password" } });
  assert.equal(admin.status, 200);
  assert.equal(admin.json.user.role, "admin");
  state.admin = admin.json.access_token;

  const created = await api("POST", "/admin/api/users", { token: state.admin, body: { username: "alice", password: "alice-password", display_name: "Alice" } });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const dup = await api("POST", "/admin/api/users", { token: state.admin, body: { username: "ALICE", password: "alice-password" } });
  assert.equal(dup.status, 409);
  const alice = await api("POST", "/auth/login", { body: { username: "alice", password: "alice-password" } });
  state.alice = alice.json.access_token;
  state.aliceId = alice.json.user.id;
  assert.equal((await api("GET", "/admin/api/users", { token: state.alice })).status, 403);

  const noModel = await api("POST", "/bots", { token: state.alice, body: { name: "早到的" } });
  const early = await api("POST", `/bots/${noModel.json.id}/messages`, { token: state.alice, body: { text: "hi", request_id: randomUUID() } });
  assert.equal(early.status, 503);
  await api("DELETE", `/bots/${noModel.json.id}`, { token: state.alice });

  const model = await api("POST", "/admin/api/models", {
    token: state.admin,
    body: { name: "测试模型", base_url: provider.url, provider_model: "upstream-model", api_key: "sk-provider-secret", context_window: 32000, max_tokens: 1000 },
  });
  assert.equal(model.status, 200, JSON.stringify(model.json));
  assert.equal(model.json.is_default, true, "first model becomes default");
  assert.equal(JSON.stringify(model.json).includes("sk-provider-secret"), false);
  state.model = model.json.id;
  const tested = await api("POST", `/admin/api/models/${state.model}/test`, { token: state.admin });
  assert.equal(tested.json.ok, true, JSON.stringify(tested.json));
  assert.equal(provider.requests.at(-1)!.headers.authorization, "Bearer sk-provider-secret");
  const models = await api("GET", "/models", { token: state.alice });
  assert.deepEqual(models.json.map((m: any) => m.name), ["测试模型"]);
  assert.equal("base_url" in models.json[0], false, "users never see provider details");
});

test("bots are per user with unique library slugs and a default avatar", { skip }, async () => {
  const a = await api("POST", "/bots", { token: state.alice, body: { name: "Research Bot", persona: "帮我整理资料" } });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.slug, "research-bot");
  assert.ok(a.json.avatar.shape && a.json.avatar.color);
  const b = await api("POST", "/bots", { token: state.alice, body: { name: "Research Bot", avatar: { shape: "bean", color: "mint" } } });
  assert.equal(b.json.slug, "research-bot-2");
  const c = await api("POST", "/bots", { token: state.alice, body: { name: "小助手" } });
  assert.match(c.json.slug, /^bot(-\d+)?$/);
  const renamed = await api("PATCH", `/bots/${b.json.id}`, { token: state.alice, body: { name: "Notes" } });
  assert.equal(renamed.json.slug, "research-bot-2", "library folder never moves");
  const admin = await api("GET", `/bots/${a.json.id}`, { token: state.admin });
  assert.equal(admin.status, 404, "bots are private to their owner");
  state.bot = a.json.id;
  state.bot2 = c.json.id;
  const list = await api("GET", "/bots", { token: state.alice });
  assert.equal(list.json.bots.length, 3);
  assert.equal(list.json.mac.online, false);
});

test("the model proxy injects the provider key, rewrites the model and records usage", { skip }, async () => {
  const keys = deviceKeys();
  const reg = await api("POST", "/devices/register", { token: state.alice, body: { public_key: keys.publicKey, label: "Alice 的 MacBook" } });
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
  keys.setId(reg.json.device.id);
  state.keys = keys;
  const body = JSON.stringify({ bot_id: state.bot });
  const token = await api("POST", "/device/llm-token", { body: { bot_id: state.bot }, headers: keys.headers("POST", "/device/llm-token", body) });
  assert.equal(token.status, 200, JSON.stringify(token.json));
  const replay = await api("POST", "/device/llm-token", { body: { bot_id: state.bot }, headers: keys.headers("POST", "/device/llm-token", "{}") });
  assert.equal(replay.status, 401, "signature covers the body");
  const r = await fetch(`${base}/llm/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token.json.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: state.model, stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "你好" }] }),
  });
  assert.equal(r.status, 200);
  const sse = await r.text();
  assert.match(sse, /"content":"好"/);
  assert.match(sse, /"prompt_tokens":42/);
  const forwarded = provider.requests.at(-1)!;
  assert.equal(forwarded.body.model, "upstream-model");
  assert.equal(forwarded.headers.authorization, "Bearer sk-provider-secret");
  const userToken = await fetch(`${base}/llm/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${state.alice}`, "content-type": "application/json" },
    body: JSON.stringify({ model: state.model, messages: [] }),
  });
  assert.equal(userToken.status, 401, "user tokens cannot call the proxy");
  const usage = await eventually(async () => {
    const u = await api("GET", "/admin/api/usage", { token: state.admin });
    return u.json.by_user.find((x: any) => x.username === "alice" && x.input_tokens >= 42) && u.json;
  });
  assert.ok(usage.by_model.length);
});

test("Mac online: runs execute on the Mac with tools, approvals and file RPC", { skip }, async () => {
  const mac = socket(base.replace("http", "ws") + "/ws/device", state.keys.headers("GET", "/ws/device"));
  await mac.next((m) => m.type === "hello");
  const events = socket(base.replace("http", "ws") + "/ws/events", { authorization: `Bearer ${state.alice}` });
  await events.next((m) => m.type === "hello" && m.mac_online === true);
  assert.equal((await api("GET", "/me", { token: state.alice })).json.mac.online, true);

  const requestId = randomUUID();
  const posted = await api("POST", `/bots/${state.bot}/messages`, { token: state.alice, body: { text: "整理一下桌面", request_id: requestId } });
  assert.equal(posted.status, 200, JSON.stringify(posted.json));
  assert.equal(posted.json.run.executor, "mac");
  const again = await api("POST", `/bots/${state.bot}/messages`, { token: state.alice, body: { text: "整理一下桌面", request_id: requestId } });
  assert.equal(again.json.run.id, posted.json.run.id, "request_id is idempotent");
  const busy = await api("POST", `/bots/${state.bot}/messages`, { token: state.alice, body: { text: "另一件事", request_id: randomUUID() } });
  assert.equal(busy.status, 409);

  const { run } = await mac.next((m) => m.type === "run");
  assert.equal(run.bot.slug, "research-bot");
  assert.match(run.system, /~\/pi-bot\/research-bot/);
  assert.match(run.system, /帮我整理资料/);
  assert.equal(run.text, "整理一下桌面");
  const runId = run.run_id;
  mac.send({ type: "run_event", run_id: runId, event: { kind: "started" } });
  mac.send({ type: "run_event", run_id: runId, event: { kind: "tool", id: "t1", name: "list_files", state: "running", summary: "." } });
  mac.send({ type: "run_event", run_id: runId, event: { kind: "text", text: "正在查看" } });
  const delta = await events.next((m) => m.event?.type === "delta");
  assert.equal(delta.event.content, "正在查看");
  mac.send({ type: "run_event", run_id: runId, event: { kind: "approval", request_id: "q1", path: "/Users/alice/Desktop", reason: "需要整理桌面" } });
  const created = await mac.next((m) => m.type === "approval_created");
  const detail = await eventually(async () => {
    const b = await api("GET", `/bots/${state.bot}`, { token: state.alice });
    return b.json.pending_approvals?.length && b.json;
  });
  assert.equal(detail.latest_run.status, "waiting_approval");
  assert.equal(detail.pending_approvals[0].path, "/Users/alice/Desktop");
  const decided = await api("POST", `/approvals/${created.approval_id}`, { token: state.alice, body: { decision: "approve" } });
  assert.equal(decided.json.status, "approved");
  const decision = await mac.next((m) => m.type === "approval");
  assert.equal(decision.decision, "approve");
  assert.equal((await api("POST", `/approvals/${created.approval_id}`, { token: state.alice, body: { decision: "reject" } })).status, 409);

  const listing = api("GET", `/bots/${state.bot}/files?path=notes`, { token: state.alice });
  const rpc = await mac.next((m) => m.type === "rpc");
  assert.equal(rpc.method, "files.list");
  assert.deepEqual(rpc.params, { slug: "research-bot", path: "notes" });
  mac.send({ type: "rpc_result", id: rpc.id, ok: true, result: { entries: [{ name: "a.md", type: "file", size: 3 }] } });
  assert.deepEqual((await listing).json.entries[0].name, "a.md");
  const slow = await api("GET", `/bots/${state.bot}/files/content?path=a.md`, { token: state.alice });
  assert.equal(slow.status, 504);

  mac.send({ type: "run_event", run_id: runId, event: { kind: "tool", id: "t1", name: "list_files", state: "completed" } });
  mac.send({ type: "run_event", run_id: runId, event: { kind: "done", state: "completed", text: "桌面已整理好。" } });
  const page = await eventually(async () => {
    const p = await api("GET", `/bots/${state.bot}/messages`, { token: state.alice });
    return p.json.messages.at(-1).status === "completed" && p.json;
  });
  const reply = page.messages.at(-1);
  assert.equal(reply.content, "桌面已整理好。");
  assert.equal(reply.executor, "mac");
  assert.deepEqual(reply.tools.map((t: any) => [t.name, t.state]), [["list_files", "completed"]]);

  await api("POST", `/bots/${state.bot}/messages`, { token: state.alice, body: { text: "再做一件事", request_id: randomUUID() } });
  const second = await mac.next((m) => m.type === "run");
  mac.send({ type: "run_event", run_id: second.run.run_id, event: { kind: "started" } });
  const cancelled = await api("POST", `/runs/${second.run.run_id}/cancel`, { token: state.alice });
  assert.equal(cancelled.status, 200);
  await mac.next((m) => m.type === "cancel" && m.run_id === second.run.run_id);

  mac.close();
  await events.next((m) => m.event?.type === "presence" && m.event.online === false);
  const failed = await eventually(async () => {
    const b = await api("GET", `/bots/${state.bot}`, { token: state.alice });
    return b.json.latest_run.status !== "running" && b.json.latest_run;
  });
  assert.equal(failed.status, "cancelled", "cancel requested before the Mac dropped");
  const offline = await api("GET", `/bots/${state.bot}/files`, { token: state.alice });
  assert.equal(offline.status, 503);
  events.close();
});

test("Mac offline: runs fall back to the cloud runner through the proxy, with memory", { skip }, async () => {
  workerLoop = worker.runForever();
  const send = async (text: string) => {
    const r = await api("POST", `/bots/${state.bot2}/messages`, { token: state.alice, body: { text, request_id: randomUUID() } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.run.executor, "cloud");
    return eventually(async () => {
      const p = await api("GET", `/bots/${state.bot2}/messages`, { token: state.alice });
      const last = p.json.messages.at(-1);
      return last.status !== "running" && last;
    }, 20000);
  };
  const first = await send("记住蓝鲸");
  assert.equal(first.status, "completed", JSON.stringify(first));
  assert.equal(first.content, "好的，我记住了蓝鲸。");
  const forwarded = provider.requests.at(-1)!.body;
  assert.equal(forwarded.model, "upstream-model");
  assert.match(forwarded.messages[0].content, /Mac 当前离线/);
  assert.equal(forwarded.tools?.length ?? 0, 0, "cloud runs have no file or shell tools");
  const second = await send("之前说了什么？");
  assert.equal(second.content, "你之前说的是蓝鲸。");

  for (let i = 0; i < 5; i++) await send(`第 ${i} 件事`);
  const memory = await eventually(async () => {
    const r = await workerDb.tx((tx) => tx.get("bot_memories", state.bot2));
    return r?.summary && r;
  }, 20000);
  assert.equal(memory.summary, "用户喜欢蓝鲸。");
  const after = await send("之前说了什么？");
  assert.equal(after.content, "你之前说的是蓝鲸。", "memory summary reaches the prompt");
});

test("users only see their own bots and Mac; a Mac dropping mid-run fails the run", { skip }, async () => {
  await api("POST", "/admin/api/users", { token: state.admin, body: { username: "bob", password: "bob-password" } });
  const bob = (await api("POST", "/auth/login", { body: { username: "bob", password: "bob-password" } })).json.access_token;
  const mac = socket(base.replace("http", "ws") + "/ws/device", state.keys.headers("GET", "/ws/device"));
  await mac.next((m) => m.type === "hello");
  const bobEvents = socket(base.replace("http", "ws") + "/ws/events", { authorization: `Bearer ${bob}` });
  assert.equal((await bobEvents.next((m) => m.type === "hello")).mac_online, false, "presence is per user");
  assert.deepEqual((await api("GET", "/bots", { token: bob })).json.bots, []);
  for (const [method, path] of [
    ["GET", `/bots/${state.bot}`],
    ["GET", `/bots/${state.bot}/messages`],
    ["GET", `/bots/${state.bot}/files`],
    ["PATCH", `/bots/${state.bot}`],
  ] as const) {
    const r = await api(method, path, { token: bob, body: method === "PATCH" ? { name: "偷来的" } : undefined });
    assert.equal(r.status, 404, `${method} ${path}`);
  }
  const posted = await api("POST", `/bots/${state.bot}/messages`, { token: bob, body: { text: "hi", request_id: randomUUID() } });
  assert.equal(posted.status, 404);

  const mine = await api("POST", `/bots/${state.bot}/messages`, { token: state.alice, body: { text: "长任务", request_id: randomUUID() } });
  assert.equal(mine.json.run.executor, "mac");
  assert.equal((await api("POST", `/runs/${mine.json.run.id}/cancel`, { token: bob })).status, 404);
  const { run } = await mac.next((m) => m.type === "run");
  mac.send({ type: "run_event", run_id: run.run_id, event: { kind: "started" } });
  mac.send({ type: "run_event", run_id: run.run_id, event: { kind: "text", text: "做到一半" } });
  await eventually(async () => (await api("GET", `/bots/${state.bot}`, { token: state.alice })).json.latest_run.status === "running");
  mac.close();
  const failed = await eventually(async () => {
    const b = await api("GET", `/bots/${state.bot}`, { token: state.alice });
    return b.json.latest_run.status === "failed" && b.json.latest_run;
  });
  assert.equal(failed.error, "Mac 已离线，可重新发送（将在云端运行）");
  const page = await api("GET", `/bots/${state.bot}/messages`, { token: state.alice });
  assert.equal(page.json.messages.at(-1).content, "做到一半", "partial text is kept");
  bobEvents.close();
});

test("admin can disable users and revoke devices", { skip }, async () => {
  const devices = await api("GET", "/admin/api/devices", { token: state.admin });
  const d = devices.json.find((x: any) => x.username === "alice" && !x.revoked_at);
  const revoked = await api("POST", `/admin/api/devices/${d.id}/revoke`, { token: state.admin });
  assert.ok(revoked.json.revoked_at);
  const signed = await api("GET", "/me", { headers: state.keys.headers("GET", "/me") });
  assert.equal(signed.status, 401);
  await api("PATCH", `/admin/api/users/${state.aliceId}`, { token: state.admin, body: { disabled: true } });
  assert.equal((await api("GET", "/me", { token: state.alice })).status, 401);
  const overview = await api("GET", "/admin/api/overview", { token: state.admin });
  assert.equal(overview.json.users, 3);
});

test("SSE usage parser keeps the last usage block across chunk boundaries", () => {
  const p = new SseUsage();
  const line = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } })}\n\n`;
  p.push(line.slice(0, 20));
  p.push(line.slice(20));
  assert.deepEqual(p.usage, { input: 7, output: 2 });
});
