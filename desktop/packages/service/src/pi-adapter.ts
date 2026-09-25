import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ResourceLoader, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import type { ModelConfig } from '../../protocol/src/index.js';

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
export interface AgentOptions { cwd: string; systemPrompt: string; tools: ToolDefinition[]; }
export type AgentFactory = (config: ModelConfig, key: string, sessionPath: string | null, conversationId: string, ephemeral?: boolean, options?: AgentOptions) => Promise<AgentHandle>;
export class PiAgent implements AgentHandle {
  sessionPath?: string; tools: string[];
  constructor(private session: AgentSession, private allowEmpty = false) { this.sessionPath = session.sessionFile; this.tools = session.getActiveToolNames(); }
  async prompt(text: string, onText: (text: string) => void) {
    let content = '', failed = false, aborted = false, settled = false;
    const unsubscribe = this.session.subscribe(event => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') { content += event.assistantMessageEvent.delta; onText(content); }
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const msg = event.message;
        content = msg.content.filter(c => c.type === 'text').map(c => c.text).join(''); onText(content);
        failed = msg.stopReason === 'error'; aborted = msg.stopReason === 'aborted';
      }
      if (event.type === 'agent_settled') settled = true;
    });
    try {
      await this.session.prompt(text, { expandPromptTemplates: false });
      // prompt resolves after Pi's queue/recovery lifecycle; confirm final settled notification.
      if (!settled) await this.session.waitForIdle();
      if (aborted) throw new Error('CANCELLED');
      if (failed) throw new Error('模型请求失败，请检查凭据、模型名称、接口兼容性和网络');
      if (!content && !this.allowEmpty) throw new Error('模型未返回文本，请检查模型是否支持 Chat Completions');
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
    const resources = isolatedResources(); if (options) resources.getSystemPrompt = () => options.systemPrompt;
    const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, thinkingLevel: 'off', noTools: 'all', tools: options?.tools.map(t => t.name) ?? [], customTools: options?.tools ?? [], resourceLoader: resources,
      sessionManager,
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false, provider: { timeoutMs: 60000, maxRetries: 0 } }, compaction: { enabled: false } }),
    });
    const allowed = new Set(options?.tools.map(t => t.name) ?? []);
    if (session.getActiveToolNames().length !== allowed.size || session.getActiveToolNames().some(name => !allowed.has(name))) { session.dispose(); throw new Error('Ask 工具隔离校验失败'); }
    return new PiAgent(session, !!options);
  };
}
