import { randomUUID } from "node:crypto";
import { UI_INSTRUCTIONS, isInternalTool, TASK_TOOL_NAMES, type SkillSummary } from "@pi-bot/agent";
import { skillCatalog } from "./skills.js";
import { z } from "zod";
import { SHAPES, COLORS, SCHEMES, DEFAULT_AVATAR, avatarFor } from "@pi-bot/bot-face";
import { fail, type Row, type Tx } from "./db.js";
import type { Settings } from "./config.js";
import { searchAvailable } from "./search.js";

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
        lane: r.lane,
        task_id: r.task_id,
        error: r.error,
        user_message_id: r.user_message_id,
        assistant_message_id: r.assistant_message_id,
        created_at: r.created_at,
        finished_at: r.finished_at,
      }
    : null;
export const taskOut = (t: Row) => ({
  id: t.task_id,
  bot_id: t.target_bot_id,
  bot_name: t.bot_name ?? "",
  status: t.status,
  mode: t.mode,
  kind: t.kind,
  title: t.title,
  updated_at: t.updated_at,
  activity: t.activity ?? null,
});
/** `m` may carry `from_bot_name`, `from_bot_avatar` and `run_origin` from `MESSAGE_SELECT`. */
export const messageOut = (m: Row, tasks: Row[] = []) => ({
  id: m.message_id,
  bot_id: m.bot_id,
  run_id: m.run_id,
  task_id: m.run_task_id ?? null,
  seq: m.seq,
  role: m.role,
  content: m.content,
  status: m.status,
  executor: m.executor,
  tools: (m.tools ?? []).filter((tool: ToolEvent) => !isInternalTool(tool.name) && !TASK_TOOL_NAMES.has(tool.name)),
  progress: m.progress ?? [],
  ui: m.ui ?? null,
  from_bot: m.from_bot_id
    ? {
        id: m.from_bot_id,
        name: m.from_bot_name ?? "",
        avatar: m.from_bot_avatar ?? null,
        kind: m.run_origin === "report" ? "report" : "task",
      }
    : null,
  agent_tasks: m.role === "assistant" ? tasks.filter((t) => t.parent_run_id === m.run_id).map(taskOut) : [],
  created_at: m.created_at,
  updated_at: m.updated_at,
});
export const MESSAGE_SELECT = `SELECT m.*, f.name AS from_bot_name, f.avatar AS from_bot_avatar, r.origin AS run_origin, r.task_id AS run_task_id
  FROM bot_messages m LEFT JOIN bots f ON f.bot_id=m.from_bot_id LEFT JOIN bot_runs r ON r.run_id=m.run_id`;
