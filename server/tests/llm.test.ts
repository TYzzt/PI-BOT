import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { complete, SseUsage, usageFrom } from "../src/llm.js";

test("Responses usage supports JSON and terminal events, including cached and reasoning tokens", () => {
  const usage = { input_tokens: 42, output_tokens: 12, input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 8 } };
  assert.deepEqual(usageFrom({ usage }), { input: 42, output: 12 });
  for (const type of ["response.completed", "response.incomplete", "response.failed"])
    assert.deepEqual(usageFrom({ type, response: { usage } }), { input: 42, output: 12 });
  assert.equal(usageFrom({ usage: null }), null);
  assert.equal(usageFrom({ usage: { input_tokens: "bad" } }), null);
});

test("SSE usage survives CRLF, multiline frames, partial chunks and an unterminated final frame", () => {
  const parser = new SseUsage();
  const body = ': keepalive\r\nevent: response.created\r\ndata: {"response":{"usage":null}}\r\n\r\n'
    + 'event: response.completed\r\ndata: {"type":"response.completed",\r\ndata: "response":{"usage":{"input_tokens":42,"output_tokens":12}}}\r\n\r\n'
    + 'data: {"response":{"usage":{"input_tokens":50,"output_tokens":15}}}';
  for (let i = 0; i < body.length; i += 7) parser.push(body.slice(i, i + 7));
  assert.deepEqual(parser.usage, { input: 42, output: 12 });
  parser.end();
  assert.deepEqual(parser.usage, { input: 50, output: 15 });
});

test("one-shot Responses requests parse all output messages and reject failed or incomplete responses", async () => {
  const requests: any[] = [];
  let result: object = { status: "completed", output: [
    { type: "reasoning", summary: [] },
    { type: "message", content: [{ type: "output_text", text: "第一段" }, { type: "refusal", refusal: "ignored" }] },
    { type: "function_call", name: "ignored" },
    { type: "message", content: [{ type: "output_text", text: "第二段" }] },
  ], usage: { input_tokens: 30, output_tokens: 6 } };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, body: JSON.parse(raw), authorization: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const model = { base_url: `http://127.0.0.1:${(server.address() as any).port}/v1///`, provider_model: "grok-test", max_tokens: 1000 };
  const input = [{ role: "system", content: "压缩记忆" }, { role: "user", content: "记住蓝鲸" }];
  try {
    assert.deepEqual(await complete(model, "sk-test", input, 2000), { text: "第一段第二段", usage: { input: 30, output: 6 } });
    assert.deepEqual(requests[0], { path: "/v1/responses", authorization: "Bearer sk-test", body: { model: "grok-test", input, max_output_tokens: 1000, stream: false, store: false } });
    result = { status: "failed", error: { message: "provider secret" } };
    await assert.rejects(complete(model, "sk-test", input, 16), /^Error: 模型生成失败$/);
    result = { status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" } };
    await assert.rejects(complete(model, "sk-test", input, 16), /模型输出不完整/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
