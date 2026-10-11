import { mkdirSync } from "node:fs";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";

/**
 * A model reachable through the Pi Bot model proxy. `modelId` is the Pi Bot
 * model UUID; the proxy maps it to the provider model and injects the key.
 */
export interface ModelConfig {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
}
export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}
export interface ToolActivity {
  id: string;
  name: string;
  state: "running" | "completed" | "failed";
  summary?: string;
}
export interface BotAgentOptions {
  model: ModelConfig;
  /** Short-lived proxy token; refresh with `setApiKey` on long runs. */
  apiKey: string;
  cwd: string;
  /** Pi's private state directory (no session files are written). */
  agentDir: string;
  systemPrompt: string;
  history: HistoryMessage[];
  tools: ToolDefinition[];
  redactSecrets?: string[];
  onTool?: (activity: ToolActivity) => void;
}
export interface AgentHandle {
  tools: string[];
  prompt(text: string, onText: (text: string) => void): Promise<string>;
  setApiKey(key: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}
export type AgentFactory = (options: BotAgentOptions) => Promise<AgentHandle>;

export const CANCELLED = "CANCELLED";

function resources(systemPrompt: string): ResourceLoader {
  const extensions = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

export function redactor(secrets: string[]) {
  const list = secrets.filter((s) => s.length >= 6);
  return (value: string) =>
    list.reduce((text, secret) => text.replaceAll(secret, "[已隐藏凭据]"), value);
}

function summarize(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

export class PiAgent implements AgentHandle {
  tools: string[];
  constructor(
    private session: AgentSession,
    private runtime: ModelRuntime,
    private provider: string,
    private redact: (value: string) => string,
    private onTool?: BotAgentOptions["onTool"],
  ) {
    this.tools = session.getActiveToolNames();
  }
  setApiKey(key: string) {
    return this.runtime.setRuntimeApiKey(this.provider, key);
  }
  async prompt(text: string, onText: (text: string) => void) {
    let content = "",
      failed = false,
      aborted = false,
      settled = false;
    const unsubscribe = this.session.subscribe((event) => {
      const e = event as any;
      if (e.type === "tool_execution_start")
        this.onTool?.({
          id: String(e.toolCallId ?? e.toolName),
          name: e.toolName,
          state: "running",
          summary: this.redact(summarize(e.args)),
        });
      if (e.type === "tool_execution_end")
        this.onTool?.({
          id: String(e.toolCallId ?? e.toolName),
          name: e.toolName,
          state: e.isError ? "failed" : "completed",
        });
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        content += event.assistantMessageEvent.delta;
        onText(this.redact(content));
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        const msg = event.message;
        content = msg.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("");
        onText(this.redact(content));
        failed = msg.stopReason === "error";
        aborted = msg.stopReason === "aborted";
      }
      if (event.type === "agent_settled") settled = true;
    });
    try {
      await this.session.prompt(text, { expandPromptTemplates: false });
      if (!settled) await this.session.waitForIdle();
      if (aborted) throw new Error(CANCELLED);
      if (failed) throw new Error("模型请求失败，请稍后重试或联系管理员检查模型配置");
      if (!content) throw new Error("模型未返回文本");
      return this.redact(content);
    } finally {
      unsubscribe();
    }
  }
  abort() {
    return this.session.abort();
  }
  dispose() {
    this.session.dispose();
  }
}

export const createBotAgent: AgentFactory = async (o) => {
  mkdirSync(o.agentDir, { recursive: true, mode: 0o700 });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const provider = `pi-bot-${o.model.id}`;
  runtime.registerProvider(provider, {
    baseUrl: o.model.baseUrl,
    api: "openai-completions",
    authHeader: true,
    models: [
      {
        id: o.model.modelId,
        name: o.model.name,
        reasoning: false,
        input: ["text"],
        contextWindow: o.model.contextWindow,
        maxTokens: o.model.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  await runtime.setRuntimeApiKey(provider, o.apiKey);
  const model = runtime.getModel(provider, o.model.modelId);
  if (!model) throw new Error("模型配置无法加载");
  const sessionManager = SessionManager.inMemory(o.cwd);
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const m of o.history)
    sessionManager.appendMessage(
      m.role === "user"
        ? { role: "user", content: m.content, timestamp: Date.now() }
        : {
            role: "assistant",
            content: [{ type: "text", text: m.content }],
            api: "openai-completions",
            provider,
            model: o.model.modelId,
            usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
            stopReason: "stop",
            timestamp: Date.now(),
          },
    );
  const { session } = await createAgentSession({
    cwd: o.cwd,
    agentDir: o.agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    noTools: "all",
    tools: o.tools.map((t) => t.name),
    customTools: o.tools,
    resourceLoader: resources(o.systemPrompt),
    sessionManager,
    settingsManager: SettingsManager.inMemory({
      retry: { enabled: true, maxRetries: 2, provider: { timeoutMs: 120000, maxRetries: 0 } },
      compaction: { enabled: true },
    }),
  });
  const allowed = new Set(o.tools.map((t) => t.name));
  const active = session.getActiveToolNames();
  if (active.length !== allowed.size || active.some((n) => !allowed.has(n))) {
    session.dispose();
    throw new Error("工具隔离校验失败");
  }
  return new PiAgent(
    session,
    runtime,
    provider,
    redactor([o.apiKey, ...(o.redactSecrets ?? [])]),
    o.onTool,
  );
};
