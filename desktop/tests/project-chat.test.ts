import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../packages/service/src/store.js';
import { Application } from '../packages/service/src/application.js';
import { piFactory } from '../packages/service/src/pi-adapter.js';
import { capture } from '../packages/service/src/coding/workspace.js';
import { temp, MemoryCredentials, eventually } from './helpers.js';
import { codingEndpoint, fixtureProject } from './coding-helpers.js';

test('unified project chat preserves context through edits, model switches, restart and repeated requests', { timeout: 90000 }, async () => {
  const dir = temp(), root = join(dir.path, 'repo'), path = join(dir.path, 'app.sqlite');
  mkdirSync(root); fixtureProject(root);
  const api = await codingEndpoint(), keys = new MemoryCredentials();
  let store = new Store(path), app = new Application(store, keys, piFactory(dir.path), () => {}, { dataDir: dir.path });
  const wait = () => eventually(() => !app.coding.active, 20000);
  try {
    const model = await app.call('modelSave', { name: 'chat', modelId: 'fixture', baseUrl: api.url, apiKey: 'secret', contextWindow: 64000, maxTokens: 4096 });
    const project = await app.call('projectAdd', { path: root, requestId: randomUUID() }), before = await capture(root);
    const create = { mode: 'agent' as const, projectId: project.id, requirement: '解释 add 的行为', planModelId: model.id, executeModelId: model.id, requestId: randomUUID() };
    const task = await app.call('codingCreate', create);
    assert.equal((await app.call('codingCreate', create)).id, task.id);
    await wait();
    let detail = await app.call('codingGet', { conversationId: task.conversationId });
    assert.equal(detail.task.state, 'completed', detail.task.message);
    assert.match(detail.summary, /差值/);
    assert.equal((await capture(root)).fingerprint, before.fingerprint);
    assert.equal(detail.plans.length, 0);
    const firstSession = detail.runs[0].sessionPath;

    const send = { conversationId: task.conversationId, text: '修复 add，保留笔记', modelId: model.id, requestId: randomUUID() };
    const run = await app.call('codingSend', send);
    assert.equal((await app.call('codingSend', send)).id, run.id);
    await assert.rejects(app.call('codingSend', { ...send, text: '不同消息' }), /幂等/);
    await wait();
    detail = await app.call('codingGet', { conversationId: task.conversationId });
    assert.equal(detail.task.state, 'completed', detail.task.message);
    assert.match(readFileSync(join(root, 'main.mjs'), 'utf8'), /a \+ b/);
    assert.equal(readFileSync(join(root, 'notes.txt'), 'utf8'), 'user uncommitted notes\n');
    assert.equal(detail.verification, 'passed');
    assert.equal(detail.plans.length, 0);
    assert.equal(detail.runs[1].sessionPath, firstSession);
    assert.ok(detail.runs.every(r => r.planId === null && r.mode === 'agent'));
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM approvals').get() as { n: number }).n, 0);
    const diff = await app.call('codingChanges', { taskId: task.id, view: 'baseline', path: 'main.mjs' });
    assert.deepEqual(diff.files.map(f => f.path), ['main.mjs']);
    assert.match(diff.diff, /\+.*a \+ b/);

    await app.shutdown(); store.close(); store = new Store(path); app = new Application(store, keys, piFactory(dir.path), () => {}, { dataDir: dir.path });
    await app.call('codingSend', { ...send, text: '解释刚才为什么这样修改', requestId: randomUUID() }); await wait();
    detail = await app.call('codingGet', { conversationId: task.conversationId });
    assert.equal(detail.runs.at(-1)!.sessionPath, firstSession);
    assert.equal(detail.messages.length, 6);
    assert.equal(detail.verification, 'passed'); // Pure follow-ups retain the last execution's review data.
    assert.match((await app.call('codingChanges', { taskId: task.id, view: 'baseline', path: 'main.mjs' })).diff, /\+.*a \+ b/);

    const other = await app.call('modelSave', { name: 'other', modelId: 'fixture-other', baseUrl: api.url, apiKey: 'other-secret', contextWindow: 64000, maxTokens: 4096 });
    const offset = api.requests.length;
    await app.call('codingSend', { ...send, text: '添加注释', modelId: other.id, requestId: randomUUID() }); await wait();
    detail = await app.call('codingGet', { conversationId: task.conversationId });
    assert.equal(detail.task.state, 'completed', detail.task.message);
    assert.equal(detail.task.planModelId, other.id); assert.equal(detail.task.executeModelId, other.id);
    assert.equal(store.conversation(task.conversationId).modelConfigId, other.id);
    assert.notEqual(detail.runs.at(-1)!.sessionPath, firstSession);
    assert.match(readFileSync(join(root, 'main.mjs'), 'utf8'), /Adds two numbers/);
    assert.equal(detail.verification, 'passed');
    const switched = api.requests[offset];
    assert.equal(switched.model, 'fixture-other');
    for (const text of ['解释 add 的行为', '修复 add，保留笔记', '解释刚才为什么这样修改']) assert.ok(JSON.stringify(switched.messages).includes(text));
    assert.match(JSON.stringify(switched.messages[0]), /提问、解释或分析请求直接回答，不修改文件/);
  } finally { await app.shutdown(); store.close(); await api.close(); dir.cleanup(); }
});

