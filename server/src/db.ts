import { Pool, types, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
types.setTypeParser(20, (value) => Number(value));
export type Row = Record<string, any>;
export class HttpError extends Error {
  constructor(
    public status: number,
    public detail: unknown,
  ) {
    super(typeof detail === "string" ? detail : "请求失败");
  }
}
export const fail = (status: number, detail: unknown): never => {
  throw new HttpError(status, detail);
};
const keys: Record<string, string> = {
  users: "user_id",
  devices: "device_id",
  projects: "project_id",
  tasks: "task_id",
  plans: "plan_id",
  runs: "run_id",
  approvals: "approval_id",
  commands: "command_id",
  events: "event_id",
  pairing_codes: "pairing_code_id",
  plan_feedback: "feedback_id",
  shared_documents: "id",
  shared_receipts: "id",
};
export class Tx {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly client: PoolClient) {}
  async rows(sql: string, args: unknown[] = []): Promise<Row[]> {
    const result = this.queue.then(
      async () => (await this.client.query(sql, args)).rows as Row[],
    );
    this.queue = result;
    return result;
  }
  async one(sql: string, args: unknown[] = []): Promise<Row | undefined> {
    return (await this.rows(sql, args))[0];
  }
  async get(table: string, id: string, required = false): Promise<Row> {
    const r = await this.one(`SELECT * FROM ${table} WHERE ${keys[table]}=$1`, [
      id,
    ]);
    if (!r && required) fail(404, "记录不存在");
    return r as Row;
  }
  async insert(table: string, data: Row): Promise<Row> {
    const values = Object.entries(data).filter(([, v]) => v !== undefined);
    return (await this.one(
      `INSERT INTO ${table} (${values.map(([k]) => k).join(",")}) VALUES (${values.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`,
      values.map(([, v]) => (Array.isArray(v) ? JSON.stringify(v) : v)),
    ))!;
  }
  async save(table: string, row: Row): Promise<Row> {
    const key = keys[table],
      entries = Object.entries(row).filter(
        ([k]) => k !== key && k !== "position" && k !== "server_cursor",
      );
    await this.rows(
      `UPDATE ${table} SET ${entries.map(([k], i) => `${k}=$${i + 2}`).join(",")} WHERE ${key}=$1`,
      [
        row[key],
        ...entries.map(([, v]) => (Array.isArray(v) ? JSON.stringify(v) : v)),
      ],
    );
    return row;
  }
  async event(
    type: string,
    task_id: string | null = null,
    payload: Row = {},
    run_id: string | null = null,
    extra: Row = {},
  ) {
    const e = await this.insert("events", {
      event_id: randomUUID(),
      task_id,
      run_id,
      producer_id: "server",
      producer_seq: null,
      type,
      schema_version: 1,
      occurred_at: new Date(),
      recorded_at: new Date(),
      payload,
      ...extra,
    });
    await this.rows("SELECT pg_notify('tagent_changes','')");
    return e;
  }
}
export class Database {
  readonly pool: Pool;
  constructor(url: string) {
    this.pool = new Pool({
      connectionString: url.replace("postgresql+psycopg:", "postgresql:"),
    });
  }
  async tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(7420250925)");
      const result = await fn(new Tx(c));
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  close() {
    return this.pool.end();
  }
}
