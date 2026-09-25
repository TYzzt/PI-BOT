import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalJson, cloudPlanBody, planContentHash } from '../packages/service/src/cloud/plan.js';
import { planBodySchema } from '../packages/protocol/src/index.js';

const vector = JSON.parse(readFileSync(new URL('../../server/tests/fixtures/plan_hash_vector.json', import.meta.url), 'utf8'));

test('plan content hash matches the shared server vector', () => {
  const input = vector.input;
  const local = planBodySchema.parse({ goal: input.body.goal, scope: input.body.scope, nonGoals: input.body.non_goals, modules: input.body.modules, steps: input.body.steps.map((s: any) => ({ stepId: s.step_id, title: s.title, description: s.description })), commands: input.body.commands, externalActions: input.body.external_actions, verification: input.body.verification, acceptance: input.body.acceptance, questions: input.body.questions });
  const body = cloudPlanBody(local);
  assert.deepEqual(body, input.body);
  assert.equal(planContentHash({ taskId: input.task_id, version: input.version, projectId: input.project_id, deviceId: input.device_id, body, workspaceFingerprint: input.workspace_fingerprint, configSnapshotId: input.config_snapshot_id }), vector.content_hash);
  assert.equal(planContentHash({ taskId: input.task_id.toUpperCase(), version: input.version, projectId: input.project_id, deviceId: input.device_id, body, workspaceFingerprint: input.workspace_fingerprint, configSnapshotId: input.config_snapshot_id }), vector.content_hash);
  assert.equal(canonicalJson({ b: [1, { d: 'x\n', c: null }], a: '中文\u0001' }), '{"a":"中文\\u0001","b":[1,{"c":null,"d":"x\\n"}]}');
});
