import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Database, type Row } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { settings } from "../src/config.js";
import { Hub, type DeviceConnection } from "../src/hub.js";
import { createBot, insertRun, finishRun, botOut, messagesPage } from "../src/bots.js";
import { AutomationScheduler, automationRequest, manageAutomation, saveAutomationDecision, checkpointAutomation, recordAutomationEffect } from "../src/automations.js";
import { failDeviceRuns, failOrphanedMacRuns } from "../src/runs.js";
import { claimExecution } from "../src/scheduling.js";
import { manageMemory } from "../src/memory.js";
import { createTask, reportLater } from "../src/agents.js";
import { proxyResponses } from "../src/llm.js";
import { nextWake, nextLocalDay, localDay, scheduleSchema, timezoneSchema } from "../src/automation-time.js";
import type { LlmClaims } from "../src/security.js";
import { TEST_DB, resetDatabase } from "./helpers.js";

const skip = !TEST_DB && "需要独立 PI_BOT_TEST_DATABASE_URL";
let db: Database, hub: Hub, user: string, bot: string, device: string, patrol: string, now: Date;
let sent: Row[], conn: DeviceConnection;
const config = () => settings({ PI_BOT_DATABASE_URL: TEST_DB ?? "test", PI_BOT_JWT_SECRET: "j".repeat(40) });
const scheduler = (options = config()) => new AutomationScheduler(db, options, hub, () => now);
const claims = (): LlmClaims => ({ sub: user, src: "mac", bot, did: device });
before(() => { if (!skip) db = new Database(TEST_DB!); });
beforeEach(async () => {
  if (skip) return;
  await resetDatabase(TEST_DB!); await migrate(db);
  now = new Date(); hub = new Hub(); sent = [];
  user = randomUUID(); device = randomUUID();
  await db.tx(async tx => {
    await tx.insert("users", { user_id: user, username: "automation-user", role: "user", password_hash: "unused" });
    await tx.insert("devices", { device_id: device, user_id: user, label: "test Mac", public_key: "unused" });
    await tx.insert("models", { model_id: randomUUID(), name: "test", base_url: "http://127.0.0.1:1/v1", provider_model: "test", context_window: 32000, max_tokens: 1000, secret: {} });
    bot = (await createBot(tx, user, { name: "巡检员", persona: "检查自己的工作" })).bot_id;
    patrol = (await tx.one("SELECT automation_id FROM bot_automations WHERE bot_id=$1", [bot]))!.automation_id;
  });
  conn = { deviceId: device, userId: user, capabilities: ["always-on-v1"], send: m => sent.push(m), close() {} };
  hub.attach(conn);
});
after(async () => { await db?.close(); });
async function due(id = patrol) { await db.tx(tx => tx.rows("UPDATE bot_automations SET next_wake_at=$2 WHERE automation_id=$1", [id, now])); }
async function current(id = patrol) { return db.tx(tx => tx.get("bot_automations", id)); }
async function active(id = patrol) { return db.tx(tx => tx.one("SELECT r.* FROM bot_runs r JOIN automation_rounds ar ON ar.run_id=r.run_id WHERE ar.automation_id=$1 AND ar.status='active'", [id])); }
async function dialogue() {
  return db.tx(tx => insertRun(tx, { userId: user, botId: bot, requestId: randomUUID(), text: "管理自动工作", mac: { deviceId: device } }));
}
async function control(run: Row, body: object) {
  return db.tx(tx => manageAutomation(tx, user, claims(), automationRequest.parse({ run_id: run.run_id, request_id: randomUUID(), ...body }), now));
}
async function commission(schedule: object = { type: "interval", minutes: 10 }) {
  const run = await dialogue();
  const a = await control(run, { action: "create", title: "持续检查", goal: "检查已授权任务", authorization: "用户授权检查该任务并整理进度", schedule });
  await db.tx(async tx => {
    await finishRun(tx, run.run_id, "completed", null, "已安排");
    await tx.rows("UPDATE bot_automations SET status='paused' WHERE automation_id=$1", [patrol]);
  });
  return a as Row;
}
async function done(run: Row, decision: Record<string, any> = {}) {
  const d = { state: "wait" as const, summary: "没有值得打扰的新变化", notify: false, reason: "无变化", category: "milestone" as const, ...decision };
  await db.tx(tx => saveAutomationDecision(tx, user, claims(), { run_id: run.run_id, decision: d }, now));
  await db.tx(tx => finishRun(tx, run.run_id, "completed", null, "PRIVATE ordinary output", now));
}

