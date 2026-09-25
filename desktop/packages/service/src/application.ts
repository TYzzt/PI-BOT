import { CodingController } from './coding/controller.js';
import { codingSchemas } from '../../protocol/src/coding.js';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Api, Method, AppEvent, Run } from '../../protocol/src/index.js';
import { parseInput } from '../../protocol/src/index.js';
import { Store } from './store.js';
import type { Credentials } from './keychain.js';
import type { AgentFactory, AgentHandle } from './pi-adapter.js';

export class Application {
  private active: { run: Run; assistantId: string; agent?: AgentHandle; cancelled: boolean; done?: Promise<void> } | null = null;
  private testing = false;
  private serial: Promise<unknown> = Promise.resolve();
  readonly coding: CodingController;
  constructor(readonly store: Store, private credentials: Credentials, private factory: AgentFactory, private emit: (event: AppEvent) => void) { this.coding = new CodingController(store, credentials, factory, emit, () => this.idle()); }
  call<M extends Method>(method: M, raw: unknown): Promise<Api[M]['output']> {
    const input = parseInput(method, raw);
    const result = this.serial.then(() => this.dispatch(method, input));
    this.serial = result.catch(() => {});
    return result.then(value => value && typeof value === 'object' && 'deferred' in value ? (value as { deferred: Promise<unknown> }).deferred : value) as Promise<Api[M]['output']>;
  }
  private changed() { this.emit({ type: 'state.changed' }); }
  private idle() { if (this.active || this.testing || this.coding.active) throw new Error('正在生成或测试连接，请先等待当前请求完成'); }
  private async dispatch(method: Method, data: any): Promise<unknown> {
    if (Object.hasOwn(codingSchemas, method)) return this.coding.dispatch(method, data);
    switch (method) {
      case 'health': return { ok: true, version: '0.2.0' };
      case 'snapshot': return { models: this.store.models(), conversations: this.store.conversations(), activeRun: this.active ? this.store.run(this.active.run.id) : this.coding.active ? this.store.run(this.coding.active.run.id) : null, testing: this.testing };
      case 'modelSave': {
        this.idle(); const existing = data.id ? this.store.model(data.id) : null; const id = existing?.id ?? randomUUID();
        if (!existing && !data.apiKey) throw new Error('请填写 API Key；无需认证的本地端点可填入占位值');
        if (data.apiKey) await this.credentials.set(id, data.apiKey);
        const m = { id, revision: (existing?.revision ?? 0) + 1, name: data.name, baseUrl: data.baseUrl, modelId: data.modelId, contextWindow: data.contextWindow, maxTokens: data.maxTokens, isDefault: existing?.isDefault ?? this.store.models().length === 0, hasKey: !!data.apiKey || !!existing?.hasKey };
        this.store.putModel(m); this.changed(); return m;
      }
      case 'modelDelete': {
        this.idle(); this.store.model(data.id);
        if (data.replacementId) { this.store.model(data.replacementId); if (data.replacementId === data.id) throw new Error('替代模型不能是当前模型'); }
        if (this.store.conversations().some(c => c.modelConfigId === data.id) && !data.replacementId) throw new Error('此模型被会话引用，请选择替代模型');
        if (this.coding.modelReferences(data.id) && !data.replacementId) throw new Error('此模型被编程任务引用，请选择替代模型');
        await this.credentials.delete(data.id); if (data.replacementId) this.coding.replaceModel(data.id, data.replacementId); this.store.deleteModel(data.id, data.replacementId); this.changed(); return null;
      }
      case 'modelDefault': this.idle(); this.store.defaultModel(data.id); this.changed(); return null;
      case 'modelTest': {
        this.idle(); const m = this.store.model(data.id); this.testing = true; this.changed();
        // Do not block other RPCs behind a network test. The busy flag serializes model calls.
        const operation = this.testModel(m);
        return { deferred: operation };
      }
      case 'conversationCreate': { const c = this.store.createConversation(data.modelConfigId); this.changed(); return c; }
      case 'conversationGet': return { conversation: this.store.conversation(data.id), messages: this.store.messages(data.id), runs: this.store.runs(data.id) };
      case 'conversationRename': this.store.rename(data.id, data.title); this.changed(); return null;
      case 'conversationDelete': {
        if (this.active?.run.conversationId === data.id) throw new Error('请先停止该会话的生成');
        this.coding.removeConversation(data.id);
        this.store.conversation(data.id);
        const sessionPath = this.store.sessionPath(data.id);
        if (sessionPath) rmSync(sessionPath, { force: true });
        this.store.deleteConversation(data.id); this.changed(); return null;
      }
      case 'messageSend': {
        const previous = this.store.existing(data.requestId, data.conversationId, data.text); if (previous) return previous;
        this.idle(); const c = this.store.conversation(data.conversationId); if (c.kind === 'coding') throw new Error('编程会话请使用规划接口'); const model = this.store.model(c.modelConfigId);
        const entry = this.store.start(c.id, data.text, data.requestId); this.active = { ...entry, cancelled: false };
        const active = this.active;
        this.emit({ type: 'run.started', conversation_id: c.id, task_id: entry.run.taskId, run_id: entry.run.id, message_id: entry.assistantId });
        active.done = this.execute(active, model, data.text); return entry.run;
      }
      case 'runCancel': {
        if (await this.coding.cancel(data.id)) return null;
        const active = this.active;
        if (active && active.run.id === data.id) { active.cancelled = true; this.store.finish(data.id, 'cancelling'); this.changed(); await active.agent?.abort(); }
        else this.store.run(data.id);
        return null;
      }
    }
  }
  private async testModel(model: ReturnType<Store['model']>) {
    let agent: AgentHandle | undefined;
    try { const key = await this.credentials.get(model.id); if (!key) throw new Error('Keychain 中缺少 API Key，请重新保存');
      agent = await this.factory({ ...model, maxTokens: Math.min(64, model.maxTokens) }, key, null, randomUUID(), true);
      await agent.prompt('Reply with OK.', () => {}); return { ok: true };
    } finally { agent?.dispose(); this.testing = false; this.changed(); }
  }
  private async execute(active: NonNullable<Application['active']>, model: ReturnType<Store['model']>, text: string) {
    let content = '', lastFlush = 0, error: string | null = null; let state: 'completed' | 'cancelled' | 'failed' = 'completed';
    const ids = { conversation_id: active.run.conversationId, task_id: active.run.taskId, run_id: active.run.id, message_id: active.assistantId };
    try {
      const key = await this.credentials.get(model.id); if (!key) throw new Error('Keychain 中缺少 API Key，请重新保存');
      if (active.cancelled) throw new Error('CANCELLED');
      const agent = await this.factory(model, key, this.store.sessionPath(active.run.conversationId), active.run.conversationId);
      active.agent = agent; if (agent.sessionPath) this.store.setSessionPath(active.run.conversationId, agent.sessionPath);
      if (active.cancelled) throw new Error('CANCELLED');
      await agent.prompt(text, value => {
        content = value.replaceAll(key, '[已隐藏凭据]');
        if (Date.now() - lastFlush > 150) { this.store.updateMessage(active.assistantId, content, 'running'); lastFlush = Date.now(); }
        this.emit({ type: 'message.delta', ...ids, content });
      });
    } catch (e) {
      state = active.cancelled || (e instanceof Error && e.message === 'CANCELLED') ? 'cancelled' : 'failed';
      if (state === 'failed') error = safeFailure(e);
    } finally {
      if (active.cancelled) state = 'cancelled';
      active.agent?.dispose();
      this.store.transaction(() => { this.store.updateMessage(active.assistantId, content, state); this.store.finish(active.run.id, state, error); });
      if (this.active === active) this.active = null;
      this.emit({ type: 'message.finalized', ...ids, content });
      this.emit({ type: state === 'completed' ? 'run.completed' : state === 'cancelled' ? 'run.cancelled' : 'run.failed', ...ids }); this.changed();
    }
  }
  async shutdown() { await this.coding.shutdown(); if (this.active) { const active = this.active; active.cancelled = true; await active.agent?.abort(); await active.done; } }
}
export function safeFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : '';
  if (text.includes('Keychain')) return '无法读取模型凭据，请在本机检查 Keychain 并重新保存 API Key';
  if (text.includes('会话文件缺失')) return '私有会话文件缺失，请新建会话';
  if (text.includes('未返回文本')) return '模型未返回文本，请检查 Chat Completions 接口配置';
  return '模型请求失败，请检查 API Key、模型名、Base URL、接口兼容性和网络后重试';
}
