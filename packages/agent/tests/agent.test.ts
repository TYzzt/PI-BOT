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
    requests.push({ headers: req.headers, body: json });
    const last = json.messages.at(-1);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish: string | null = null) =>
      res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: json.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (last.role === "tool") {
      for (const piece of ["结果是", text(last.content), "，令牌 ", SECRET]) chunk({ content: piece });
      chunk({}, "stop");
    } else {
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: JSON.stringify({ query: "天气" }) } }] });
      chunk({}, "tool_calls");
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as any).port}/v1`;
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
  });
  assert.deepEqual(agent.tools, ["lookup"]);
  const seen: string[] = [];
  const reply = await agent.prompt("今天天气？", (t) => seen.push(t));
  agent.dispose();

  assert.equal(reply, "结果是天气晴，令牌 [已隐藏凭据]");
  assert.ok(seen.every((t) => !t.includes(SECRET)), "streamed text is redacted too");
  assert.deepEqual(tools.map((t) => [t.name, t.state, t.summary]), [
    ["lookup", "running", "天气"],
    ["lookup", "completed", undefined],
  ]);
  const first = requests[0];
  assert.equal(first.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(first.body.model, "pi-bot-model-uuid");
  assert.deepEqual(first.body.tools.map((t: any) => t.function.name), ["lookup"]);
  assert.match(text(first.body.messages[0].content), /你是测试 Bot。/);
  assert.deepEqual(
    first.body.messages.slice(1).map((m: any) => [m.role, text(m.content)]),
    [["user", "记住蓝鲸"], ["assistant", "好的"], ["user", "今天天气？"]],
  );
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