test("schedule validation, timezone and real local daily occurrences including DST", () => {
  const t = new Date("2026-10-18T00:59:00Z");
  assert.equal(nextWake({ type: "daily", time: "09:00" }, "Asia/Shanghai", t)!.toISOString(), "2026-10-18T01:00:00.000Z");
  assert.equal(nextWake({ type: "daily", time: "09:00" }, "Asia/Shanghai", new Date("2026-10-18T01:00:00Z"))!.toISOString(), "2026-10-19T01:00:00.000Z");
  assert.equal(nextWake({ type: "daily", time: "02:30" }, "America/New_York", new Date("2026-03-08T06:00:00Z"))!.toISOString(), "2026-03-09T06:30:00.000Z");
  assert.equal(localDay(nextLocalDay(t, "Asia/Shanghai"), "Asia/Shanghai"), "2026-10-19");
  assert.equal(timezoneSchema.safeParse("invalid/timezone").success, false);
  assert.equal(scheduleSchema.safeParse({ type: "interval", minutes: 0 }).success, false);
  assert.deepEqual([0, 1, 2, 3, 9].map(n => (nextWake({ type: "adaptive" }, "UTC", t, n)!.getTime() - t.getTime()) / 3600000), [1, 2, 4, 6, 6]);
});

test("upgrading an existing database creates exactly one patrol without changing its Bot or public history", { skip }, async () => {
  await resetDatabase(TEST_DB!);
  const folder = new URL("../migrations/", import.meta.url);
  await db.tx(async tx => {
    await tx.rows("CREATE TABLE schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())");
    for (const file of (await readdir(folder)).filter(f => f.endsWith(".sql") && f < "0009").sort()) {
      await tx.rows(await readFile(new URL(file, folder), "utf8"));
      await tx.rows("INSERT INTO schema_migrations(version) VALUES($1)", [file.slice(0, -4)]);
    }
    await tx.insert("users", { user_id: user, username: "existing-user", role: "user", password_hash: "unused" });
    await tx.insert("bots", { bot_id: bot, user_id: user, name: "已有 Bot", slug: "existing-bot", avatar: {}, next_seq: 2 });
    await tx.insert("bot_messages", { message_id: randomUUID(), bot_id: bot, seq: 1, role: "assistant", content: "原有对话", status: "completed", visibility: "public" });
  });
  await migrate(db); await migrate(db);
  const patrols = await db.tx(tx => tx.rows("SELECT * FROM bot_automations WHERE bot_id=$1", [bot]));
  assert.equal(patrols.length, 1); assert.equal(patrols[0].kind, "patrol");
  assert.equal((await db.tx(tx => tx.get("bots", bot))).next_seq, 2);
  assert.deepEqual((await db.tx(tx => messagesPage(tx, bot, undefined, 50))).messages.map(m => m.content), ["原有对话"]);
});

test("default patrol waits offline and for compatible Mac, never becomes a cloud job", { skip }, async () => {
  assert.equal((await db.tx(tx => tx.rows("SELECT * FROM bot_automations WHERE bot_id=$1", [bot]))).length, 1);
  hub.detach(conn); await due(); await scheduler().once();
  assert.equal((await current()).status, "waiting_mac"); assert.equal(await active(), undefined);
  conn.capabilities = []; hub.attach(conn); await scheduler().once(); assert.equal(await active(), undefined);
  conn.capabilities = ["always-on-v1"]; await scheduler().once();
  const run = (await active())!;
  assert.equal(run.executor, "mac"); assert.equal(run.execution_policy, "mac_only");
  assert.equal(sent.filter(m => m.type === "run").length, 1);
  const ctx = sent.find(m => m.type === "run")!.run;
  assert.equal(ctx.automation.kind, "patrol"); assert.equal(ctx.automation_readonly, true); assert.equal(ctx.agents_enabled, false);
  assert.equal(await db.tx(tx => claimExecution(tx, run.run_id, config(), randomUUID())), null);
});

