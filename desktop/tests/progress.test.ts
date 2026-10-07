import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executionProgress, executionDuration, runDuration, activityDuration } from '../apps/desktop/ui/progress.js';
import type { ToolCall, ModelConfig } from '../packages/protocol/src/index.js';
import { fixturePlan } from './coding-helpers.js';
function fixture(): Parameters<typeof executionProgress>[0] {
  const run = (id: string, planId: string | null, mode: 'execute' | 'agent' = 'execute') => ({ run: { id, taskId: 'task', conversationId: 'chat', state: 'running' as const, error: null }, mode, planId, model: {} as ModelConfig, sessionPath: null });
  return {
    task: { id: 'task', conversationId: 'chat', projectId: 'project', requirement: '修复', planModelId: 'model', executeModelId: 'model', state: 'executing', latestPlanId: 'new-plan', activeRunId: 'new-run', message: '', createdAt: 0 },
    runs: [run('old-run', 'old-plan'), run('new-run', 'new-plan')],
    plans: ['old-plan', 'new-plan'].map((id, i) => ({ id, taskId: 'task', version: i + 1, hash: '', body: fixturePlan, fingerprint: '', configHash: '', createdAt: 0 })),
    steps: [{ stepId: 'fix-add', state: 'pending', note: '' }], tools: [],
  };
}
function tool(id: string, runId: string, state: ToolCall['state'], name = 'read_file'): ToolCall {
  return { id, taskId: 'task', runId, name, state, input: '{}', output: '', startedAt: 1000, endedAt: state === 'running' ? null : 2000, exitCode: null, verification: false, truncated: false, cwd: '', path: '' };
}
test('live progress filters old runs and does not infer step completion from successful tools', () => {
  const detail = fixture();
  detail.tools = [tool('old', 'old-run', 'running'), tool('done', 'new-run', 'completed'), tool('active', 'new-run', 'running', 'run_command'), tool('bookkeeping', 'new-run', 'running', 'update_step')];
  let progress = executionProgress(detail);
  assert.equal(progress.current?.id, 'active'); assert.equal(progress.active.length, 1); assert.equal(progress.completed, 0); assert.equal(progress.plan?.id, 'new-plan');
  detail.steps[0] = { stepId: 'fix-add', state: 'running', note: '正在验证' };
  progress = executionProgress(detail); assert.equal(progress.runningStep?.title, '修复加法');
  detail.steps[0].state = 'completed';
  assert.equal(executionProgress(detail).completed, 1);
});
test('thinking gaps and direct conversations do not show stale planned progress', () => {
  const detail = fixture(); detail.tools = [tool('done', 'new-run', 'completed')];
  let progress = executionProgress(detail);
  assert.equal(progress.current, undefined); assert.equal(progress.latest?.id, 'done');
  detail.runs[1].mode = 'agent'; detail.runs[1].planId = null;
  assert.equal(executionProgress(detail).steps.length, 0);
  detail.task.activeRunId = 'not-loaded-yet';
  progress = executionProgress(detail); assert.equal(progress.tools.length, 0); assert.equal(progress.steps.length, 0);
});
test('execution time includes thinking, freezes at completion and excludes planning and review waits', () => {
  const detail = fixture();
  const [old, current] = detail.runs;
  Object.assign(old, { startedAt: 1000, endedAt: 6000, run: { ...old.run, state: 'completed' } });
  Object.assign(current, { startedAt: 20000, endedAt: null });
  const planning = { ...current, mode: 'plan' as const, startedAt: 6000, endedAt: 8000 };
  assert.equal(executionDuration([old, planning, current], 23000), 8000);
  assert.equal(executionDuration([old, planning, current], 24000), 9000);
  Object.assign(current, { endedAt: 25000, run: { ...current.run, state: 'cancelled' } });
  assert.equal(executionDuration([old, planning, current], 99000), 10000);
  assert.equal(executionDuration([planning], 99000), undefined);
  assert.equal(runDuration({ ...current, startedAt: undefined }, 99000), undefined);
  assert.equal(runDuration({ ...current, endedAt: undefined }, 99000), undefined);
  assert.equal(activityDuration(3661000), '1 小时 1 分 1 秒');
});
