import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ResourceLoader, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import type { ModelConfig } from '../../protocol/src/index.js';
import { monotonicMs, type TokenUsage } from './coding/performance-log.js';

export function isolatedResources(): ResourceLoader {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions, getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => '你是 T-AGNET 的中文问答助手。当前为纯文本 Ask 模式，没有文件、命令、浏览器等工具。请直接回答问题，不声称执行任何本机操作。',
    getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
  };
}
export interface AgentHandle { sessionPath?: string; tools: string[]; prompt(text: string, onText: (text: string) => void): Promise<void>; abort(): Promise<void>; dispose(): void; }
export type CompactionProgress = { phase: 'start' | 'end'; error?: string };
export class CompactionError extends Error { constructor() { super('上下文整理失败，任务已停止；已有修改与记录已保留'); } }
export type AgentPerformanceEvent = { kind: 'model_round'; durationMs: number; inputChars: number; outputChars: number; usage: TokenUsage | null } | { kind: 'compaction'; durationMs: number };
export interface AgentOptions { autoCompaction?: boolean; onCompaction?: (event: CompactionProgress) => void; onPerformance?: (event: AgentPerformanceEvent) => void; cwd: string; systemPrompt: string; tools: ToolDefinition[]; }
export type AgentFactory = (config: ModelConfig, key: string, sessionPath: string | null, conversationId: string, ephemeral?: boolean, options?: AgentOptions) => Promise<AgentHandle>;
function textLength(content: unknown) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, part) => sum + (part && typeof part === 'object' && (part as { type?: string }).type === 'text' ? String((part as { text?: string }).text ?? '').length : 0), 0);
}
function usageOf(message: { usage?: Partial<TokenUsage> }): TokenUsage | null {
  const usage = message.usage;
  if (!usage || typeof usage.input !== 'number' || typeof usage.output !== 'number') return null;
  return { input: usage.input, output: usage.output, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0, totalTokens: usage.totalTokens ?? usage.input + usage.output };
}
export class PiAgent implements AgentHandle {
  sessionPath?: string; tools: string[];
  constructor(private session: AgentSession, private allowEmpty = false, private onCompaction?: AgentOptions['onCompaction'], private onPerformance?: AgentOptions['onPerformance']) { this.sessionPath = session.sessionFile; this.tools = session.getActiveToolNames(); }
  async prompt(text: string, onText: (text: string) => void) {
    let content = '', failed = false, aborted = false, settled = false, compactionFailed = false;
    let roundStarted = 0, roundOpen = false, pendingInput = text.length, compactionStarted = 0;
    const report = (event: AgentPerformanceEvent) => { try { this.onPerformance?.(event); } catch { /* performance reporting must not break the run */ } };
    const unsubscribe = this.session.subscribe(event => {
      if (event.type === 'turn_start') { roundStarted = monotonicMs(); roundOpen = true; }
      if (event.type === 'compaction_start') { compactionStarted = monotonicMs(); this.onCompaction?.({ phase: 'start' }); }
      if (event.type === 'compaction_end') {
        report({ kind: 'compaction', durationMs: compactionStarted ? monotonicMs() - compactionStarted : 0 });
        compactionStarted = 0;
        compactionFailed ||= !!event.errorMessage;
        this.onCompaction?.({ phase: 'end', error: event.errorMessage ? new CompactionError().message : undefined });
        if (event.errorMessage) void this.session.abort();
      }
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') { content += event.assistantMessageEvent.delta; onText(content); }
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const msg = event.message;
        content = msg.content.filter(c => c.type === 'text').map(c => c.text).join(''); onText(content);
        failed = msg.stopReason === 'error'; aborted = msg.stopReason === 'aborted';
        if (roundOpen) {
          roundOpen = false;
          report({ kind: 'model_round', durationMs: monotonicMs() - roundStarted, inputChars: pendingInput, outputChars: textLength(msg.content), usage: usageOf(msg) });
          pendingInput = 0;
        }
      }
      if (event.type === 'turn_end') for (const result of event.toolResults ?? []) pendingInput += textLength(result.content);
      if (event.type === 'agent_settled') settled = true;
    });
    try {
      await this.session.prompt(text, { expandPromptTemplates: false });
      // prompt resolves after Pi's queue/recovery lifecycle; confirm final settled notification.
      if (!settled) await this.session.waitForIdle();
      if (compactionFailed) throw new CompactionError();
      if (aborted) throw new Error('CANCELLED');
      if (failed) throw new Error('模型请求失败，请检查凭据、模型名称、接口兼容性和网络');
      if (!content && !this.allowEmpty) throw new Error('模型未返回文本，请检查模型是否支持 Chat Completions');
    } catch (error) {
      if (compactionFailed) throw new CompactionError();
      throw error;
    } finally { unsubscribe(); }
  }
  abort() { return this.session.abort(); }
  dispose() { this.session.dispose(); }
}
export function piFactory(dataDir: string): AgentFactory {
  return async (config, key, existing, conversationId, ephemeral = false, options) => {
    const agentDir = join(dataDir, 'pi'), cwd = options?.cwd ?? join(agentDir, 'empty-workspace'), sessionDir = join(agentDir, 'sessions', conversationId);
    for (const path of [agentDir, ...(!options ? [cwd] : []), sessionDir]) mkdirSync(path, { recursive: true, mode: 0o700 });
    if (existing && !existsSync(existing)) throw new Error('私有会话文件缺失，请新建会话，避免丢失上下文后继续');
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    const provider = `t-agnet-${config.id}`;
    runtime.registerProvider(provider, { baseUrl: config.baseUrl, api: 'openai-completions', authHeader: true, models: [{ id: config.modelId, name: config.name, reasoning: false, input: ['text'], contextWindow: config.contextWindow, maxTokens: config.maxTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
    await runtime.setRuntimeApiKey(provider, key);
    const model = runtime.getModel(provider, config.modelId); if (!model) throw new Error('模型配置无法加载');
    const sessionManager = ephemeral ? SessionManager.inMemory(cwd) : existing ? SessionManager.open(existing, sessionDir, cwd) : SessionManager.create(cwd, sessionDir);
    // Provider errors may echo credentials. Redact before Pi persists any message.
    const appendMessage = sessionManager.appendMessage.bind(sessionManager);
    sessionManager.appendMessage = message => appendMessage(JSON.parse(JSON.stringify(message).replaceAll(JSON.stringify(key).slice(1, -1), '[已隐藏凭据]')));
    const appendCompaction = sessionManager.appendCompaction.bind(sessionManager);
    sessionManager.appendCompaction = (...args) => appendCompaction(...JSON.parse(JSON.stringify(args).replaceAll(JSON.stringify(key).slice(1, -1), '[已隐藏凭据]')) as typeof args);
    const resources = isolatedResources(); if (options) resources.getSystemPrompt = () => options.systemPrompt;
    const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, thinkingLevel: 'off', noTools: 'all', tools: options?.tools.map(t => t.name) ?? [], customTools: options?.tools ?? [], resourceLoader: resources,
      sessionManager,
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false, provider: { timeoutMs: 60000, maxRetries: 0 } }, compaction: { enabled: options?.autoCompaction ?? false } }),
    });
    const allowed = new Set(options?.tools.map(t => t.name) ?? []);
    if (session.getActiveToolNames().length !== allowed.size || session.getActiveToolNames().some(name => !allowed.has(name))) { session.dispose(); throw new Error('Ask 工具隔离校验失败'); }
    return new PiAgent(session, !!options, options?.onCompaction, options?.onPerformance);
  };
}