test("an offline backlog cannot starve due work or reports belonging to an online Mac", { skip }, async () => {
  const offlineUser = randomUUID();
  await db.tx(async tx => {
    await tx.insert("users", { user_id: offlineUser, username: "offline-user", role: "user", password_hash: "unused" });
    for (let i = 0; i < 101; i++) await createBot(tx, offlineUser, { name: `offline-${i}`, persona: "" });
    await tx.rows("UPDATE bot_automations SET next_wake_at=$2 WHERE user_id=$1", [offlineUser, new Date(now.getTime() - 86400000)]);
    const offline = await tx.rows("SELECT automation_id FROM bot_automations WHERE user_id=$1 LIMIT 51", [offlineUser]);
    for (const a of offline) await tx.insert("automation_reports", { report_id: randomUUID(), automation_id: a.automation_id,
      version: 1, event_key: "offline-pending", category: "milestone", content: "离线待回报", available_at: new Date(now.getTime() - 86400000) });
  });
  await due(); await scheduler().once();
  assert.ok(await active());
  const count = await db.tx(tx => tx.one("SELECT count(*) AS n FROM bot_automations WHERE user_id=$1 AND status='waiting_mac'", [offlineUser]));
  assert.equal(count!.n, 101);
  await done((await active())!, { notify: true, summary: "在线用户的重要结果", notification_key: "online-result" });
  await scheduler().once();
  assert.equal((await db.tx(tx => messagesPage(tx, bot, undefined, 50))).messages.at(-1)!.content, "在线用户的重要结果");
});

test("concurrent scans coalesce wakes and quiet rounds change neither timeline nor visible activity time", { skip }, async () => {
  const previous = await db.tx(tx => tx.get("bots", bot));
  await due(); await Promise.all([scheduler().once(), scheduler().once()]);
  const run = (await active())!;
  assert.ok(run);
  assert.equal(sent.filter(m => m.type === "run").length, 1);
  const view = await db.tx(tx => botOut(tx, previous)); assert.equal(view.activity.summary, "正在检查");
  await done(run);
  assert.equal((await db.tx(tx => messagesPage(tx, bot, undefined, 50))).messages.length, 0);
  assert.equal((await db.tx(tx => tx.get("bots", bot))).last_active_at.getTime(), previous.last_active_at.getTime());
  assert.equal(new Date((await current()).next_wake_at).getTime() - now.getTime(), 2 * 3600000);
  await scheduler().once(); assert.equal(await active(), undefined);
});

test("important output is persisted, remains pending offline, and is published exactly once", { skip }, async () => {
  await due(); await scheduler().once();
  const run = (await active())!;
  await done(run, { notify: true, summary: "发现一个需要确认的新问题", category: "decision", notification_key: "issue:42:needs-decision" });
  hub.detach(conn); await scheduler().once();
  assert.equal((await db.tx(tx => messagesPage(tx, bot, undefined, 50))).messages.length, 0);
  hub.attach(conn); await Promise.all([scheduler().once(), scheduler().once()]);
  const page = await db.tx(tx => messagesPage(tx, bot, undefined, 50));
  assert.equal(page.messages.length, 1); assert.equal(page.messages[0].content, "发现一个需要确认的新问题");
  assert.equal(page.messages[0].status, "completed");
  assert.ok(!JSON.stringify(page).includes("PRIVATE"));
  await due(); await scheduler().once(); await done((await active())!, { notify: true, summary: "同一问题", category: "decision", notification_key: "issue:42:needs-decision" });
  await scheduler().once(); assert.equal((await db.tx(tx => messagesPage(tx, bot, undefined, 50))).messages.length, 1);
});

