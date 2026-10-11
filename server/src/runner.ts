import Fastify from "fastify";
import { z } from "zod";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { Type } from "typebox";
import {
  CANCELLED,
  createBotAgent,
  type AgentFactory,
  type AgentHandle,
} from "@pi-bot/agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const requestSchema = z.object({
  run: z.object({
    run_id: z.string().uuid(),
    bot: z.object({ id: z.string().uuid(), name: z.string(), slug: z.string() }),
    model: z.object({
      id: z.string().uuid(),
      name: z.string(),
      context_window: z.number().int().positive(),
      max_tokens: z.number().int().positive(),
    }),
    system: z.string(),
    history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })),
    text: z.string().min(1),
  }),
  base_url: z.string().url(),
  token: z.string().min(16),
  search_key: z.string().optional(),
});

export function searchTool(key: string): ToolDefinition {
  return {
    name: "web_search",
    label: "联网搜索",
    description: "搜索网络信息并返回标题、链接和摘要。",
    parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 2000 }) }),
    execute: async (_id: string, args: any, signal?: AbortSignal) => {
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: key, query: args.query, max_results: 5 }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error("联网搜索失败");
      const data = (await response.json()) as any;
      const results = (data.results ?? []).map((r: any) => ({ title: r.title, url: r.url, content: String(r.content ?? "").slice(0, 2000) }));
      return { content: [{ type: "text" as const, text: JSON.stringify(results) }], details: {} };
    },
  } as ToolDefinition;
}

/**
 * Cloud execution for bots whose Mac is offline: conversation and optional web
 * search only. It has no file system or shell tools and never sees provider keys.
 */
export async function createRunner(options: { token: string; dir: string; factory?: AgentFactory }) {
  if (options.token.length < 32) throw new Error("Runner token 至少 32 字符");
  const app = Fastify({ bodyLimit: 16 * 1024 * 1024, logger: false });
  const factory = options.factory ?? createBotAgent;
  const active = new Map<string, { agent?: AgentHandle; cancelled: boolean }>();
  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health") return;
    const value = Buffer.from(req.headers.authorization ?? ""),
      expected = Buffer.from(`Bearer ${options.token}`);
    if (value.length !== expected.length || !timingSafeEqual(value, expected))
      return reply.code(401).send({ error: "认证失败" });
  });
  app.get("/health", () => ({ ok: true, active: active.size }));
  app.post("/runs/:id/cancel", async (req) => {
    const state = active.get((req.params as any).id);
    if (state) {
      state.cancelled = true;
      await state.agent?.abort();
    }
    return { ok: true };
  });
  app.post("/runs", async (req, reply) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: "运行参数无效" });
    const p = parsed.data;
    if (active.has(p.run.run_id)) return reply.code(409).send({ error: "运行已存在" });
    const state: { agent?: AgentHandle; cancelled: boolean } = { cancelled: false };
    active.set(p.run.run_id, state);
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
    const emit = (value: unknown) => {
      if (!reply.raw.destroyed) reply.raw.write(JSON.stringify(value) + "\n");
    };
    reply.raw.on("close", () => {
      state.cancelled = true;
      void state.agent?.abort();
    });
    try {
      const cwd = join(options.dir, "empty");
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      state.agent = await factory({
        model: {
          id: p.run.model.id,
          name: p.run.model.name,
          baseUrl: p.base_url,
          modelId: p.run.model.id,
          contextWindow: p.run.model.context_window,
          maxTokens: p.run.model.max_tokens,
        },
        apiKey: p.token,
        cwd,
        agentDir: join(options.dir, "pi"),
        systemPrompt: p.run.system,
        history: p.run.history,
        tools: p.search_key ? [searchTool(p.search_key)] : [],
        redactSecrets: [p.search_key ?? ""],
        onTool: (t) => emit({ type: "tool", ...t }),
      });
      if (state.cancelled) throw new Error(CANCELLED);
      const text = await state.agent.prompt(p.run.text, (t) => emit({ type: "text", text: t }));
      emit({ type: "done", state: "completed", text });
    } catch (e) {
      const cancelled = state.cancelled || (e instanceof Error && e.message === CANCELLED);
      emit({
        type: "done",
        state: cancelled ? "cancelled" : "failed",
        error: cancelled ? null : e instanceof Error && /模型|工具/.test(e.message) ? e.message : "模型请求失败，请稍后重试",
      });
    } finally {
      state.agent?.dispose();
      active.delete(p.run.run_id);
      reply.raw.end();
    }
  });
  app.addHook("onClose", async () => {
    for (const s of active.values()) {
      s.cancelled = true;
      await s.agent?.abort();
    }
  });
  return app;
}

if (process.argv[1]?.endsWith("/runner.ts") || process.argv[1]?.endsWith("/runner.mjs")) {
  const app = await createRunner({
    token: process.env.PI_BOT_RUNNER_TOKEN ?? "",
    dir: process.env.PI_BOT_RUNNER_DATA_DIR ?? "/data",
  });
  await app.listen({ host: "0.0.0.0", port: Number(process.env.PI_BOT_RUNNER_PORT ?? 8001) });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void app.close());
}
