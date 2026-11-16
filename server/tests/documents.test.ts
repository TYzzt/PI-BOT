import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { createApp } from "../src/app.js";
import { Database } from "../src/db.js";
import { settings } from "../src/config.js";
import { insertRun, createBot, buildContext, finishRun } from "../src/bots.js";
import { AgentDispatcher, createTask, readTask } from "../src/agents.js";
import { recordReply } from "../src/replies.js";
import { searchHistory, resumeTask } from "../src/memory.js";
import { messageAttachments } from "../src/reports.js";
import { Hub } from "../src/hub.js";
import { issueLlmToken, issueToken } from "../src/security.js";
import { processDocument } from "../../packages/agent/src/documents/runtime.js";
import { DOCUMENT_CHUNK } from "../../packages/agent/src/documents/spec.js";
import { RemoteService } from "../src/remote/service.js";
import { Readable } from "node:stream";
import { TEST_DB, resetDatabase, tempDir, vaultFile } from "./helpers.js";
test(
  "documents upload idempotently, attach to context, enforce bot isolation and publish binary downloads",
  { skip: !TEST_DB },
  async (t) => {
    await resetDatabase(TEST_DB!);
    const dir = tempDir(),
      db = new Database(TEST_DB!);
    const s = settings({
      PI_BOT_LOCAL_WORK_ROOT: "/pibot-test-workspaces",
      PI_BOT_REMOTE_BACKEND: "none",
      PI_BOT_DATABASE_URL: TEST_DB!,
      PI_BOT_ADMIN_PASSWORD: "test-password",
      PI_BOT_JWT_SECRET: "j".repeat(40),
      PI_BOT_VAULT_FILE: vaultFile(dir.path),
    });
    const library = new Map<string, Buffer>();
    const app = await createApp(s, db, undefined, undefined, (db, settings) => {
      const remote = new RemoteService(db, settings);
      t.mock.method(
        remote,
        "action",
        async (
          _env: any,
          _run: any,
          _slug: string,
          _call: string,
          action: string,
          args: any,
        ) => {
          assert.equal(action, "upload");
          library.set(args.path, Buffer.from(args.base64, "base64"));
          return { path: args.path };
        },
      );
      t.mock.method(
        remote,
        "file",
        async (_user: string, _bot: string, _env: string, path: string) => {
          assert.ok(library.has(path), `library file missing: ${path}`);
          return {
            path,
            sftp: {
              createReadStream: () => Readable.from([library.get(path)!]),
              end() {},
            },
          };
        },
      );
      return remote;
    });
    t.after(async () => {
      await app.close();
      dir.cleanup();
    });
    const login = (
      await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username: "admin", password: "test-password" },
      })
    ).json();
    const user = login.user.id;
    const api = (
      method: "GET" | "POST" | "DELETE",
      url: string,
      payload?: object,
      bearer = login.access_token,
    ) =>
      app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${bearer}` },
        ...(payload ? { payload } : {}),
      });
    await api("POST", "/admin/api/models", {
      name: "test",
      base_url: "http://127.0.0.1:1/v1",
      provider_model: "test",
      api_key: "unused",
      context_window: 32000,
      max_tokens: 1000,
    });
    const bot = (await api("GET", "/bots")).json().bots[0].id;
    const bytes = (
      await processDocument({
        action: "write",
        name: "中文文档.docx",
        content: {
          paragraphs: [{ text: "文档接入验收" }],
          tables: [
            [
              ["名称", "结果"],
              ["上传", "通过"],
            ],
          ],
        },
      })
    ).bytes as Buffer;
    const upload = randomUUID(),
      begin = () =>
        api("POST", `/bots/${bot}/documents/uploads`, {
          request_id: upload,
          name: "中文文档.docx",
          size: bytes.length,
        });
    assert.equal((await begin()).statusCode, 200);
    assert.equal(
      (
        await api("POST", `/bots/${bot}/documents/uploads`, {
          request_id: randomUUID(),
          name: "huge.xlsx",
          size: 10 * 1024 * 1024 + 1,
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await api("POST", `/documents/uploads/${upload}/chunks`, {
          part: 0,
          data: bytes.toString("base64"),
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await api("POST", `/documents/uploads/${upload}/chunks`, {
          part: 0,
          data: bytes.toString("base64"),
        })
      ).statusCode,
      200,
    );
    const changed = Buffer.from(bytes);
    changed[0] = 0;
    assert.equal(
      (
        await api("POST", `/documents/uploads/${upload}/chunks`, {
          part: 0,
          data: changed.toString("base64"),
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await api("POST", `/documents/uploads/${upload}/complete`, {
          sha256: "0".repeat(64),
        })
      ).statusCode,
      422,
    );
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const completed = await api(
      "POST",
      `/documents/uploads/${upload}/complete`,
      { sha256 },
    );
    assert.equal(completed.statusCode, 200, completed.body);
    const artifact = completed.json().artifact;
    assert.equal(
      (
        await api("POST", `/documents/uploads/${upload}/complete`, { sha256 })
      ).json().artifact.id,
      artifact.id,
    );
    assert.equal((await begin()).json().artifact.id, artifact.id);
    const sent = await api("POST", `/bots/${bot}/messages`, {
      request_id: randomUUID(),
      document_ids: [artifact.id],
    });
    assert.equal(sent.statusCode, 200, sent.body);
    assert.equal(sent.json().messages.find((m: any) => m.role === "user").attachments[0].id, artifact.id);
    const context = await db.tx(async (tx) =>
      buildContext(tx, s, await tx.get("bot_runs", sent.json().run.id, true)),
    );
    assert.match(context.text, /中文文档/);
    assert.match(context.text, new RegExp(artifact.id));
    assert.ok(!JSON.stringify(context).includes(bytes.toString("base64")));
    await db.tx(tx => finishRun(tx, sent.json().run.id, "completed", null, "请说明处理要求。"));
    const followup = await api("POST", `/bots/${bot}/messages`, {
      request_id: randomUUID(), text: "请分析刚才上传的文档",
    });
    assert.equal(followup.statusCode, 200, followup.body);
    await db.tx(async tx => {
      const next = await tx.get("bot_runs", followup.json().run.id);
      const nextContext = await buildContext(tx, s, next);
      assert.ok(nextContext.history.some(m => m.role === "user" && m.content.includes(artifact.id)));
      const history = await searchHistory(tx, user, { sub: user, src: "cloud", bot }, next.run_id, "中文文档");
      assert.equal(history.matches[0].attachments[0].id, artifact.id);
      assert.ok(!JSON.stringify(history).includes(bytes.toString("base64")));
      await finishRun(tx, next.run_id, "completed", null, "已收到处理要求。");
    });
    const run = await db.tx(async (tx) => {
      const r = await insertRun(tx, {
        userId: user,
        botId: bot,
        requestId: randomUUID(),
        text: "处理文档",
        computer: null,
        lane: "task",
      });
      return tx.update("bot_runs", r.run_id, { status: "running" });
    });
    const token = await issueLlmToken({ sub: user, src: "cloud", bot }, s);
    const read = await api(
      "POST",
      "/agent/documents/action",
      {
        run_id: run.run_id,
        request_id: "read",
        artifact_id: artifact.id,
        job: { action: "read", name: "document.pdf" },
      },
      token,
    );
    assert.equal(read.statusCode, 200, read.body);
    assert.match(read.body, /文档接入验收/);
    const written = await api(
      "POST",
      "/agent/documents/action",
      {
        run_id: run.run_id,
        request_id: "write",
        job: {
          action: "write",
          name: "结果.xlsx",
          content: { sheets: [{ name: "验证", rows: [["结果"], ["通过"]] }] },
        },
      },
      token,
    );
    assert.equal(written.statusCode, 200, written.body);
    const output = written.json().artifact;
    const published = await api(
      "POST",
      "/agent/documents/publish",
      { run_id: run.run_id, artifact_id: output.id },
      token,
    );
    assert.equal(published.statusCode, 200, published.body);
    const open = (await api("POST", `/reports/${output.id}/open`)).json();
    const ticket = new URLSearchParams(open.url.split("#")[1]).get("token");
    const download = await app.inject({
      method: "GET",
      url: `/reports/${output.id}/content?ticket=${ticket}&download=1`,
    });
    assert.equal(download.statusCode, 200);
    assert.match(download.headers["content-type"]!, /spreadsheetml/);
    assert.match(download.headers["content-disposition"]!, /filename\*=UTF-8/);
    assert.equal(download.rawPayload.subarray(0, 2).toString(), "PK");
    assert.equal(
      (
        await api(
          "POST",
          `/agent/reports/${output.id}/read`,
          { run_id: run.run_id },
          token,
        )
      ).statusCode,
      422,
    );
    const other = await db.tx((tx) =>
      createBot(tx, user, { name: "隔离测试", persona: "" }),
    );
    const otherRun = await db.tx(async (tx) => {
      const r = await insertRun(tx, {
        userId: user,
        botId: other.bot_id,
        requestId: randomUUID(),
        text: "不能读取",
        computer: null,
        lane: "task",
      });
      return tx.update("bot_runs", r.run_id, { status: "running" });
    });
    const otherToken = await issueLlmToken(
      { sub: user, src: "cloud", bot: other.bot_id },
      s,
    );
    const cross = () =>
      api(
        "POST",
        "/agent/documents/action",
        {
          run_id: otherRun.run_id,
          request_id: "cross",
          artifact_id: artifact.id,
          job: { action: "read", name: "document.docx" },
        },
        otherToken,
      );
    assert.equal((await cross()).statusCode, 404);
    await db.tx((tx) =>
      tx.rows(
        "INSERT INTO message_artifacts(message_id,artifact_id) VALUES($1,$2)",
        [otherRun.user_message_id, artifact.id],
      ),
    );
    assert.equal((await cross()).statusCode, 200);
    const environmentId = randomUUID();
    await db.tx(async (tx) => {
      await tx.insert("remote_environments", {
        environment_id: environmentId,
        user_id: user,
        backend: "ssh",
        secret: {},
      });
      await tx.update("bot_runs", run.run_id, {
        operation_target: `remote:${environmentId}`,
      });
    });
    const cloudWrite = await api(
      "POST",
      "/agent/documents/action",
      {
        run_id: run.run_id,
        request_id: "cloud-write",
        job: {
          action: "write",
          name: "云端.xlsx",
          content: { sheets: [{ name: "数据", rows: [["云端资料库"]] }] },
        },
      },
      token,
    );
    assert.equal(cloudWrite.statusCode, 200, cloudWrite.body);
    assert.ok(library.has(cloudWrite.json().path));
    const cloudRead = await api(
      "POST",
      "/agent/documents/action",
      {
        run_id: run.run_id,
        request_id: "cloud-read",
        path: cloudWrite.json().path,
        job: { action: "read", name: "document.xlsx" },
      },
      token,
    );
    assert.equal(cloudRead.statusCode, 200, cloudRead.body);
    assert.match(cloudRead.body, /云端资料库/);
    // Files generated with another environment tool are published as-is, including PDF.
    const generatedPdf = Buffer.from(
      "%PDF-1.4\n1 0 obj <</Type /Catalog>> endobj\n%%EOF",
    );
    library.set("documents/generated.pdf", generatedPdf);
    const cloudPdf = await api(
      "POST",
      "/agent/documents/publish",
      {
        run_id: run.run_id,
        request_id: "cloud-pdf",
        path: "documents/generated.pdf",
      },
      token,
    );
    assert.equal(cloudPdf.statusCode, 200, cloudPdf.body);
    assert.equal(cloudPdf.json().artifact.mime, "application/pdf");
    const savedPdf = await db.tx((tx) =>
      tx.get("report_artifacts", cloudPdf.json().artifact.id),
    );
    assert.deepEqual(Buffer.from(savedPdf.body), generatedPdf);
    assert.equal(
      (
        await api(
          "POST",
          "/agent/documents/publish",
          {
            run_id: run.run_id,
            path: "../outside.pdf",
          },
          token,
        )
      ).statusCode,
      422,
    );
    await db.tx((tx) =>
      tx.update("bot_runs", run.run_id, { automation_readonly: true }),
    );
    assert.equal(
      (
        await api(
          "POST",
          "/agent/documents/publish",
          { run_id: run.run_id, artifact_id: output.id },
          token,
        )
      ).statusCode,
      403,
    );
    const otherUser = await db.tx((tx) =>
      tx.insert("users", {
        user_id: randomUUID(),
        username: "other",
        password_hash: "unused",
        role: "user",
      }),
    );
    const actor = await issueToken(otherUser, s);
    assert.equal(
      (await api("POST", `/reports/${artifact.id}/open`, {}, actor)).statusCode,
      404,
    );
    const large = Buffer.concat([
        Buffer.from("%PDF-1.4\n"),
        randomBytes(DOCUMENT_CHUNK + 17),
      ]),
      multi = randomUUID();
    await api("POST", `/bots/${bot}/documents/uploads`, {
      request_id: multi,
      name: "large.pdf",
      size: large.length,
    });
    const finish = () =>
      api("POST", `/documents/uploads/${multi}/complete`, {
        sha256: createHash("sha256").update(large).digest("hex"),
      });
    assert.equal((await finish()).statusCode, 422);
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await api("POST", `/documents/uploads/${multi}/chunks`, {
            part: i,
            data: large
              .subarray(i * DOCUMENT_CHUNK, (i + 1) * DOCUMENT_CHUNK)
              .toString("base64"),
          })
        ).statusCode,
        200,
      );
    assert.equal((await finish()).statusCode, 200);
    assert.equal(
      (await api("DELETE", `/documents/uploads/${multi}`)).statusCode,
      200,
    );
  },
);

test("document tasks preserve answers and forward only published files in wait, report and resumed tasks", { skip: !TEST_DB }, async t => {
  await resetDatabase(TEST_DB!);
  const dir = tempDir(), db = new Database(TEST_DB!), hub = new Hub();
  const s = settings({
    PI_BOT_LOCAL_WORK_ROOT: "/pibot-test-workspaces", PI_BOT_REMOTE_BACKEND: "none",
    PI_BOT_DATABASE_URL: TEST_DB!, PI_BOT_ADMIN_PASSWORD: "test-password",
    PI_BOT_JWT_SECRET: "j".repeat(40), PI_BOT_VAULT_FILE: vaultFile(dir.path),
  });
  const app = await createApp(s, db, hub);
  t.after(async () => { await app.close(); dir.cleanup(); });
  const login = (await app.inject({ method: "POST", url: "/auth/login", payload: { username: "admin", password: "test-password" } })).json();
  const user = login.user.id;
  const headers = { authorization: `Bearer ${login.access_token}` };
  await app.inject({ method: "POST", url: "/admin/api/models", headers, payload: {
    name: "test", base_url: "http://127.0.0.1:1/v1", provider_model: "test", api_key: "unused", context_window: 32000, max_tokens: 1000,
  } });
  const bot = (await app.inject({ method: "GET", url: "/bots", headers })).json().bots[0].id;
  const other = await db.tx(tx => createBot(tx, user, { name: "文档助手", persona: "" }));
  const claims = (id = bot) => ({ sub: user, src: "cloud" as const, bot: id });
  const newRun = (lane: "task" | "conversation") => db.tx(async tx => {
    const r = await insertRun(tx, { userId: user, botId: bot, requestId: randomUUID(), text: "处理文档", computer: null, lane });
    return tx.update("bot_runs", r.run_id, { status: "running" });
  });
  const bytes = (await processDocument({ action: "write", name: "原件.docx", content: { paragraphs: [{ text: "需要核对的文档内容" }] } })).bytes as Buffer;
  const documentApi = async (path: string, run: Record<string, any>, body: object) => {
    const token = await issueLlmToken(claims(run.bot_id), s);
    const response = await app.inject({ method: "POST", url: `/agent/documents/${path}`,
      headers: { authorization: `Bearer ${token}` }, payload: { run_id: run.run_id, ...body } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const save = async (run: Record<string, any>, name: string) =>
    (await documentApi("save", run, { name, request_id: randomUUID(), data: bytes.toString("base64") })).artifact;
  const files = async (messageId: string) => db.tx(async tx =>
    (await messageAttachments(tx, [messageId])).get(messageId) ?? []);
  const originalRun = await newRun("task");
  const original = await save(originalRun, "已有文档.docx");
  await db.tx(tx => finishRun(tx, originalRun.run_id, "completed", null, "已有文档已保存。"));
  let previousTask: string | undefined;
  let previousPublished: string[] = [];
  for (const mode of ["report", "wait"] as const) {
    const parent = await newRun(mode === "report" ? "conversation" : "task");
    const created = await db.tx(async tx => {
      await tx.rows("INSERT INTO message_artifacts(message_id,artifact_id) VALUES($1,$2)", [parent.user_message_id, original.id]);
      const result = await createTask(tx, hub, user, claims(), {
        run_id: parent.run_id, agent: mode === "wait" ? other.bot_id : undefined,
        kind: mode === "report" ? "background" : "delegation", task: "修改并交付文档",
        execution: "cloud", wait: mode === "wait",
      }, s);
      assert.ok(result.run);
      await tx.update("bot_runs", result.run!.run_id, { status: "running" });
      if (mode === "report") await finishRun(tx, parent.run_id, "completed", null, "已安排后台任务。");
      return result;
    });
    const child = created.run!;
    const draft = await save(child, "未发布草稿.docx");
    const final = await save(child, "最终稿.docx");
    await documentApi("publish", child, { artifact_id: final.id });
    // Republishing keeps the original run_id, so delivery must follow message links.
    await documentApi("publish", child, { artifact_id: original.id });
    const expected = [original.id, final.id].sort();
    const answer = "已核对重要内容；副本的复杂版式和图片不保留。";
    await db.tx(async tx => {
      await recordReply(tx, await tx.get("bot_runs", child.run_id), {
        id: `answer-${mode}`, phase: "answer", text: answer, generated_at: new Date().toISOString(),
      });
      assert.equal((await tx.get("bot_messages", child.assistant_message_id)).content, answer);
      await finishRun(tx, child.run_id, "completed", null, answer);
      const message = await tx.get("bot_messages", child.assistant_message_id);
      assert.equal(message.content, answer);
      assert.deepEqual(message.reply_segments.filter((r: any) => r.phase === "answer").map((r: any) => r.text), [answer]);
      const task = await readTask(tx, user, claims(), created.task.id);
      assert.deepEqual(task.attachments.map((a: any) => a.id).sort(), expected);
    });
    if (mode === "report") {
      await new AgentDispatcher(db, s, hub).once();
      const report = await db.tx(async tx => {
        const task = await tx.get("agent_tasks", created.task.id);
        assert.ok(task.report_run_id);
        return tx.get("bot_runs", task.report_run_id);
      });
      const forwarded = await files(report.assistant_message_id);
      assert.deepEqual(forwarded.map(a => a.id).sort(), expected);
      assert.ok(!forwarded.some(a => a.id === draft.id));
      await db.tx(tx => finishRun(tx, report.run_id, "completed", null, answer));
    } else {
      assert.deepEqual((await files(parent.assistant_message_id)).map(a => a.id).sort(), expected);
      await db.tx(tx => finishRun(tx, parent.run_id, "completed", null, answer));
    }
    previousTask = created.task.id;
    previousPublished = expected;
  }
  const parent = await newRun("conversation");
  const resumed = await db.tx(tx => resumeTask(tx, hub, user, claims(), {
    run_id: parent.run_id, task_id: previousTask!, request_id: randomUUID(), text: "继续核对",
  }, s));
  assert.ok(resumed.run);
  assert.deepEqual((await files(resumed.run!.user_message_id)).map(a => a.id).sort(), previousPublished);
  assert.deepEqual(await files(resumed.run!.assistant_message_id), []);
});
