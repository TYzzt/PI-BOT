import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SHAPES, COLORS, SCHEMES, avatarFor } from "@pi-bot/bot-face";
import { fail, type Row, type Tx } from "./db.js";
import type { Settings } from "./config.js";

export const ACTIVE = ["queued", "running", "waiting_approval"];
export const avatarSchema = z.object({
  shape: z.enum(SHAPES),
  color: z.enum(COLORS),
  scheme: z.enum(SCHEMES).default("light"),
});
export const botInput = z.object({
  name: z.string().trim().min(1).max(40),
  persona: z.string().max(8000).default(""),
  model_id: z.string().uuid().nullable().optional(),
  avatar: avatarSchema.optional(),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "目录名只能包含小写字母、数字和短横线")
    .optional(),
});
export const botPatch = botInput.omit({ slug: true }).partial();

export function slugBase(name: string) {
  const ascii = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return ascii || "bot";
}
async function uniqueSlug(tx: Tx, userId: string, base: string) {
  const taken = new Set(
    (
      await tx.rows(
        "SELECT slug FROM bots WHERE user_id=$1 AND (slug=$2 OR slug LIKE $3)",
        [userId, base, `${base}-%`],
      )
    ).map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

export const runOut = (r: Row | undefined) =>
  r
    ? {
        id: r.run_id,
        bot_id: r.bot_id,
        status: r.status,
        executor: r.executor,
        error: r.error,
        user_message_id: r.user_message_id,
        assistant_message_id: r.assistant_message_id,
        created_at: r.created_at,
        finished_at: r.finished_at,
      }
    : null;
export const messageOut = (m: Row) => ({
  id: m.message_id,
  bot_id: m.bot_id,
  run_id: m.run_id,
  seq: m.seq,
  role: m.role,
  content: m.content,
  status: m.status,
  executor: m.executor,
  tools: m.tools ?? [],
  created_at: m.created_at,
  updated_at: m.updated_at,
});
export const approvalOut = (a: Row) => ({
  id: a.approval_id,
  run_id: a.run_id,
  bot_id: a.bot_id,
  kind: a.kind,
  path: a.detail.path,
  reason: a.detail.reason,
  status:
    a.status === "pending" && new Date(a.expires_at) < new Date()
      ? "expired"
      : a.status,
  expires_at: a.expires_at,
  created_at: a.created_at,
});
export async function botOut(tx: Tx, b: Row) {
  const [run, last, approvals] = await Promise.all([
    tx.one(
      "SELECT * FROM bot_runs WHERE bot_id=$1 ORDER BY created_at DESC LIMIT 1",
      [b.bot_id],
    ),
    tx.one(
      "SELECT role,content,status,created_at FROM bot_messages WHERE bot_id=$1 ORDER BY seq DESC LIMIT 1",
      [b.bot_id],
    ),
    tx.rows(
      "SELECT * FROM approvals WHERE bot_id=$1 AND status='pending' AND expires_at>now() ORDER BY created_at",
      [b.bot_id],
    ),
  ]);
  return {
    id: b.bot_id,
    name: b.name,
    slug: b.slug,
    persona: b.persona,
    model_id: b.model_id,
    avatar: b.avatar,
    created_at: b.created_at,
    updated_at: b.updated_at,
    last_active_at: b.last_active_at,
    latest_run: runOut(run),
    last_message: last
      ? {
          role: last.role,
          preview: String(last.content).slice(0, 120),
          status: last.status,
          created_at: last.created_at,
        }
      : null,
    pending_approvals: approvals.map(approvalOut),
  };
}
export async function ownBot(tx: Tx, userId: string, botId: string, lock = false) {
  const b = await tx.one(
    `SELECT * FROM bots WHERE bot_id=$1 AND user_id=$2 AND archived_at IS NULL${lock ? " FOR UPDATE" : ""}`,
    [botId, userId],
  );
  if (!b) fail(404, "Bot 不存在");
  return b!;
}
async function checkModel(tx: Tx, modelId: string | null | undefined) {
  if (!modelId) return;
  const m = await tx.get("models", modelId);
  if (!m || !m.enabled) fail(422, "模型不可用");
}
export async function createBot(
  tx: Tx,
  userId: string,
  input: z.infer<typeof botInput>,
) {
  await checkModel(tx, input.model_id);
  const id = randomUUID();
  const slug = await uniqueSlug(tx, userId, input.slug ?? slugBase(input.name));
  return tx.insert("bots", {
    bot_id: id,
    user_id: userId,
    name: input.name,
    slug,
    persona: input.persona,
    model_id: input.model_id ?? null,
    avatar: input.avatar ?? avatarFor(id),
  });
}
export async function updateBot(
  tx: Tx,
  userId: string,
  botId: string,
  patch: z.infer<typeof botPatch>,
) {
  await ownBot(tx, userId, botId);
  if (patch.model_id !== undefined) await checkModel(tx, patch.model_id);
  // The library directory keeps its slug when a bot is renamed.
  return tx.update("bots", botId, {
    name: patch.name,
    persona: patch.persona,
    model_id: patch.model_id,
    avatar: patch.avatar,
    updated_at: new Date(),
  });
}
export async function resolveModel(tx: Tx, bot: Row) {
  const m =
    (bot.model_id &&
      (await tx.one("SELECT * FROM models WHERE model_id=$1 AND enabled", [
        bot.model_id,
      ]))) ||
    (await tx.one("SELECT * FROM models WHERE enabled ORDER BY is_default DESC, created_at LIMIT 1"));
  return m;
}
async function nextSeq(tx: Tx, botId: string, count: number) {
  const r = await tx.one(
    "UPDATE bots SET next_seq=next_seq+$2, last_active_at=now() WHERE bot_id=$1 RETURNING next_seq",
    [botId, count],
  );
  return r!.next_seq - count;
}
export async function postMessage(
  tx: Tx,
  userId: string,
  botId: string,
  text: string,
  requestId: string,
  mac: { deviceId: string } | null,
) {
  const bot = await ownBot(tx, userId, botId, true);
  const existing = await tx.one(
    "SELECT * FROM bot_runs WHERE bot_id=$1 AND request_id=$2",
    [botId, requestId],
  );
  if (existing) return { run: existing, bot, created: false };
  if (
    await tx.one(
      `SELECT 1 FROM bot_runs WHERE bot_id=$1 AND status = ANY($2)`,
      [botId, ACTIVE],
    )
  )
    fail(409, "Bot 正在处理上一条消息，请稍候或先停止");
  if (!(await resolveModel(tx, bot))) fail(503, "管理员尚未配置可用模型");
  const seq = await nextSeq(tx, botId, 2);
  const runId = randomUUID(),
    userMessageId = randomUUID(),
    assistantMessageId = randomUUID();
  const executor = mac ? "mac" : "cloud";
  const run = await tx.insert("bot_runs", {
    run_id: runId,
    bot_id: botId,
    user_id: userId,
    request_id: requestId,
    executor,
    device_id: mac?.deviceId ?? null,
    status: "queued",
    user_message_id: userMessageId,
    assistant_message_id: assistantMessageId,
  });
  await tx.insert("bot_messages", {
    message_id: userMessageId,
    bot_id: botId,
    run_id: runId,
    seq,
    role: "user",
    content: text,
    status: "completed",
  });
  await tx.insert("bot_messages", {
    message_id: assistantMessageId,
    bot_id: botId,
    run_id: runId,
    seq: seq + 1,
    role: "assistant",
    content: "",
    status: "running",
    executor,
  });
  await tx.notify({ user_id: userId, bot_id: botId });
  return { run, bot, created: true };
}

export interface RunContext {
  run_id: string;
  executor: "mac" | "cloud";
  bot: { id: string; name: string; slug: string };
  model: { id: string; name: string; context_window: number; max_tokens: number };
  system: string;
  history: { role: "user" | "assistant"; content: string }[];
  text: string;
}
export function systemPrompt(
  bot: Row,
  memory: string,
  executor: "mac" | "cloud",
  options: { search?: boolean; now?: Date } = {},
) {
  const date = (options.now ?? new Date()).toISOString().slice(0, 10);
  const parts = [
    `你是「${bot.name}」，一个运行在 Pi Bot 中的智能体。今天是 ${date}。`,
  ];
  if (bot.persona.trim()) parts.push(`你的人设与职责：\n${bot.persona.trim()}`);
  if (memory.trim()) parts.push(`你对之前对话的长期记忆（摘要）：\n${memory.trim()}`);
  parts.push(
    executor === "mac"
      ? [
          "执行环境：你在用户的 Mac 上工作。",
          `你的资料库目录是 ~/pi-bot/${bot.slug}，也是当前工作目录；文件工具中的相对路径都位于资料库内，产出的文件请保存在这里。`,
          "你可以读写资料库文件并执行终端命令。访问资料库以外的路径前，必须先调用 request_outside_access 说明原因并等待用户批准。",
          "不要执行破坏性或不可逆的系统操作；需要密码或交互登录时请让用户自行处理。",
        ].join("\n")
      : [
          "执行环境：用户的 Mac 当前离线，资料库文件和终端都不可用。",
          `你只能对话${options.search ? "和联网搜索" : ""}。任务需要读写文件或运行命令时，说明需要等 Mac 上线后再继续，不要假装已经完成。`,
        ].join("\n"),
  );
  parts.push("默认用中文回答；用户使用其他语言时跟随用户。");
  return parts.join("\n\n");
}
export async function buildContext(
  tx: Tx,
  s: Settings,
  run: Row,
  options: { search?: boolean } = {},
): Promise<RunContext> {
  const bot = await tx.get("bots", run.bot_id, true);
  const model = await resolveModel(tx, bot);
  if (!model) fail(503, "管理员尚未配置可用模型");
  const memory = await tx.get("bot_memories", bot.bot_id);
  const question = await tx.get("bot_messages", run.user_message_id, true);
  const rows = await tx.rows(
    `SELECT role,content FROM bot_messages
     WHERE bot_id=$1 AND seq>$2 AND seq<$3 AND content<>'' AND status IN ('completed','cancelled')
     ORDER BY seq DESC LIMIT $4`,
    [bot.bot_id, memory?.through_seq ?? 0, question.seq, s.historyLimit],
  );
  const budget = model.context_window * 2;
  let used = 0;
  const history: RunContext["history"] = [];
  for (const r of rows) {
    used += r.content.length;
    if (used > budget) break;
    history.unshift({ role: r.role, content: r.content });
  }
  return {
    run_id: run.run_id,
    executor: run.executor,
    bot: { id: bot.bot_id, name: bot.name, slug: bot.slug },
    model: {
      id: model.model_id,
      name: model.name,
      context_window: model.context_window,
      max_tokens: model.max_tokens,
    },
    system: systemPrompt(bot, memory?.summary ?? "", run.executor, options),
    history,
    text: question.content,
  };
}
export async function setContent(tx: Tx, run: Row, content: string) {
  await tx.rows(
    "UPDATE bot_messages SET content=$2, updated_at=now() WHERE message_id=$1 AND status='running'",
    [run.assistant_message_id, content],
  );
}
export interface ToolEvent {
  id: string;
  name: string;
  state: "running" | "completed" | "failed";
  summary?: string;
}
export async function recordTool(tx: Tx, run: Row, tool: ToolEvent) {
  const m = await tx.get("bot_messages", run.assistant_message_id);
  if (!m) return;
  const tools: ToolEvent[] = Array.isArray(m.tools) ? m.tools : [];
  const entry = {
    id: String(tool.id).slice(0, 80),
    name: String(tool.name).slice(0, 80),
    state: tool.state,
    summary: tool.summary ? String(tool.summary).slice(0, 300) : undefined,
  };
  const i = tools.findIndex((t) => t.id === entry.id);
  if (i >= 0) tools[i] = { ...tools[i], ...entry };
  else tools.push(entry);
  await tx.rows(
    "UPDATE bot_messages SET tools=$2, updated_at=now() WHERE message_id=$1",
    [m.message_id, JSON.stringify(tools.slice(-50))],
  );
}
export async function markRunning(tx: Tx, runId: string) {
  return tx.one(
    "UPDATE bot_runs SET status='running', started_at=coalesce(started_at, now()) WHERE run_id=$1 AND status IN ('queued','waiting_approval') RETURNING *",
    [runId],
  );
}
export async function finishRun(
  tx: Tx,
  runId: string,
  state: "completed" | "failed" | "cancelled",
  error: string | null,
  content?: string,
) {
  const run = await tx.one(
    "SELECT * FROM bot_runs WHERE run_id=$1 FOR UPDATE",
    [runId],
  );
  if (!run || !ACTIVE.includes(run.status)) return null;
  const final = run.cancel_requested && state !== "completed" ? "cancelled" : state;
  await tx.rows(
    "UPDATE bot_runs SET status=$2, error=$3, finished_at=now(), lease_until=NULL WHERE run_id=$1",
    [runId, final, final === "failed" ? error : null],
  );
  await tx.rows(
    `UPDATE bot_messages SET status=$2, content=coalesce($3, content), updated_at=now() WHERE message_id=$1`,
    [run.assistant_message_id, final, content ?? null],
  );
  await tx.rows(
    "UPDATE approvals SET status='expired', decided_at=now() WHERE run_id=$1 AND status='pending'",
    [runId],
  );
  await tx.rows("UPDATE bots SET last_active_at=now() WHERE bot_id=$1", [run.bot_id]);
  await tx.notify({ user_id: run.user_id, bot_id: run.bot_id });
  return { ...run, status: final };
}
export async function messagesPage(
  tx: Tx,
  botId: string,
  before: number | undefined,
  limit: number,
) {
  const rows = await tx.rows(
    `SELECT * FROM bot_messages WHERE bot_id=$1 ${before ? "AND seq<$3" : ""} ORDER BY seq DESC LIMIT $2`,
    before ? [botId, limit + 1, before] : [botId, limit + 1],
  );
  const page = rows.slice(0, limit).reverse();
  return { messages: page.map(messageOut), has_more: rows.length > limit };
}
