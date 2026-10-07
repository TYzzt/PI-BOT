import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answersReady, formatQuestionAnswers, planBodySchema } from '../packages/protocol/src/index.js';
import { cloudPlanBody } from '../packages/service/src/cloud/plan.js';

const choice = { id: 'channel', prompt: '频道缺失时', options: [{ id: 'error', label: '直接报错' }, { id: 'fallback', label: '回退当前频道' }] };

test('plan questions accept legacy strings and choice objects', () => {
  const legacy = planBodySchema.parse({ goal: '目标', scope: ['范围'], nonGoals: [], modules: [], steps: [{ stepId: 's1', title: '步骤', description: '' }], commands: [], externalActions: [], verification: ['验证'], acceptance: ['验收'], questions: ['请提供期望结果'] });
  const chosen = planBodySchema.parse({ ...legacy, questions: [choice, { ...choice, id: 'scope', prompt: '存量任务', allowMultiple: true, options: [{ id: 'keep', label: '只限新建' }, { id: 'clean', label: '清理旧数据' }] }] });
  assert.equal(typeof legacy.questions[0], 'string');
  assert.equal(chosen.questions.length, 2);
  const cloud = cloudPlanBody(chosen);
  assert.deepEqual(cloud.questions[0], { ...choice, allow_multiple: false });
});

test('choice answers format the selected label', () => {
  assert.equal(answersReady([choice], {}), false);
  const picks = { channel: { options: ['error'], other: '' } };
  assert.equal(answersReady([choice], picks), true);
  assert.equal(formatQuestionAnswers([choice], picks), '问题「频道缺失时」选择：直接报错');
  assert.equal(formatQuestionAnswers(['请提供期望结果'], { 'legacy:0': { options: [], other: '返回 5' } }), '问题「请提供期望结果」选择：返回 5');
  assert.equal(answersReady(['请提供期望结果'], {}), false);
});