test("commission controls preserve checkpoints, reject stale decisions and cancel in-flight work", { skip }, async () => {
  const a = await commission(); await due(a.id); await scheduler().once(); const run = (await active(a.id))!;
  await db.tx(tx => checkpointAutomation(tx, run, { completed: ["已查阅来源"] }, 0));
  await assert.rejects(db.tx(tx => checkpointAutomation(tx, run, {}, 0)), /版本/);
  const dialog = await dialogue();
  await control(dialog, { action: "pause", automation_id: a.id, expected_version: 1 });
  await assert.rejects(db.tx(tx => saveAutomationDecision(tx, user, claims(), { run_id: run.run_id,
    decision: { state: "complete", summary: "stale", notify: true, reason: "stale", notification_key: "stale", category: "milestone" } }, now)), /失效/);
  await scheduler().once();
  assert.equal((await current(a.id)).status, "paused"); assert.equal((await db.tx(tx => tx.get("bot_runs", run.run_id))).status, "cancelled");
  await control(dialog, { action: "resume", automation_id: a.id, expected_version: 2 });
  assert.deepEqual((await current(a.id)).checkpoint, { completed: ["已查阅来源"] });
  await control(dialog, { action: "stop", all: true });
  assert.ok((await db.tx(tx => tx.rows("SELECT status FROM bot_automations WHERE bot_id=$1", [bot]))).every(a => a.status === "stopped"));
});

test("Mac interruption preserves queued work and safely restarts a read-only round without failure charge", { skip }, async () => {
  await due(); await scheduler().once(); const first = (await active())!;
  hub.detach(conn); await failDeviceRuns(db, device);
  assert.equal((await current()).status, "waiting_mac"); assert.equal((await current()).failures, 0);
  now = new Date(); hub.attach(conn); await scheduler().once(); const resumed = (await active())!;
  assert.notEqual(resumed.run_id, first.run_id); assert.equal(resumed.executor, "mac");
  await done(resumed);
  // Simulate a queued automatic run that had not reached the socket when the process died.
  await due(); await scheduler().once(); const queued = (await active())!;
  await db.tx(tx => tx.rows("UPDATE bot_runs SET status='queued' WHERE run_id=$1", [queued.run_id]));
  hub.detach(conn); await failOrphanedMacRuns(db);
  assert.equal((await db.tx(tx => tx.get("bot_runs", queued.run_id))).status, "queued");
  assert.equal((await db.tx(tx => tx.get("bot_runs", queued.run_id))).executor, "mac");
  assert.equal((await current()).status, "waiting_mac");
  const view = await db.tx(async tx => botOut(tx, await tx.get("bots", bot)));
  assert.equal(view.activity.running_count, 0); assert.equal(view.activity.queued_count, 0);
});

test("write-ahead journal prevents uncertain side effects from replaying after disconnect", { skip }, async () => {
  const a = await commission(); await due(a.id); await scheduler().once(); const run = (await active(a.id))!;
  await db.tx(tx => recordAutomationEffect(tx, user, claims(), { run_id: run.run_id, tool_call_id: "write-1", phase: "start" }));
  await assert.rejects(db.tx(tx => recordAutomationEffect(tx, user, claims(), { run_id: run.run_id, tool_call_id: "write-1", phase: "start" })), /不得重复/);
  hub.detach(conn); await failDeviceRuns(db, device);
  assert.equal((await current(a.id)).status, "waiting_user");
  now = new Date(); hub.attach(conn); await scheduler().once(); assert.equal(await active(a.id), undefined);
  assert.match((await db.tx(tx => messagesPage(tx, bot, undefined, 50))).messages.at(-1)!.content, /避免重复执行/);
});

test("missing finish result retries at 1/5/15 minutes then asks the user only once", { skip }, async () => {
  const a = await commission();
  for (let i = 0; i < 4; i++) {
    await due(a.id); await scheduler().once(); const run = (await active(a.id))!;
    await db.tx(tx => finishRun(tx, run.run_id, "completed", null, "not a structured outcome", now));
    const state = await current(a.id);
    if (i < 3) assert.equal(new Date(state.next_wake_at).getTime() - now.getTime(), [1, 5, 15][i] * 60000);
    else assert.equal(state.status, "waiting_user");
    now = new Date(now.getTime() + 1000);
  }
  await scheduler().once(); await scheduler().once();
  const reports = await db.tx(tx => tx.rows("SELECT * FROM automation_reports WHERE category='failure'"));
  assert.equal(reports.length, 1); assert.ok(reports[0].delivered_at);
});

