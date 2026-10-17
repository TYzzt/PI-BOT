import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { memoryExtension } from "../src/hermes-memory/extension.js";
import { observationExtension } from "../src/observations.js";

test("memory extension injects a bounded snapshot and has no local skill/session discovery", () => {
  const tools = new Map<string, any>(),
    hooks = new Map<string, any>(),
    entries: any[] = [];
  memoryExtension({
    baseUrl: "http://cloud",
    token: () => "",
    runId: randomUUID(),
    lane: "task",
    context: "MY PRIVATE MEMORY",
    checkpointVersion: 2,
  })({
    registerTool: (t: any) => tools.set(t.name, t),
    on: (n: string, f: any) => hooks.set(n, f),
    appendEntry: (...x: any[]) => entries.push(x),
  } as any);
  assert.ok(tools.has("task_checkpoint"));
  assert.ok(!tools.has("resume_task"));
  assert.ok(!tools.has("skill_manage"));
  assert.ok(!hooks.has("resources_discover"));
  const e = { systemPromptOptions: { sections: {} as Record<string, string> } };
  hooks.get("before_agent_start")(e);
  assert.match(e.systemPromptOptions.sections.bot_memory, /MY PRIVATE MEMORY/);
  hooks.get("session_before_compact")();
  assert.equal(entries[0][1].checkpointVersion, 2);
});
test("neutral observations correlate concurrent tools and failed reporting does not fail tool execution", () => {
  const hooks = new Map<string, any>(),
    events: any[] = [];
  const runId = randomUUID();
  observationExtension(runId, (e) => events.push(e))({
    on: (n: string, f: any) => hooks.set(n, f),
  } as any);
  const headers: any = {};
  hooks.get("before_provider_headers")({ headers });
  assert.equal(headers["x-pibot-run-id"], runId);
  assert.match(headers["x-pibot-generation-id"], /^[0-9a-f-]{36}$/);
  hooks.get("tool_execution_start")({
    toolCallId: "a",
    toolName: "memory_manage",
    args: { action: "list" },
  });
  hooks.get("tool_execution_start")({
    toolCallId: "b",
    toolName: "ask_agent",
    args: { agent: "researcher" },
  });
  hooks.get("tool_execution_end")({
    toolCallId: "b",
    toolName: "ask_agent",
    result: { text: "answer" },
    isError: false,
  });
  hooks.get("tool_execution_end")({
    toolCallId: "a",
    toolName: "memory_manage",
    result: {},
    isError: true,
  });
  assert.equal(events.length, 4);
  assert.equal(events[2].input.agent, "researcher");
  assert.equal(events[3].error, true);
  assert.equal(events[2].generation_id, events[3].generation_id);
  observationExtension(runId, () => {
    throw new Error("network");
  })({ on: (n: string, f: any) => hooks.set(n, f) } as any);
  assert.doesNotThrow(() =>
    hooks.get("tool_execution_start")({
      toolCallId: "c",
      toolName: "read_file",
      args: {},
    }),
  );
});
