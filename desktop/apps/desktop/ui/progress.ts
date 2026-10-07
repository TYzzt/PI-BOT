import type { CodingDetail, CodingRun } from '../../../packages/protocol/src/index.js';

/** Step completion is reported by the agent; tool activity is observed independently. */
export function executionProgress(detail: Pick<CodingDetail, 'task' | 'runs' | 'plans' | 'steps' | 'tools'>) {
  const run = detail.task.activeRunId ? detail.runs.find(r => r.run.id === detail.task.activeRunId) : detail.runs.findLast(r => r.mode === 'execute' || r.mode === 'agent');
  const tools = run ? detail.tools.filter(t => t.runId === run.run.id) : [];
  const activities = tools.filter(t => !['update_step', 'update_plan'].includes(t.name));
  const active = activities.filter(t => t.state === 'running');
  const plan = run?.mode === 'execute' ? detail.plans.find(p => p.id === run.planId) : undefined;
  // Stored step states belong to the most recently approved execution, never a historical plan.
  const latestExecution = detail.runs.findLast(r => r.mode === 'execute');
  const steps = plan?.body.steps.map(step => ({ ...step, ...((latestExecution?.run.id === run?.run.id ? detail.steps.find(s => s.stepId === step.stepId) : undefined) ?? { state: 'pending' as const, note: '' }) })) ?? [];
  return { run, tools, activities, active, current: active.at(-1), latest: activities.at(-1), plan, steps, completed: steps.filter(s => s.state === 'completed').length, runningStep: steps.find(s => s.state === 'running') };
}
export function activityDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds} 秒` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分 ${seconds % 60} 秒`;
}
export function runDuration(run: CodingRun, now: number): number | undefined {
  if (run.startedAt === undefined) return undefined;
  // Historical runs without an end timestamp must never keep ticking.
  const end = run.endedAt ?? (['running', 'cancelling'].includes(run.run.state) ? now : undefined);
  return end === undefined ? undefined : Math.max(0, end - run.startedAt);
}
export function executionDuration(runs: CodingRun[], now: number) {
  const durations = runs.filter(r => r.mode === 'execute' || r.mode === 'agent').map(r => runDuration(r, now)).filter((d): d is number => d !== undefined);
  return durations.length ? durations.reduce((total, duration) => total + duration, 0) : undefined;
}
