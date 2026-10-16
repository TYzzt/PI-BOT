import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { askAgentTool, summarize } from "../src/index.js";

const RUN = "11111111-1111-4111-8111-111111111111";
const calls: { method: string; path: string; auth?: string; body?: any }[] = [];
/** Per-test script: how many polls stay running, and how the API answers report requests. */
let script = { runningPolls: 1, report: 200 as number, hangPolls: false, createStatus: 200 };
let server: ReturnType<typeof createServer>, base: string;

const task = (status: string, mode = "wait") => ({ id: "t1", status, mode, agent: { id: "b2", name: "写作助手" }, result: status === "completed" ? "周报写好了" : null, error: status === "failed" ? "模型请求失败" : null });

before(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const path = req.url!;
    calls.push({ method: req.method!, path, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "POST" && path === "/agent/tasks") {
      if (script.createStatus !== 200) return send(script.createStatus, { detail: "找不到智能体「不存在」。可以委托的有：写作助手" });
      return send(200, task("running", JSON.parse(raw).wait ? "wait" : "report"));
    }
    if (req.method === "GET" && path.startsWith("/agent/tasks/t1")) {
      if (script.hangPolls) return; // never answers; the caller aborts
      return send(200, script.runningPolls-- > 0 ? task("running") : task("completed"));
    }
    if (path === "/agent/tasks/t1/report")
      return script.report === 200 ? send(200, task("running", "report")) : send(script.report, { detail: "被委托的任务里只能同步等待结果" });
    if (path === "/agent/tasks/t1/cancel") return send(200, task("cancelled"));
    send(404, { detail: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const run = (args: object, options = {}, signal?: AbortSignal) =>
  askAgentTool(base, () => "agent-token", RUN, { pollSeconds: 1, ...options }).execute("call", args as any, signal, undefined as any, undefined as any);
const output = (r: any) => r.content[0].text as string;

test("wait=true long-polls until the other bot finishes and returns its result", async () => {
  calls.length = 0;
  script = { runningPolls: 2, report: 200, hangPolls: false, createStatus: 200 };
  const r = await run({ agent: "写作助手", task: "写一份周报" });
  assert.equal(output(r), "「写作助手」的结果：\n周报写好了");
  assert.deepEqual(calls[0], { method: "POST", path: "/agent/tasks", auth: "Bearer agent-token", body: { run_id: RUN, agent: "写作助手", task: "写一份周报", wait: true } });
  assert.deepEqual(calls.slice(1).map((c) => c.path), ["/agent/tasks/t1?wait=1", "/agent/tasks/t1?wait=1", "/agent/tasks/t1?wait=1"]);
});

test("wait=false hands the task off without polling", async () => {
  calls.length = 0;
  const r = await run({ agent: "写作助手", task: "调研竞品", wait: false });
  assert.match(output(r), /已转交给「写作助手」/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.wait, false);
});

test("a wait past the limit becomes a later report", async () => {
  calls.length = 0;
  script = { runningPolls: 100, report: 200, hangPolls: false, createStatus: 200 };
  const r = await run({ agent: "写作助手", task: "写长文" }, { waitLimitMs: 0 });
  assert.match(output(r), /已改为完成后回报/);
  assert.deepEqual(calls.map((c) => c.path), ["/agent/tasks", "/agent/tasks/t1/report"]);
});

test("when a report is not allowed (nested delegation) the tool keeps waiting", async () => {
  calls.length = 0;
  script = { runningPolls: 1, report: 422, hangPolls: false, createStatus: 200 };
  const r = await run({ agent: "写作助手", task: "写长文" }, { waitLimitMs: 0 });
  assert.equal(output(r), "「写作助手」的结果：\n周报写好了");
  assert.deepEqual(calls.map((c) => c.path), ["/agent/tasks", "/agent/tasks/t1/report", "/agent/tasks/t1?wait=1", "/agent/tasks/t1?wait=1"]);
});

test("aborting the delegating run cancels the task", async () => {
  calls.length = 0;
  script = { runningPolls: 0, report: 200, hangPolls: true, createStatus: 200 };
  const controller = new AbortController();
  const pending = run({ agent: "写作助手", task: "写长文" }, {}, controller.signal);
  while (!calls.some((c) => c.method === "GET")) await new Promise((r) => setTimeout(r, 10));
  controller.abort();
  await assert.rejects(pending);
  assert.equal(calls.at(-1)!.path, "/agent/tasks/t1/cancel");
});

test("API refusals reach the model as readable errors", async () => {
  script = { runningPolls: 0, report: 200, hangPolls: false, createStatus: 404 };
  await assert.rejects(run({ agent: "不存在", task: "x" }), /可以委托的有：写作助手/);
});

test("delegation summaries name the target and the start of the task", () => {
  assert.equal(summarize({ agent: "写作助手", task: "写一份\n周报", wait: true }), "写作助手：写一份 周报");
  assert.equal(summarize({ agent: "写作助手", task: "长".repeat(100) }), `写作助手：${"长".repeat(59)}…`);
});
