import { randomUUID } from "node:crypto";
import { fail, type Database, type Row, type Tx } from "./db.js";
import type { Settings } from "./config.js";
import type { Hub } from "./hub.js";
import type { LlmClaims } from "./security.js";
import { ACTIVE, MAX_DELEGATION_DEPTH, delegationChain, insertRun, resolveModel } from "./bots.js";
import { cancelRun, dispatchMac } from "./runs.js";

export const MAX_TASKS_PER_RUN = 5;
export const TERMINAL = ["completed", "failed", "cancelled"];

export const agentTaskOut = (t: Row) => ({
  id: t.task_id,
  status: t.status,
  mode: t.mode,
  agent: { id: t.target_bot_id, name: t.bot_name ?? "" },
  result: t.result,
  error: t.error,
  created_at: t.created_at,
  finished_at: t.finished_at,
});

/** The active run a bot-scoped proxy token is acting for. */
export async function callerRun(tx: Tx, userId: string, claims: LlmClaims, runId: string) {
  if (!claims.bot) fail(403, "令牌未绑定智能体");
  const run = await tx.one("SELECT * FROM bot_runs WHERE run_id=$1 FOR UPDATE", [runId]);
  if (
    !run ||
    run.user_id !== userId ||
    run.bot_id !== claims.bot ||
    run.executor !== claims.src ||
    (claims.src === "mac" && run.device_id !== claims.did) ||
    !ACTIVE.includes(run.status)
  )
    fail(404, "当前运行不存在或已结束");
  return run!;
}
async function ownTask(tx: Tx, userId: string, claims: LlmClaims, taskId: string, lock = false) {
  if (!claims.bot) fail(403, "令牌未绑定智能体");
  const t = await tx.one(
    `SELECT t.*, b.name AS bot_name FROM agent_tasks t JOIN bots b ON b.bot_id=t.target_bot_id
     WHERE t.task_id=$1 AND t.user_id=$2 AND t.parent_bot_id=$3${lock ? " FOR UPDATE OF t" : ""}`,
    [taskId, userId, claims.bot],
  );
  if (!t) fail(404, "委托不存在");
  return t!;
}
async function resolveTarget(tx: Tx, userId: string, name: string, selfId: string) {
  const bots = await tx.rows("SELECT * FROM bots WHERE user_id=$1 AND archived_at IS NULL ORDER BY is_main DESC, last_active_at DESC", [userId]);
  const key = name.trim(),
    lower = key.toLowerCase();
  const partial = bots.filter((b) => String(b.name).toLowerCase().includes(lower));
  const found =
    bots.find((b) => b.bot_id === key) ??
    bots.find((b) => String(b.name).toLowerCase() === lower) ??
    (partial.length === 1 ? partial[0] : undefined);
  if (!found) {
    const names = bots.filter((b) => b.bot_id !== selfId).map((b) => b.name);
    fail(404, `找不到智能体「${key}」。可以委托的有：${names.join("、") || "（没有其他智能体）"}`);
  }
  if (found!.bot_id === selfId) fail(422, "不能委托给自己，请直接完成");
  return found!;
}
/** Whether `botId`'s current run is (transitively) blocked waiting for `target`. */
async function waitsFor(tx: Tx, botId: string, target: string, seen = new Set<string>()): Promise<boolean> {
  if (seen.has(botId)) return false;
  seen.add(botId);
  const rows = await tx.rows(
    `SELECT t.target_bot_id FROM agent_tasks t JOIN bot_runs r ON r.run_id=t.parent_run_id
     WHERE r.bot_id=$1 AND r.status = ANY($2) AND t.mode='wait' AND t.status IN ('queued','running')`,
    [botId, ACTIVE],
  );
  for (const r of rows)
    if (r.target_bot_id === target || (await waitsFor(tx, r.target_bot_id, target, seen))) return true;
  return false;
}

export async function createTask(
  tx: Tx,
  hub: Hub,
  userId: string,
  claims: LlmClaims,
  body: { run_id: string; agent: string; task: string; wait: boolean },
) {
  const parent = await callerRun(tx, userId, claims, body.run_id);
  const { bots, depth } = await delegationChain(tx, parent);
  if (depth >= MAX_DELEGATION_DEPTH) fail(422, "你正在完成多层委托中的任务，不能再委托其他智能体，请自己完成");
  if (!body.wait && depth > 0) fail(422, "被委托的任务里只能用 wait=true 同步等待结果");
  const target = await resolveTarget(tx, userId, body.agent, parent.bot_id);
  if (bots.includes(target.bot_id)) fail(422, `「${target.name}」正在等你的结果，不能再委托回去，否则会形成循环`);
  if (body.wait && (await waitsFor(tx, target.bot_id, parent.bot_id)))
    fail(409, `「${target.name}」正在等你完成另一项任务，同步等待会互相卡住${depth === 0 ? "；可以改用 wait=false" : "，请自己完成"}`);
  const { n } = (await tx.one("SELECT count(*) AS n FROM agent_tasks WHERE parent_run_id=$1", [parent.run_id]))!;
  if (n >= MAX_TASKS_PER_RUN) fail(422, `本次任务已委托 ${MAX_TASKS_PER_RUN} 次，达到上限，请自己完成剩余部分`);
  const task = await tx.insert("agent_tasks", {
    task_id: randomUUID(),
    user_id: userId,
    parent_run_id: parent.run_id,
    parent_bot_id: parent.bot_id,
    target_bot_id: target.bot_id,
    mode: body.wait ? "wait" : "report",
    depth: depth + 1,
    task: body.task,
    status: "queued",
  });
  const run = await startTask(tx, hub, task);
  const saved = await tx.get("agent_tasks", task.task_id);
  return { task: agentTaskOut({ ...saved, bot_name: target.name }), run };
}

