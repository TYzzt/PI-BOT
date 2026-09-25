import type { Store } from '../store.js';

export interface CloudLink { account: string; serverUrl: string; deviceId: string; label: string; publicKey: string; pairedAt: number; producerSeq: number; lastSyncAt: number | null; }
export interface CloudProjectLink { projectId: string; cloudProjectId: string; name: string; enabled: boolean; remoteAvailable: boolean; }
export interface CloudPlanLink { version: number; hash: string; cloudPlanId: string; }
export interface CloudTaskLink { taskId: string; cloudTaskId: string; cloudProjectId: string; runs: Record<string, string>; active: { localRunId: string; cloudRunId: string } | null; plans: Record<string, CloudPlanLink>; terminal: Record<string, CloudEventType>; }
export type CloudCommandType = 'plan_request' | 'plan_revise' | 'execute' | 'cancel';
export interface CloudCommand { command_id: string; command_type: CloudCommandType; task_id: string; run_id: string | null; payload: Record<string, any>; expires_at: string; created_at: string; }
export type CommandStatus = 'received' | 'acked' | 'processing' | 'done' | 'dropped';
export type CloudEventType = 'run.started' | 'run.waiting_for_input' | 'run.waiting_for_local_action' | 'run.interrupted' | 'run.needs_replan' | 'run.completed' | 'run.failed' | 'run.cancelled' | 'step.started' | 'step.updated' | 'step.completed' | 'step.failed' | 'tool.started' | 'tool.finished';
export interface CloudEventPayload { step_id?: string; title?: string; summary?: string; tool_name?: string; status?: 'ok' | 'error' | 'cancelled' | 'timeout'; exit_code?: number; verification?: 'passed' | 'failed' | 'not_run' | 'cancelled'; duration_ms?: number; }
export interface OutboxEvent { event_id: string; producer_seq: number; type: CloudEventType; task_id: string; run_id: string | null; occurred_at: string; payload: CloudEventPayload; }
export interface OutboxPlan { taskId: string; planId: string; cloudTaskId: string; cloudRunId: string; }
export type OutboxItem = { seq: number; kind: 'event'; status: string; data: OutboxEvent; error: string | null; createdAt: number } | { seq: number; kind: 'plan'; status: string; data: OutboxPlan; error: string | null; createdAt: number };

export class CloudStore {
  constructor(private store: Store) {}
  private get db() { return this.store.db; }
  link(): CloudLink | null { const r = this.db.prepare('SELECT data FROM cloud_link WHERE id=1').get() as { data: string } | undefined; return r ? JSON.parse(r.data) : null; }
  putLink(link: CloudLink) { this.db.prepare('INSERT INTO cloud_link VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(link)); }
  clear() { this.store.transaction(() => this.db.exec('DELETE FROM cloud_link; DELETE FROM cloud_projects; DELETE FROM cloud_tasks; DELETE FROM cloud_commands; DELETE FROM cloud_outbox;')); }
  projects(): CloudProjectLink[] { return (this.db.prepare('SELECT data FROM cloud_projects ORDER BY rowid').all() as { data: string }[]).map(r => JSON.parse(r.data)); }
  project(projectId: string) { return this.projects().find(p => p.projectId === projectId) ?? null; }
  projectByCloud(cloudProjectId: string) { return this.projects().find(p => p.cloudProjectId === cloudProjectId) ?? null; }
  putProject(p: CloudProjectLink) { this.db.prepare('INSERT INTO cloud_projects VALUES(?,?,?) ON CONFLICT(projectId) DO UPDATE SET data=excluded.data').run(p.projectId, p.cloudProjectId, JSON.stringify(p)); }
  tasks(): CloudTaskLink[] { return (this.db.prepare('SELECT data FROM cloud_tasks ORDER BY rowid').all() as { data: string }[]).map(r => JSON.parse(r.data)); }
  task(taskId: string): CloudTaskLink | null { const r = this.db.prepare('SELECT data FROM cloud_tasks WHERE taskId=?').get(taskId) as { data: string } | undefined; return r ? JSON.parse(r.data) : null; }
  taskByCloud(cloudTaskId: string): CloudTaskLink | null { const r = this.db.prepare('SELECT data FROM cloud_tasks WHERE cloudTaskId=?').get(cloudTaskId) as { data: string } | undefined; return r ? JSON.parse(r.data) : null; }
  putTask(t: CloudTaskLink) { this.db.prepare('INSERT INTO cloud_tasks VALUES(?,?,?) ON CONFLICT(taskId) DO UPDATE SET data=excluded.data').run(t.taskId, t.cloudTaskId, JSON.stringify(t)); }
  command(commandId: string): { status: CommandStatus; command: CloudCommand } | null { const r = this.db.prepare('SELECT status,data FROM cloud_commands WHERE commandId=?').get(commandId) as { status: CommandStatus; data: string } | undefined; return r ? { status: r.status, command: JSON.parse(r.data) } : null; }
  commands(status: CommandStatus): CloudCommand[] { return (this.db.prepare('SELECT data FROM cloud_commands WHERE status=? ORDER BY seq').all(status) as { data: string }[]).map(r => JSON.parse(r.data)); }
  addCommand(c: CloudCommand) { return Number(this.db.prepare('INSERT INTO cloud_commands(commandId,status,data) VALUES(?,?,?) ON CONFLICT(commandId) DO NOTHING').run(c.command_id, 'received', JSON.stringify(c)).changes) > 0; }
  setCommand(commandId: string, status: CommandStatus) { this.db.prepare('UPDATE cloud_commands SET status=? WHERE commandId=?').run(status, commandId); }
  count(sql: string) { return Number((this.db.prepare(sql).get() as { n: number }).n); }
  enqueueEvent(event: Omit<OutboxEvent, 'producer_seq'>) {
    return this.store.transaction(() => {
      const link = this.link(); if (!link) return null;
      const item: OutboxEvent = { ...event, producer_seq: link.producerSeq + 1 }; this.putLink({ ...link, producerSeq: item.producer_seq });
      this.db.prepare('INSERT INTO cloud_outbox(kind,status,data,createdAt) VALUES(?,?,?,?)').run('event', 'pending', JSON.stringify(item), Date.now()); return item;
    });
  }
  enqueuePlan(plan: OutboxPlan) { this.db.prepare('INSERT INTO cloud_outbox(kind,status,data,createdAt) VALUES(?,?,?,?)').run('plan', 'pending', JSON.stringify(plan), Date.now()); }
  pending(limit: number): OutboxItem[] { return (this.db.prepare("SELECT seq,kind,status,data,error,createdAt FROM cloud_outbox WHERE status='pending' ORDER BY seq LIMIT ?").all(limit) as any[]).map(r => ({ ...r, data: JSON.parse(r.data) })); }
  failures(limit: number): OutboxItem[] { return (this.db.prepare("SELECT seq,kind,status,data,error,createdAt FROM cloud_outbox WHERE status='failed' ORDER BY seq DESC LIMIT ?").all(limit) as any[]).map(r => ({ ...r, data: JSON.parse(r.data) })); }
  sent(seqs: number[]) { this.store.transaction(() => { for (const seq of seqs) this.db.prepare('DELETE FROM cloud_outbox WHERE seq=?').run(seq); }); }
  fail(seq: number, error: string) { this.db.prepare("UPDATE cloud_outbox SET status='failed',error=? WHERE seq=?").run(error.slice(0, 500), seq); }
  retry() { this.db.prepare("UPDATE cloud_outbox SET status='pending',error=NULL WHERE status='failed'").run(); }
}
