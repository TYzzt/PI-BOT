import Fastify from "fastify";
import { z } from "zod";
import { mkdir, readFile, writeFile, realpath, lstat } from "node:fs/promises";
import { resolve, join, dirname, sep } from "node:path";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { Type } from "typebox";
import { piFactory, type AgentFactory, type AgentHandle } from "@t-agnet/agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PluginDocument } from "@t-agnet/agent/plugins";
const requestSchema = z.object({
  runId: z.string().uuid(),
  conversationId: z.string().uuid(),
  generation: z.number().int().nonnegative(),
  question: z.string().min(1).max(30000),
  history: z.array(
    z.object({ role: z.enum(["user", "assistant"]), content: z.string() }),
  ),
  model: z.object({
    id: z.string().uuid(),
    name: z.string(),
    baseUrl: z.string().url(),
    modelId: z.string(),
    contextWindow: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
  }),
  key: z.string().min(1),
  searchKey: z.string().optional(),
  skills: z.array(z.any()),
  mcp_servers: z.array(z.any()),
});
export async function workspaceTools(cwd: string): Promise<ToolDefinition[]> {
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const root = await realpath(cwd);
  async function path(value: string, write = false) {
    const full = resolve(root, value);
    if (full !== root && !full.startsWith(root + sep))
      throw new Error("文件必须位于云端工作区");
    let existing = full;
    while (!(await lstat(existing).catch(() => null))) {
      const parent = dirname(existing);
      if (parent === existing) throw new Error("文件不存在");
      existing = parent;
    }
    const actual = await realpath(existing);
    if (actual !== root && !actual.startsWith(root + sep))
      throw new Error("路径越过工作区");
    if (!write) await realpath(full);
    return full;
  }
  return [
    {
      name: "read_file",
      label: "读取云端文件",
      description: "读取云端工作区中的 UTF-8 文件，最多 200KB。",
      parameters: Type.Object({ path: Type.String() }),
      execute: async (_id, args: any) => {
        const full = await path(args.path);
        if ((await lstat(full)).size > 200000) throw new Error("文件过大");
        return {
          content: [{ type: "text", text: await readFile(full, "utf8") }],
          details: {},
        };
      },
    },
    {
      name: "write_file",
      label: "写入云端文件",
      description: "在云端工作区写入 UTF-8 文件。",
      parameters: Type.Object({
        path: Type.String(),
        content: Type.String({ maxLength: 200000 }),
      }),
      execute: async (_id, args: any) => {
        const full = await path(args.path, true);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, args.content, { mode: 0o600 });
        return { content: [{ type: "text", text: "已写入" }], details: {} };
      },
    },
    {
      name: "run_command",
      label: "云端命令",
      description:
        "在隔离云端容器的当前工作区执行命令，最长 60 秒；无法访问 Mac 或服务端部署凭据。",
      parameters: Type.Object({ command: Type.String({ maxLength: 10000 }) }),
      execute: async (_id, args: any, signal) =>
        new Promise((done, reject) => {
          if (signal?.aborted) {
            reject(new Error("CANCELLED"));
            return;
          }
          const child = spawn("/bin/sh", ["-c", args.command], {
            cwd: root,
            env: {
              PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
              HOME: root,
              LANG: "C.UTF-8",
            },
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "",
            settled = false,
            timedOut = false;
          const stop = () => {
            try {
              process.kill(-child.pid!, "SIGTERM");
            } catch {}
            setTimeout(() => {
              try {
                process.kill(-child.pid!, "SIGKILL");
              } catch {}
            }, 1000).unref();
          };
          const timer = setTimeout(() => {
            timedOut = true;
            stop();
          }, 60000);
          const abort = () => stop();
          signal?.addEventListener("abort", abort, { once: true });
          const collect = (b: Buffer) => {
            output = (output + b.toString()).slice(-200000);
          };
          child.stdout.on("data", collect);
          child.stderr.on("data", collect);
          const finish = (error?: Error, code?: number | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            if (error) reject(new Error("云端命令无法启动"));
            else if (signal?.aborted) reject(new Error("CANCELLED"));
            else
              done({
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      exit_code: code,
                      timeout: timedOut,
                      output,
                    }),
                  },
                ],
                details: {},
              });
          };
          child.once("error", (e) => finish(e));
          child.once("close", (code) => finish(undefined, code));
        }),
    },
  ];
}
export async function createRunner(options: {
  token: string;
  dir: string;
  factory?: AgentFactory;
  secrets?: Record<string, string>;
}) {
  if (options.token.length < 32) throw new Error("Runner token 至少 32 字符");
  const app = Fastify({ bodyLimit: 8 * 1024 * 1024, logger: false }),
    factory = options.factory ?? piFactory(options.dir);
  let active:
    { id: string; agent?: AgentHandle; cancelled: boolean } | undefined;
  app.addHook("onRequest", async (req, reply) => {
    const value = Buffer.from(req.headers.authorization ?? ""),
      expected = Buffer.from(`Bearer ${options.token}`);
    if (value.length !== expected.length || !timingSafeEqual(value, expected))
      return reply.code(401).send({ error: "认证失败" });
  });
  app.get("/health", () => ({ ok: true }));
  app.post("/runs/:id/cancel", async (req, reply) => {
    if (active && active.id === (req.params as any).id) {
      active.cancelled = true;
      await active.agent?.abort();
    }
    return { ok: true };
  });
  app.post("/runs", async (req, reply) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: "运行参数无效" });
    if (active) return reply.code(409).send({ error: "Runner 正忙" });
    const p = parsed.data,
      state = {
        id: p.runId,
        cancelled: false,
        agent: undefined as AgentHandle | undefined,
      };
    active = state;
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
    });
    const emit = (value: unknown) => {
      if (!reply.raw.destroyed) reply.raw.write(JSON.stringify(value) + "\n");
    };
    reply.raw.on("close", () => {
      state.cancelled = true;
      void state.agent?.abort();
    });
    try {
      const cwd = join(options.dir, "workspaces", p.conversationId),
        sessionId = `${p.conversationId}-${p.generation}`,
        manifest = join(
          options.dir,
          "pi",
          "sessions",
          sessionId,
          "current.json",
        );
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      let existing: string | null = null;
      try {
        existing = JSON.parse(await readFile(manifest, "utf8")).path;
      } catch {}
      const secretValues = options.secrets ?? {},
        skills = p.skills as PluginDocument[],
        mcp = p.mcp_servers as PluginDocument[];
      const agent = await factory(p.model, p.key, existing, sessionId, false, {
        cwd,
        systemPrompt: `你是 T-AGNET 的中文云端助手。日期 ${new Date().toISOString().slice(0, 10)}。你仅能操作云端隔离工作区，不能访问 Mac 的文件、终端或浏览器。需要本机信息时请用户在 Mac 项目会话中操作。`,
        tools: [
          ...(await workspaceTools(cwd)),
          ...(p.searchKey
            ? [
                {
                  name: "web_search",
                  label: "联网搜索",
                  description: "搜索网络信息并返回来源链接。",
                  parameters: Type.Object({
                    query: Type.String({ minLength: 1, maxLength: 2000 }),
                  }),
                  execute: async (
                    _id: string,
                    args: any,
                    signal?: AbortSignal,
                  ) => {
                    const response = await fetch(
                      "https://api.tavily.com/search",
                      {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          api_key: p.searchKey,
                          query: args.query,
                          max_results: 5,
                        }),
                        signal: signal
                          ? AbortSignal.any([
                              signal,
                              AbortSignal.timeout(30000),
                            ])
                          : AbortSignal.timeout(30000),
                      },
                    );
                    if (!response.ok) throw new Error("联网搜索失败");
                    const data = (await response.json()) as any;
                    return {
                      content: [
                        {
                          type: "text" as const,
                          text: JSON.stringify(data.results),
                        },
                      ],
                      details: {},
                    };
                  },
                },
              ]
            : []),
        ],
        history: existing ? undefined : p.history,
        autoCompaction: true,
        redactSecrets: [p.searchKey ?? "", ...Object.values(secretValues)],
        plugins: {
          runtime: "cloud",
          cwd,
          dir: join(options.dir, "skills"),
          skills,
          mcp_servers: mcp,
          secret: async (name) => secretValues[name] ?? null,
          report: async (d, status, reasons) =>
            emit({
              type: "plugin",
              id: d.id,
              version: d.version,
              hash: d.content_hash,
              state: status,
              reasons,
            }),
        },
        onEvent: (event) => {
          const e = event as any;
          if (["tool_execution_start", "tool_execution_end"].includes(e.type))
            emit({
              type: "tool",
              name: e.toolName,
              state:
                e.type === "tool_execution_start" ? "running" : "completed",
            });
        },
      });
      state.agent = agent;
      if (state.cancelled) throw new Error("CANCELLED");
      const redact = (text: string) =>
        [p.key, p.searchKey ?? "", ...Object.values(secretValues)]
          .filter(Boolean)
          .reduce((t, key) => t.replaceAll(key, "[已隐藏凭据]"), text);
      await agent.prompt(p.question, (text) =>
        emit({ type: "text", text: redact(text) }),
      );
      if (state.cancelled) throw new Error("CANCELLED");
      if (agent.sessionPath)
        await writeFile(manifest, JSON.stringify({ path: agent.sessionPath }), {
          mode: 0o600,
        });
      emit({ type: "done", state: "completed" });
    } catch {
      emit({
        type: "done",
        state: state.cancelled ? "cancelled" : "failed",
        error: state.cancelled ? null : "模型或工具请求失败，请检查云端配置",
      });
    } finally {
      state.agent?.dispose();
      active = undefined;
      reply.raw.end();
    }
  });
  app.addHook("onClose", async () => {
    if (active) {
      active.cancelled = true;
      await active.agent?.abort();
    }
  });
  return app;
}
if (
  process.argv[1]?.endsWith("/runner.ts") ||
  process.argv[1]?.endsWith("/runner.mjs")
) {
  let secrets: Record<string, string> = {};
  if (process.env.T_AGNET_MCP_SECRET_FILE)
    secrets = JSON.parse(
      await readFile(process.env.T_AGNET_MCP_SECRET_FILE, "utf8"),
    );
  const app = await createRunner({
    token: process.env.T_AGNET_RUNNER_TOKEN ?? "",
    dir: process.env.T_AGNET_RUNNER_DATA_DIR ?? "/data",
    secrets,
  });
  await app.listen({
    host: "0.0.0.0",
    port: Number(process.env.T_AGNET_RUNNER_PORT ?? 8001),
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => void app.close());
}
