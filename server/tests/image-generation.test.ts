import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { generateImage, generatedImage, generationRequest, generateImageBody, imageBaseUrl, imageConfigBody, IMAGE_MODELS, MAX_GENERATED_IMAGE_BYTES } from "../src/image-generation.js";
import { createApp } from "../src/app.js";
import { Database, HttpError } from "../src/db.js";
import { settings } from "../src/config.js";
import { insertRun } from "../src/bots.js";
import { issueLlmToken } from "../src/security.js";
import { messageAttachments } from "../src/reports.js";
import { TEST_DB, resetDatabase, tempDir, vaultFile } from "./helpers.js";

const png = () => sharp({ create: { width: 32, height: 24, channels: 3, background: "#f4692a" } }).png().toBuffer();

test("CLIProxy presets route Grok/GPT to Images and Gemini to native generation, preserving path prefixes", () => {
  const base = imageBaseUrl("https://proxy.example/prefix/v1/");
  assert.equal(base, "https://proxy.example/prefix");
  for (const model of IMAGE_MODELS) {
    const r = generationRequest(base, { model, prompt: "一只橙色小机器人", aspect_ratio: "3:2" });
    if (model.startsWith("gemini")) {
      assert.equal(r.url, `${base}/v1beta/models/${model}:generateContent`);
      assert.deepEqual(r.body.generationConfig, { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "3:2" } });
    } else {
      assert.equal(r.url, `${base}/v1/images/generations`);
      assert.deepEqual(r.body, { model, prompt: "一只橙色小机器人", n: 1, response_format: "b64_json", size: "1536x1024" });
    }
  }
  for (const url of ["file:///tmp", "https://user:secret@proxy.example", "https://proxy.example/?key=private", "https://proxy.example/#key", "invalid"])
    assert.throws(() => imageBaseUrl(url), HttpError);
  assert.equal(imageConfigBody.safeParse({ enabled: true, base_url: base, models: [IMAGE_MODELS[0]], default_model: IMAGE_MODELS[1] }).success, false);
  assert.equal(generateImageBody.safeParse({ run_id: randomUUID(), request_id: "test", prompt: "  " }).success, false);
});

test("image responses decode actual bytes, ignore Gemini thoughts and reject remote URLs, corrupt data and oversize images", async () => {
  const bytes = await png(), data = bytes.toString("base64");
  for (const payload of [{ data: [{ b64_json: data }] }, { data: [{ url: `data:image/png;base64,${data}` }] }]) {
    const image = await generatedImage(payload, false);
    assert.equal(image!.mime, "image/png"); assert.equal(image!.width, 32); assert.deepEqual(image!.bytes, bytes);
  }
  const image = await generatedImage({ candidates: [{ content: { parts: [
    { thought: true, inlineData: { data: "invalid" } }, { inlineData: { mimeType: "image/jpeg", data } },
  ] } }] }, true);
  assert.equal(image!.mime, "image/png", "use actual content format, not provider MIME");
  for (const payload of [{}, { data: [{ url: "http://169.254.169.254/latest/meta-data" }] },
    { data: [{ b64_json: "not an image" }] }, { data: [{ b64_json: data + "!" }] },
    { data: [{ b64_json: "A".repeat(Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4 + 4) }] }])
    await assert.rejects(generatedImage(payload, false), HttpError);
});

test("provider calls carry only gateway auth, bound responses and sanitize failures/cancellation", async () => {
  const data = (await png()).toString("base64");
  const input = generateImageBody.parse({ run_id: randomUUID(), request_id: "one", model: IMAGE_MODELS[0], prompt: "机器人" });
  const requests: { url: string; init?: RequestInit }[] = [];
  const request: typeof fetch = async (url, init) => { requests.push({ url: String(url), init }); return Response.json({ data: [{ b64_json: data }] }); };
  await generateImage("https://proxy.example", "private-key", input, undefined, request);
  assert.equal(new Headers(requests[0].init?.headers).get("authorization"), "Bearer private-key");
  assert.equal(requests[0].init?.redirect, "error");
  assert.equal(JSON.stringify(JSON.parse(String(requests[0].init?.body))).includes("run_id"), false);
  for (const status of [400, 401, 403, 429, 500]) await assert.rejects(
    generateImage("https://proxy.example", "private-key", input, undefined, async () => Response.json({ error: "private-key private-provider-detail" }, { status })),
    error => { assert.ok(error instanceof HttpError); assert.doesNotMatch(error.message, /private-key|private-provider-detail/); return true; });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(generateImage("https://proxy.example", "key", input, abort.signal,
    async (_url, init) => { init?.signal?.throwIfAborted(); throw new Error("should not reach"); }), /取消/);
  await assert.rejects(generateImage("https://proxy.example", "key", input, undefined,
    async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(16 * 1024 * 1024)); controller.close(); } }))), /大小限制/);
});

