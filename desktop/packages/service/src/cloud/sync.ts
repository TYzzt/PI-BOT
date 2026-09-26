import { randomUUID } from 'node:crypto';
import type { Store } from '../store.js';
import type { Credentials } from '../keychain.js';
import type { CodingController, CodingObserver, RunMode, Verification } from '../coding/controller.js';
import { parseInput, type Api, type AppEvent, type CloudStatus, type CloudTaskInfo, type CodingTask, type PlanVersion, type Run, type StepStatus, type TaskState, type ToolCall } from '../../../protocol/src/index.js';
import { CloudStore, type CloudCommand, type CloudEventPayload, type CloudEventType, type CloudTaskLink, type OutboxItem } from './store.js';
import { cloudFetch, CloudHttpError, CloudNetworkError, CloudSocket } from './client.js';
import { newIdentity, signer, type Signer } from './identity.js';
import { cloudPlanBody, planContentHash } from './plan.js';

export interface CloudHost { store: Store; coding: CodingController; credentials: Credentials; serial<T>(fn: () => Promise<T>): Promise<T>; busy(): boolean; emit(event: AppEvent): void; }
export interface CloudOptions { retryBaseMs?: number; retryMaxMs?: number; busyPollMs?: number; }
type CloudMethod = Extract<keyof Api, `cloud${string}`>;

const BUSY = '正在生成或测试连接';
const TERMINAL: CloudEventType[] = ['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted', 'run.needs_replan', 'run.waiting_for_local_action'];
// Fixed summaries only: local messages can contain file paths or model text, which never leave the Mac.
const SUMMARY: Partial<Record<CloudEventType, string>> = {
  'run.completed': '本机执行已结束', 'run.failed': '本机运行失败', 'run.cancelled': '本机运行已停止', 'run.interrupted': '本机服务重启，运行已中断，不会自动重跑',
  'run.needs_replan': '需要重新规划', 'run.waiting_for_local_action': '需要在本机处理后重新规划',
};
const STEP_EVENT: Record<StepStatus['state'], CloudEventType> = { pending: 'step.updated', running: 'step.started', completed: 'step.completed', failed: 'step.failed' };

export class CloudSync implements CodingObserver {
  readonly db: CloudStore;
  private socket: CloudSocket | null = null; private sign: Signer | null = null; private serverUrl = '';
  private timer: NodeJS.Timeout | undefined; private pumping = false; private again = false; private attempts = 0; private stopped = false;
  private notice: { at: number; message: string } | null = null;
  constructor(private host: CloudHost, private options: CloudOptions = {}) {
    this.db = new CloudStore(host.store);
    host.coding.observer = this; host.coding.cloudOwned = taskId => !!this.db.task(taskId);
  }
  get connected() { return !!this.socket?.connected; }

  async start() {
    const link = this.db.link(); if (!link || this.stopped) return;
    let key: string | null = null;
    try { key = await this.host.credentials.get(link.account); } catch { /* Reported below. */ }
    if (!key) { this.note('Keychain 中缺少设备密钥，请解除配对后重新配对'); return; }
    this.serverUrl = link.serverUrl; this.sign = signer(link.deviceId, key);
    this.recover();
    const base = this.options.retryBaseMs ?? 1000, max = this.options.retryMaxMs ?? 30000;
    this.socket = new CloudSocket(link.serverUrl, this.sign, {
      command: message => this.receive(message),
      open: () => { this.notice = null; this.changed(); this.kick(0); },
      close: authFailed => { if (authFailed) this.note('设备认证失败：设备可能已在云端撤销，或本机时间不准确'); this.changed(); },
    }, { baseMs: base, maxMs: max });
    this.socket.start(); this.kick(0);
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.socket?.stop(); this.socket = null; }