async function failQueued(tx: Tx, task: Row, error: string) {
  await tx.rows(
    "UPDATE agent_tasks SET status='failed', error=$2, finished_at=now() WHERE task_id=$1 AND status='queued'",
    [task.task_id, error],
  );
  await tx.notify({ user_id: task.user_id, bot_id: task.parent_bot_id });
}
/** Starts a queued task on its target if the target is idle; otherwise it stays queued. */
export async function startTask(tx: Tx, hub: Hub, task: Row) {
  const target = await tx.one("SELECT * FROM bots WHERE bot_id=$1 FOR UPDATE", [task.target_bot_id]);
  if (!target || target.archived_at) {
    await failQueued(tx, task, "目标智能体已归档");
    return null;
  }
  if (await tx.one("SELECT 1 FROM bot_runs WHERE bot_id=$1 AND status = ANY($2)", [target.bot_id, ACTIVE])) return null;
  if (!(await resolveModel(tx, target))) {
    await failQueued(tx, task, "管理员尚未配置可用模型");
    return null;
  }
  const conn = hub.device(task.user_id);
  const run = await insertRun(tx, {
    userId: task.user_id,
    botId: target.bot_id,
    requestId: `task:${task.task_id}`,
    text: task.task,
    mac: conn ? { deviceId: conn.deviceId } : null,
    origin: "agent",
    taskId: task.task_id,
    fromBotId: task.parent_bot_id,
  });
  await tx.rows("UPDATE agent_tasks SET status='running', child_run_id=$2 WHERE task_id=$1", [task.task_id, run.run_id]);
  await tx.notify({ user_id: task.user_id, bot_id: task.parent_bot_id });
  return run;
}

export async function readTask(tx: Tx, userId: string, claims: LlmClaims, taskId: string) {
  return agentTaskOut(await ownTask(tx, userId, claims, taskId));
}
/** The delegating tool gave up (its run stopped); nothing is reported back afterwards. */
export async function cancelTask(tx: Tx, hub: Hub, userId: string, claims: LlmClaims, taskId: string) {
  const t = await ownTask(tx, userId, claims, taskId, true);
  await tx.rows("UPDATE agent_tasks SET delivered_at=coalesce(delivered_at, now()) WHERE task_id=$1", [taskId]);
  let notify: { runId: string; send(m: Row): void } | null = null;
  if (t.status === "queued")
    await tx.rows("UPDATE agent_tasks SET status='cancelled', finished_at=now() WHERE task_id=$1", [taskId]);
  else if (t.status === "running" && t.child_run_id) {
    const r = await cancelRun(tx, hub, userId, t.child_run_id);
    if (r.notify) notify = { runId: t.child_run_id, send: (m) => r.notify!.send(m) };
  }
  await tx.notify({ user_id: userId, bot_id: t.parent_bot_id });
  return { task: agentTaskOut(await ownTask(tx, userId, claims, taskId)), notify };
}
/** A synchronous wait that ran too long becomes a hand-off reported back later. */
export async function reportLater(tx: Tx, userId: string, claims: LlmClaims, taskId: string) {
  const t = await ownTask(tx, userId, claims, taskId, true);
  if (TERMINAL.includes(t.status) || t.mode === "report") return agentTaskOut(t);
  const parent = await tx.get("bot_runs", t.parent_run_id);
  if (!parent || (await delegationChain(tx, parent)).depth > 0) fail(422, "被委托的任务里只能同步等待结果");
  await tx.rows("UPDATE agent_tasks SET mode='report' WHERE task_id=$1", [taskId]);
  return agentTaskOut({ ...t, mode: "report" });
}

function reportText(t: Row) {
  const task = t.task.length > 500 ? `${t.task.slice(0, 499)}…` : t.task;
  if (t.status === "completed")
    return `「${t.bot_name}」完成了你委托的任务。\n\n任务：${task}\n\n结果：\n${String(t.result || "（没有文字结果）").slice(0, 20000)}`;
  if (t.status === "failed") return `「${t.bot_name}」没能完成你委托的任务：${t.error ?? "运行失败"}\n\n任务：${task}`;
  return `「${t.bot_name}」的任务已被取消。\n\n任务：${task}`;
}

