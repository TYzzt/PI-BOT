import { z } from 'zod';
export interface CloudFailure { at: number; message: string; }
export interface CloudProjectState { projectId: string; enabled: boolean; }
export interface CloudStatus { paired: boolean; serverUrl: string | null; deviceId: string | null; label: string | null; connected: boolean; lastSyncAt: number | null; pending: number; queued: number; failed: number; failures: CloudFailure[]; projects: CloudProjectState[]; }
export interface CloudTaskInfo { cloudTaskId: string; connected: boolean; publishedPlanIds: string[]; }
export interface SharedStatus { deviceLabel?: string; connected?: boolean; runs?: {id:string; conversationId:string; state:string; cancelRequested:boolean}[]; models: { id: string; version: number; applied: number; error?: string; conflict?: boolean }[]; conversations: { id: string; shared: boolean; version: number; error?: string; syncedAt?: number }[]; error?: string; }
export interface CloudModel { id: string; version: number; name: string; modelId: string; isDefault: boolean; sourceModelId: string | null; }
export interface CloudChatConversation { updatedAt?: number; id: string; version: number; title: string; modelId: string; handoff: { fromConversationId: string; messageCount: number } | null; }
export interface CloudChatMessage { id: string; runId: string; role: 'user' | 'assistant'; content: string; status: string; sequence: number; }
export interface CloudChatRun { id: string; conversationId: string; state: string; cancelRequested: boolean; error: string | null; }
export interface CloudChatDetail { conversation: CloudChatConversation; messages: CloudChatMessage[]; run: CloudChatRun | null; }
export interface CloudApi {
  sharedStatus: { input: Record<string, never>; output: SharedStatus };
  sharedConversation: { input: { ids: string[]; shared: boolean }; output: null };
  sharedResolve: { input: { id: string; choice: 'remote' | 'local' }; output: null };
  cloudStatus: { input: Record<string, never>; output: CloudStatus };
  cloudPair: { input: { serverUrl: string; label: string; password: string }; output: CloudStatus };
  cloudUnpair: { input: Record<string, never>; output: CloudStatus };
  cloudProjectShare: { input: { projectId: string; enabled: boolean }; output: CloudStatus };
  cloudRetry: { input: Record<string, never>; output: CloudStatus };
  cloudApprove: { input: { taskId: string; planId: string; requestId: string }; output: null };
  cloudReject: { input: { taskId: string; requestId: string }; output: null };
  cloudRevise: { input: { taskId: string; feedback: string; requestId: string }; output: null };
  cloudChatList: { input: Record<string, never>; output: CloudChatConversation[] };
  cloudChatGet: { input: { id: string }; output: CloudChatDetail };
  cloudChatCreate: { input: { id: string; modelId: string; title: string }; output: CloudChatConversation };
  cloudChatSend: { input: { conversationId: string; text: string; requestId: string }; output: CloudChatRun };
  cloudChatCancel: { input: { runId: string }; output: CloudChatRun };
  cloudChatHandoff: { input: { id: string; conversationId: string; modelId: string; requestId: string }; output: CloudChatConversation };
  cloudModelList: { input: Record<string, never>; output: CloudModel[] };
  cloudModelFromLocal: { input: { modelId: string; requestId: string }; output: CloudModel };
}
const id = z.string().uuid();
export const cloudServerUrl = z.string().url().refine(v => { const u = new URL(v); return (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname))) && !u.username && !u.password && !u.search && !u.hash && ['', '/'].includes(u.pathname); }, '服务器地址需使用 HTTP(S)，只填写协议、主机和端口');
export const cloudSchemas = {
  sharedStatus: z.object({}).strict(),
  sharedConversation: z.object({ ids: z.array(id).min(1).max(500), shared: z.boolean() }).strict(),
  sharedResolve: z.object({ id, choice: z.enum(['remote','local']) }).strict(),
  cloudStatus: z.object({}).strict(),
  cloudPair: z.object({ serverUrl: cloudServerUrl, label: z.string().trim().min(1).max(80), password: z.string().min(1).max(1024) }).strict(),
  cloudUnpair: z.object({}).strict(),
  cloudProjectShare: z.object({ projectId: id, enabled: z.boolean() }).strict(),
  cloudRetry: z.object({}).strict(),
  cloudApprove: z.object({ taskId: id, planId: id, requestId: id }).strict(),
  cloudReject: z.object({ taskId: id, requestId: id }).strict(),
  cloudRevise: z.object({ taskId: id, feedback: z.string().trim().min(1).max(30000), requestId: id }).strict(),
  cloudChatList: z.object({}).strict(),
  cloudChatGet: z.object({ id }).strict(),
  cloudChatCreate: z.object({ id, modelId: id, title: z.string().trim().min(1).max(120) }).strict(),
  cloudChatSend: z.object({ conversationId: id, text: z.string().trim().min(1).max(100000), requestId: id }).strict(),
  cloudChatCancel: z.object({ runId: id }).strict(),
  cloudChatHandoff: z.object({ id, conversationId: id, modelId: id, requestId: id }).strict(),
  cloudModelList: z.object({}).strict(),
  cloudModelFromLocal: z.object({ modelId: id, requestId: id }).strict(),
} satisfies Record<keyof CloudApi, z.ZodType>;
