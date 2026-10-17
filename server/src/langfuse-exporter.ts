/** Imported only by the cloud Worker. No frontend, Mac or Runner dependency. */
import type { Database, Row } from "./db.js";
import type { Settings } from "./config.js";
import { bounded, sanitize } from "./observations.js";

export class ObservationExporter {
  private send?: (events: Row[]) => Promise<{ errors?: { id: string }[] }>;
  private busy?: Promise<void>;
  readonly enabled: boolean;
  constructor(
    private db: Database,
    s: Settings,
    private env: NodeJS.ProcessEnv = process.env,
    sender?: (events: Row[]) => Promise<{ errors?: { id: string }[] }>,
  ) {
    this.enabled = s.tracingEnabled;
    this.send = sender;
    if (this.enabled && !sender) {
      if (
        !env.LANGFUSE_BASE_URL ||
        !env.LANGFUSE_PUBLIC_KEY ||
        !env.LANGFUSE_SECRET_KEY
      )
        throw new Error(
          "启用追踪时需要配置 LANGFUSE_BASE_URL、LANGFUSE_PUBLIC_KEY、LANGFUSE_SECRET_KEY",
        );
      const url = new URL(env.LANGFUSE_BASE_URL);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("Langfuse 地址无效");
    }
  }
  flush() {
    if (!this.enabled) return Promise.resolve();
    return (this.busy ??= this.exportBatch()
      .catch(() => {})
      .finally(() => {
        this.busy = undefined;
      }));
  }
  private async exportBatch() {
    const rows = await this.db.tx(async (tx) => {
      const expired = await tx.rows(
        "DELETE FROM observation_outbox WHERE expires_at<=now() RETURNING event_id",
      );
      if (expired.length)
        console.warn(`observation expired: ${expired.length}`);
      return tx.rows(`UPDATE observation_outbox SET lease_until=now()+interval '30 seconds' WHERE event_id IN
        (SELECT event_id FROM observation_outbox WHERE next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now())
        ORDER BY created_at,event_id LIMIT 40 FOR UPDATE SKIP LOCKED) RETURNING *`);
    });
    if (!rows.length) return;
    try {
      if (!this.send) {
        const { LangfuseClient } = await import("@langfuse/client");
        const client = new LangfuseClient({
          baseUrl: this.env.LANGFUSE_BASE_URL,
          publicKey: this.env.LANGFUSE_PUBLIC_KEY,
          secretKey: this.env.LANGFUSE_SECRET_KEY,
        });
        this.send = (events) =>
          client.api.ingestion.batch(
            { batch: events as any },
            { timeoutInSeconds: 8, maxRetries: 0 },
          ) as any;
      }
      const secrets = [
        this.env.LANGFUSE_PUBLIC_KEY ?? "",
        this.env.LANGFUSE_SECRET_KEY ?? "",
      ];
      const events = rows.map((r) => ({
        id: r.event_id,
        timestamp: new Date(r.created_at).toISOString(),
        ...r.payload,
        body: {
          ...(sanitize(r.payload.body, secrets) as Row),
          environment: this.env.LANGFUSE_TRACING_ENVIRONMENT ?? "production",
        },
      }));
      const response = await this.send!(events);
      const errors = new Set(response.errors?.map((e) => e.id) ?? []);
      await this.db.tx(async (tx) => {
        for (const r of rows) {
          if (errors.has(r.event_id)) await this.retry(tx, r);
          else
            await tx.rows("DELETE FROM observation_outbox WHERE event_id=$1", [
              r.event_id,
            ]);
        }
      });
    } catch {
      await this.db.tx(async (tx) => {
        for (const r of rows) await this.retry(tx, r);
      });
      console.warn("observation export deferred");
    }
  }
  private retry(tx: import("./db.js").Tx, r: Row) {
    return tx.rows(
      "UPDATE observation_outbox SET attempts=attempts+1,lease_until=NULL,next_attempt_at=now()+$2*interval '1 second' WHERE event_id=$1",
      [r.event_id, Math.min(3600, 5 * 2 ** Math.min(r.attempts, 10))],
    );
  }
  async shutdown() {
    await Promise.race([
      this.flush(),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 10000);
        t.unref();
      }),
    ]);
  }
}
