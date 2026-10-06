import { codingSchemas, type CodingApi } from './coding.js';
import { cloudSchemas, type CloudApi } from './cloud.js';
import { configSchemas, type ConfigApi } from './configs.js';
import { browserSchemas, type BrowserApi } from './browser.js';
export * from './coding.js';
export * from './cloud.js';
export * from './configs.js';
export * from './browser.js';
import { z } from 'zod';

export type RunState = 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
export interface ModelConfig { id: string; name: string; baseUrl: string; modelId: string; contextWindow: number; maxTokens: number; isDefault: boolean; hasKey: boolean; revision?: number; }
export interface Conversation { shared?: boolean | number; kind?: 'ask' | 'coding'; projectId?: string | null; id: string; title: string; modelConfigId: string; createdAt: number; updatedAt: number; }
export interface Message { id: string; conversationId: string; runId: string; role: 'user' | 'assistant'; content: string; status: string; visibility: 'local_only' | 'shared'; }
export interface Run { id: string; taskId: string; conversationId: string; state: RunState; error: string | null; }
export interface Snapshot { models: ModelConfig[]; conversations: Conversation[]; activeRun: Run | null; testing: boolean; }
export interface ConversationDetail { conversation: Conversation; messages: Message[]; runs: Run[]; }
export interface AppEvent { seq?: number; project_id?: string; tool_call_id?: string; type: 'coding.changed' | 'cloud.changed' | 'tool.updated' | 'service.status' | 'state.changed' | 'run.started' | 'message.delta' | 'message.finalized' | 'run.completed' | 'run.cancelled' | 'run.failed'; conversation_id?: string; task_id?: string; run_id?: string; message_id?: string; content?: string; connected?: boolean; }
export interface ModelInput { id?: string; name: string; baseUrl: string; modelId: string; apiKey?: string; contextWindow: number; maxTokens: number; }
export interface Api extends CodingApi, CloudApi, ConfigApi, BrowserApi {
  health: { input: Record<string, never>; output: { ok: boolean; version: string } };
  snapshot: { input: Record<string, never>; output: Snapshot };
  modelSave: { input: ModelInput; output: ModelConfig };
  modelDelete: { input: { id: string; replacementId?: string }; output: null };
  modelDefault: { input: { id: string }; output: null };
  modelTest: { input: { id: string }; output: { ok: boolean } };
  conversationCreate: { input: { modelConfigId: string; shared?: boolean }; output: Conversation };
  conversationGet: { input: { id: string }; output: ConversationDetail };
  conversationRename: { input: { id: string; title: string }; output: null };
  conversationDelete: { input: { id: string }; output: null };
  messageSend: { input: { conversationId: string; text: string; requestId: string }; output: Run };
  runCancel: { input: { id: string }; output: null };
}
export type Method = keyof Api;
const id = z.string().uuid();
const endpoint = z.string().url().refine(v => { const u = new URL(v); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; }, 'API 根地址需使用 HTTP(S)，且不包含账号、查询参数或片段');
export const schemas = {
  ...codingSchemas,
  ...cloudSchemas,
  ...configSchemas,
  ...browserSchemas,
  health: z.object({}).strict(), snapshot: z.object({}).strict(),
  modelSave: z.object({ id: id.optional(), name: z.string().trim().min(1).max(80), baseUrl: endpoint, modelId: z.string().trim().min(1).max(200), apiKey: z.string().max(8192).optional(), contextWindow: z.number().int().min(1024).max(4000000), maxTokens: z.number().int().min(16).max(1000000) }).strict().refine(v => v.maxTokens < v.contextWindow, '输出上限必须小于上下文长度'),
  modelDelete: z.object({ id, replacementId: id.optional() }).strict(), modelDefault: z.object({ id }).strict(), modelTest: z.object({ id }).strict(),
  conversationCreate: z.object({ modelConfigId: id, shared: z.boolean().optional() }).strict(), conversationGet: z.object({ id }).strict(),
  conversationRename: z.object({ id, title: z.string().trim().min(1).max(120) }).strict(), conversationDelete: z.object({ id }).strict(),
  messageSend: z.object({ conversationId: id, text: z.string().trim().min(1).max(100000), requestId: id }).strict(), runCancel: z.object({ id }).strict(),
} satisfies Record<Method, z.ZodType>;
export function parseInput<M extends Method>(method: M, input: unknown): Api[M]['input'] {
  if (!Object.hasOwn(schemas, method)) throw new Error('不支持的请求');
  const result = schemas[method].safeParse(input);
  if (!result.success) throw new Error(result.error.issues.map(i => i.message).join('；'));
  return result.data as Api[M]['input'];
}
export interface DesktopBridge { chooseProjectDirectory(): Promise<string | null>; computerName(): Promise<string>; cloudServerUrl(): Promise<string>; call<M extends Method>(method: M, input: Api[M]['input']): Promise<Api[M]['output']>; subscribe(listener: (event: AppEvent) => void): () => void; openExternal(url: string): Promise<void>; }
