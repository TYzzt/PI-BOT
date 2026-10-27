import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp, openapi } from "../src/app.js";
import { Database, type Row } from "../src/db.js";
import { settings } from "../src/config.js";
import { createBot, insertRun, finishRun } from "../src/bots.js";
import { issueToken } from "../src/security.js";
import { enqueueApproval, enqueueMessage, firebaseTransport, loadAndroidPushConfig, parseAndroidPushConfig, PushDispatcher, pushSummary, type PushTransport } from "../src/push.js";
import type { Message } from "firebase-admin/messaging";
import { TEST_DB, resetDatabase, eventually, tempDir } from "./helpers.js";

const androidDocument = () => ({
  project_info: { project_id: "test-project", project_number: "123456", storage_bucket: "unrelated" },
  client: [{ client_info: { mobilesdk_app_id: "1:123456:android:abcdef", android_client_info: { package_name: "dev.pibot.android" } },
    api_key: [{ current_key: "A" + "x".repeat(38) }], oauth_client: [{ secret: "never-distribute" }] }],
  private_key: "never-distribute",
});

test("FCM configuration is optional, but explicit missing credentials fail immediately", async () => {
  const config = settings({ PI_BOT_DATABASE_URL: "unused", PI_BOT_JWT_SECRET: "j".repeat(40) });
  assert.equal(await firebaseTransport(config), undefined);
  await assert.rejects(firebaseTransport({ ...config, fcmProjectId: "project" }), /GOOGLE_APPLICATION_CREDENTIALS/);
  assert.ok(openapi().paths["/push/installations/{id}"].put);
  assert.ok(openapi().paths["/push/installations/{id}"].delete);
  assert.ok(openapi().paths["/push/config"].get);
  assert.equal(await loadAndroidPushConfig(config), undefined);
  await assert.rejects(loadAndroidPushConfig({ ...config, fcmProjectId: "test-project" }), /PI_BOT_FCM_ANDROID_CONFIG_FILE/);
  await assert.rejects(loadAndroidPushConfig({ ...config, fcmAndroidConfigFile: "unused" }), /PI_BOT_FCM_PROJECT_ID/);
});

test("Android configuration is allowlisted and rejects mismatched projects, packages, senders, and keys", () => {
  const document = androidDocument();
  const config = parseAndroidPushConfig(document, "test-project");
  assert.deepEqual(config, { project_id: "test-project", sender_id: "123456", application_id: "1:123456:android:abcdef",
    package_name: "dev.pibot.android", api_key: "A" + "x".repeat(38) });
  assert.equal(JSON.stringify(config).includes("never-distribute"), false);
  assert.throws(() => parseAndroidPushConfig(document, "other-project"));
  document.client[0].client_info.android_client_info.package_name = "other.app";
  assert.throws(() => parseAndroidPushConfig(document, "test-project"));
  const mismatched = androidDocument(); mismatched.project_info.project_number = "999";
  assert.throws(() => parseAndroidPushConfig(mismatched, "test-project"));
  const invalidKey = androidDocument(); invalidKey.client[0].api_key[0].current_key = "invalid";
  assert.throws(() => parseAndroidPushConfig(invalidKey, "test-project"));
});

test("explicit unreadable or malformed Android configuration fails startup without echoing JSON", async () => {
  const dir = tempDir();
  try {
    const file = join(dir.path, "google-services.json");
    const config = { ...settings({ PI_BOT_DATABASE_URL: "unused", PI_BOT_JWT_SECRET: "j".repeat(40) }),
      fcmProjectId: "test-project", fcmAndroidConfigFile: file };
    await assert.rejects(loadAndroidPushConfig(config), /不可读或无效/);
    await writeFile(file, JSON.stringify({ private_key: "never-distribute" }));
    await assert.rejects(createApp(config), e => e instanceof Error && !e.message.includes("never-distribute") && /不可读或无效/.test(e.message));
  } finally { dir.cleanup(); }
});

test("notification previews are bounded by Unicode characters and contain no markup", () => {
  assert.equal(pushSummary(" <b>Hello</b>\nworld ", "fallback"), "Hello world");
  assert.equal(pushSummary(" ", "fallback"), "fallback");
  assert.equal(Array.from(pushSummary("😀".repeat(200), "fallback")).length, 120);
});

