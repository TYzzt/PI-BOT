import { randomUUID } from "node:crypto";
import { Database, type Row, type Tx } from "./db.js";
import { settings, type Settings } from "./config.js";
import { Vault } from "./security.js";
import { change, docs, newDoc, terminal } from "./shared.js";
import { migrate } from "./migrate.js";
export class Worker {
  readonly id = randomUUID();
  private stopped = false;
  private abort?: AbortController;
  constructor(
    readonly db: Database,
    readonly s: Settings,
  ) {
    if (!s.runnerToken || s.runnerToken.length < 32)
      throw new Error("需要配置 Runner token");
  }
  stop() {
    this.stopped = true;
    this.abort?.abort();
  }
  async finish(
    tx: Tx,
    r: Row,
    state: string,
    error: string | null,
    content?: string,
  ) {
    r.version++;
    r.data = { ...r.data, state, error, lease_until: null };
    await change(tx, r);
    const m = r.data.assistant_message_id
      ? await tx.get("shared_documents", r.data.assistant_message_id)
      : null;
    if (m) {
      m.version++;
      m.data = {
        ...m.data,
        status: state,
        ...(content !== undefined ? { content } : {}),
      };
      await change(tx, m);
    }
    if (state !== "completed") {
      const c = await tx.get("shared_documents", r.data.conversation_id);
      if (c) {
        c.data = { ...c.data, generation: (c.data.generation ?? 0) + 1 };
        await tx.save("shared_documents", c);
      }
    }
  }
  async claim(): Promise<Row | undefined> {
    return this.db.tx(async (tx) => {
      const running = (await docs(tx, "chat_run", null)).filter(
        (r) => r.data.state === "running",
      );
      for (const r of running)
        if (new Date(r.data.lease_until ?? 0).getTime() < Date.now())
          await this.finish(tx, r, "interrupted", "云端执行中断，请重新提问");
        else return undefined;
      const run = await tx.one(
        "SELECT * FROM shared_documents WHERE kind='chat_run' AND device_id IS NULL AND data->>'state'='queued' ORDER BY position LIMIT 1 FOR UPDATE SKIP LOCKED",
      );
      if (!run) return;
      const c = await tx.get("shared_documents", run.data.conversation_id),
        model = c
          ? await tx.get("shared_documents", c.data.model_config_id)
          : null;
      run.version++;
      run.data = {
        ...run.data,
        state: "running",
        acked: true,
        worker_id: this.id,
        lease_until: new Date(
          Date.now() + this.s.leaseSeconds * 1000,
        ).toISOString(),
        error: null,
      };
      await change(tx, run);
      const history = c
          ? await tx.rows(
              "SELECT * FROM shared_documents WHERE kind='message' AND device_id IS NULL AND data->>'conversation_id'=$1 AND (data->>'sequence')::bigint>0 ORDER BY (data->>'sequence')::bigint",
              [c.id],
            )
          : [],
        sequence = history.reduce((n, m) => Math.max(n, m.data.sequence), 0),
        question = await tx.get("shared_documents", run.data.message_id);
      if (question) {
        question.version++;
        question.data = {
          ...question.data,
          status: "completed",
          sequence: sequence + 1,
        };
        await change(tx, question);
      }
      const assistant = await newDoc(tx, randomUUID(), "message", null, {
        conversation_id: run.data.conversation_id,
        run_id: run.id,
        role: "assistant",
        content: "",
        status: "running",
        sequence: sequence + 2,
      });
      await change(tx, assistant);
      run.data = { ...run.data, assistant_message_id: assistant.id };
      await tx.save("shared_documents", run);
      if (
        !c ||
        c.data.deleted ||
        !model ||
        model.kind !== "cloud_model" ||
        model.data.deleted
      ) {
        await this.finish(tx, run, "failed", "云端模型不可用，请更换模型");
        return;
      }
      let key: string;
      try {
        key = new Vault(this.s.vaultFile).open(model.data.secret, model.id);
      } catch {
        await this.finish(
          tx,
          run,
          "failed",
          "云端模型密钥不可用，请重新保存模型",
        );
        return;
      }
      const config = model.data.config;
      return {
        runId: run.id,
        conversationId: c.id,
        generation: c.data.generation ?? 0,
        question: run.data.text,
        history: history
          .filter((m) => m.data.content)
          .map((m) => ({ role: m.data.role, content: m.data.content })),
        model: {
          id: model.id,
          name: config.name,
          baseUrl: config.base_url,
          modelId: config.model_id,
          contextWindow: config.context_window,
          maxTokens: config.max_tokens,
        },
        key,
        searchKey: this.s.tavilyKey,
        skills: (await docs(tx, "skill", null))
          .filter((d) => !d.data.deleted)
          .map((d) => ({
            id: d.id,
            version: d.version,
            content_hash: d.data.content_hash,
            config: d.data.config,
          })),
        mcp_servers: (await docs(tx, "mcp_server", null))
          .filter((d) => !d.data.deleted)
          .map((d) => ({
            id: d.id,
            version: d.version,
            content_hash: d.data.content_hash,
            config: d.data.config,
          })),
      };
    });
  }
  async runOnce() {
    const job = await this.claim();
    if (!job) return false;
    const controller = new AbortController();
    this.abort = controller;
    let content = "",
      state = "failed",
      error: string | null = "模型请求失败，请检查云端模型配置后重试",
      lost = false,
      cancelled = false,
      lastSnapshot = 0,
      beating = false;
    const headers = {
      Authorization: `Bearer ${this.s.runnerToken}`,
      "Content-Type": "application/json",
    };
    const cancelRunner = () =>
      fetch(`${this.s.runnerUrl}/runs/${job.runId}/cancel`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    const beat = async () => {
      if (beating) return;
      beating = true;
      try {
        await this.db.tx(async (tx) => {
          const r = await tx.get("shared_documents", job.runId);
          if (
            !r ||
            terminal.has(r.data.state) ||
            r.data.worker_id !== this.id
          ) {
            lost = true;
            return;
          }
          cancelled = !!r.data.cancel_requested;
          r.data = {
            ...r.data,
            lease_until: new Date(
              Date.now() + this.s.leaseSeconds * 1000,
            ).toISOString(),
          };
          await tx.save("shared_documents", r);
        });
        if (cancelled || lost || this.stopped) {
          await cancelRunner();
          controller.abort();
        }
      } catch {
        lost = true;
        await cancelRunner();
        controller.abort();
      } finally {
        beating = false;
      }
    };
    const timer = setInterval(
      () => void beat(),
      Math.max(1000, Math.min(15000, this.s.leaseSeconds * 250)),
    );
    let sawDone = false;
    try {
      const response = await fetch(`${this.s.runnerUrl}/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify(job),
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
            if (Date.now() - lastSnapshot >= 1000) {
              await this.db.tx(async (tx) => {
                const r = await tx.get("shared_documents", job.runId);
                if (
                  !r ||
                  terminal.has(r.data.state) ||
                  r.data.worker_id !== this.id
                ) {
                  lost = true;
                  return;
                }
                const m = await tx.get(
                  "shared_documents",
                  r.data.assistant_message_id,
                );
                if (m && m.data.content !== content) {
                  m.version++;
                  m.data = { ...m.data, content };
                  await change(tx, m);
                }
              });
              lastSnapshot = Date.now();
            }
          }
          if (e.type === "plugin")
            await this.db.tx(async (tx) => {
              const d = await tx.get("shared_documents", e.id);
              if (
                d &&
                d.version === e.version &&
                d.data.content_hash === e.hash
              ) {
                d.data = {
                  ...d.data,
                  cloud: {
                    checked_version: e.version,
                    state: e.state,
                    reasons: e.reasons,
                    checked_at: new Date().toISOString(),
                  },
                };
                await change(tx, d);
              }
            });
          if (e.type === "done") {
            sawDone = true;
            state = e.state;
            error = e.error ?? null;
          }
        }
      }
      if (!sawDone) throw new Error("Runner stream interrupted");
    } catch {
      if (cancelled) {
        state = "cancelled";
        error = null;
      } else if (this.stopped) {
        state = "interrupted";
        error = "云端执行中断，请重新提问";
      }
      await cancelRunner();
    } finally {
      clearInterval(timer);
      this.abort = undefined;
    }
    if (!lost)
      await this.db.tx(async (tx) => {
        const r = await tx.get("shared_documents", job.runId);
        if (!r || terminal.has(r.data.state) || r.data.worker_id !== this.id)
          return;
        if (r.data.cancel_requested) {
          state = "cancelled";
          error = null;
        }
        await this.finish(tx, r, state, error, content);
      });
    return true;
  }
  async runForever() {
    while (!this.stopped) {
      try {
        if (await this.runOnce()) continue;
      } catch {
        console.error("cloud worker cycle failed");
      }
      await new Promise((resolve) =>
        setTimeout(resolve, this.s.pollSeconds * 1000),
      );
    }
  }
}
if (
  process.argv[1]?.endsWith("/worker.ts") ||
  process.argv[1]?.endsWith("/worker.mjs")
) {
  const s = settings(),
    db = new Database(s.databaseUrl);
  await migrate(db);
  const worker = new Worker(db, s);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => worker.stop());
  try {
    await worker.runForever();
  } finally {
    await db.close();
  }
}