/**
 * Lives in the API process because only it holds the Mac sockets. Starts queued
 * tasks once their target is idle, reports finished hand-offs back to the
 * delegating bot, and forwards cascaded cancels to the Mac.
 */
export class AgentDispatcher {
  private timer?: NodeJS.Timeout;
  private pending?: NodeJS.Timeout;
  private cycle?: Promise<void>;
  private again = false;
  private stopped = false;
  private cancelSent = new Set<string>();
  constructor(
    private db: Database,
    private s: Settings,
    private hub: Hub,
    private intervalMs = 5000,
  ) {}
  start() {
    this.timer = setInterval(() => this.kick(), this.intervalMs);
    this.kick();
  }
  /** Coalesces bursts of change notifications into one pass. */
  kick() {
    if (this.stopped || this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.run();
    }, 100);
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.pending);
    await this.cycle;
  }
  private run() {
    if (this.cycle) return void (this.again = true);
    this.cycle = this.once()
      .catch(() => console.error("agent dispatch failed"))
      .finally(() => {
        this.cycle = undefined;
        if (this.again && !this.stopped) {
          this.again = false;
          this.run();
        }
      });
  }
  async once() {
    await this.startQueued();
    await this.deliverReports();
    await this.forwardCancels();
  }
  private async startQueued() {
    const queued = await this.db.tx((tx) =>
      tx.rows(
        `SELECT t.task_id FROM agent_tasks t WHERE t.status='queued'
         AND NOT EXISTS (SELECT 1 FROM bot_runs r WHERE r.bot_id=t.target_bot_id AND r.status = ANY($1))
         ORDER BY t.created_at LIMIT 20`,
        [ACTIVE],
      ),
    );
    for (const { task_id } of queued) {
      if (this.stopped) return;
      try {
        const run = await this.db.tx(async (tx) => {
          const t = await tx.one("SELECT * FROM agent_tasks WHERE task_id=$1 AND status='queued' FOR UPDATE SKIP LOCKED", [task_id]);
          return t ? startTask(tx, this.hub, t) : null;
        });
        if (run?.executor === "mac") await dispatchMac(this.db, this.s, this.hub, run.run_id);
      } catch {
        console.error("agent task start failed");
      }
    }
  }
  private async deliverReports() {
    const finished = await this.db.tx((tx) =>
      tx.rows(
        `SELECT t.task_id FROM agent_tasks t
         WHERE t.mode='report' AND t.delivered_at IS NULL AND t.status IN ('completed','failed','cancelled')
           AND NOT EXISTS (SELECT 1 FROM bot_runs r WHERE r.bot_id=t.parent_bot_id AND r.status = ANY($1))
         ORDER BY t.finished_at LIMIT 20`,
        [ACTIVE],
      ),
    );
    for (const { task_id } of finished) {
      if (this.stopped) return;
      try {
        const run = await this.db.tx(async (tx) => {
          const t = await tx.one(
            `SELECT t.*, b.name AS bot_name FROM agent_tasks t JOIN bots b ON b.bot_id=t.target_bot_id
             WHERE t.task_id=$1 AND t.delivered_at IS NULL FOR UPDATE OF t SKIP LOCKED`,
            [task_id],
          );
          if (!t) return null;
          const bot = await tx.one("SELECT * FROM bots WHERE bot_id=$1 FOR UPDATE", [t.parent_bot_id]);
          if (bot && !bot.archived_at && (await tx.one("SELECT 1 FROM bot_runs WHERE bot_id=$1 AND status = ANY($2)", [bot.bot_id, ACTIVE])))
            return null;
          await tx.rows("UPDATE agent_tasks SET delivered_at=now() WHERE task_id=$1", [task_id]);
          if (!bot || bot.archived_at || !(await resolveModel(tx, bot))) return null;
          const conn = this.hub.device(t.user_id);
          return insertRun(tx, {
            userId: t.user_id,
            botId: bot.bot_id,
            requestId: `report:${t.task_id}`,
            text: reportText(t),
            mac: conn ? { deviceId: conn.deviceId } : null,
            origin: "report",
            taskId: t.task_id,
            fromBotId: t.target_bot_id,
          });
        });
        if (run?.executor === "mac") await dispatchMac(this.db, this.s, this.hub, run.run_id);
      } catch {
        console.error("agent report delivery failed");
      }
    }
  }
  private async forwardCancels() {
    const runs = await this.db.tx((tx) =>
      tx.rows(
        "SELECT run_id, user_id, device_id FROM bot_runs WHERE cancel_requested AND executor='mac' AND origin='agent' AND status = ANY($1)",
        [ACTIVE],
      ),
    );
    const live = new Set(runs.map((r) => r.run_id));
    for (const id of this.cancelSent) if (!live.has(id)) this.cancelSent.delete(id);
    for (const r of runs) {
      if (this.cancelSent.has(r.run_id)) continue;
      const conn = this.hub.device(r.user_id);
      if (!conn || conn.deviceId !== r.device_id) continue;
      conn.send({ type: "cancel", run_id: r.run_id });
      this.cancelSent.add(r.run_id);
    }
  }
}
