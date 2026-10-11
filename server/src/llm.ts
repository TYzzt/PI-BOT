import type { FastifyReply } from "fastify";
import { fail, type Database, type Row, type Tx } from "./db.js";
import type { Settings } from "./config.js";
import { Vault, type LlmClaims } from "./security.js";

export interface Usage {
  input: number;
  output: number;
}
export function usageFrom(value: unknown): Usage | null {
  const u = (value as Row | null)?.usage;
  if (!u || typeof u !== "object") return null;
  const input = Number(u.prompt_tokens ?? u.input_tokens ?? 0),
    output = Number(u.completion_tokens ?? u.output_tokens ?? 0);
  return Number.isFinite(input) && Number.isFinite(output)
    ? { input, output }
    : null;
}
/** Picks the last usage block from an SSE body without buffering the whole stream. */
export class SseUsage {
  private buffer = "";
  usage: Usage | null = null;
  push(chunk: string) {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line.startsWith("data:") || !line.includes('"usage"')) continue;
      try {
        this.usage = usageFrom(JSON.parse(line.slice(5))) ?? this.usage;
      } catch {
        /* partial or non-JSON events are ignored */
      }
    }
    if (this.buffer.length > 1_000_000) this.buffer = "";
  }
}
export async function findModel(tx: Tx, requested: unknown) {
  const id = typeof requested === "string" ? requested : "";
  const m = /^[0-9a-f-]{36}$/i.test(id)
    ? await tx.one("SELECT * FROM models WHERE model_id=$1 AND enabled", [id])
    : await tx.one(
        "SELECT * FROM models WHERE enabled ORDER BY is_default DESC, created_at LIMIT 1",
      );
  if (!m) fail(404, "模型不存在或已停用");
  return m!;
}
export const endpoint = (m: Row) => `${m.base_url.replace(/\/+$/, "")}/chat/completions`;
export async function recordUsage(
  db: Database,
  claims: LlmClaims,
  modelId: string,
  usage: Usage | null,
) {
  await db
    .tx((tx) =>
      tx.insert("usage_logs", {
        user_id: claims.sub,
        bot_id: claims.bot ?? null,
        model_id: modelId,
        source: claims.src,
        input_tokens: Math.max(0, Math.round(usage?.input ?? 0)),
        output_tokens: Math.max(0, Math.round(usage?.output ?? 0)),
      }),
    )
    .catch(() => {});
}
const openAiError = (reply: FastifyReply, status: number, message: string) =>
  reply.code(status).send({ error: { message, type: "pi_bot_proxy" } });

export async function proxyChat(
  db: Database,
  s: Settings,
  claims: LlmClaims,
  model: Row,
  body: Row,
  reply: FastifyReply,
  signal: AbortSignal,
) {
  const key = new Vault(s.vaultFile).open(model.secret, model.model_id);
  const payload: Row = { ...body, model: model.provider_model };
  if (typeof payload.max_tokens === "number")
    payload.max_tokens = Math.min(payload.max_tokens, model.max_tokens);
  let upstream: Response;
  try {
    upstream = await fetch(endpoint(model), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]),
      redirect: "error",
    });
  } catch {
    return openAiError(reply, 502, "无法连接模型服务");
  }
  if (!upstream.ok || !upstream.body) {
    await upstream.body?.cancel().catch(() => {});
    await recordUsage(db, claims, model.model_id, null);
    // Provider bodies can echo request details; only the status is surfaced.
    return openAiError(
      reply,
      upstream.status === 429 ? 429 : 502,
      `模型服务返回错误（HTTP ${upstream.status}）`,
    );
  }
  const type = upstream.headers.get("content-type") ?? "application/json";
  if (!type.includes("text/event-stream")) {
    const text = await upstream.text();
    let usage: Usage | null = null;
    try {
      usage = usageFrom(JSON.parse(text));
    } catch {
      /* non-JSON bodies are passed through unchanged */
    }
    await recordUsage(db, claims, model.model_id, usage);
    return reply.code(200).header("content-type", type).send(text);
  }
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const sse = new SseUsage(),
    decoder = new TextDecoder();
  try {
    for await (const chunk of upstream.body) {
      sse.push(decoder.decode(chunk, { stream: true }));
      if (!reply.raw.write(chunk))
        await new Promise((r) => reply.raw.once("drain", r));
    }
  } catch {
    /* client or provider closed the stream */
  } finally {
    reply.raw.end();
    await recordUsage(db, claims, model.model_id, sse.usage);
  }
}

/** One-shot completion used by the admin connectivity test and memory summaries. */
export async function complete(
  model: Row,
  key: string,
  messages: { role: string; content: string }[],
  maxTokens: number,
  timeoutMs = 60000,
) {
  const response = await fetch(endpoint(model), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: model.provider_model,
      messages,
      max_tokens: Math.min(maxTokens, model.max_tokens),
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  }).catch(() => {
    throw new Error("无法连接模型服务");
  });
  if (!response.ok) throw new Error(`模型服务返回错误（HTTP ${response.status}）`);
  const data = (await response.json()) as Row;
  return {
    text: String(data.choices?.[0]?.message?.content ?? ""),
    usage: usageFrom(data),
  };
}