test("generation API encrypts configuration, scopes tasks, publishes downloads and deduplicates paid calls", { skip: !TEST_DB }, async t => {
  await resetDatabase(TEST_DB!);
  const dir = tempDir(), db = new Database(TEST_DB!);
  const s = settings({ PI_BOT_DATABASE_URL: TEST_DB!, PI_BOT_ADMIN_PASSWORD: "test-password", PI_BOT_JWT_SECRET: "j".repeat(40),
    PI_BOT_VAULT_FILE: vaultFile(dir.path), PI_BOT_REMOTE_BACKEND: "none", PI_BOT_LOCAL_WORK_ROOT: "/pibot-test-workspaces" });
  const bytes = await png(), data = bytes.toString("base64");
  const calls: { path: string; body: any }[] = [];
  let providerStatus = 200;
  let hold: (() => void) | undefined;
  const provider = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push({ path: req.url!, body });
    assert.equal(req.headers.authorization, "Bearer fixture-image-key");
    const respond = () => { res.writeHead(providerStatus, { "Content-Type": "application/json" }); res.end(JSON.stringify(req.url!.includes("v1beta")
      ? { candidates: [{ content: { parts: [{ inlineData: { data, mimeType: "image/png" } }] } }] }
      : { data: [{ b64_json: data }] })); };
    if (body.prompt === "hold" || body.prompt === "cancel") hold = respond; else respond();
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const app = await createApp(s, db);
  t.after(async () => { hold?.(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); await app.close(); dir.cleanup(); });
  const login = (await app.inject({ method: "POST", url: "/auth/login", payload: { username: "admin", password: "test-password" } })).json();
  const headers = { authorization: `Bearer ${login.access_token}` };
  const admin = (method: "GET" | "PUT" | "POST", url: string, payload?: object) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  const config = { enabled: true, base_url: `${base}/v1`, models: [...IMAGE_MODELS], default_model: IMAGE_MODELS[1] };
  assert.equal((await admin("PUT", "/admin/api/image-generation", config)).statusCode, 422);
  const saved = await admin("PUT", "/admin/api/image-generation", { ...config, api_key: "fixture-image-key" });
  assert.equal(saved.statusCode, 200, saved.body); assert.equal(saved.json().configured, true);
  assert.doesNotMatch(saved.body, /fixture-image-key|secret/);
  assert.equal((await admin("PUT", "/admin/api/image-generation", config)).statusCode, 200);
  const row = await db.tx(tx => tx.one("SELECT * FROM image_generation_config"));
  assert.ok(row!.secret); assert.doesNotMatch(JSON.stringify(row!.secret), /fixture-image-key/);
  await admin("POST", "/admin/api/models", { name: "chat", base_url: base, provider_model: "test", api_key: "unused", context_window: 32000, max_tokens: 1000 });
  const bot = (await admin("GET", "/bots")).json().bots[0].id;
  const createRun = () => db.tx(tx => insertRun(tx, { userId: login.user.id, botId: bot, requestId: randomUUID(), text: "生图", computer: null, lane: "task" }));
  const run = await createRun();
  const token = await issueLlmToken({ sub: login.user.id, bot, src: "cloud" }, s);
  const llmHeaders = { authorization: `Bearer ${token}` };
  const generate = (payload: object, auth = llmHeaders) => app.inject({ method: "POST", url: "/agent/images/generate", headers: auth,
    payload: { run_id: run.run_id, request_id: "one", prompt: "orange robot", ...payload } });
  const models = await app.inject({ method: "POST", url: "/agent/image-models", headers: llmHeaders, payload: { run_id: run.run_id } });
  assert.deepEqual(models.json().models, IMAGE_MODELS); assert.doesNotMatch(models.body, /fixture-image-key|base_url/);
  assert.equal((await generate({}, headers)).statusCode, 401, "human login is not an agent token");
  const wrong = await issueLlmToken({ sub: login.user.id, bot: randomUUID(), src: "cloud" }, s);
  assert.equal((await generate({}, { authorization: `Bearer ${wrong}` })).statusCode, 404);
  await db.tx(tx => tx.update("bot_runs", run.run_id, { automation_readonly: true }));
  assert.equal((await generate({})).statusCode, 403);
  await db.tx(tx => tx.update("bot_runs", run.run_id, { automation_readonly: false, lane: "conversation" }));
  assert.equal((await generate({})).statusCode, 403);
  await db.tx(tx => tx.update("bot_runs", run.run_id, { lane: "task" }));
  const first = await generate({}); assert.equal(first.statusCode, 200, first.body);
  const artifact = first.json().artifact;
  assert.equal(artifact.mime, "image/png"); assert.doesNotMatch(first.body, new RegExp(data));
  assert.equal(calls[0].body.model, IMAGE_MODELS[1]);
  assert.equal((await generate({})).json().artifact.id, artifact.id);
  assert.equal(calls.length, 1);
  await admin("PUT", "/admin/api/image-generation", { ...config, enabled: false });
  assert.equal((await generate({})).json().artifact.id, artifact.id, "cached output survives provider disable");
  assert.equal((await generate({ request_id: "disabled" })).statusCode, 503);
  await admin("PUT", "/admin/api/image-generation", { ...config, models: [IMAGE_MODELS[1]] });
  assert.equal((await generate({ request_id: "not-enabled", model: IMAGE_MODELS[0] })).statusCode, 422);
  await admin("PUT", "/admin/api/image-generation", config);
  assert.equal((await generate({ prompt: "changed" })).statusCode, 409);
  assert.equal((await db.tx(tx => messageAttachments(tx, [run.assistant_message_id]))).get(run.assistant_message_id)![0].id, artifact.id);
  const opened = await admin("POST", `/reports/${artifact.id}/open`);
  const ticket = opened.json().url.split("#token=")[1];
  const download = await app.inject({ method: "GET", url: `/reports/${artifact.id}/content?ticket=${encodeURIComponent(ticket)}` });
  assert.equal(download.headers["content-type"], "image/png"); assert.deepEqual(download.rawPayload, bytes);
  assert.equal((await app.inject({ method: "GET", url: `/reports/${artifact.id}/content?ticket=invalid` })).statusCode, 401);
  const other = await admin("POST", "/admin/api/users", { username: "image-other", password: "other-password", display_name: "其他用户" });
  assert.equal(other.statusCode, 200, other.body);
  const otherLogin = (await app.inject({ method: "POST", url: "/auth/login", payload: { username: "image-other", password: "other-password" } })).json();
  const otherHeaders = { authorization: `Bearer ${otherLogin.access_token}` };
  assert.equal((await app.inject({ method: "GET", url: "/admin/api/image-generation", headers: otherHeaders })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: `/reports/${artifact.id}/open`, headers: otherHeaders })).statusCode, 404);
  const otherAgent = await issueLlmToken({ sub: otherLogin.user.id, bot, src: "cloud" }, s);
  assert.equal((await generate({}, { authorization: `Bearer ${otherAgent}` })).statusCode, 404);
  for (const [index, model] of IMAGE_MODELS.entries()) assert.equal((await generate({ request_id: `model-${index}`, model })).statusCode, 200);
  assert.equal(calls.at(-1)!.path, `/v1beta/models/${IMAGE_MODELS[2]}:generateContent`);
  providerStatus = 401;
  const failed = await generate({ request_id: "failed" }); assert.equal(failed.statusCode, 502);
  providerStatus = 200;
  const count = calls.length;
  assert.equal((await generate({ request_id: "failed" })).statusCode, 409); assert.equal(calls.length, count);
  const waitForHold = async () => { for (let i = 0; i < 100 && !hold; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(hold); };
  const pending = generate({ request_id: "pending", prompt: "hold" });
  // LightMyRequest starts an injection only once it is awaited/then'ed.
  const response = Promise.resolve(pending);
  await waitForHold();
  assert.equal((await generate({ request_id: "pending", prompt: "hold" })).statusCode, 409);
  assert.equal((await generate({ request_id: "concurrent" })).statusCode, 429);
  hold!(); hold = undefined;
  assert.equal((await response).statusCode, 200);
  const cancelling = Promise.resolve(generate({ request_id: "cancelled", prompt: "cancel" }));
  await waitForHold();
  await db.tx(tx => tx.update("bot_runs", run.run_id, { cancel_requested: true }));
  assert.equal((await cancelling).statusCode, 499);
  hold!(); hold = undefined;
  assert.equal((await db.tx(tx => tx.one("SELECT status FROM image_generation_jobs WHERE run_id=$1 AND call_id='cancelled'", [run.run_id])))!.status, "unknown");
  assert.equal((await db.tx(tx => tx.rows("SELECT 1 FROM report_artifacts WHERE run_id=$1 AND call_id='image:cancelled'", [run.run_id]))).length, 0);
});