test("periodic completion remains periodic, once completion ends, and finish submission is idempotent", { skip }, async () => {
  const a = await commission(); await due(a.id); await scheduler().once(); const run = (await active(a.id))!;
  const decision = { state: "complete" as const, summary: "本次完成", notify: false, reason: "普通完成", category: "milestone" as const };
  await db.tx(tx => saveAutomationDecision(tx, user, claims(), { run_id: run.run_id, decision }, now));
  await db.tx(tx => saveAutomationDecision(tx, user, claims(), { run_id: run.run_id, decision }, now));
  await db.tx(tx => finishRun(tx, run.run_id, "completed", null, undefined, now));
  assert.equal((await current(a.id)).status, "enabled");
  const dialog = await dialogue();
  await control(dialog, { action: "update", automation_id: a.id, schedule: { type: "once", at: new Date(now.getTime() + 120000).toISOString() } });
  await db.tx(tx => finishRun(tx, dialog.run_id, "completed", null, "updated"));
  await due(a.id); await scheduler().once(); await done((await active(a.id))!, { state: "complete" });
  assert.equal((await current(a.id)).status, "completed");
  const controlRun = await dialogue();
  await control(controlRun, { action: "pause", all: true });
  await control(controlRun, { action: "resume", all: true });
  assert.equal((await current(a.id)).status, "completed", "bulk controls must not resurrect completed one-off work");
});

test("daily budget defers to the next local day and reports a commission limit once", { skip }, async () => {
  const a = await commission(); const limited = { ...config(), automationDailyRounds: 1 };
  await due(a.id); await scheduler(limited).once(); await done((await active(a.id))!);
  await due(a.id); await scheduler(limited).once(); await scheduler(limited).once();
  assert.equal(await active(a.id), undefined);
  assert.equal(localDay(new Date((await current(a.id)).next_wake_at), "Asia/Shanghai"), localDay(nextLocalDay(now, "Asia/Shanghai"), "Asia/Shanghai"));
  assert.equal((await db.tx(tx => tx.rows("SELECT * FROM automation_reports WHERE category='budget'"))).length, 1);
});

test("ownership, readonly memory and automatic control boundaries are enforced by the server", { skip }, async () => {
  await due(); await scheduler().once(); const run = (await active())!;
  await assert.rejects(db.tx(tx => manageAutomation(tx, user, claims(), automationRequest.parse({ action: "list", run_id: run.run_id, request_id: "x" }))), /用户对话/);
  await assert.rejects(db.tx(tx => manageMemory(tx, user, claims(), { run_id: run.run_id, action: "save", content: "unauthorized" } as any)), /只能读取/);
  await assert.rejects(db.tx(tx => recordAutomationEffect(tx, user, claims(), { run_id: run.run_id, phase: "start", tool_call_id: "x" })), /不能修改/);
  await assert.rejects(db.tx(tx => saveAutomationDecision(tx, user, { ...claims(), bot: randomUUID() }, { run_id: run.run_id, decision: { state: "wait", summary: "x", notify: false, reason: "x", category: "milestone" } })), /不存在/);
  await assert.rejects(db.tx(tx => saveAutomationDecision(tx, user, claims(), { run_id: run.run_id, decision: { state: "continue", summary: "loop", notify: false, reason: "loop", category: "milestone", next_wake_at: now.toISOString() } }, now)), /一分钟/);
});

test("a persisted finish survives loss of the final socket event without repeating work", { skip }, async () => {
  const a = await commission(); await due(a.id); await scheduler().once(); const run = (await active(a.id))!;
  await db.tx(tx => saveAutomationDecision(tx, user, claims(), { run_id: run.run_id, decision: {
    state: "complete", summary: "已保存的成果", notify: true, reason: "交付成果", category: "milestone", notification_key: "saved-outcome",
  } }, now));
  hub.detach(conn); await failDeviceRuns(db, device); now = new Date();
  hub.attach(conn); await scheduler().once();
  assert.equal(await active(a.id), undefined);
  assert.equal((await db.tx(tx => tx.rows("SELECT * FROM automation_rounds WHERE automation_id=$1", [a.id]))).length, 1);
  assert.equal((await db.tx(tx => messagesPage(tx, bot, undefined, 50))).messages.at(-1)!.content, "已保存的成果");
});

test("new user input during a quiet patrol survives the end of that round", { skip }, async () => {
  await due(); await scheduler().once(); const run = (await active())!;
  const dialog = await dialogue();
  await db.tx(tx => finishRun(tx, dialog.run_id, "completed", null, "好的"));
  await done(run);
  const a = await current();
  assert.equal(a.idle_count, 0);
  assert.ok(new Date(a.next_wake_at).getTime() <= Date.now() + 61000);
});