test("FCM registration and durable delivery", { skip: !TEST_DB }, async t => {
  await resetDatabase(TEST_DB!);
  const s = settings({ PI_BOT_DATABASE_URL: TEST_DB!, PI_BOT_JWT_SECRET: "j".repeat(40), PI_BOT_ADMIN_PASSWORD: "admin-test-password" });
  const db = new Database(TEST_DB!);
  const app = await createApp(s, db);
  t.after(() => app.close());
  db.pushEnabled = true; // Exercise the queue with an injected sender, never real FCM.
  let user: Row, other: Row, bot: string, token: string, otherToken: string;
  await db.tx(async tx => {
    user = await tx.insert("users", { user_id: randomUUID(), username: "push-user", role: "user", password_hash: "unused" });
    other = await tx.insert("users", { user_id: randomUUID(), username: "push-other", role: "user", password_hash: "unused" });
    bot = (await createBot(tx, user.user_id, { name: "助手", persona: "" })).bot_id;
  });
  token = await issueToken(user!, s); otherToken = await issueToken(other!, s);
  const installation = randomUUID(), binding = randomUUID();
  const call = (method: "PUT" | "DELETE", id: string, bearer = token, body?: object, query = "") => app.inject({
    method, url: `/push/installations/${id}${query}`, headers: { authorization: `Bearer ${bearer}` }, payload: body,
  });
  const register = (id = installation, bind = binding, fcm = "token-one", bearer = token) =>
    call("PUT", id, bearer, { fcm_token: fcm, binding_id: bind });
  const messages: Message[] = [];
  let failure: unknown;
  const transport: PushTransport = { async send(m) { if (failure) throw failure; messages.push(m); }, async close() {} };
  let now = new Date();
  const clock = () => new Date(Math.max(now.getTime(), Date.now()));
  const dispatcher = new PushDispatcher(db, transport, clock);
  const dispatchOnce = async (sender = dispatcher) => {
    // PostgreSQL has microsecond precision. Advance the test clock beyond committed enqueue timestamps.
    const time = await db.tx(tx => tx.one("SELECT clock_timestamp() AS now"));
    now = new Date(Math.max(now.getTime(), new Date(time!.now).getTime() + 1));
    await sender.once();
  };
  const deliveries = () => db.tx(tx => tx.rows("SELECT * FROM push_deliveries ORDER BY event_id,installation_id"));
  const resetQueue = async () => { messages.length = 0; failure = undefined; now = new Date(); await db.tx(tx => tx.rows("DELETE FROM push_deliveries")); };
  const run = async (options: { origin?: "report" | "voice"; lane?: "task"; state?: "completed" | "failed" | "cancelled" } = {}) => db.tx(async tx => {
    const r = await insertRun(tx, { userId: user!.user_id, botId: bot!, requestId: randomUUID(), text: "question", computer: null, origin: options.origin === "voice" ? undefined : options.origin, lane: options.lane });
    if (options.origin === "voice") await tx.rows("UPDATE bot_runs SET origin='voice' WHERE run_id=$1", [r.run_id]);
    await finishRun(tx, r.run_id, options.state ?? "completed", options.state === "failed" ? "failed" : null, "结果");
    return r;
  });

  await t.test("authenticated, idempotent registration, token rotation, and owner-scoped deletion", async () => {
    assert.equal((await app.inject({ method: "GET", url: "/push/config" })).statusCode, 401);
    const disabled = await app.inject({ method: "GET", url: "/push/config", headers: { authorization: `Bearer ${token}` } });
    assert.deepEqual(disabled.json(), { enabled: false, firebase: null });
    assert.equal(disabled.headers["cache-control"], "no-store");
    assert.equal((await app.inject({ method: "PUT", url: `/push/installations/${installation}`, payload: { fcm_token: "x", binding_id: binding } })).statusCode, 401);
    assert.equal((await register()).statusCode, 200);
    assert.equal((await register()).statusCode, 200);
    assert.equal((await register(installation, binding, "rotated")).statusCode, 200);
    let rows = await db.tx(tx => tx.rows("SELECT * FROM push_installations"));
    assert.equal(rows.length, 1); assert.equal(rows[0].fcm_token, "rotated");
    assert.equal(Math.floor(new Date(rows[0].session_expires_at).getTime() / 1000), JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).exp);
    await call("DELETE", installation, otherToken, undefined, `?binding_id=${binding}`);
    rows = await db.tx(tx => tx.rows("SELECT * FROM push_installations")); assert.equal(rows.length, 1);
    assert.equal((await call("PUT", installation, token, { fcm_token: "x", binding_id: "bad" })).statusCode, 422);
    await register();
  });

  await t.test("an older registration racing the first insert cannot replace a newer login", async () => {
    const id = randomUUID(), newerBinding = randomUUID();
    const issued = Math.floor(Date.now() / 1000);
    const oldToken = await new SignJWT({ typ: "user", role: user!.role }).setProtectedHeader({ alg: "HS256" })
      .setSubject(user!.user_id).setIssuedAt(issued - 60).setExpirationTime(issued + 3600)
      .sign(new TextEncoder().encode(s.jwtSecret));
    const connection = await db.pool.connect();
    let pending: ReturnType<typeof register> | undefined;
    try {
      await connection.query("BEGIN");
      await connection.query(`INSERT INTO push_installations(installation_id,user_id,fcm_token,binding_id,session_expires_at,session_issued_at)
        VALUES($1,$2,'newer-token',$3,to_timestamp($4),$5)`, [id, user!.user_id, newerBinding, issued + 3600, issued]);
      pending = register(id, randomUUID(), "older-token", oldToken);
      // The old request sees no committed row, then waits for the conflicting insert.
      await eventually(() => db.tx(tx => tx.one(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock'
        AND query LIKE 'INSERT INTO push_installations%'`)));
      await connection.query("COMMIT");
      assert.equal((await pending).statusCode, 409);
      const row = await db.tx(tx => tx.one("SELECT * FROM push_installations WHERE installation_id=$1", [id]));
      assert.equal(row!.binding_id, newerBinding);
      assert.equal(row!.fcm_token, "newer-token");
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
      await pending;
      await db.tx(tx => tx.rows("DELETE FROM push_installations WHERE installation_id=$1", [id]));
    }
  });

  await t.test("public final replies and task/goal reports enqueue once per phone", async () => {
    await resetQueue();
    const second = randomUUID(); await register(second, randomUUID(), "phone-two");
    const r = await run();
    await db.tx(tx => enqueueMessage(tx, r));
    await db.tx(tx => finishRun(tx, r.run_id, "completed", null, "duplicate"));
    assert.equal((await deliveries()).length, 2);
    await dispatchOnce(); assert.equal(messages.length, 2);
    assert.equal(messages[0].android?.priority, "high");
    assert.equal(messages[0].data?.message_id, r.assistant_message_id);
    assert.equal("notification" in messages[0], false);
    await dispatchOnce(); assert.equal(messages.length, 2);
    await run({ origin: "report" }); // Both task handoff and goal progress use public report runs.
    await run({ state: "failed" });
    assert.equal((await deliveries()).length, 6);
    await db.tx(tx => tx.rows("DELETE FROM push_installations WHERE installation_id=$1", [second]));
  });

  await t.test("rollback, disabled push, internal task, voice, and cancellation do not notify", async () => {
    await resetQueue();
    await assert.rejects(db.tx(async tx => {
      const r = await insertRun(tx, { userId: user!.user_id, botId: bot!, requestId: randomUUID(), text: "rollback", computer: null });
      await finishRun(tx, r.run_id, "completed", null, "must rollback");
      throw new Error("rollback");
    }), /rollback/);
    await run({ lane: "task" }); await run({ origin: "voice" }); await run({ state: "cancelled" });
    db.pushEnabled = false; await run(); db.pushEnabled = true;
    assert.equal((await deliveries()).length, 0);
  });

  await t.test("approvals send reasons only; resolved and expired requests are skipped", async () => {
    await resetQueue();
    const r = await run(); await resetQueue();
    const ids: string[] = [];
    await db.tx(async tx => {
      for (const status of ["pending", "approved", "expired"]) {
        const a = await tx.insert("approvals", { approval_id: randomUUID(), user_id: user!.user_id, bot_id: bot!, run_id: r.run_id,
          kind: "outside_access", detail: { path: "SECRET-PATH", reason: "需要读取资料 SECRET-PATH" }, status,
          expires_at: new Date(Date.now() + (status === "expired" ? -1000 : 60000)) });
        ids.push(a.approval_id); await enqueueApproval(tx, a);
      }
    });
    await dispatchOnce(); assert.equal(messages.length, 1);
    assert.equal(messages[0].data?.approval_id, ids[0]);
    assert.equal(messages[0].data?.body, "需要读取资料 所请求的文件");
    assert.equal(JSON.stringify(messages).includes("SECRET-PATH"), false);
  });

  await t.test("transient errors retry and a new dispatcher recovers expired leases", async () => {
    await resetQueue(); await run();
    failure = { code: "messaging/server-unavailable" }; await dispatchOnce();
    let row = (await deliveries())[0]; assert.equal(row.finished_at, null); assert.equal(row.attempts, 1);
    assert.ok(new Date(row.available_at) > now);
    failure = undefined; now = new Date(now.getTime() + 15000);
    await db.tx(tx => tx.rows("UPDATE push_deliveries SET lease_id=$1,lease_until=$2", [randomUUID(), new Date(now.getTime() + 1000)]));
    await dispatchOnce(); assert.equal(messages.length, 0);
    now = new Date(now.getTime() + 2000);
    await dispatchOnce(new PushDispatcher(db, transport, clock));
    row = (await deliveries())[0]; assert.equal(row.outcome, "sent"); assert.equal(messages.length, 1);
  });

  await t.test("old bindings, disabled accounts, and expired sessions never receive queued data", async () => {
    await resetQueue(); await run();
    const replacement = randomUUID(); await register(installation, replacement);
    // A delayed unregister from the old login must leave the new binding intact.
    await call("DELETE", installation, token, undefined, `?binding_id=${binding}`);
    await dispatchOnce(); assert.equal(messages.length, 0);
    await register(); await resetQueue(); await run();
    await db.tx(tx => tx.rows("UPDATE users SET disabled=true WHERE user_id=$1", [user!.user_id]));
    await dispatchOnce(); assert.equal(messages.length, 0);
    await db.tx(tx => tx.rows("UPDATE users SET disabled=false WHERE user_id=$1", [user!.user_id]));
    await resetQueue(); await run();
    await db.tx(tx => tx.rows("UPDATE push_installations SET session_expires_at=now()-interval '1 second'"));
    await dispatchOnce(); assert.equal(messages.length, 0);
    await register();
  });

  await t.test("invalid tokens are disabled; permanent payload errors finish without retry", async () => {
    await resetQueue(); await run(); failure = { code: "messaging/registration-token-not-registered" };
    await dispatchOnce(); assert.equal((await deliveries())[0].outcome, "invalid-token");
    assert.ok((await db.tx(tx => tx.one("SELECT disabled_at FROM push_installations")))!.disabled_at);
    await register(); await resetQueue(); await run(); failure = { code: "messaging/invalid-argument" };
    await dispatchOnce(); assert.equal((await deliveries())[0].outcome, "permanent-error");
    await register(); await resetQueue(); await run();
    now = new Date(Date.now() + 86401_000); await dispatchOnce(); assert.equal(messages.length, 0);
  });

  await t.test("the configured API starts the sender and closes it before the database", async () => {
    await resetQueue(); await register();
    const sent: Message[] = [];
    let closed = false;
    const dir = tempDir(); t.after(() => dir.cleanup());
    const file = join(dir.path, "google-services.json");
    await writeFile(file, JSON.stringify(androidDocument()));
    const api = await createApp({ ...s, fcmProjectId: "test-project", fcmAndroidConfigFile: file }, new Database(TEST_DB!), undefined, undefined, undefined,
      async () => ({ async send(m) { sent.push(m); }, async close() { closed = true; } }));
    try {
      const config = await api.inject({ method: "GET", url: "/push/config", headers: { authorization: `Bearer ${token}` } });
      assert.deepEqual(config.json(), { enabled: true, firebase: parseAndroidPushConfig(androidDocument(), "test-project") });
      assert.equal(config.body.includes("never-distribute"), false);
      assert.equal((await api.inject({ method: "PUT", url: `/push/installations/${installation}`, headers: { authorization: `Bearer ${token}` },
        payload: { binding_id: binding, fcm_token: "wrong-project-token", firebase_project_id: "other-project" } })).statusCode, 409);
      assert.equal((await api.inject({ method: "PUT", url: `/push/installations/${installation}`, headers: { authorization: `Bearer ${token}` },
        payload: { binding_id: binding, fcm_token: "token-one", firebase_project_id: "test-project" } })).statusCode, 200);
      const r = await run();
      await eventually(async () => (await deliveries()).some(d => d.source_id === r.assistant_message_id && d.outcome === "sent"));
      assert.equal(sent.length, 1);
    } finally { await api.close(); }
    assert.equal(closed, true);
  });
});
