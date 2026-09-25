import { z } from 'zod';
export interface CloudFailure { at: number; message: string; }
export interface CloudProjectState { projectId: string; enabled: boolean; }
export interface CloudStatus { paired: boolean; serverUrl: string | null; deviceId: string | null; label: string | null; connected: boolean; lastSyncAt: number | null; pending: number; queued: number; failed: number; failures: CloudFailure[]; projects: CloudProjectState[]; }
export interface CloudTaskInfo { cloudTaskId: string; connected: boolean; publishedPlanIds: string[]; }
export interface CloudApi {
  cloudStatus: { input: Record<string, never>; output: CloudStatus };
  cloudPair: { input: { serverUrl: string; label: string; password: string }; output: CloudStatus };
  cloudUnpair: { input: Record<string, never>; output: CloudStatus };
  cloudProjectShare: { input: { projectId: string; enabled: boolean }; output: CloudStatus };
  cloudRetry: { input: Record<string, never>; output: CloudStatus };
  cloudApprove: { input: { taskId: string; planId: string; requestId: string }; output: null };
  cloudReject: { input: { taskId: string; requestId: string }; output: null };
  cloudRevise: { input: { taskId: string; feedback: string; requestId: string }; output: null };
}
const id = z.string().uuid();
export const cloudServerUrl = z.string().url().refine(v => { const u = new URL(v); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash && ['', '/'].includes(u.pathname); }, '服务器地址需使用 HTTP(S)，只填写协议、主机和端口');
export const cloudSchemas = {
  cloudStatus: z.object({}).strict(),
  cloudPair: z.object({ serverUrl: cloudServerUrl, label: z.string().trim().min(1).max(80), password: z.string().min(1).max(1024) }).strict(),
  cloudUnpair: z.object({}).strict(),
  cloudProjectShare: z.object({ projectId: id, enabled: z.boolean() }).strict(),
  cloudRetry: z.object({}).strict(),
  cloudApprove: z.object({ taskId: id, planId: id, requestId: id }).strict(),
  cloudReject: z.object({ taskId: id, requestId: id }).strict(),
  cloudRevise: z.object({ taskId: id, feedback: z.string().trim().min(1).max(30000), requestId: id }).strict(),
} satisfies Record<keyof CloudApi, z.ZodType>;