test("automatic delegation inherits Mac-only policy and shares the root model-call budget", { skip }, async () => {
  const a = await commission(); await due(a.id); await scheduler().once(); const root = (await active(a.id))!;
  const peer = await db.tx(tx => createBot(tx, user, { name: "协作者", persona: "研究" }));
  const child = await db.tx(tx => createTask(tx, hub, user, claims(), { run_id: root.run_id, agent: peer.bot_id, task: "核对资料", wait: true }));
  assert.equal(child.run!.execution_policy, "mac_only"); assert.equal(child.run!.automation_id, a.id);
  assert.equal(new Date(child.run!.deadline_at).getTime(), new Date(root.deadline_at).getTime());
  await assert.rejects(db.tx(tx => reportLater(tx, user, claims(), child.task.id, config())), /不能改为公开回报/);
  await db.tx(tx => tx.rows("UPDATE bot_runs SET automation_calls=$2,waiting_on_task_id=NULL WHERE run_id=$1", [root.run_id, config().automationModelCalls]));
  const captured: any = {};
  const reply: any = { code(status: number) { captured.status = status; return this; }, send(body: any) { captured.body = body; return this; } };
  await proxyResponses(db, config(), { ...claims(), bot: peer.bot_id }, {} as Row, {}, reply, new AbortController().signal, { run: child.run! });
  assert.equal(captured.status, 429); assert.match(captured.body.error.message, /调用上限/);
  await assert.rejects(db.tx(tx => createTask(tx, hub, user, claims(), { run_id: root.run_id, agent: peer.bot_id, task: "不能异步回报", wait: false })), /同步等待/);
});

test("task completion wakes a dependent commission early and pending user work wins capacity", { skip }, async () => {
  const a = await commission(); const d = await dialogue();
  const job = await db.tx(tx => createTask(tx, hub, user, claims(), { run_id: d.run_id, task: "一次性核查", kind: "background", wait: false }));
  await control(d, { action: "update", automation_id: a.id, dependency_task_id: job.task.id });
  await db.tx(tx => finishRun(tx, d.run_id, "completed", null, "已安排"));
  await due(a.id); await scheduler().once(); assert.equal(await active(a.id), undefined, "user job has priority");
  await db.tx(tx => finishRun(tx, job.run!.run_id, "completed", null, "核查完成"));
  await db.tx(tx => tx.rows("UPDATE bot_automations SET next_wake_at=$2 WHERE automation_id=$1", [a.id, new Date(now.getTime() + 86400000)]));
  await scheduler().once(); assert.ok(await active(a.id), "terminal task event wakes before the future timer");
});

test("patrol suggestions are merged during cooldown while new risk evidence can be immediate", { skip }, async () => {
  await due(); await scheduler().once(); await done((await active())!, { notify: true, summary: "建议一", category: "suggestion", notification_key: "suggestion-v1" });
  await scheduler().once();
  now = new Date(now.getTime() + 60000);
  await due(); await scheduler().once(); await done((await active())!, { notify: true, summary: "建议二", category: "suggestion", notification_key: "suggestion-v2" });
  await scheduler().once();
  now = new Date(now.getTime() + 60000);
  await due(); await scheduler().once(); await done((await active())!, { notify: true, summary: "合并后的建议", category: "suggestion", notification_key: "suggestion-v3" });
  await scheduler().once();
  let page = await db.tx(tx => messagesPage(tx, bot, undefined, 50));
  assert.deepEqual(page.messages.map(m => m.content), ["建议一"]);
  const pending = await db.tx(tx => tx.rows("SELECT * FROM automation_reports WHERE delivered_at IS NULL AND discarded_at IS NULL"));
  assert.equal(pending.length, 1); assert.equal(pending[0].content, "合并后的建议");
  now = new Date(now.getTime() + 60000);
  await due(); await scheduler().once(); await done((await active())!, { notify: true, summary: "新的风险证据", category: "risk", notification_key: "risk-v1" });
  await scheduler().once();
  page = await db.tx(tx => messagesPage(tx, bot, undefined, 50)); assert.equal(page.messages.at(-1)!.content, "新的风险证据");
});