export async function messageTasks(tx: Tx, messages: Row[]) {
  const runs = [...new Set(messages.filter((m) => m.role === "assistant" && m.run_id).map((m) => m.run_id))];
  if (!runs.length) return [];
  return tx.rows(
    `SELECT t.*, b.name AS bot_name FROM agent_tasks t JOIN bots b ON b.bot_id=t.target_bot_id
     WHERE t.parent_run_id = ANY($1) ORDER BY t.created_at`,
    [runs],
  );
}
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
  const [run, last, approvals, tasks] = await Promise.all([
    tx.one(
      "SELECT * FROM bot_runs WHERE bot_id=$1 AND lane='conversation' ORDER BY (status IN ('running','waiting_approval')) DESC, created_at DESC LIMIT 1",
      [b.bot_id],
    ),
    tx.one(
      "SELECT role,content,status,created_at FROM bot_messages WHERE bot_id=$1 AND visibility='public' ORDER BY seq DESC LIMIT 1",
      [b.bot_id],
    ),
    tx.rows(
      "SELECT * FROM approvals WHERE bot_id=$1 AND status='pending' AND expires_at>now() ORDER BY created_at",
      [b.bot_id],
    ),
    tx.rows(`SELECT t.*, b.name AS bot_name, m.progress, m.tools, r.status AS run_status
      FROM agent_tasks t JOIN bots b ON b.bot_id=t.target_bot_id
      LEFT JOIN bot_runs r ON r.run_id=t.child_run_id
      LEFT JOIN bot_messages m ON m.message_id=r.assistant_message_id
      WHERE (t.parent_bot_id=$1 OR t.target_bot_id=$1) AND t.status IN ('queued','running','waiting_approval')
      ORDER BY t.created_at`, [b.bot_id]),
  ]);
  const running = tasks.filter(t => t.status !== "queued");
  const activeTool = running.flatMap(t => t.tools ?? []).findLast(t => t.state === "running");
  const status = approvals.length ? "waiting_approval" : running.length ? "running" : tasks.length ? "queued" : run?.status ?? null;
  const labels: Record<string, string> = { run_command: "正在运行命令", web_search: "正在查找资料", read_file: "正在阅读文件", write_file: "正在整理文件", edit_file: "正在修改文件", ask_agent: "正在等待协作结果" };
  const activity = { status, tool: activeTool?.name ?? null, running_count: running.length,
    queued_count: tasks.length - running.length,
    summary: approvals.length ? "等你批准访问请求" : running.length > 1 ? `正在处理 ${running.length} 个任务` : running.length ? labels[activeTool?.name] ?? "正在处理任务" : tasks.length ? `有 ${tasks.length} 个任务排队中` : run && ACTIVE.includes(run.status) ? "正在思考" : null };
  return {
    id: b.bot_id,
    name: b.name,
    slug: b.slug,
    persona: b.persona,
    model_id: b.model_id,
    avatar: b.avatar,
    is_main: b.is_main ?? false,
    created_at: b.created_at,
    updated_at: b.updated_at,
    last_active_at: b.last_active_at,
    latest_run: runOut(run),
    active_tasks: tasks.map(taskOut),
    activity,
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
    `SELECT * FROM bots WHERE bot_id=$1 AND user_id=$2 AND archived_at IS NULL${lock ? " FOR NO KEY UPDATE" : ""}`,
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
/** One permanent entry point for each account, including accounts created before this feature. */
export async function ensureMainBot(tx: Tx, userId: string) {
  await tx.one("SELECT user_id FROM users WHERE user_id=$1 FOR UPDATE", [userId]);
  const existing = await tx.one("SELECT * FROM bots WHERE user_id=$1 AND is_main", [userId]);
  if (existing) return existing;
  const bot = await createBot(tx, userId, {
    name: "Pi Bot",
    slug: "pi-bot",
    avatar: DEFAULT_AVATAR,
    persona: "你是 Pi Bot，用户的主智能体和日常助手。帮助用户解答问题、整理资料、写作和完成日常任务。用自然、简洁的中文交流，先理解用户的目标，再主动把授权的工作做完；只有信息确实缺失时才询问。复杂任务只在开始和重要转折时简短说明进度。",
  });
  return tx.update("bots", bot.bot_id, { is_main: true });
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
  if (!(await resolveModel(tx, bot))) fail(503, "管理员尚未配置可用模型");
  const run = await insertRun(tx, { userId, botId, requestId, text, mac });
  return { run, bot, created: true };
}

export interface NewRun {
  userId: string;
  botId: string;
  requestId: string;
  text: string;
  mac: { deviceId: string } | null;
  origin?: "user" | "agent" | "report";
  taskId?: string;
  lane?: "conversation" | "task";
  /** Set when the incoming message was written by another bot rather than the user. */
  fromBotId?: string;
}
/** Appends the incoming message, an empty reply and a queued run; the caller has locked the bot and checked it is idle. */
export async function insertRun(tx: Tx, o: NewRun) {
  const seq = await nextSeq(tx, o.botId, 2);
  const runId = randomUUID(),
    userMessageId = randomUUID(),
    assistantMessageId = randomUUID();
  const executor = o.mac ? "mac" : "cloud";
  const run = await tx.insert("bot_runs", {
    run_id: runId,
    bot_id: o.botId,
    user_id: o.userId,
    request_id: o.requestId,
    executor,
    device_id: o.mac?.deviceId ?? null,
    status: "queued",
    user_message_id: userMessageId,
    assistant_message_id: assistantMessageId,
    origin: o.origin ?? "user",
    task_id: o.taskId ?? null,
    lane: o.lane ?? "conversation",
  });
  await tx.insert("bot_messages", {
    message_id: userMessageId,
    bot_id: o.botId,
    run_id: runId,
    seq,
    role: "user",
    content: o.text,
    status: "completed",
    from_bot_id: o.fromBotId ?? null,
    visibility: o.lane === "task" ? "task" : o.origin === "report" ? "internal" : "public",
  });
  await tx.insert("bot_messages", {
    message_id: assistantMessageId,
    bot_id: o.botId,
    run_id: runId,
    seq: seq + 1,
    role: "assistant",
    content: "",
    progress: [],
    status: "running",
    executor,
    visibility: o.lane === "task" ? "task" : "public",
  });
  await tx.notify({ user_id: o.userId, bot_id: o.botId });
  return run;
}

export interface RunContext {
  run_id: string;
  executor: "mac" | "cloud";
  bot: { id: string; name: string; slug: string };
  model: { id: string; name: string; context_window: number; max_tokens: number };
  system: string;
  history: { role: "user" | "assistant"; content: string }[];
  text: string;
  lane: "conversation" | "task";
  instructions?: { id: string; text: string }[];
  search_enabled: boolean;
  /** Whether the run may hand work to other bots through `ask_agent`. */
  agents_enabled: boolean;
  skills: SkillSummary[];
}
/** Deepest delegation level that may still be created: user -> A -> B -> C. */
export const MAX_DELEGATION_DEPTH = 2;
export interface Collaborator {
  name: string;
  brief: string;
}
/**
 * Bots on the delegation chain ending at `run`, nearest first, and how deep
 * the run is (0 for runs started by the user or by a report).
 */
export async function delegationChain(tx: Tx, run: Row) {
  const bots = [run.bot_id as string];
  let current = run;
  while (current.origin === "agent" && current.task_id && bots.length <= MAX_DELEGATION_DEPTH + 1) {
    const task = await tx.get("agent_tasks", current.task_id);
    if (!task || task.kind === "background") break;
    current = await tx.get("bot_runs", task.parent_run_id);
    if (!current) break;
    bots.push(current.bot_id);
  }
  return { bots, depth: bots.length - 1 };
}
export async function collaborators(tx: Tx, bot: Row): Promise<Collaborator[]> {
  const rows = await tx.rows(
    "SELECT name, persona FROM bots WHERE user_id=$1 AND bot_id<>$2 AND archived_at IS NULL ORDER BY is_main DESC, last_active_at DESC LIMIT 20",
    [bot.user_id, bot.bot_id],
  );
  return rows.map((r) => {
    const brief = String(r.persona).replace(/\s+/g, " ").trim();
    return { name: r.name, brief: brief.length > 160 ? `${brief.slice(0, 159)}…` : brief };
  });
}
function collaborationPrompt(agents: Collaborator[], depth: number) {
  return [
    "协作：你可以用 ask_agent 把任务交给同一用户的其他智能体：",
    ...agents.map((a) => `- ${a.name}${a.brief ? `：${a.brief}` : ""}`),
    "只有某个智能体的职责明显更适合，或用户明确要求时才委托；简单任务自己完成，不要为了委托而委托。",
    "对方看不到你和用户的对话，任务描述要自包含：目标、已知信息、期望的输出形式。对方使用自己的资料库，不能直接读写你的资料库文件。",
    depth === 0
      ? "几分钟内能完成的用 wait=true 等结果再回答；调研、写长文等耗时任务用 wait=false，告诉用户已经交给对方，结果回来后你会收到回报再转告用户。"
      : "你正在完成其他智能体委托的任务，如需再委托只能用 wait=true 等待结果。",
  ].join("\n");
}
export function systemPrompt(
  bot: Row,
  memory: string,
  executor: "mac" | "cloud",
  options: { search?: boolean; now?: Date; agents?: Collaborator[]; depth?: number; lane?: "conversation" | "task" } = {},
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
  if (options.lane === "conversation") parts.push([
    "你现在处于对话调度通道：持续接话、理解意图、安排工作、查询任务和整理回报。",
    "闲聊和已有依据的简单问题直接回答。凡需要搜索、读写文件、执行命令或较长推理的工作，立即用 start_task 创建后台任务，成功后用一句具体的话说明正在做什么，然后结束当前回合。你自己不能执行这些工作，也不要等待后台完成。",
    "start_task 的 task 必须自包含：用户目标、相关上下文、已有条件、文件位置和期望输出。避免重复创建已有任务。",
    "查询任务用 task_status，结果仅代表记录的活动和更新时间；查询外部训练、部署的最新状态时，另建一个简短的核查任务，不要把缓存当作刚查到的外部进度。",
    "用户补充或改变已有任务要求时，用 task_message 发给准确的任务。工具会说明是已传达、排队或已结束；已结束则结合原结果用 start_task 创建后续任务。",
    "用户要求停止时用 cancel_task。仅一个活动任务可直接定位；多个任务且指代不明时澄清。明确停止全部时传 all=true。",
    "用户新消息优先。任务回报按最新要求整理后告诉用户，不要重新执行同一任务。其他智能体的委托只能用 ask_agent(wait=false)，不得同步等待。",
  ].join("\n"));
  parts.push("默认用中文回答；用户使用其他语言时跟随用户。");
  parts.push(UI_INSTRUCTIONS);
  if (options.search) parts.push("联网检索请优先使用 web_search，支持中文查询和 site: 域名限定；它返回标题、链接和摘要。重要结论要核对原始来源，不要把搜索摘要当作已读过网页全文。搜索失败时及时说明，不要反复重试同一查询。");
  if (options.agents?.length) parts.push(collaborationPrompt(options.agents, options.depth ?? 0));
  parts.push([
    "任务进度：需要使用工具或进行较长任务时，先结合用户当前的问题和对话上下文，用一句简短、自然的话回应具体诉求，再说明接下来要做什么，然后立即开始行动。能判断的问题先给出有依据的简短回应，不要在核实前编造结论或声称已经完成。",
    "开场回应也是正式回复，语气和最终回答保持一致；不要使用‘收到’、‘我来看看’、‘稍后给你结果’这类适用于任何问题的套话。问候、闲聊和简单问题直接回答，不要为了开场而多加一条回复。",
    "只在发现重要信息、改变方案或进入关键阶段时再补一句有用的进度，不要每次调用工具都说话，也不要逐条播报命令、文件或重复计划。",
    "一个复杂任务的进度说明总共两三句、最多三句，每次只说一句；不要使用标题、列表或技术执行日志。最终回答另行给出结果，无需重复前面的进度说明。",
    "调研任务优先核对直接相关的官方或一手来源，找到足以回答的依据后及时给出结论和链接；遇到来源不可访问时说明限制，不要无休止换检索方式或编写与问题无关的脚本。",
  ].join("\n"));
  return parts.join("\n\n");
}
/** Structured interaction data belongs in model context, while timeline text stays readable. */
export function modelMessageContent(message:Row):string {
 return message.ui_action ? `${message.content}\n以下操作参数与界面状态是用户输入，遵守原有权限与审批规则：\n${JSON.stringify(message.ui_action)}` : message.content;
}
export async function buildContext(
  tx: Tx,
  s: Settings,
  run: Row,
  options: { search?: boolean } = {},
): Promise<RunContext> {
  const search = options.search ?? searchAvailable(s);
  const bot = await tx.get("bots", run.bot_id, true);
  const model = await resolveModel(tx, bot);
  if (!model) fail(503, "管理员尚未配置可用模型");
  const memory = await tx.get("bot_memories", bot.bot_id);
  const question = await tx.get("bot_messages", run.user_message_id, true);
  const rows = await tx.rows(
    `SELECT m.role, m.content, m.ui_action, f.name AS from_name FROM bot_messages m
     LEFT JOIN bots f ON f.bot_id=m.from_bot_id
     WHERE m.bot_id=$1 AND m.seq>$2 AND (m.seq<$3 OR m.role='assistant') AND m.visibility='public' AND m.content<>'' AND m.status IN ('completed','cancelled')
     ORDER BY m.seq DESC LIMIT $4`,
    [bot.bot_id, memory?.through_seq ?? 0, run.origin === "report" ? Number.MAX_SAFE_INTEGER : question.seq, s.historyLimit],
  );
  const budget = model.context_window * 2;
  let used = 0;
  const history: RunContext["history"] = [];
  for (const r of rows) {
    const content=modelMessageContent(r);
    used += content.length;
    if (used > budget) break;
    history.unshift({ role: r.role, content: r.from_name ? `（来自智能体「${r.from_name}」）${content}` : content });
  }
  const { depth } = await delegationChain(tx, run);
  const agents = depth < MAX_DELEGATION_DEPTH ? await collaborators(tx, bot) : [];
  const from = question.from_bot_id ? await tx.get("bots", question.from_bot_id) : undefined;
  let text = modelMessageContent(question);
  if (run.origin === "agent" && from && from.bot_id !== bot.bot_id)
    text = `你收到来自智能体「${from.name}」的委托，它正在为用户处理一项任务：\n\n${text}\n\n请直接完成并给出自包含的结果，「${from.name}」会把它转述给用户。缺少必要信息时直接说明缺什么，不要向用户提问。`;
  else if (run.origin === "report")
    text = `这是你之前委托给「${from?.name ?? bot.name}」的任务的回报。请据此把结果整理后告诉用户，不要再次委托同一任务：\n\n${text}`;
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
    instructions: run.task_id && run.lane === "task" ? (await tx.rows("SELECT instruction_id AS id, text FROM agent_task_instructions WHERE task_id=$1 AND delivered_at IS NULL ORDER BY created_at, instruction_id", [run.task_id])) as { id: string; text: string }[] : [],
    lane: run.lane ?? "conversation",
    system: systemPrompt(bot, memory?.summary ?? "", run.executor, { search, agents, depth, lane: run.lane }),
    history,
    text,
    search_enabled: run.lane === "task" && search,
    agents_enabled: agents.length > 0,
    skills: await skillCatalog(tx, bot.bot_id),
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
export async function setProgress(tx: Tx, run: Row, lines: string[]) {
  const progress = [...new Set(lines.map(line => line.trim().slice(0, 200)).filter(Boolean))].slice(0, 3);
  await tx.rows(
    "UPDATE bot_messages SET progress=$2, content='', updated_at=now() WHERE message_id=$1 AND status='running'",
    [run.assistant_message_id, JSON.stringify(progress)],
  );
}
export async function recordTool(tx: Tx, run: Row, tool: ToolEvent) {
  if (isInternalTool(tool.name) || TASK_TOOL_NAMES.has(tool.name)) return;
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
  if (i >= 0) tools[i] = { ...tools[i], ...entry, summary: entry.summary ?? tools[i].summary };
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
  const final = run.cancel_requested ? "cancelled" : state;
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
  if (run.origin === "agent" && run.task_id) {
    const reply = await tx.one("SELECT content FROM bot_messages WHERE message_id=$1", [run.assistant_message_id]);
    const task = await tx.one(
      "UPDATE agent_tasks SET status=$2, result=$3, error=$4, finished_at=now(), updated_at=now() WHERE task_id=$1 AND status IN ('queued','running','waiting_approval') RETURNING parent_bot_id",
      [run.task_id, final, final === "completed" ? reply?.content ?? "" : null, final === "failed" ? error ?? "运行失败" : null],
    );
    if (task) await tx.notify({ user_id: run.user_id, bot_id: task.parent_bot_id });
  }
  if (final === "cancelled" && run.lane === "task") await cancelDelegations(tx, runId);
  await tx.notify({ user_id: run.user_id, bot_id: run.bot_id });
  return { ...run, status: final };
}
/**
 * A delegating run that stops early takes its hand-offs with it. Running Mac
 * children only get `cancel_requested`; the API's dispatcher forwards the cancel.
 */
export async function cancelDelegations(tx: Tx, runId: string) {
  const tasks = await tx.rows(
    "SELECT * FROM agent_tasks WHERE parent_run_id=$1 AND (status IN ('queued','running','waiting_approval') OR (mode='report' AND delivered_at IS NULL)) ORDER BY created_at, task_id",
    [runId],
  );
  for (const snapshot of tasks) {
    if (snapshot.child_run_id) await tx.one("SELECT run_id FROM bot_runs WHERE run_id=$1 FOR UPDATE", [snapshot.child_run_id]);
    const t = (await tx.one("SELECT * FROM agent_tasks WHERE task_id=$1 FOR UPDATE", [snapshot.task_id]))!;
    await tx.rows(
      `UPDATE agent_tasks SET delivered_at=coalesce(delivered_at, now()),
         status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
         finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END
       WHERE task_id=$1`,
      [t.task_id],
    );
    if (!["queued", "running", "waiting_approval"].includes(t.status) || !t.child_run_id) continue;
    const child = await tx.one(
      "UPDATE bot_runs SET cancel_requested=true WHERE run_id=$1 AND status = ANY($2) RETURNING *",
      [t.child_run_id, ACTIVE],
    );
    if (child?.status === "queued") await finishRun(tx, child.run_id, "cancelled", null);
    else if (child) await tx.notify({ user_id: child.user_id, bot_id: child.bot_id });
  }
}
export async function messagesPage(
  tx: Tx,
  botId: string,
  before: number | undefined,
  limit: number,
) {
  const rows = await tx.rows(
    `${MESSAGE_SELECT} WHERE m.bot_id=$1 AND m.visibility='public' ${before ? "AND m.seq<$3" : ""} ORDER BY m.seq DESC LIMIT $2`,
    before ? [botId, limit + 1, before] : [botId, limit + 1],
  );
  const page = rows.slice(0, limit).reverse();
  const tasks = await messageTasks(tx, page);
  return { messages: page.map((m) => messageOut(m, tasks)), has_more: rows.length > limit };
}
