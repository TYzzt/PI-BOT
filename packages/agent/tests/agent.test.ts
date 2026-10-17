import { ResponseStream } from "./responses.js";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createBotAgent, redactor, summarize, type ToolActivity } from "../src/index.js";

const SECRET = "proxy-token-123456";
const text = (c: any): string => (Array.isArray(c) ? c.map((p) => p.text ?? "").join("") : String(c ?? ""));
const requests: any[] = [];
let server: ReturnType<typeof createServer>, url: string, dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "pi-bot-agent-"));
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const json = JSON.parse(raw);
    requests.push({ path: req.url, headers: req.headers, body: json });
    assert.equal(req.url, "/v1/responses");
    const last = json.input.at(-1);
    const user = text(json.input.filter((m: any) => m.role === "user").at(-1)?.content);
    const rounds = json.input.filter((m: any) => m.type === "function_call_output").length;
    const stream = new ResponseStream(res, json.model);
    if (user === "补充为蓝色") {
      stream.text("已按补充改为蓝色。");
    } else if (user === "直接回答") {
      stream.text("你好，我在。");
    } else if (user === "挂起") {
      res.flushHeaders();
      return;
    } else if (user === "多阶段" && rounds < 5) {
      const remarks = ["我先核对12.1版本。后面这句不用保留。", "找到差异了，接下来核对来源。", "找到差异了，接下来核对来源。", `信息已确认 ${SECRET}，开始整理。`, "现在检查结果。"];
      for (const piece of Array.from(remarks[rounds])) stream.text(piece);
      stream.tool("lookup", { query: "天气" }, `stage_${rounds}`, true);
    } else if (last.type === "function_call_output") {
      for (const piece of ["结果是", text(last.output), "，令牌 ", SECRET]) stream.text(piece);
    } else {
      stream.tool("lookup", { query: "天气" }, "call_1");
    }
    stream.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as any).port}/v1`;
});

test("tool-round remarks survive separately, stay brief and do not pollute final streaming", async () => {
  const progress: string[][] = [], seen: string[] = [];
  const agent = await createBotAgent({
    model: { id: "progress", name: "测试", baseUrl: url, modelId: "test", contextWindow: 32000, maxTokens: 1000 },
    apiKey: SECRET, cwd: dir, agentDir: join(dir, "progress"), systemPrompt: "测试", history: [],
    tools: [{ name: "lookup", label: "查询", description: "查询", parameters: Type.Object({ query: Type.String() }), execute: async () => ({ content: [{ type: "text", text: "晴" }], details: {} }) } as ToolDefinition],
    onProgress: lines => progress.push(lines),
  });
  try {
    const reply = await agent.prompt("多阶段", t => seen.push(t));
    assert.deepEqual(progress, [
      ["我先核对12.1版本。"],
      ["我先核对12.1版本。", "找到差异了，接下来核对来源。"],
      ["我先核对12.1版本。", "找到差异了，接下来核对来源。", "信息已确认 [已隐藏凭据]，开始整理。"],
    ]);
    assert.equal(reply, "结果是晴，令牌 [已隐藏凭据]");
    assert.equal(seen.at(-1), reply);
    assert.ok(seen.includes("结果是"), "final reply starts a fresh stream rather than appending to the previous remark");
    assert.ok(seen.every(t => !t.includes(SECRET)));
  } finally { agent.dispose(); }
});

test("steering waits for the current tool and changes the next model turn", async () => {
  let release!: () => void, started!: () => void;
  const running = new Promise<void>(r => { started = r; });
  const finish = new Promise<void>(r => { release = r; });
  const agent = await createBotAgent({
    model: { id: "steer", name: "测试", baseUrl: url, modelId: "test", contextWindow: 32000, maxTokens: 1000 },
    apiKey: SECRET, cwd: dir, agentDir: join(dir, "steer"), systemPrompt: "测试", history: [],
    tools: [{ name: "lookup", label: "查询", description: "查询", parameters: Type.Object({ query: Type.String() }),
      execute: async () => { started(); await finish; return { content: [{ type: "text", text: "原任务结果" }], details: {} }; } } as ToolDefinition],
  });
  try {
    const result = agent.prompt("执行任务", () => {});
    await running;
    await agent.steer!("补充为蓝色");
    release();
    assert.equal(await result, "已按补充改为蓝色。");
  } finally { release(); agent.dispose(); }
});

test("direct answers do not create progress remarks", async () => {
  const progress: string[][] = [];
  const agent = await createBotAgent({
    model: { id: "direct", name: "测试", baseUrl: url, modelId: "test", contextWindow: 32000, maxTokens: 1000 },
    apiKey: SECRET, cwd: dir, agentDir: join(dir, "direct"), systemPrompt: "测试", history: [], tools: [],
    onProgress: lines => progress.push(lines),
  });
  try {
    assert.equal(await agent.prompt("直接回答", () => {}), "你好，我在。");
    assert.deepEqual(progress, []);
  } finally { agent.dispose(); }
});

test("an unresponsive model stream is stopped instead of showing typing indefinitely", async () => {
  const agent = await createBotAgent({
    model: { id: "idle", name: "测试", baseUrl: url, modelId: "test", contextWindow: 32000, maxTokens: 1000 },
    apiKey: SECRET, cwd: dir, agentDir: join(dir, "idle"), systemPrompt: "测试", history: [], tools: [], modelIdleTimeoutMs: 100,
  });
  try { await assert.rejects(agent.prompt("挂起", () => {}), /模型长时间没有响应/); }
  finally { agent.dispose(); }
});

test("all models use Responses without Chat Completions parameters", async () => {
  const agent = await createBotAgent({
    model: { id: "qwen", name: "qwen3.8-27B", baseUrl: url, modelId: "qwen-test", contextWindow: 32000, maxTokens: 1000 },
    apiKey: SECRET, cwd: dir, agentDir: join(dir, "qwen"), systemPrompt: "测试", history: [], tools: [],
  });
  try {
    assert.equal(await agent.prompt("直接回答", () => {}), "你好，我在。");
    const request = requests.find(r => r.body.model === "qwen-test");
    assert.equal(request.path, "/v1/responses");
    assert.equal(request.body.store, false);
    assert.equal(request.body.max_output_tokens, 1000);
    for (const key of ["messages", "max_tokens", "stream_options", "chat_template_kwargs"]) assert.equal(key in request.body, false);
  } finally { agent.dispose(); }
});
after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test("createBotAgent runs only the given tools through the proxy and redacts the token", async () => {
  const lookup: ToolDefinition = {
    name: "lookup",
    label: "查询",
    description: "查询信息",
    parameters: Type.Object({ query: Type.String() }),
    execute: async (_id, args: any) => ({ content: [{ type: "text", text: `${args.query}晴` }], details: {} }),
  } as ToolDefinition;
  const tools: ToolActivity[] = [];
  const progress: string[][] = [];
  const agent = await createBotAgent({
    model: { id: "m1", name: "测试", baseUrl: url, modelId: "pi-bot-model-uuid", contextWindow: 32000, maxTokens: 1000 },
    apiKey: SECRET,
    cwd: dir,
    agentDir: join(dir, "agent"),
    systemPrompt: "你是测试 Bot。",
    history: [
      { role: "user", content: "记住蓝鲸" },
      { role: "assistant", content: "好的" },
    ],
    tools: [lookup],
    onTool: (t) => tools.push(t),
    onProgress: (lines) => progress.push(lines),
  });
  assert.deepEqual(agent.tools, ["lookup"]);
  const seen: string[] = [];
  const reply = await agent.prompt("今天天气？", (t) => seen.push(t));
  agent.dispose();

  assert.equal(reply, "结果是天气晴，令牌 [已隐藏凭据]");
  assert.ok(seen.every((t) => !t.includes(SECRET)), "streamed text is redacted too");
  assert.deepEqual(progress, [], "tool calls without model remarks do not invent an opening reply");
  assert.deepEqual(tools.map((t) => [t.name, t.state, t.summary]), [
    ["lookup", "running", "天气"],
    ["lookup", "completed", undefined],
  ]);
  const first = requests.find(r => r.body.model === "pi-bot-model-uuid");
  assert.equal(first.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(first.body.model, "pi-bot-model-uuid");
  assert.deepEqual(first.body.tools.map((t: any) => t.name), ["lookup"]);
  assert.match(text(first.body.input[0].content), /你是测试 Bot。/);
  assert.deepEqual(
    first.body.input.slice(1).map((m: any) => [m.role, text(m.content)]),
    [["user", "记住蓝鲸"], ["assistant", "好的"], ["user", "今天天气？"]],
  );
  const followup = requests.filter(r => r.body.model === "pi-bot-model-uuid").at(-1).body;
  const call = followup.input.find((item: any) => item.type === "function_call");
  const result = followup.input.find((item: any) => item.type === "function_call_output");
  assert.equal(call.name, "lookup");
  assert.deepEqual(JSON.parse(call.arguments), { query: "天气" });
  assert.equal(result.call_id, call.call_id);
  assert.equal(result.output, "天气晴");
});

test("summarize prefers the most telling argument and truncates", () => {
  assert.equal(summarize({ path: "notes/a.md", content: "x" }), "notes/a.md");
  assert.equal(summarize({ command: "ls -la" }), "ls -la");
  assert.equal(summarize("plain"), "plain");
  assert.equal(summarize({ other: 1 }), '{"other":1}');
  assert.equal(summarize({ query: "a".repeat(200) }).length, 158);
});

test("redactor ignores short secrets", () => {
  const r = redactor(["abc", "long-secret"]);
  assert.equal(r("abc long-secret"), "abc [已隐藏凭据]");
});
