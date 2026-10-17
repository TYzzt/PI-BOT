import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { a2uiTools, askAgentTool, taskTools, CANCELLED, createBotAgent, webSearchTool, type AgentFactory, type AgentHandle, type ToolActivity, type SkillSummary } from '@pi-bot/agent';
import type { Mood } from '@pi-bot/bot-face';
import { libraryDir, libraryTools, Sandbox } from './library.js';

/** What the server sends with `{type:'run'}`; mirrors server `RunContext`. */
export interface RunContext {
  run_id: string;
  executor: 'mac' | 'cloud';
  lane?: 'conversation' | 'task';
  instructions?: { id: string; text: string }[];
  bot: { id: string; name: string; slug: string };
  model: { id: string; name: string; context_window: number; max_tokens: number };
  system: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  text: string;
  search_enabled?: boolean;
  agents_enabled?: boolean;
  skills?: SkillSummary[];
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
  prompted: boolean;
  received: Set<string>;
  pending: { id: string; text: string }[];
  /** request_id → resolver */
  waiting: Map<string, (approved: boolean) => void>;
  /** approval_id → request_id */
  approvals: Map<string, string>;
  early: Map<string, boolean>;
}
const SEARCH = new Set(['list_files', 'read_file', 'search_files', 'web_search']);
const TOKEN_REFRESH_MS = 10 * 60 * 1000;

export class Executor {
  private active = new Map<string, Active>();
  constructor(private deps: ExecutorDeps) {}
  get running() { return [...this.active.keys()]; }

  async start(run: RunContext) {
    if (this.active.has(run.run_id)) return;
    const state: Active = { run, cancelled: false, prompted: false, received: new Set((run.instructions ?? []).map(i => i.id)), pending: [...run.instructions ?? []], waiting: new Map(), approvals: new Map(), early: new Map() };
    this.active.set(run.run_id, state);
    const event = (e: Record<string, unknown>) => this.deps.send({ type: 'run_event', run_id: run.run_id, event: e });
    event({ kind: 'started' });
    this.deps.activity(run, null, 'thinking');
    let timedOut = false;
    const deadline = run.lane === 'conversation' ? setTimeout(() => { timedOut = true; void state.agent?.abort(); }, 60000) : undefined;
    let latest = '', lastSent = 0, pendingText: NodeJS.Timeout | undefined, refresh: NodeJS.Timeout | undefined;
    const flush = () => { clearTimeout(pendingText); pendingText = undefined; lastSent = Date.now(); event({ kind: 'text', text: latest }); };
    try {
      const sandbox = new Sandbox(await libraryDir(this.deps.libraryRoot, run.bot.slug));
      let token = await this.deps.llmToken(run.bot.id);
      const tools = run.lane === "conversation" ? [] : libraryTools(sandbox, {
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
      const api = this.deps.proxyUrl.replace(/\/llm\/v1\/?$/, '');
      if (run.lane === "conversation") tools.push(...taskTools(api, () => token, run.run_id));
      if (run.lane !== "conversation" && run.search_enabled) tools.push(webSearchTool(api, () => token));
      if (run.agents_enabled) tools.push(askAgentTool(api, () => token, run.run_id, { conversation: run.lane === "conversation" }));
      tools.push(...a2uiTools(messages => { event({ kind: 'ui', messages }); }));
      const onTool = (t: ToolActivity) => {
        event({ kind: 'tool', ...t });
        const mood: Mood = t.name === 'ask_agent' ? 'waiting' : SEARCH.has(t.name) ? 'searching' : 'working';
        this.deps.activity(run, t.state === 'running' ? t.name : null, t.state === 'running' ? mood : 'thinking');
      };
      state.agent = await (this.deps.factory ?? createBotAgent)({
        model: { id: run.model.id, name: run.model.name, baseUrl: this.deps.proxyUrl, modelId: run.model.id, contextWindow: run.model.context_window, maxTokens: run.model.max_tokens },
        apiKey: token,
        cwd: sandbox.root,
        agentDir: join(this.deps.agentDir, 'bots', run.bot.id),
        systemPrompt: run.system,
        history: run.history,
        tools,
        skills: { baseUrl: api, token: () => token, runId: run.run_id, catalog: run.skills ?? [] },
        onTool,
        onProgress: lines => {
          clearTimeout(pendingText); pendingText = undefined;
          latest = '';
          event({ kind: 'progress', lines });
        },
      });
      if (timedOut) throw new Error('对话响应超时，请重新发送');
      if (state.cancelled) throw new Error(CANCELLED);
      refresh = setInterval(() => { void this.deps.llmToken(run.bot.id).then(t => { token = t; return state.agent?.setApiKey(t); }).catch(() => {}); }, TOKEN_REFRESH_MS);
      const initial = state.pending.splice(0);
      for (const i of initial) event({ kind: 'instruction_ack', id: i.id });
      state.prompted = true;
      const input = run.text + initial.map(i => `\n\n用户追加要求：\n${i.text}`).join('');
      const final = await state.agent.prompt(input, text => {
        latest = text;
        if (Date.now() - lastSent > 150) flush();
        else pendingText ??= setTimeout(flush, 150);
      });
      clearTimeout(pendingText);
      event({ kind: 'done', state: 'completed', text: final });
      this.deps.activity(run, null, 'celebrate');
    } catch (error) {
      clearTimeout(pendingText);
      const cancelled = !timedOut && (state.cancelled || (error instanceof Error && error.message === CANCELLED));
      const message = timedOut ? '对话响应超时，请重新发送' : error instanceof Error && !cancelled ? error.message.slice(0, 300) : null;
      event({ kind: 'done', state: cancelled ? 'cancelled' : 'failed', error: message ?? '运行失败', text: latest || undefined });
      this.deps.activity(run, null, cancelled ? null : 'error');
    } finally {
      clearTimeout(deadline);
      clearInterval(refresh);
      for (const settle of state.waiting.values()) settle(false);
      state.agent?.dispose();
      this.active.delete(run.run_id);
    }
  }
  async message(runId: string, id: string, text: string) {
    const state = this.active.get(runId);
    if (!state || state.cancelled) return false;
    if (state.received.has(id)) return true;
    state.received.add(id);
    try {
      if (!state.prompted) state.pending.push({ id, text });
      else {
        if (!state.agent?.steer) throw new Error('执行器不支持追加要求');
        await state.agent.steer(text);
      }
      return true;
    } catch (e) { state.received.delete(id); throw e; }
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
