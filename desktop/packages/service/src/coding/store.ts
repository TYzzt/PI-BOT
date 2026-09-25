import { randomUUID } from 'node:crypto';
import type { Store } from '../store.js';
import type { Project, CodingTask, PlanVersion, CodingRun, ToolCall, StepStatus, AppEvent } from '../../../protocol/src/index.js';
import { digest, type WorkspaceImage } from './workspace.js';
export class CodingStore {
  constructor(readonly store: Store) {
    for (const task of this.tasks()) if (['reading', 'planning', 'executing'].includes(task.state)) {
      this.putTask({ ...task, state: 'interrupted', activeRunId: null, message: task.intent === 'read' ? '阅读中断，已有回答已保留；可以继续提问。' : '服务重启，任务已中断；请针对当前工作区重新规划，不会自动重跑。' });
      this.event(task.id, { type: 'coding.changed', task_id: task.id, conversation_id: task.conversationId, project_id: task.projectId, run_id: task.activeRunId ?? undefined });
    }
    for (const tool of this.all<ToolCall>('SELECT data FROM tool_calls')) if (tool.state === 'running') this.putTool({ ...tool, state: 'interrupted', endedAt: Date.now() });
    for (const task of this.tasks()) { const steps = this.steps(task.id); if (steps.some(s => s.state === 'running')) this.putSteps(task.id, steps.map(s => s.state === 'running' ? { ...s, state: 'failed', note: '执行中断' } : s)); }
  }
  private all<T>(sql: string, ...params: string[]): T[] { return (this.store.db.prepare(sql).all(...params) as { data: string }[]).map(r => JSON.parse(r.data)); }
  private one<T>(sql: string, id: string): T { const result = this.all<T>(sql, id)[0]; if (!result) throw new Error('记录不存在'); return result; }
  deviceId() { let r = this.store.db.prepare('SELECT value FROM app_meta WHERE key=?').get('deviceId') as { value: string } | undefined; if (!r) { r = { value: randomUUID() }; this.store.db.prepare('INSERT INTO app_meta VALUES(?,?)').run('deviceId', r.value); } return r.value; }
  projects() { return this.all<Project>('SELECT data FROM projects'); }
  project(id: string) { return this.one<Project>('SELECT data FROM projects WHERE id=?', id); }
  putProject(p: Project) { this.store.db.prepare('INSERT INTO projects VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,data=excluded.data').run(p.id, p.path, JSON.stringify(p)); }
  tasks() { return this.all<CodingTask>('SELECT data FROM coding_tasks'); }
  task(id: string) { return this.one<CodingTask>('SELECT data FROM coding_tasks WHERE id=?', id); }
  byConversation(id: string) { return this.one<CodingTask>('SELECT data FROM coding_tasks WHERE conversationId=?', id); }
  putTask(t: CodingTask) { this.store.db.prepare('INSERT INTO coding_tasks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(t.id, t.conversationId, JSON.stringify(t)); }
  plans(taskId: string) { return this.all<PlanVersion>('SELECT data FROM plans WHERE taskId=? ORDER BY rowid', taskId); }
  plan(id: string) { return this.one<PlanVersion>('SELECT data FROM plans WHERE id=?', id); }
  planBaseline(id: string): WorkspaceImage { const r = this.store.db.prepare('SELECT baseline FROM plans WHERE id=?').get(id) as { baseline: string }; return JSON.parse(r.baseline); }
  addPlan(plan: PlanVersion, baseline: WorkspaceImage) { this.store.db.prepare('INSERT INTO plans VALUES(?,?,?,?)').run(plan.id, plan.taskId, JSON.stringify(plan), JSON.stringify(baseline)); }
  runs(taskId: string): CodingRun[] { return this.all<Omit<CodingRun, 'run'> & { runId: string }>('SELECT data FROM coding_runs WHERE taskId=? ORDER BY rowid', taskId).map(r => ({ ...r, run: this.store.run(r.runId) })); }
  putRun(taskId: string, run: CodingRun, baseline?: WorkspaceImage) { this.store.db.prepare('INSERT INTO coding_runs VALUES(?,?,?,?) ON CONFLICT(runId) DO UPDATE SET data=excluded.data,baseline=COALESCE(excluded.baseline,coding_runs.baseline)').run(run.run.id, taskId, JSON.stringify({ runId: run.run.id, mode: run.mode, planId: run.planId, model: run.model, sessionPath: run.sessionPath }), baseline ? JSON.stringify(baseline) : null); }
  baseline(taskId: string): WorkspaceImage | null { const r = this.store.db.prepare('SELECT baseline FROM coding_runs WHERE taskId=? AND baseline IS NOT NULL ORDER BY rowid DESC LIMIT 1').get(taskId) as { baseline: string } | undefined; return r ? JSON.parse(r.baseline) : null; }
  approval(planId: string): string | null { return (this.store.db.prepare('SELECT runId FROM approvals WHERE planId=?').get(planId) as { runId: string } | undefined)?.runId ?? null; }
  approve(planId: string, runId: string, details: unknown) { this.store.db.prepare('INSERT INTO approvals VALUES(?,?,?)').run(planId, runId, JSON.stringify(details)); }
  tools(taskId: string) { return this.all<ToolCall>('SELECT data FROM tool_calls WHERE taskId=? ORDER BY rowid DESC LIMIT 150', taskId).reverse(); }
  logs(taskId: string, offset: number): ToolCall[] { return (this.store.db.prepare('SELECT data FROM tool_calls WHERE taskId=? ORDER BY rowid DESC LIMIT 25 OFFSET ?').all(taskId, offset) as { data: string }[]).map(r => JSON.parse(r.data)); }
  putTool(tool: ToolCall) { this.store.db.prepare('INSERT INTO tool_calls VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(tool.id, tool.taskId, tool.runId, JSON.stringify(tool)); }
  steps(taskId: string) { return this.all<StepStatus[]>('SELECT data FROM task_steps WHERE taskId=?', taskId)[0] ?? []; }
  putSteps(taskId: string, steps: StepStatus[]) { this.store.db.prepare('INSERT INTO task_steps VALUES(?,?) ON CONFLICT(taskId) DO UPDATE SET data=excluded.data').run(taskId, JSON.stringify(steps)); }
  event(taskId: string, event: AppEvent) { const result = this.store.db.prepare('INSERT INTO coding_events(taskId,data) VALUES(?,?)').run(taskId, JSON.stringify(event)); return { ...event, seq: Number(result.lastInsertRowid) }; }
  events(taskId: string, after: number): AppEvent[] { return (this.store.db.prepare('SELECT seq,data FROM coding_events WHERE taskId=? AND seq>? ORDER BY seq LIMIT 200').all(taskId, after) as { seq: number; data: string }[]).map(r => ({ ...JSON.parse(r.data), seq: r.seq })); }
  lastSeq(taskId: string) { return Number((this.store.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM coding_events WHERE taskId=?').get(taskId) as { seq: number }).seq); }
  receipt(method: string, input: { requestId: string }): { found: boolean; value?: unknown } { const r = this.store.db.prepare('SELECT hash,result FROM request_receipts WHERE id=?').get(input.requestId) as { hash: string; result: string } | undefined; if (!r) return { found: false }; if (r.hash !== digest([method, input])) throw new Error('幂等 ID 对应的请求内容不一致'); return { found: true, value: JSON.parse(r.result) }; }
  remember(method: string, input: { requestId: string }, result: unknown) { this.store.db.prepare('INSERT INTO request_receipts VALUES(?,?,?)').run(input.requestId, digest([method, input]), JSON.stringify(result)); }
}
