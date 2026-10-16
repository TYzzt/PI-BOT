import { randomUUID } from "node:crypto";
import { Database, type Row } from "./db.js";
import { settings, type Settings } from "./config.js";
import { issueLlmToken, Vault } from "./security.js";
import { migrate } from "./migrate.js";
import { modelMessageContent, buildContext, finishRun, markRunning, recordTool, resolveModel, setContent, setProgress, type RunContext } from "./bots.js";
import { complete, recordUsage } from "./llm.js";

import {recordUi} from "./ui.js";

const RUN_LIMIT_MS = 30 * 60 * 1000;

/**
 * Executes cloud runs (Mac offline) through the Runner and keeps each bot's
 * rolling memory summary up to date.
 */
export class Worker {
  readonly id = randomUUID();
  private stopped = false;
  private controllers = new Set<AbortController>();
  private running = new Set<Promise<void>>();
  constructor(
    readonly db: Database,
    readonly s: Settings,
  ) {
    if (!s.runnerToken || s.runnerToken.length < 32) throw new Error("需要配置 PI_BOT_RUNNER_TOKEN（至少 32 字符）");
  }
  stop() {
    this.stopped = true;
    for (const c of this.controllers) c.abort();
  }
  async claim(): Promise<RunContext | undefined> {
    return this.db.tx(async (tx) => {
      const stale = await tx.rows(
        "SELECT run_id FROM bot_runs WHERE executor='cloud' AND status='running' AND lease_until < now() FOR UPDATE SKIP LOCKED",
      );
      for (const r of stale) await finishRun(tx, r.run_id, "failed", "云端执行中断，请重新发送");
      const run = await tx.one(
        "SELECT * FROM bot_runs WHERE executor='cloud' AND status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED",
      );
      if (!run) return;
      if (run.cancel_requested) {
        await finishRun(tx, run.run_id, "cancelled", null);
        return;
      }
      await tx.rows("UPDATE bot_runs SET worker_id=$2, lease_until=$3 WHERE run_id=$1", [
        run.run_id,
        this.id,
        new Date(Date.now() + this.s.leaseSeconds * 1000),
      ]);
      await markRunning(tx, run.run_id);
      await tx.notify({ user_id: run.user_id, bot_id: run.bot_id });
      try {
        return await buildContext(tx, this.s, run);
      } catch {
        await finishRun(tx, run.run_id, "failed", "管理员尚未配置可用模型");
      }
    });
  }
  async runOnce() {
    const job = await this.claim();
    if (!job) return false;
    await this.execute(job);
    return true;
  }
  private async execute(job: RunContext) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const owner = await this.db.tx((tx) => tx.get("bot_runs", job.run_id));
    let content = "",
      state: "completed" | "failed" | "cancelled" = "failed",
      error: string | null = "模型请求失败，请稍后重试",
      lost = false,
      cancelled = false,
      written = 0,
      beating = false;
    const headers = { Authorization: `Bearer ${this.s.runnerToken}`, "Content-Type": "application/json" };
    const cancelRunner = () =>
      fetch(`${this.s.runnerUrl}/runs/${job.run_id}/cancel`, { method: "POST", headers, signal: AbortSignal.timeout(5000) }).catch(() => {});
    const ours = (r: Row | undefined) => !!r && r.status === "running" && r.worker_id === this.id;
    const beat = async () => {
      if (beating) return;
      beating = true;
      try {
        await this.db.tx(async (tx) => {
          const r = await tx.get("bot_runs", job.run_id);
          if (!ours(r)) {
            lost = true;
            return;
          }
          cancelled = r.cancel_requested;
          await tx.rows("UPDATE bot_runs SET lease_until=$2 WHERE run_id=$1", [job.run_id, new Date(Date.now() + this.s.leaseSeconds * 1000)]);
        });
      } catch {
        lost = true;
      } finally {
        beating = false;
      }
      if (cancelled || lost || this.stopped) {
        await cancelRunner();
        controller.abort();
      }
    };
    const timer = setInterval(() => void beat(), Math.max(1000, Math.min(15000, this.s.leaseSeconds * 250)));
    const deadline = setTimeout(() => {
      error = "运行超过 30 分钟，已停止";
      void cancelRunner();
      controller.abort();
    }, RUN_LIMIT_MS);
    let sawDone = false;
    try {
      const token = await issueLlmToken({ sub: owner.user_id, src: "cloud", bot: job.bot.id }, this.s, Math.ceil(RUN_LIMIT_MS / 1000) + 300);
      const response = await fetch(`${this.s.runnerUrl}/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ run: job, base_url: `${this.s.internalUrl}/llm/v1`, token }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error("Runner unavailable");
      let buffer = "";
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const e = JSON.parse(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          if (e.type === "text") {
            content = e.text;
            if (Date.now() - written >= 500) {
              written = Date.now();
              await this.db.tx(async (tx) => {
                const r = await tx.get("bot_runs", job.run_id);
                if (!ours(r)) return void (lost = true);
                await setContent(tx, r, content);
                await tx.notify({ user_id: r.user_id, bot_id: r.bot_id, message_id: r.assistant_message_id, content });
              });
            }
          } else if (e.type === "ui") {
            await this.db.tx(async tx => { const r=await tx.get("bot_runs",job.run_id); if(ours(r)) await recordUi(tx,r,e.messages); });
          } else if (e.type === "progress") {
            content = "";
            written = 0;
            await this.db.tx(async (tx) => {
              const r = await tx.get("bot_runs", job.run_id);
              if (!ours(r)) return;
              await setProgress(tx, r, e.lines);
              await tx.notify({ user_id: r.user_id, bot_id: r.bot_id });
            });
          } else if (e.type === "tool")
            await this.db.tx(async (tx) => {
              const r = await tx.get("bot_runs", job.run_id);
              if (!ours(r)) return;
              await recordTool(tx, r, e);
              await tx.notify({ user_id: r.user_id, bot_id: r.bot_id });
            });
          else if (e.type === "done") {
            sawDone = true;
            state = e.state;
            error = e.error ?? null;
            if (typeof e.text === "string") content = e.text;
          }
        }
      }
      if (!sawDone) throw new Error("Runner stream interrupted");
    } catch {
      if (cancelled) {
        state = "cancelled";
        error = null;
      } else if (this.stopped) error = "云端执行中断，请重新发送";
      state = cancelled ? "cancelled" : "failed";
      await cancelRunner();
    } finally {
      clearInterval(timer);
      clearTimeout(deadline);
      this.controllers.delete(controller);
    }
    if (!lost)
      await this.db.tx(async (tx) => {
        const r = await tx.get("bot_runs", job.run_id);
        if (!ours(r)) return;
        await finishRun(tx, job.run_id, state, error, content);
      });
  }

  /** Folds old messages into the bot's long-term summary once the tail grows past the threshold. */
  async compactOnce(): Promise<boolean> {
    const job = await this.db.tx(async (tx) => {
      const b = await tx.one(
        `SELECT b.*, coalesce(m.through_seq,0) AS through_seq, coalesce(m.summary,'') AS summary FROM bots b
         LEFT JOIN bot_memories m USING(bot_id)
         WHERE b.archived_at IS NULL AND b.next_seq - 1 - coalesce(m.through_seq,0) > $1
           AND NOT EXISTS (SELECT 1 FROM bot_runs r WHERE r.bot_id=b.bot_id AND r.status IN ('queued','running','waiting_approval'))
         ORDER BY b.last_active_at DESC LIMIT 1 FOR UPDATE OF b SKIP LOCKED`,
        [this.s.memoryThreshold],
      );
      if (!b) return null;
      const until = b.next_seq - 1 - Math.min(20, Math.floor(this.s.memoryThreshold / 2));
      const messages = await tx.rows(
        "SELECT seq, role, content, ui_action FROM bot_messages WHERE bot_id=$1 AND seq>$2 AND seq<=$3 AND content<>'' ORDER BY seq",
        [b.bot_id, b.through_seq, until],
      );
      const model = await resolveModel(tx, b);
      if (!model) return null;
      // Mark progress first so a failing provider cannot make this bot block the queue.
      await tx.rows(
        `INSERT INTO bot_memories(bot_id, summary, through_seq, updated_at) VALUES($1,$2,$3,now())
         ON CONFLICT (bot_id) DO UPDATE SET through_seq=EXCLUDED.through_seq, updated_at=now()`,
        [b.bot_id, b.summary, until],
      );
      return { bot: b, messages, model, until };
    });
    if (!job) return false;
    const transcript = job.messages
      .map((m) => `${m.role === "user" ? "用户" : job.bot.name}：${modelMessageContent(m).slice(0, 4000)}`)
      .join("\n\n")
      .slice(-job.model.context_window * 2);
    try {
      const key = new Vault(this.s.vaultFile).open(job.model.secret, job.model.model_id);
      const r = await complete(
        job.model,
        key,
        [
          {
            role: "system",
            content: "你负责维护一个智能体的长期记忆。把旧记忆和新增对话合并成简洁的中文要点：用户偏好、身份与背景、进行中的事项、已完成的结论、资料库中重要文件。删除寒暄和过时信息，不超过 1500 字。只输出记忆正文。",
          },
          { role: "user", content: `旧记忆：\n${job.bot.summary || "（无）"}\n\n新增对话：\n${transcript}` },
        ],
        2000,
        120000,
      );
      await recordUsage(this.db, { sub: job.bot.user_id, src: "memory", bot: job.bot.bot_id }, job.model.model_id, r.usage);
      if (r.text.trim())
        await this.db.tx((tx) =>
          tx.rows("UPDATE bot_memories SET summary=$2, updated_at=now() WHERE bot_id=$1 AND through_seq=$3", [job.bot.bot_id, r.text.trim().slice(0, 8000), job.until]),
        );
    } catch {
      console.error("memory compaction failed");
    }
    return true;
  }

  async runForever() {
    while (!this.stopped) {
      try {
        if (this.running.size < this.s.workerConcurrency) {
          const job = await this.claim();
          if (job) {
            const p: Promise<void> = this.execute(job)
              .catch(() => console.error("cloud run failed"))
              .finally(() => this.running.delete(p));
            this.running.add(p);
            continue;
          }
        }
        if (await this.compactOnce()) continue;
      } catch {
        console.error("cloud worker cycle failed");
      }
      await new Promise((resolve) => setTimeout(resolve, this.s.pollSeconds * 1000));
    }
    await Promise.all(this.running);
  }
}

if (process.argv[1]?.endsWith("/worker.ts") || process.argv[1]?.endsWith("/worker.mjs")) {
  const s = settings(),
    db = new Database(s.databaseUrl);
  await migrate(db);
  const worker = new Worker(db, s);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => worker.stop());
  try {
    await worker.runForever();
  } finally {
    await db.close();
  }
}