test('legacy conversations support normal chat; explicit plans and remote permissions stay isolated', { timeout: 90000 }, async () => {
  const dir = temp(), root = join(dir.path, 'repo'); mkdirSync(root); fixtureProject(root);
  const api = await codingEndpoint(), store = new Store(join(dir.path, 'app.sqlite')), keys = new MemoryCredentials();
  const app = new Application(store, keys, piFactory(dir.path), () => {}, { dataDir: dir.path });
  const wait = () => eventually(() => !app.coding.active, 20000);
  try {
    const model = await app.call('modelSave', { name: 'chat', modelId: 'fixture', baseUrl: api.url, apiKey: 'secret', contextWindow: 64000, maxTokens: 4096 });
    const project = await app.call('projectAdd', { path: root, requestId: randomUUID() });
    const task = await app.call('codingCreate', { intent: 'read', projectId: project.id, requirement: '解释 add', planModelId: model.id, executeModelId: model.id, requestId: randomUUID() }); await wait();
    const input = { conversationId: task.conversationId, text: '修复 add', modelId: model.id, requestId: randomUUID() };
    const before = await capture(root);
    await app.call('codingSend', { ...input, mode: 'plan' }); await wait();
    let detail = await app.call('codingGet', { conversationId: task.conversationId });
    assert.equal(detail.task.state, 'awaiting_review', detail.task.message);
    assert.equal((await capture(root)).fingerprint, before.fingerprint);
    const planning = api.requests.filter(r => r.tools.some((t: any) => t.function.name === 'update_plan'));
    assert.ok(planning.length);
    assert.ok(planning.every(r => !r.tools.some((t: any) => ['edit_file', 'write_file', 'run_command', 'browser_open'].includes(t.function.name))));
    const plan = detail.plans[0];
    await app.call('codingApprove', { taskId: task.id, planId: plan.id, hash: plan.hash, requestId: randomUUID() }); await wait();
    assert.match(readFileSync(join(root, 'main.mjs'), 'utf8'), /a \+ b/);
    await app.call('codingSend', { ...input, text: '添加注释', requestId: randomUUID() }); await wait();
    detail = await app.call('codingGet', { conversationId: task.conversationId });
    assert.equal(detail.task.state, 'completed', detail.task.message);
    assert.equal(detail.plans.length, 1);
    assert.match(readFileSync(join(root, 'main.mjs'), 'utf8'), /Adds two numbers/);

    const remoteBefore = await capture(root), offset = api.requests.length;
    await app.call('codingRead', { taskId: task.id, text: '修复 add', requestId: randomUUID() }); await wait();
    assert.equal((await capture(root)).fingerprint, remoteBefore.fingerprint);
    assert.ok(api.requests.slice(offset).every(r => !r.tools.some((t: any) => ['edit_file', 'write_file', 'run_command'].includes(t.function.name))));
    app.coding.cloudOwned = id => id === task.id;
    const count = store.messages(task.conversationId).length;
    await assert.rejects(app.call('codingSend', { ...input, requestId: randomUUID() }), /云端任务/);
    await assert.rejects(app.call('codingSend', { ...input, mode: 'plan', requestId: randomUUID() }), /云端任务/);
    assert.equal(store.messages(task.conversationId).length, count);
  } finally { await app.shutdown(); store.close(); await api.close(); dir.cleanup(); }
});

test('direct runs preserve edits on cancellation and can continue after failure', { timeout: 60000 }, async () => {
  const dir = temp(), root = join(dir.path, 'repo'); mkdirSync(root); fixtureProject(root);
  const api = await codingEndpoint(), store = new Store(join(dir.path, 'app.sqlite')), keys = new MemoryCredentials();
  const app = new Application(store, keys, piFactory(dir.path), () => {}, { dataDir: dir.path });
  const wait = () => eventually(() => !app.coding.active, 20000);
  try {
    const model = await app.call('modelSave', { name: 'chat', modelId: 'fixture', baseUrl: api.url, apiKey: 'secret', contextWindow: 64000, maxTokens: 4096 });
    const project = await app.call('projectAdd', { path: root, requestId: randomUUID() });
    const task = await app.call('codingCreate', { intent: 'read', projectId: project.id, requirement: '解释 add', planModelId: model.id, executeModelId: model.id, requestId: randomUUID() }); await wait();
    const run = await app.call('codingSend', { conversationId: task.conversationId, text: '修复 add slow-command', modelId: model.id, requestId: randomUUID() });
    await eventually(() => app.coding.db.tools(task.id).some(t => t.name === 'run_command' && t.output.includes('started')), 20000);
    await app.call('runCancel', { id: run.id }); await wait();
    assert.equal(app.coding.db.task(task.id).state, 'cancelled');
    assert.match(readFileSync(join(root, 'main.mjs'), 'utf8'), /a \+ b/);
    assert.equal((await app.call('codingGet', { conversationId: task.conversationId })).verification, 'cancelled');
    await keys.delete(model.id);
    const input = { conversationId: task.conversationId, text: '继续解释当前状态', modelId: model.id, requestId: randomUUID() };
    await app.call('codingSend', input); await wait();
    assert.equal(app.coding.db.task(task.id).state, 'failed');
    await keys.set(model.id, 'secret');
    await app.call('codingSend', { ...input, text: '添加注释', requestId: randomUUID() }); await wait();
    const detail = await app.call('codingGet', { conversationId: task.conversationId });
    assert.equal(detail.task.state, 'completed', detail.task.message);
    assert.equal(detail.verification, 'passed');
    assert.deepEqual(detail.runs.map(r => r.run.state), ['completed', 'cancelled', 'failed', 'completed']);
    assert.match(readFileSync(join(root, 'main.mjs'), 'utf8'), /Adds two numbers/);
    assert.equal(readFileSync(join(root, 'notes.txt'), 'utf8'), 'user uncommitted notes\n');
  } finally { await app.shutdown(); store.close(); await api.close(); dir.cleanup(); }
});
