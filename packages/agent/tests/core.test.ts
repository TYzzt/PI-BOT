import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugins } from "../src/plugins.js";
import { piFactory } from "../src/index.js";
import { endpoint, temp } from "../../../desktop/tests/helpers.js";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { workspaceTools } from "../../../server/src/runner.js";
import { symlink, writeFile, mkdir } from "node:fs/promises";
test("shared Pi harness operates locally without server and resumes its session", async () => {
  const dir = temp(),
    api = await endpoint();
  const config = {
    id: randomUUID(),
    name: "test",
    baseUrl: api.url,
    modelId: "fixture",
    contextWindow: 32000,
    maxTokens: 1000,
  };
  let path: string | undefined;
  try {
    let agent = await piFactory(dir.path)(
      config,
      "fixture-secret",
      null,
      config.id,
    );
    await agent.prompt("记住蓝鲸", () => {});
    path = agent.sessionPath;
    agent.dispose();
    assert.ok(path);
    agent = await piFactory(dir.path)(
      config,
      "fixture-secret",
      path!,
      config.id,
    );
    let answer = "";
    await agent.prompt("之前是什么？", (text) => (answer = text));
    assert.match(answer, /蓝鲸/);
    agent.dispose();
    assert.equal(api.requests[0].tools?.length ?? 0, 0);
  } finally {
    await api.close();
    dir.cleanup();
  }
});
test("MCP stdio connects, filters tools, injects only configured secrets, times out and closes", async () => {
  const dir = temp(),
    previous = process.env.T_AGNET_DATABASE_URL;
  process.env.T_AGNET_DATABASE_URL = "must-not-inherit";
  try {
    const loaded = await loadPlugins({
      runtime: "mac",
      dir: dir.path,
      cwd: dir.path,
      skills: [],
      secret: async () => "fixture-mcp-secret",
      mcp_servers: [
        {
          id: randomUUID(),
          version: 1,
          content_hash: "a".repeat(64),
          config: {
            name: "fixture",
            runtime: "both",
            enabled: true,
            transport: "stdio",
            command: process.execPath,
            args: [
              "--import",
              import.meta.resolve("tsx"),
              fileURLToPath(new URL("./mcp-fixture.ts", import.meta.url)),
            ],
            env: [{ name: "FIXTURE_SECRET", secret_ref: "fixture" }],
            timeout_ms: 500,
            disabled_tools: ["disabled"],
          },
        },
      ],
    });
    assert.equal(loaded.tools.length, 2);
    assert.ok(!loaded.tools.some((t) => t.name.includes("disabled")));
    const value = await loaded.tools
      .find((t) => t.name.includes("echo"))!
      .execute("id", { text: "hello" }, undefined, undefined, {} as any);
    const result = JSON.parse((value.content[0] as any).text);
    const text = JSON.parse(result.content[0].text);
    assert.equal(text.text, "hello");
    assert.equal(text.key, "fixture-mcp-secret");
    assert.equal(text.leak, null);
    await assert.rejects(
      () =>
        loaded.tools
          .find((t) => t.name.includes("slow"))!
          .execute("id", {}, undefined, undefined, {} as any),
      /MCP 工具调用失败/,
    );
    await loaded.close();
  } finally {
    if (previous === undefined) delete process.env.T_AGNET_DATABASE_URL;
    else process.env.T_AGNET_DATABASE_URL = previous;
    dir.cleanup();
  }
});
test("cloud file tools reject symlink traversal", async () => {
  const dir = temp();
  try {
    await mkdir(dir.path + "/workspace");
    await writeFile(dir.path + "/outside", "private");
    await symlink(dir.path + "/outside", dir.path + "/workspace/link");
    const tools = await workspaceTools(dir.path + "/workspace");
    await assert.rejects(() =>
      tools[0].execute("id", { path: "link" }, undefined, undefined, {} as any),
    );
    await assert.rejects(() =>
      tools[1].execute(
        "id",
        { path: "link", content: "overwrite" },
        undefined,
        undefined,
        {} as any,
      ),
    );
  } finally {
    dir.cleanup();
  }
});
test("plugin loader respects runtime, platform and required MCP without executing package scripts", async () => {
  const dir = temp(),
    id = randomUUID(),
    reports: any[] = [];
  try {
    const loaded = await loadPlugins({
      runtime: "mac",
      cwd: dir.path,
      dir: dir.path,
      secret: async () => null,
      mcp_servers: [],
      skills: [
        {
          id,
          version: 1,
          content_hash: "a".repeat(64),
          config: {
            name: "fixture",
            description: "Fixture",
            content: "技能内容",
            runtime: "both",
            enabled: true,
            files: [],
            requires: { platforms: [], commands: [], mcp: [], scripts: [] },
          },
        },
        {
          id: randomUUID(),
          version: 1,
          content_hash: "b".repeat(64),
          config: {
            name: "cloud",
            content: "Cloud",
            runtime: "cloud",
            enabled: true,
          },
        },
        {
          id: randomUUID(),
          version: 1,
          content_hash: "c".repeat(64),
          config: {
            name: "missing",
            content: "Missing",
            runtime: "both",
            enabled: true,
            requires: { mcp: ["missing"] },
          },
        },
      ],
      report: async (d, state, reasons) => {
        reports.push({ id: d.id, state, reasons });
      },
    });
    assert.equal(loaded.skills.length, 1);
    assert.equal(loaded.tools.length, 1);
    const content = await loaded.tools[0].execute(
      "id",
      { name: "fixture" },
      undefined,
      undefined,
      {} as any,
    );
    assert.equal((content.content[0] as any).text, "技能内容");
    assert.ok(reports.some((r) => r.state === "unavailable"));
    assert.ok(reports.some((r) => r.state === "not_applicable"));
    await loaded.close();
  } finally {
    dir.cleanup();
  }
});