test('early clarification persists without a plan, blocks writes, and requires review after execution questions', { timeout: 90000 }, async () => {
  const { randomUUID } = await import('node:crypto');
  const { mkdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { Store } = await import('../packages/service/src/store.js');
  const { Application } = await import('../packages/service/src/application.js');
  const { piFactory } = await import('../packages/service/src/pi-adapter.js');
  const { temp, MemoryCredentials, eventually } = await import('./helpers.js');
  const { codingEndpoint, fixtureProject, fixtureQuestions } = await import('./coding-helpers.js');
  const dir = temp(), root = join(dir.path, 'repo'), dbPath = join(dir.path, 'app.sqlite'); mkdirSync(root); fixtureProject(root);
  const api = await codingEndpoint(), keys = new MemoryCredentials();
  let store = new Store(dbPath), app = new Application(store, keys, piFactory(dir.path), () => {}, { dataDir: dir.path });
  const wait = () => eventually(() => !app.coding.active, 20000);
  try {
    const model = await app.call('modelSave', { name: 'questions', modelId: 'fixture', baseUrl: api.url, apiKey: 'secret', contextWindow: 64000, maxTokens: 4096 });
    const project = await app.call('projectAdd', { path: root, requestId: randomUUID() });
    const create = (requirement: string, mode: 'plan' | 'agent' = 'plan') => app.call('codingCreate', { mode, projectId: project.id, requirement, planModelId: model.id, executeModelId: model.id, requestId: randomUUID() });
    const task = await create('修复 add early-question'); await wait();
    let detail = await app.call('codingGet', { conversationId: task.conversationId });
    assert.equal(detail.task.state, 'awaiting_input', detail.task.message);
    assert.equal(detail.plans.length, 0, 'Clarification does not require a fabricated complete plan');
    assert.deepEqual(detail.task.pendingInput?.questions, fixtureQuestions);
    assert.equal(detail.task.pendingInput?.mode, 'plan');
    const pendingId = detail.task.pendingInput!.id;
    await app.shutdown(); store.close(); store = new Store(dbPath); app = new Application(store, keys, piFactory(dir.path), () => {}, { dataDir: dir.path });
    detail = await app.call('codingGet', { conversationId: task.conversationId });
    assert.equal(detail.task.pendingInput!.id, pendingId);
    const text = formatQuestionAnswers(fixtureQuestions, { scope: { options: ['minimal'], other: '' }, verification: { options: ['existing'], other: '' } });
    await app.call('codingSend', { conversationId: task.conversationId, text, modelId: model.id, mode: 'agent', requestId: randomUUID() }); await wait();
    detail = await app.call('codingGet', { conversationId: task.conversationId });
    assert.equal(detail.task.state, 'awaiting_review', detail.task.message);
    assert.equal(detail.task.pendingInput, undefined);
    assert.equal(detail.runs.at(-1)!.mode, 'plan', 'An answer cannot bypass plan review by choosing agent mode');
    assert.match(readFileSync(join(root, 'main.mjs'), 'utf8'), /a - b/);

    const execution = await create('修复 add execution-question'); await wait();
    const plan = app.coding.db.plans(execution.id).at(-1)!;
    await app.call('codingApprove', { taskId: execution.id, planId: plan.id, hash: plan.hash, requestId: randomUUID() }); await wait();
    detail = await app.call('codingGet', { conversationId: execution.conversationId });
    assert.equal(detail.task.state, 'awaiting_input', detail.task.message);
    assert.equal(detail.task.pendingInput?.mode, 'execute');
    assert.match(readFileSync(join(root, 'main.mjs'), 'utf8'), /a - b/, 'A write attempted after clarification must be blocked');
    assert.ok(!detail.tools.some(t => t.name === 'edit_file' && t.state === 'completed'));
    await app.call('codingSend', { conversationId: execution.conversationId, text, modelId: model.id, mode: 'agent', requestId: randomUUID() }); await wait();
    detail = await app.call('codingGet', { conversationId: execution.conversationId });
    assert.equal(detail.task.state, 'awaiting_review', detail.task.message);
    assert.equal(detail.plans.length, 2);
    const revised = detail.plans.at(-1)!;
    const runCount = detail.runs.length;
    await app.call('codingApprove', { taskId: execution.id, planId: plan.id, hash: plan.hash, requestId: randomUUID() });
    assert.equal(app.coding.db.runs(execution.id).length, runCount, 'Repeating an already recorded approval cannot resume the paused execution');
    assert.equal(app.coding.db.task(execution.id).state, 'awaiting_review');
    await app.call('codingApprove', { taskId: execution.id, planId: revised.id, hash: revised.hash, requestId: randomUUID() }); await wait();
    assert.match(readFileSync(join(root, 'main.mjs'), 'utf8'), /a \+ b/);
    assert.equal((await app.call('codingGet', { conversationId: execution.conversationId })).verification, 'passed');

    const directRoot = join(dir.path, 'direct'); mkdirSync(directRoot); fixtureProject(directRoot);
    const directProject = await app.call('projectAdd', { path: directRoot, requestId: randomUUID() });
    const direct = await app.call('codingCreate', { mode: 'agent', projectId: directProject.id, requirement: '修复 add early-question', planModelId: model.id, executeModelId: model.id, requestId: randomUUID() }); await wait();
    detail = await app.call('codingGet', { conversationId: direct.conversationId });
    assert.equal(detail.task.pendingInput?.mode, 'agent');
    assert.match(readFileSync(join(directRoot, 'main.mjs'), 'utf8'), /a - b/);
    await app.call('codingSend', { conversationId: direct.conversationId, text, modelId: model.id, mode: 'agent', requestId: randomUUID() }); await wait();
    detail = await app.call('codingGet', { conversationId: direct.conversationId });
    assert.equal(detail.task.state, 'completed', detail.task.message);
    assert.equal(detail.task.pendingInput, undefined);
    assert.equal(detail.plans.length, 0, 'Normal conversations keep their original execution flow');
    assert.equal(detail.verification, 'passed');
    assert.match(readFileSync(join(directRoot, 'main.mjs'), 'utf8'), /a \+ b/);
  } finally { await app.shutdown(); store.close(); await api.close(); dir.cleanup(); }
});