  async dispatch(method: CloudMethod, input: any): Promise<unknown> {
    switch (method) {
      case 'cloudStatus': return this.status();
      case 'cloudPair': return this.pair(input);
      case 'cloudUnpair': return this.unpair();
      case 'cloudProjectShare': return this.share(input.projectId, input.enabled);
      case 'cloudRetry': this.db.retry(); this.attempts = 0; this.socket?.reconnectNow(); this.kick(0); return this.status();
      case 'cloudApprove': return this.decide(input.taskId, 'approve', input.requestId, input.planId);
      case 'cloudReject': return this.decide(input.taskId, 'reject', input.requestId);
      case 'cloudRevise': return this.decide(input.taskId, 'revise', input.requestId, undefined, input.feedback);
    }
  }
  status(): CloudStatus {
    const link = this.db.link();
    if (!link) return { paired: false, serverUrl: null, deviceId: null, label: null, connected: false, lastSyncAt: null, pending: 0, queued: 0, failed: 0, failures: [], projects: [] };
    const failures = this.db.failures(5).map(f => ({ at: f.createdAt, message: f.error ?? '同步失败' }));
    return {
      paired: true, serverUrl: link.serverUrl, deviceId: link.deviceId, label: link.label, connected: this.connected, lastSyncAt: link.lastSyncAt,
      pending: this.db.count("SELECT count(*) AS n FROM cloud_outbox WHERE status='pending'"), queued: this.db.count("SELECT count(*) AS n FROM cloud_commands WHERE status IN ('received','acked','processing')"),
      failed: this.db.count("SELECT count(*) AS n FROM cloud_outbox WHERE status='failed'"), failures: this.notice ? [this.notice, ...failures] : failures,
      projects: this.db.projects().map(p => ({ projectId: p.projectId, enabled: p.enabled })),
    };
  }
  taskInfo(taskId: string): CloudTaskInfo | undefined { const t = this.db.task(taskId); return t ? { cloudTaskId: t.cloudTaskId, connected: this.connected, publishedPlanIds: Object.keys(t.plans) } : undefined; }

