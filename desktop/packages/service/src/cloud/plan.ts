import { createHash } from 'node:crypto';
import type { PlanBody } from '../../../protocol/src/index.js';

export interface CloudPlanQuestion { id: string; prompt: string; options: { id: string; label: string }[]; allow_multiple: boolean }
export interface CloudPlanBody { goal: string; scope: string[]; non_goals: string[]; modules: string[]; steps: { step_id: string; title: string; description: string }[]; commands: string[]; external_actions: string[]; verification: string[]; acceptance: string[]; questions: Array<string | CloudPlanQuestion>; }
export interface PlanHashInput { taskId: string; version: number; projectId: string; deviceId: string; body: CloudPlanBody; workspaceFingerprint: string; configSnapshotId: string; }

export function cloudPlanBody(body: PlanBody): CloudPlanBody {
  return { goal: body.goal, scope: [...body.scope], non_goals: [...body.nonGoals], modules: [...body.modules], steps: body.steps.map(s => ({ step_id: s.stepId, title: s.title, description: s.description })), commands: [...body.commands], external_actions: [...body.externalActions], verification: [...body.verification], acceptance: [...body.acceptance], questions: body.questions.map(question => typeof question === 'string' ? question : { id: question.id, prompt: question.prompt, options: question.options.map(option => ({ id: option.id, label: option.label })), allow_multiple: question.allowMultiple ?? false }) };
}
// Must stay byte-identical to the server's json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False).
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  if (typeof value === 'number' && !Number.isInteger(value)) throw new Error('计划哈希只支持整数');
  return JSON.stringify(value);
}
export function planContentHash(input: PlanHashInput): string {
  const material = { task_id: input.taskId.toLowerCase(), version: input.version, project_id: input.projectId.toLowerCase(), device_id: input.deviceId.toLowerCase(), body: input.body, workspace_fingerprint: input.workspaceFingerprint, config_snapshot_id: input.configSnapshotId };
  return createHash('sha256').update(canonicalJson(material), 'utf8').digest('hex');
}
