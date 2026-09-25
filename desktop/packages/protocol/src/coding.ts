import { z } from 'zod';
import type { AppEvent, ModelConfig, Run, Message } from './index.js';
export type TaskState = 'reading' | 'planning' | 'awaiting_review' | 'awaiting_input' | 'executing' | 'needs_replan' | 'waiting_for_local_action' | 'completed' | 'failed' | 'cancelled' | 'rejected' | 'interrupted';
export interface Project { id: string; name: string; path: string; removed: boolean; createdAt: number; branch?: string; status?: string; available?: boolean; error?: string; }
export const planBodySchema = z.object({
  goal: z.string().min(1).max(4000), scope: z.array(z.string().max(1000)).min(1).max(30), nonGoals: z.array(z.string().max(1000)).max(30), modules: z.array(z.string().max(500)).max(100),
  steps: z.array(z.object({ stepId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), title: z.string().min(1).max(500), description: z.string().max(3000) }).strict()).min(1).max(30),
  commands: z.array(z.string().max(2000)).max(30), externalActions: z.array(z.string().max(1000)).max(30), verification: z.array(z.string().min(1).max(1000)).min(1).max(30), acceptance: z.array(z.string().min(1).max(1000)).min(1).max(30), questions: z.array(z.string().max(2000)).max(20),
}).strict().refine(p => new Set(p.steps.map(s => s.stepId)).size === p.steps.length, 'stepId 必须唯一');
export type PlanBody = z.infer<typeof planBodySchema>;
export interface PlanVersion { id: string; taskId: string; version: number; hash: string; body: PlanBody; fingerprint: string; configHash: string; createdAt: number; }
export interface CodingTask { intent?: 'read' | 'code'; readReturnState?: TaskState; id: string; conversationId: string; projectId: string; requirement: string; planModelId: string; executeModelId: string; state: TaskState; latestPlanId: string | null; activeRunId: string | null; message: string; createdAt: number; }
export interface CodingRun { run: Run; mode: 'read' | 'plan' | 'execute'; planId: string | null; model: ModelConfig; sessionPath: string | null; }
export interface ToolCall { id: string; taskId: string; runId: string; name: string; input: string; output: string; state: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; startedAt: number; endedAt: number | null; exitCode: number | null; verification: boolean; truncated: boolean; cwd: string; path: string; }
export interface StepStatus { stepId: string; state: 'pending' | 'running' | 'completed' | 'failed'; note: string; }
export interface CodingDetail { messages: Message[]; summary: string; task: CodingTask; project: Project; plans: PlanVersion[]; runs: CodingRun[]; steps: StepStatus[]; tools: ToolCall[]; lastSeq: number; verification: 'passed' | 'failed' | 'not_run' | 'cancelled'; }
export interface FileChange { path: string; kind: 'added' | 'modified' | 'deleted'; preview: boolean; }
export interface Changes { files: FileChange[]; diff: string; warning: string; }
export interface CodingApi {
  projectList: { input: Record<string, never>; output: Project[] };
  projectAdd: { input: { path: string; requestId: string }; output: Project };
  projectRemove: { input: { id: string; requestId: string }; output: null };
  codingCreate: { input: { intent?: 'read' | 'code'; projectId: string; requirement: string; planModelId: string; executeModelId: string; requestId: string }; output: CodingTask };
  codingGet: { input: { conversationId: string }; output: CodingDetail };
  codingRead: { input: { taskId: string; text: string; modelId?: string; requestId: string }; output: Run };
  codingPlan: { input: { taskId: string; feedback: string; planModelId?: string; executeModelId?: string; requestId: string }; output: Run };
  codingApprove: { input: { taskId: string; planId: string; hash: string; requestId: string }; output: Run | null };
  codingReject: { input: { taskId: string; requestId: string }; output: null };
  codingChanges: { input: { taskId: string; view: 'baseline' | 'workspace'; path?: string }; output: Changes };
  codingLogs: { input: { taskId: string; offset: number }; output: ToolCall[] };
  codingEvents: { input: { taskId: string; after: number }; output: AppEvent[] };
}
const id = z.string().uuid(), requestId = id, taskId = id;
export const codingSchemas = {
  projectList: z.object({}).strict(), projectAdd: z.object({ path: z.string().min(1).max(4096), requestId }).strict(), projectRemove: z.object({ id, requestId }).strict(),
  codingCreate: z.object({ intent: z.enum(['read', 'code']).optional(), projectId: id, requirement: z.string().trim().min(1).max(30000), planModelId: id, executeModelId: id, requestId }).strict(),
  codingGet: z.object({ conversationId: id }).strict(), codingRead: z.object({ taskId, text: z.string().trim().min(1).max(30000), modelId: id.optional(), requestId }).strict(), codingPlan: z.object({ taskId, feedback: z.string().trim().min(1).max(30000), planModelId: id.optional(), executeModelId: id.optional(), requestId }).strict(),
  codingApprove: z.object({ taskId, planId: id, hash: z.string().length(64), requestId }).strict(), codingReject: z.object({ taskId, requestId }).strict(),
  codingChanges: z.object({ taskId, view: z.enum(['baseline', 'workspace']), path: z.string().max(4096).optional() }).strict(),
  codingLogs: z.object({ taskId, offset: z.number().int().nonnegative().max(1000000) }).strict(),
  codingEvents: z.object({ taskId, after: z.number().int().nonnegative() }).strict(),
} satisfies Record<keyof CodingApi, z.ZodType>;