  private async pair(input: { serverUrl: string; label: string; password: string }) {
    if (this.db.link()) throw new Error('已配对云端，请先解除配对');
    const serverUrl = new URL(input.serverUrl).origin;
    // The admin password and JWT exist only in this call frame; neither is stored, logged or returned.
    const login = await cloudFetch<{ access_token: string }>(serverUrl, 'POST', '/auth/login', { body: { password: input.password } }).catch(e => { throw pairingError(e, '管理员密码错误'); });
    const code = await cloudFetch<{ pairing_code: string }>(serverUrl, 'POST', '/devices/pairing-codes', { headers: { authorization: `Bearer ${login.access_token}` } }).catch(e => { throw pairingError(e, '无法生成配对码'); });
    const identity = newIdentity();
    const device = await cloudFetch<{ device_id: string }>(serverUrl, 'POST', '/devices/pair', { body: { pairing_code: code.pairing_code, public_key: identity.publicKey, label: input.label, capabilities: ['plan', 'execute', 'shared_v1'] } }).catch(e => { throw pairingError(e, '配对失败'); });
    const account = randomUUID();
    await this.host.credentials.set(account, identity.privateKey);
    this.db.putLink({ account, serverUrl, deviceId: device.device_id, label: input.label, publicKey: identity.publicKey, pairedAt: Date.now(), producerSeq: 0, lastSyncAt: Date.now() });
    this.stopped = false; this.notice = null; await this.start(); this.changed(); return this.status();
  }
  private async unpair() {
    const link = this.db.link(); if (!link) return this.status();
    const active = this.host.coding.active; if (active && this.db.task(active.task.id)) throw new Error('请先停止正在运行的云端任务');
    clearTimeout(this.timer); this.socket?.stop(); this.socket = null; this.sign = null; this.notice = null;
    try { await this.host.credentials.delete(link.account); } catch { /* A missing key must not block forgetting the link. */ }
    this.db.clear(); this.changed(); return this.status();
  }
  private async share(projectId: string, enabled: boolean) {
    if (!this.db.link()) throw new Error('尚未配对云端');
    const project = this.host.coding.db.project(projectId); if (project.removed) throw new Error('项目已移除');
    const existing = this.db.project(projectId);
    if (!existing) {
      if (!enabled) return this.status();
      const created = await this.request<{ project_id: string }>('POST', '/projects', { display_name: project.name.slice(0, 120) }).catch(e => { throw e instanceof CloudNetworkError ? new Error('开启同步需要连接云端') : e; });
      this.db.putProject({ projectId, cloudProjectId: created.project_id, name: project.name, enabled: true, remoteAvailable: true });
    } else this.db.putProject({ ...existing, enabled });
    this.changed(); this.kick(0); return this.status();
  }
  private async decide(taskId: string, action: 'approve' | 'reject' | 'revise', requestId: string, planId?: string, feedback?: string) {
    const link = this.db.task(taskId); if (!link) throw new Error('不是云端任务');
    if (!this.connected) throw new Error('审批需要连接云端');
    const task = this.host.coding.db.task(taskId), published = Object.entries(link.plans).sort(([, a], [, b]) => b.version - a.version);
    const [localPlanId, plan] = (planId ? published.find(([id]) => id === planId) : published[0]) ?? [];
    if (!plan || !localPlanId) throw new Error('计划尚未同步到云端，请稍候');
    const body = action === 'approve' ? { version: plan.version, content_hash: plan.hash, idempotency_key: requestId } : action === 'reject' ? { idempotency_key: requestId } : { feedback, idempotency_key: requestId };
    if (action === 'approve' && (task.state !== 'awaiting_review' || task.latestPlanId !== localPlanId || this.host.coding.db.plan(localPlanId).body.questions.length)) throw new Error('此计划不可批准，请完成最新规划');
    await this.request('POST', `/device/plans/${plan.cloudPlanId}/${action}`, body).catch(e => { throw e instanceof CloudNetworkError ? new Error('审批需要连接云端') : e; });
    if (action === 'reject') await this.host.coding.dispatch('codingReject', { taskId, requestId }, true);
    this.kick(0); return null;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.sign) throw new Error('尚未配对云端');
    const result = await cloudFetch<T>(this.serverUrl, method, path, { body, signer: this.sign });
    const link = this.db.link(); if (link) this.db.putLink({ ...link, lastSyncAt: Date.now() });
    return result;
  }
  private note(message: string) { this.notice = { at: Date.now(), message }; this.changed(); }
  private changed() { this.host.emit({ type: 'cloud.changed' }); }
  private kick(delay = 0) { if (this.stopped || !this.sign) return; clearTimeout(this.timer); this.timer = setTimeout(() => void this.pump(), delay); }
  private async pump() {
    if (this.pumping) { this.again = true; return; }
    this.pumping = true; let retry: number | null = null;
    try {
      do {
        this.again = false;
        for (const step of [() => this.ackReceived(), () => this.processCommands(), () => this.reconcileProjects(), () => this.flushOutbox()]) {
          try { await step(); } catch (error) { retry = this.transient(error); }
        }
      } while (this.again && retry === null && !this.stopped);
    } finally { this.pumping = false; }
    if (this.stopped || !this.sign) return;
    this.changed();
    if (retry !== null) this.kick(retry);
    else { this.attempts = 0; if (this.db.commands('acked').length) this.kick(this.options.busyPollMs ?? 1000); }
  }
  private transient(error: unknown) {
    const message = error instanceof CloudNetworkError ? '无法连接云端服务器，恢复后会自动补发' : error instanceof CloudHttpError && error.status === 401 ? '设备认证失败：设备可能已在云端撤销，或本机时间不准确' : error instanceof CloudHttpError && error.status >= 500 ? '云端暂时不可用，稍后自动重试' : error instanceof Error ? error.message : '同步失败';
    this.notice = { at: Date.now(), message };
    const base = this.options.retryBaseMs ?? 1000, max = this.options.retryMaxMs ?? 30000;
    return Math.min(max, base * 2 ** this.attempts++);
  }

  private recover() {
    for (const command of this.db.commands('processing')) this.db.setCommand(command.command_id, this.db.taskByCloud(command.task_id) && command.run_id && Object.values(this.db.taskByCloud(command.task_id)!.runs).includes(command.run_id) ? 'done' : 'acked');
    for (const link of this.db.tasks()) if (link.active && this.host.coding.active?.run.id !== link.active.localRunId) this.finish(link, link.active.localRunId, 'run.interrupted');
  }
  private receive(message: Record<string, any>) {
    if (typeof message.command_id !== 'string' || typeof message.task_id !== 'string') return;
    const command: CloudCommand = { command_id: message.command_id, command_type: message.command_type, task_id: message.task_id, run_id: message.run_id ?? null, payload: message.payload ?? {}, expires_at: message.expires_at, created_at: message.created_at };
    const existing = this.db.command(command.command_id);
    if (!existing) this.db.addCommand(command); else if (existing.status !== 'received') return;
    this.kick(0);
  }
  private async ackReceived() {
    for (const command of this.db.commands('received')) {
      try { await this.request('POST', `/device/commands/${command.command_id}/ack`); this.db.setCommand(command.command_id, 'acked'); }
      catch (error) { if (error instanceof CloudHttpError && (error.status === 404 || error.status === 409)) this.db.setCommand(command.command_id, 'dropped'); else throw error; }
    }
  }
  private async processCommands() {
    let blocked = false;
    for (const command of this.db.commands('acked')) {
      if (command.command_type === 'cancel') { await this.cancel(command); continue; }
      if (blocked || this.host.busy()) { blocked = true; continue; }
      this.db.setCommand(command.command_id, 'processing');
      try { await this.host.serial(() => this.perform(command)); this.db.setCommand(command.command_id, 'done'); }
      catch (error) {
        if (error instanceof Error && error.message.includes(BUSY)) { this.db.setCommand(command.command_id, 'acked'); blocked = true; continue; }
        this.report(command.task_id, command.run_id, 'run.failed', { summary: '本机处理云端命令失败' }); this.db.setCommand(command.command_id, 'done');
      }
    }
  }
  private receiptExists(id: string) { return !!this.host.store.db.prepare('SELECT 1 FROM request_receipts WHERE id=?').get(id); }
  private async attempt<T>(fn: () => Promise<T>): Promise<T | Error> { try { return await fn(); } catch (error) { if (error instanceof Error && error.message.includes(BUSY)) throw error; return error instanceof Error ? error : new Error('失败'); } }
  private async perform(command: CloudCommand) {
    const { task_id: cloudTaskId, run_id: cloudRunId, payload } = command; if (!cloudRunId) return;
    const coding = this.host.coding, existing = this.db.taskByCloud(cloudTaskId);
    if (existing && Object.values(existing.runs).includes(cloudRunId)) return;
    if (command.command_type === 'plan_request') {
      const shared = this.db.projectByCloud(payload.project_id), project = shared?.enabled ? coding.db.projects().find(p => p.id === shared.projectId && !p.removed) : undefined;
      if (!project) return this.report(cloudTaskId, cloudRunId, 'run.failed', { summary: '项目在本机不可用或未开启云端同步' });
      const models = this.host.store.models(), model = models.find(m => m.isDefault) ?? models[0];
      if (!model) return this.report(cloudTaskId, cloudRunId, 'run.failed', { summary: '本机尚未配置模型' });
      const input = valid('codingCreate', { intent: 'code', projectId: project.id, requirement: payload.requirement, planModelId: model.id, executeModelId: model.id, requestId: command.command_id });
      if (!input) return this.report(cloudTaskId, cloudRunId, 'run.failed', { summary: '云端需求超出本机限制' });
      const recovered = this.receiptExists(command.command_id);
      const task = await this.attempt(() => coding.dispatch('codingCreate', input, true) as Promise<CodingTask>);
      if (task instanceof Error) return this.report(cloudTaskId, cloudRunId, 'run.failed', { summary: '项目在本机不可用' });
      const link: CloudTaskLink = { taskId: task.id, cloudTaskId, cloudProjectId: payload.project_id, runs: {}, active: null, plans: {}, terminal: {} };
      this.db.putTask(link);
      if (recovered || !task.activeRunId) return this.report(cloudTaskId, cloudRunId, 'run.interrupted', { summary: SUMMARY['run.interrupted'] });
      return this.bind(task.id, task.activeRunId, cloudRunId);
    }
    if (!existing) return this.report(cloudTaskId, cloudRunId, 'run.failed', { summary: '本机没有该任务的记录' });
    if (command.command_type === 'plan_revise') {
      const input = valid('codingPlan', { taskId: existing.taskId, feedback: payload.feedback, requestId: command.command_id });
      if (!input) return this.report(cloudTaskId, cloudRunId, 'run.failed', { summary: '修改意见超出本机限制' });
      const recovered = this.receiptExists(command.command_id);
      const run = await this.attempt(() => coding.dispatch('codingPlan', input, true) as Promise<Run>);
      if (run instanceof Error) return this.report(cloudTaskId, cloudRunId, 'run.failed', { summary: '项目在本机不可用' });
      if (recovered) return this.report(cloudTaskId, cloudRunId, 'run.interrupted', { summary: SUMMARY['run.interrupted'] });
      return this.bind(existing.taskId, run.id, cloudRunId);
    }
    if (command.command_type === 'execute') {
      const replan = (summary: string) => this.report(cloudTaskId, cloudRunId, 'run.needs_replan', { summary });
      if (!(Date.parse(payload.expires_at) > Date.now())) return replan('批准已过期，未执行');
      const [planId, plan] = Object.entries(existing.plans).find(([, p]) => p.cloudPlanId === payload.plan_id) ?? [];
      if (!planId || !plan || plan.hash !== payload.content_hash || plan.version !== payload.version) return replan('计划与本机记录不一致，未执行');
      if (coding.db.approval(planId)) return replan(this.receiptExists(command.command_id) ? SUMMARY['run.interrupted']! : '该计划已在本机执行过，请修改计划后重新批准');
      const run = await this.attempt(() => coding.dispatch('codingApprove', { taskId: existing.taskId, planId, hash: coding.db.plan(planId).hash, requestId: command.command_id }, true) as Promise<Run | null>);
      if (run instanceof Error) return replan('计划在本机不可执行，请修改计划');
      if (!run) return replan('工作区或模型配置在规划后发生变化，请修改计划');
      return this.bind(existing.taskId, run.id, cloudRunId);
    }
  }
  private bind(taskId: string, localRunId: string, cloudRunId: string) {
    const link = this.db.task(taskId)!; link.runs[localRunId] = cloudRunId; link.active = { localRunId, cloudRunId }; this.db.putTask(link);
    if (this.host.store.run(localRunId).state === 'interrupted') this.finish(link, localRunId, 'run.interrupted');
  }
  private async cancel(command: CloudCommand) {
    const cloudRunId = command.run_id ?? command.payload.run_id; let dropped = false;
    for (const status of ['received', 'acked'] as const) for (const queued of this.db.commands(status)) if (queued.command_type !== 'cancel' && queued.run_id === cloudRunId) { this.db.setCommand(queued.command_id, 'dropped'); dropped = true; }
    const link = this.db.taskByCloud(command.task_id), localRunId = link && Object.entries(link.runs).find(([, id]) => id === cloudRunId)?.[0];
    this.db.setCommand(command.command_id, 'done');
    // The finishing run reports run.cancelled through the observer; otherwise confirm directly.
    if (link && localRunId && link.active?.localRunId === localRunId && await this.host.coding.cancel(localRunId)) return;
    const terminal = !dropped && link ? link.terminal[cloudRunId] : undefined;
    if (link && localRunId && link.active?.localRunId === localRunId) this.finish(link, localRunId, 'run.cancelled');
    else this.report(command.task_id, cloudRunId, terminal ?? 'run.cancelled', { summary: SUMMARY[terminal ?? 'run.cancelled'] });
  }
  private finish(link: CloudTaskLink, localRunId: string, type: CloudEventType, payload: CloudEventPayload = {}) {
    const cloudRunId = link.runs[localRunId]; if (!cloudRunId) return;
    if (link.active?.localRunId === localRunId) link.active = null;
    this.db.putTask(link); this.report(link.cloudTaskId, cloudRunId, type, { summary: SUMMARY[type], ...payload });
  }
  private report(cloudTaskId: string, cloudRunId: string | null, type: CloudEventType, payload: CloudEventPayload) {
    const clean = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined)) as CloudEventPayload;
    this.host.store.transaction(() => {
      if (!this.db.enqueueEvent({ event_id: randomUUID(), type, task_id: cloudTaskId, run_id: cloudRunId, occurred_at: new Date().toISOString(), payload: clean })) return;
      const link = this.db.taskByCloud(cloudTaskId); if (link && cloudRunId && TERMINAL.includes(type)) { link.terminal[cloudRunId] = type; this.db.putTask(link); }
    });
    this.kick(0);
  }
  private async reconcileProjects() {
    for (const shared of this.db.projects()) {
      const local = this.host.coding.db.projects().find(p => p.id === shared.projectId), desired = shared.enabled && !!local && !local.removed;
      if (desired === shared.remoteAvailable) continue;
      await this.request('PATCH', `/projects/${shared.cloudProjectId}`, { availability: desired ? 'available' : 'unavailable' });
      this.db.putProject({ ...this.db.project(shared.projectId)!, remoteAvailable: desired });
    }
  }
  private async flushOutbox() {
    let single = false;
    for (;;) {
      if (this.stopped || !this.sign) return;
      const items = this.db.pending(100); if (!items.length) return;
      if (items[0].kind === 'plan') { await this.publish(items[0]); continue; }
      const batch: OutboxItem[] = []; for (const item of items) { if (item.kind !== 'event' || (single && batch.length)) break; batch.push(item); }
      try { await this.request('POST', '/device/events', { events: batch.map(item => item.data) }); this.db.sent(batch.map(item => item.seq)); single = false; }
      catch (error) {
        if (!rejected(error)) throw error;
        // Isolate the rejected event so the rest of the queue keeps flowing.
        if (batch.length > 1) { single = true; continue; }
        this.db.fail(batch[0].seq, error.message);
      }
    }
  }
  private async publish(item: OutboxItem & { kind: 'plan' }) {
    const { taskId, planId, cloudTaskId, cloudRunId } = item.data, link = this.db.task(taskId), device = this.db.link();
    if (!link || !device) { this.db.sent([item.seq]); return; }
    const plan = this.host.coding.db.plan(planId), body = cloudPlanBody(plan.body), version = Math.max(0, ...Object.values(link.plans).map(p => p.version)) + 1;
    const hash = planContentHash({ taskId: cloudTaskId, version, projectId: link.cloudProjectId, deviceId: device.deviceId, body, workspaceFingerprint: plan.fingerprint, configSnapshotId: plan.configHash });
    try {
      const published = await this.request<{ plan_id: string }>('POST', `/tasks/${cloudTaskId}/plans`, { run_id: cloudRunId, version, content_hash: hash, body, workspace_fingerprint: plan.fingerprint, config_snapshot_id: plan.configHash });
      this.host.store.transaction(() => { const fresh = this.db.task(taskId)!; fresh.plans[planId] = { version, hash, cloudPlanId: published.plan_id }; this.db.putTask(fresh); this.db.sent([item.seq]); });
    } catch (error) {
      if (!rejected(error)) throw error;
      this.db.fail(item.seq, error.message); this.report(cloudTaskId, cloudRunId, 'run.failed', { summary: '计划发布到云端失败' });
    }
  }

  private defer(fn: () => void) { setImmediate(() => { try { fn(); } catch { /* Cloud sync never interrupts local runs. */ } }); }
  runStarted(task: CodingTask, runId: string, mode: RunMode) { if (mode !== 'read') this.defer(() => { const link = this.db.task(task.id), cloudRunId = link?.runs[runId]; if (link && cloudRunId) this.report(link.cloudTaskId, cloudRunId, 'run.started', {}); }); }
  planCreated(task: CodingTask, plan: PlanVersion, mode: RunMode) {
    const runId = task.activeRunId; if (mode !== 'plan' || !runId) return;
    this.defer(() => { const link = this.db.task(task.id), cloudRunId = link?.runs[runId]; if (link && cloudRunId) { this.db.enqueuePlan({ taskId: task.id, planId: plan.id, cloudTaskId: link.cloudTaskId, cloudRunId }); this.kick(0); } });
  }
  stepChanged(task: CodingTask, runId: string, step: StepStatus) {
    const snapshot = { ...step };
    this.defer(() => {
      const link = this.db.task(task.id), cloudRunId = link?.runs[runId]; if (!link || !cloudRunId) return;
      const planId = this.host.coding.db.runs(task.id).find(r => r.run.id === runId)?.planId, title = planId ? this.host.coding.db.plan(planId).body.steps.find(s => s.stepId === snapshot.stepId)?.title : undefined;
      this.report(link.cloudTaskId, cloudRunId, STEP_EVENT[snapshot.state], { step_id: snapshot.stepId, title: title?.slice(0, 500) });
    });
  }
  toolFinished(task: CodingTask, tool: ToolCall) {
    const payload: CloudEventPayload = {
      tool_name: tool.name, status: tool.state === 'completed' ? 'ok' : tool.state === 'failed' ? 'error' : 'cancelled',
      exit_code: tool.exitCode === null ? undefined : Math.max(-1024, Math.min(1024, tool.exitCode)),
      verification: !tool.verification ? undefined : ['cancelled', 'interrupted'].includes(tool.state) ? 'cancelled' : tool.state === 'completed' && tool.exitCode === 0 ? 'passed' : 'failed',
      duration_ms: tool.endedAt ? Math.min(86_400_000, Math.max(0, tool.endedAt - tool.startedAt)) : undefined,
    };
    this.defer(() => { const link = this.db.task(task.id), cloudRunId = link?.runs[tool.runId]; if (link && cloudRunId) this.report(link.cloudTaskId, cloudRunId, 'tool.finished', payload); });
  }
  runFinished(task: CodingTask, runId: string, mode: RunMode, state: TaskState, verification: Verification) {
    if (mode === 'read') return;
    this.defer(() => {
      const link = this.db.task(task.id); if (!link?.runs[runId]) return;
      if (mode === 'plan' && ['awaiting_review', 'awaiting_input'].includes(state)) { if (link.active?.localRunId === runId) { link.active = null; this.db.putTask(link); } this.kick(0); return; }
      const type: CloudEventType = state === 'needs_replan' ? 'run.needs_replan' : state === 'waiting_for_local_action' ? 'run.waiting_for_local_action' : state === 'cancelled' ? 'run.cancelled' : state === 'completed' ? 'run.completed' : 'run.failed';
      this.finish(link, runId, type, type === 'run.completed' ? { verification } : {});
    });
  }
}
function valid<M extends 'codingCreate' | 'codingPlan'>(method: M, input: unknown) { try { return parseInput(method, input); } catch { return null; } }
function rejected(error: unknown): error is CloudHttpError { return error instanceof CloudHttpError && error.status >= 400 && error.status < 500 && ![401, 408, 429].includes(error.status); }
function pairingError(error: unknown, fallback: string) { return error instanceof CloudNetworkError ? error : error instanceof CloudHttpError && error.status < 500 ? new Error(`${fallback}：${error.message}`) : new Error('云端暂时不可用，请稍后重试'); }
