import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CANCELLED, createBotAgent, type AgentFactory, type AgentHandle, type ToolActivity } from '@pi-bot/agent';
import type { Mood } from '@pi-bot/bot-face';
import { libraryDir, libraryTools, Sandbox } from './library.js';

/** What the server sends with `{type:'run'}`; mirrors server `RunContext`. */
export interface RunContext {
  run_id: string;
  executor: 'mac' | 'cloud';
  bot: { id: string; name: string; slug: string };
  model: { id: string; name: string; context_window: number; max_tokens: number };
  system: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  text: string;
}
export interface ExecutorDeps {
  libraryRoot: string;
  agentDir: string;
  /** `${serverUrl}/llm/v1` */
  proxyUrl: string;
  llmToken(botId: string): Promise<string>;
  send(message: Record<string, unknown>): void;
  activity(run: RunContext, tool: string | null, mood: Mood | null): void;
  factory?: AgentFactory;
  approvalTimeoutMs?: number;
}
interface Active {
  run: RunContext;
  agent?: AgentHandle;
  cancelled: boolean;
  /** request_id → resolver */
  waiting: Map<string, (approved: boolean) => void>;
  /** approval_id → request_id */
  approvals: Map<string, string>;
  early: Map<string, boolean>;
}
const SEARCH = new Set(['list_files', 'read_file', 'search_files']);
const TOKEN_REFRESH_MS = 10 * 60 * 1000;

export class Executor {
  private active = new Map<string, Active>();
  constructor(private deps: ExecutorDeps) {}
  get running() { return [...this.active.keys()]; }

  async start(run: RunContext) {
    if (this.active.has(run.run_id)) return;
    const state: Active = { run, cancelled: false, waiting: new Map(), approvals: new Map(), early: new Map() };
    this.active.set(run.run_id, state);
    const event = (e: Record<string, unknown>) => this.deps.send({ type: 'run_event', run_id: run.run_id, event: e });
    event({ kind: 'started' });
    this.deps.activity(run, null, 'thinking');
    let latest = '', lastSent = 0, pendingText: NodeJS.Timeout | undefined, refresh: NodeJS.Timeout | undefined;
    const flush = () => { clearTimeout(pendingText); pendingText = undefined; lastSent = Date.now(); event({ kind: 'text', text: latest }); };
    try {
      const sandbox = new Sandbox(await libraryDir(this.deps.libraryRoot, run.bot.slug));
      const token = await this.deps.llmToken(run.bot.id);
      const tools = libraryTools(sandbox, {
        requestOutside: (path, reason, signal) => new Promise<boolean>(resolve => {
          const requestId = randomUUID();
          const timer = setTimeout(() => settle(false), this.deps.approvalTimeoutMs ?? 15 * 60 * 1000);
          const settle = (approved: boolean) => {
            clearTimeout(timer); signal?.removeEventListener('abort', abort); state.waiting.delete(requestId);
            this.deps.activity(run, null, 'thinking');
            resolve(approved);
          };
          const abort = () => settle(false);
          signal?.addEventListener('abort', abort, { once: true });
          state.waiting.set(requestId, settle);
          this.deps.activity(run, null, 'waiting');
          event({ kind: 'approval', request_id: requestId, path, reason });
        }),
      });
      const onTool = (t: ToolActivity) => {
        event({ kind: 'tool', ...t });
        this.deps.activity(run, t.state === 'running' ? t.name : null, t.state === 'running' ? (SEARCH.has(t.name) ? 'searching' : 'working') : 'thinking');
      };
      state.agent = await (this.deps.factory ?? createBotAgent)({
        model: { id: run.model.id, name: run.model.name, baseUrl: this.deps.proxyUrl, modelId: run.model.id, contextWindow: run.model.context_window, maxTokens: run.model.max_tokens },
        apiKey: token,
        cwd: sandbox.root,
        agentDir: this.deps.agentDir,
        systemPrompt: run.system,
        history: run.history,
        tools,
        onTool,
      });
      if (state.cancelled) throw new Error(CANCELLED);
      refresh = setInterval(() => { void this.deps.llmToken(run.bot.id).then(t => state.agent?.setApiKey(t)).catch(() => {}); }, TOKEN_REFRESH_MS);
      const final = await state.agent.prompt(run.text, text => {
        latest = text;
        if (Date.now() - lastSent > 150) flush();
        else pendingText ??= setTimeout(flush, 150);
      });
      clearTimeout(pendingText);
      event({ kind: 'done', state: 'completed', text: final });
      this.deps.activity(run, null, 'celebrate');
    } catch (error) {
      clearTimeout(pendingText);
      const cancelled = state.cancelled || (error instanceof Error && error.message === CANCELLED);
      const message = error instanceof Error && !cancelled ? error.message.slice(0, 300) : null;
      event({ kind: 'done', state: cancelled ? 'cancelled' : 'failed', error: message ?? '运行失败', text: latest || undefined });
      this.deps.activity(run, null, cancelled ? null : 'error');
    } finally {
      clearInterval(refresh);
      for (const settle of state.waiting.values()) settle(false);
      state.agent?.dispose();
      this.active.delete(run.run_id);
    }
  }
  cancel(runId: string) {
    const state = this.active.get(runId);
    if (!state) return false;
    state.cancelled = true;
    for (const settle of state.waiting.values()) settle(false);
    void state.agent?.abort();
    return true;
  }
  approvalCreated(runId: string, requestId: string, approvalId: string) {
    const state = this.active.get(runId);
    if (!state) return;
    state.approvals.set(approvalId, requestId);
    const early = state.early.get(approvalId);
    if (early !== undefined) this.decided(runId, approvalId, early);
  }
  approvalDecided(runId: string, approvalId: string, decision: 'approve' | 'reject') { this.decided(runId, approvalId, decision === 'approve'); }
  private decided(runId: string, approvalId: string, approved: boolean) {
    const state = this.active.get(runId);
    if (!state) return;
    const requestId = state.approvals.get(approvalId);
    if (!requestId) { state.early.set(approvalId, approved); return; }
    state.waiting.get(requestId)?.(approved);
  }
  stopAll() { for (const id of this.active.keys()) this.cancel(id); }
}

export const agentDirFor = (dataDir: string) => join(dataDir, 'pi');
