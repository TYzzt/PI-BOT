import { SharedSync } from './cloud/shared.js';
import { CloudChat, cloudChatMethods, type CloudChatMethod } from './cloud/chat.js';
import { ConfigSync, configMethods, type ConfigMethod, type ConfigHost } from './cloud/configs.js';
import { dataDir } from './paths.js';
import { join } from 'node:path';
import { CodingController } from './coding/controller.js';
import { BrowserService } from './browser/index.js';
import { JevConfig } from './browser/jev.js';
import { browserSchemas } from '../../protocol/src/browser.js';
import { codingSchemas } from '../../protocol/src/coding.js';
import { cloudSchemas } from '../../protocol/src/cloud.js';
import { CloudSync, type CloudOptions } from './cloud/sync.js';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Api, Method, AppEvent, Run } from '../../protocol/src/index.js';
import { parseInput } from '../../protocol/src/index.js';
import { Store } from './store.js';
import { MemoryCredentials, type Credentials } from './keychain.js';
import type { AgentFactory, AgentHandle } from './pi-adapter.js';

export class Application {
  private active: { run: Run; assistantId: string; agent?: AgentHandle; cancelled: boolean; done?: Promise<void> } | null = null;
  private testing = false;
  private serial: Promise<unknown> = Promise.resolve();
  readonly coding: CodingController; readonly cloud: CloudSync; readonly shared: SharedSync; readonly cloudChat: CloudChat; readonly configs: ConfigSync; readonly browser: BrowserService;
  constructor(readonly store: Store, private credentials: Credentials, private factory: AgentFactory, private emit: (event: AppEvent) => void, cloud: { dataDir?: string; credentials?: Credentials; options?: CloudOptions; configs?: { dir?: string; intervalMs?: number; env?: ConfigHost['env'] }; browser?: { profileDir?: string; executable?: string; headless?: boolean; args?: string[]; lockTimeoutMs?: number; fetch?: typeof fetch } } = {}) {
    const b = cloud.browser ?? {};
    this.browser = new BrowserService({ profileDir: b.profileDir ?? join(dataDir, 'chrome-profile'), executable: b.executable, headless: b.headless, args: b.args, lockTimeoutMs: b.lockTimeoutMs, jev: new JevConfig(store.db, credentials, b.fetch) });
    this.coding = new CodingController(store, credentials, factory, emit, () => this.idle(), this.browser, cloud.dataDir ?? dataDir);
    this.cloud = new CloudSync({ store, coding: this.coding, credentials: cloud.credentials ?? new MemoryCredentials(), serial: fn => this.enqueue(fn), busy: () => this.busy(), emit }, cloud.options);
    this.shared = new SharedSync({ store, keys: credentials, cloud: this.cloud, coding: this.coding, busy: () => this.busy(), serial: fn => this.enqueue(fn), call: (method, input) => this.dispatch(method as Method, input, true), emit });
    this.cloudChat = new CloudChat({ paired: () => !!this.cloud.db.link(), request: (method, path, body) => this.cloud.request(method, path, body) });
    this.configs = new ConfigSync({ paired: () => !!this.cloud.db.link(), connected: () => this.cloud.connected, request: (method, path, body) => this.cloud.request(method, path, body), keys: credentials, db: store.db, dir: cloud.configs?.dir ?? join(dataDir, 'skills'), env: cloud.configs?.env, emit: () => emit({ type: 'cloud.changed' }) }, cloud.configs?.intervalMs);
    void this.cloud.start();
  }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> { const result = this.serial.then(fn); this.serial = result.catch(() => {}); return result; }
  call<M extends Method>(method: M, raw: unknown): Promise<Api[M]['output']> {
    const input = parseInput(method, raw);
    // Cloud chat is plain server I/O: it must not wait behind local generation or sync work in the serial queue.
    if (cloudChatMethods.has(method)) return this.cloudChat.dispatch(method as CloudChatMethod, input as never) as Promise<Api[M]['output']>;
    if (configMethods.has(method)) return this.configs.dispatch(method as ConfigMethod, input as never) as Promise<Api[M]['output']>;
    if (Object.hasOwn(browserSchemas, method)) return this.browserCall(method, input) as Promise<Api[M]['output']>;
    const result = this.enqueue(() => this.dispatch(method, input));
    return result.then(value => value && typeof value === 'object' && 'deferred' in value ? (value as { deferred: Promise<unknown> }).deferred : value) as Promise<Api[M]['output']>;
  }
  private async browserCall(method: Method, data: any): Promise<unknown> {
    const jev = this.browser.jev;
    switch (method) {
      case 'jevGet': return jev.status();
      case 'jevSave': return jev.save(data);
      case 'jevDelete': return jev.remove();
      case 'jevTest': return jev.test();
      case 'browserStatus': return this.browser.status();
    }
    throw new Error('不支持的浏览器请求');
  }
  private changed() { this.emit({ type: 'state.changed' }); }
  private busy() { return !!(this.active || this.testing || this.coding.active); }
  private idle() { if (this.busy()) throw new Error('正在生成或测试连接，请先等待当前请求完成'); }
  private async dispatch(method: Method, data: any, syncing = false): Promise<unknown> {
    if (method === 'sharedStatus') return this.shared.status();
    if (method === 'sharedConversation') { await this.shared.share(data.ids, data.shared); return null; }
    if (method === 'sharedResolve') { await this.shared.resolve(data.id, data.choice); return null; }
    if (method === 'cloudUnpair') return this.cloud.dispatch(method, data);
    if (method === 'cloudPair') {
      const previous = this.cloud.db.detached();
      const result = await this.cloud.dispatch(method, data);
      const current = this.cloud.db.link()!;
      if (!previous || previous.serverUrl !== current.serverUrl || previous.deviceId !== current.deviceId) await this.shared.reset();
      return result;
    }
    if (Object.hasOwn(cloudSchemas, method)) return this.cloud.dispatch(method as Extract<Method, `cloud${string}`>, data);
    if (method === 'codingGet') { const detail = await this.coding.dispatch(method, data) as Api['codingGet']['output']; return { ...detail, cloud: this.cloud.taskInfo(detail.task.id) }; }
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
        if (!syncing) await this.shared.beforeDeleteModel(data.id, data.replacementId);
        await this.credentials.delete(data.id); if (data.replacementId) this.coding.replaceModel(data.id, data.replacementId); this.store.deleteModel(data.id, data.replacementId); this.changed(); return null;
      }
      case 'modelDefault': this.idle(); this.store.defaultModel(data.id); this.changed(); return null;
      case 'modelTest': {
        this.idle(); const m = this.store.model(data.id); this.store.assertModelReady(m.id); this.testing = true; this.changed();
        // Do not block other RPCs behind a network test. The busy flag serializes model calls.
        const operation = this.testModel(m);
        return { deferred: operation };
      }
      case 'conversationCreate': { const c = this.store.createConversation(data.modelConfigId, data.shared); this.changed(); return c; }
      case 'conversationGet': return { conversation: this.store.conversation(data.id), messages: this.store.messages(data.id), runs: this.store.runs(data.id) };
      case 'conversationRename': this.store.rename(data.id, data.title); this.changed(); return null;
      case 'conversationDelete': {
        if (this.active?.run.conversationId === data.id || this.coding.active?.run.conversationId === data.id) throw new Error('请先停止该会话的生成');
        if (!syncing) await this.shared.beforeDeleteConversation(data.id);
        this.coding.removeConversation(data.id);
        this.store.conversation(data.id);
        const sessionPath = this.store.sessionPath(data.id);
        if (sessionPath) rmSync(sessionPath, { force: true });
        this.store.deleteConversation(data.id); this.changed(); return null;
      }
      case 'messageSend': {
        const previous = this.store.existing(data.requestId, data.conversationId, data.text); if (previous) return previous;
        this.idle(); const c = this.store.conversation(data.conversationId); if (c.kind === 'coding') throw new Error('编程会话请使用规划接口'); const model = this.store.model(c.modelConfigId); this.store.assertModelReady(model.id);
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
  async shutdown() { await this.configs.stop(); await this.shared.stop(); this.cloud.stop(); await this.coding.shutdown(); if (this.active) { const active = this.active; active.cancelled = true; await active.agent?.abort(); await active.done; } await this.browser.close(); }
}
export function safeFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : '';
  if (text.includes('Keychain')) return '无法读取模型凭据，请在本机检查 Keychain 并重新保存 API Key';
  if (text.includes('会话文件缺失')) return '私有会话文件缺失，请新建会话';
  if (text.includes('未返回文本')) return '模型未返回文本，请检查 Chat Completions 接口配置';
  return '模型请求失败，请检查 API Key、模型名、Base URL、接口兼容性和网络后重试';
}
