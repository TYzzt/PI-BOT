import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../packages/service/src/store.js';
import { Application } from '../packages/service/src/application.js';
import { piFactory } from '../packages/service/src/pi-adapter.js';
import { safePath, capture, projectRoot, workspaceChanges, searchProject, findProjectFiles, readProjectText, windowProjectText } from '../packages/service/src/coding/workspace.js';
import { temp, MemoryCredentials, eventually } from './helpers.js';
import { codingEndpoint, fixtureProject } from './coding-helpers.js';

test('Pi coding: read-only plan, revision, approval, tools, dirty baseline and real commands', { timeout: 90000 }, async () => {
  const dir = temp(), root = join(dir.path, 'project'); mkdirSync(root); fixtureProject(root);
  const api = await codingEndpoint(), store = new Store(join(dir.path, 'app.sqlite')), app = new Application(store, new MemoryCredentials(), piFactory(dir.path), () => {});
  const wait = async (taskId: string) => { await eventually(() => !app.coding.active, 20000); return app.coding.db.task(taskId); };
  try {
    const model = await app.call('modelSave', { name: 'fixture', modelId: 'fixture', baseUrl: api.url, apiKey: 'coding-fixture-secret', contextWindow: 32000, maxTokens: 4096 });
    const project = await app.call('projectAdd', { path: root, requestId: randomUUID() }); assert.equal((await app.call('projectAdd', { path: root, requestId: randomUUID() })).id, project.id);
    const before = await capture(root), request = { projectId: project.id, requirement: '修复 add', planModelId: model.id, executeModelId: model.id, requestId: randomUUID() };
    const task = await app.call('codingCreate', request); assert.equal((await app.call('codingCreate', request)).id, task.id);
    assert.equal((await wait(task.id)).state, 'awaiting_review', app.coding.db.task(task.id).message);
    assert.equal((await capture(root)).fingerprint, before.fingerprint, 'Planning must not change the project');
    let detail = await app.call('codingGet', { conversationId: task.conversationId }); assert.equal(detail.plans.length, 1); assert.ok(detail.tools.some(t => t.name === 'read_file'));
    const first = detail.plans[0];
    await app.call('codingPlan', { taskId: task.id, feedback: '保持改动最小', requestId: randomUUID() }); await wait(task.id);
    detail = await app.call('codingGet', { conversationId: task.conversationId }); assert.equal(detail.plans.length, 2); assert.equal(detail.plans[0].hash, first.hash);
    await assert.rejects(app.call('codingApprove', { taskId: task.id, planId: first.id, hash: first.hash, requestId: randomUUID() }), /不可批准/);
    const plan = detail.plans.at(-1)!; const approve = { taskId: task.id, planId: plan.id, hash: plan.hash, requestId: randomUUID() };
    const run = await app.call('codingApprove', approve); assert.ok(run); assert.equal((await app.call('codingApprove', approve))?.id, run.id);
    assert.equal((await wait(task.id)).state, 'completed', app.coding.db.task(task.id).message);
    assert.equal((await app.call('codingApprove', { ...approve, requestId: randomUUID() }))?.id, run.id);
    assert.match(readFileSync(join(root, 'main.mjs'), 'utf8'), /a \+ b/); assert.equal(readFileSync(join(root, 'notes.txt'), 'utf8'), 'user uncommitted notes\n');
    detail = await app.call('codingGet', { conversationId: task.conversationId }); assert.equal(detail.verification, 'passed'); assert.equal(detail.steps[0].state, 'completed'); assert.ok(detail.runs.every(r => r.sessionPath)); assert.equal(new Set(detail.runs.map(r => r.sessionPath)).size, detail.runs.length);
    const changes = await app.call('codingChanges', { taskId: task.id, view: 'baseline', path: 'main.mjs' }); assert.deepEqual(changes.files.map(f => f.path), ['main.mjs']); assert.match(changes.diff, /\+.*a \+ b/);
    const events = await app.call('codingEvents', { taskId: task.id, after: 0 }); assert.ok(events.length); assert.ok(events.every((e, i) => !i || e.seq! > events[i - 1].seq!));
    for (const req of api.requests.filter(r => r.tools?.some((t: any) => t.function.name === 'update_plan'))) assert.ok(!req.tools.some((t: any) => ['run_command', 'write_file', 'edit_file', 'bash'].includes(t.function.name)));
    await assert.rejects(app.call('messageSend', { conversationId: task.conversationId, text: 'bypass', requestId: randomUUID() }), /规划接口/);
    assert.ok(!JSON.stringify(detail).includes('coding-fixture-secret'));
  } finally { await app.shutdown(); store.close(); await api.close(); dir.cleanup(); }
});

test('stale workspace, ignored read files and model revisions invalidate approval; cancellation stops commands', { timeout: 90000 }, async () => {
  const dir = temp(), root = join(dir.path, 'project'); mkdirSync(root); fixtureProject(root); writeFileSync(join(root, '.gitignore'), 'private.txt\n'); writeFileSync(join(root, 'private.txt'), 'private context');
  const api = await codingEndpoint(), store = new Store(join(dir.path, 'app.sqlite')), app = new Application(store, new MemoryCredentials(), piFactory(dir.path), () => {});
  try {
    const model = await app.call('modelSave', { name: 'fixture', modelId: 'fixture', baseUrl: api.url, apiKey: 'secret', contextWindow: 32000, maxTokens: 4096 });
    const project = await app.call('projectAdd', { path: root, requestId: randomUUID() });
    const task = await app.call('codingCreate', { projectId: project.id, requirement: 'read-ignored slow-command', planModelId: model.id, executeModelId: model.id, requestId: randomUUID() });
    await eventually(() => !app.coding.active, 20000); let plan = app.coding.db.plans(task.id).at(-1)!; assert.ok(plan, app.coding.db.task(task.id).message);
    writeFileSync(join(root, 'private.txt'), 'changed private context');
    assert.equal(await app.call('codingApprove', { taskId: task.id, planId: plan.id, hash: plan.hash, requestId: randomUUID() }), null); assert.equal(app.coding.db.task(task.id).state, 'needs_replan');
    await app.call('codingPlan', { taskId: task.id, feedback: '重新读取工作区', requestId: randomUUID() }); await eventually(() => !app.coding.active, 20000); plan = app.coding.db.plans(task.id).at(-1)!;
    await app.call('modelSave', { id: model.id, name: model.name, baseUrl: model.baseUrl, modelId: model.modelId, contextWindow: model.contextWindow, maxTokens: model.maxTokens, apiKey: 'new-secret' });
    assert.equal(await app.call('codingApprove', { taskId: task.id, planId: plan.id, hash: plan.hash, requestId: randomUUID() }), null);
    await app.call('codingPlan', { taskId: task.id, feedback: '使用当前配置，重新规划', requestId: randomUUID() }); await eventually(() => !app.coding.active, 20000); plan = app.coding.db.plans(task.id).at(-1)!;
    const run = await app.call('codingApprove', { taskId: task.id, planId: plan.id, hash: plan.hash, requestId: randomUUID() }); assert.ok(run);
    await eventually(() => app.coding.db.tools(task.id).some(t => t.name === 'run_command' && t.output.includes('started')), 20000); await app.call('runCancel', { id: run.id }); await eventually(() => !app.coding.active, 15000); assert.equal(app.coding.db.task(task.id).state, 'cancelled');
    const detail = await app.call('codingGet', { conversationId: task.conversationId }); assert.equal(detail.verification, 'cancelled');
  } finally { await app.shutdown(); store.close(); await api.close(); dir.cleanup(); }
});

test('workspace rejects traversal and symlink escapes, accepts unborn Git, rejects ordinary directories', async () => {
  const dir = temp(); const root = join(dir.path, 'repo'); mkdirSync(root); fixtureProject(root);
  try {
    assert.equal(await projectRoot(root), root); await assert.rejects(projectRoot(dir.path), /Git/);
    await assert.rejects(safePath(root, '../outside'), /路径/); symlinkSync(dir.path, join(root, 'escape')); await assert.rejects(safePath(root, 'escape/anything', true), /项目外/);
    const changes = await workspaceChanges(root, 'main.mjs'); assert.ok(changes.files.some(f => f.path === 'main.mjs')); assert.match(changes.warning, /尚无/);
  } finally { dir.cleanup(); }
});

test('unanswered questions block approval and scope expansion closes execution tools', { timeout: 60000 }, async () => {
  const dir = temp(), root = join(dir.path, 'repo'); mkdirSync(root); fixtureProject(root);
  const api = await codingEndpoint(), store = new Store(join(dir.path, 'app.sqlite')), app = new Application(store, new MemoryCredentials(), piFactory(dir.path), () => {});
  try {
    const model = await app.call('modelSave', { name: 'fixture', modelId: 'fixture', baseUrl: api.url, apiKey: 'test-key', contextWindow: 32000, maxTokens: 4096 });
    const project = await app.call('projectAdd', { path: root, requestId: randomUUID() });
    const a = await app.call('codingCreate', { projectId: project.id, requirement: 'need-question', planModelId: model.id, executeModelId: model.id, requestId: randomUUID() }); await eventually(() => !app.coding.active, 20000);
    assert.equal(app.coding.db.task(a.id).state, 'awaiting_input'); const questionPlan = app.coding.db.plans(a.id)[0];
    await assert.rejects(app.call('codingApprove', { taskId: a.id, planId: questionPlan.id, hash: questionPlan.hash, requestId: randomUUID() }), /不可批准/);
    const b = await app.call('codingCreate', { projectId: project.id, requirement: 'scope-expansion', planModelId: model.id, executeModelId: model.id, requestId: randomUUID() }); await eventually(() => !app.coding.active, 20000);
    const before = await capture(root), plan = app.coding.db.plans(b.id)[0]; await app.call('codingApprove', { taskId: b.id, planId: plan.id, hash: plan.hash, requestId: randomUUID() }); await eventually(() => !app.coding.active, 20000);
    assert.equal(app.coding.db.task(b.id).state, 'needs_replan'); assert.equal(app.coding.db.plans(b.id).length, 2); assert.equal((await capture(root)).fingerprint, before.fingerprint);
    assert.equal((await app.call('codingGet', { conversationId: b.conversationId })).verification, 'not_run');
  } finally { await app.shutdown(); store.close(); await api.close(); dir.cleanup(); }
});

test('read-only code chat answers directly, retains history across restart and requires explicit planning for edits', { timeout: 60000 }, async () => {
  const dir = temp(), root = join(dir.path, 'repo'); mkdirSync(root); fixtureProject(root);
  const api = await codingEndpoint(), path = join(dir.path, 'app.sqlite'), credentials = new MemoryCredentials(); let store = new Store(path), app = new Application(store, credentials, piFactory(dir.path), () => {});
  try {
    const model = await app.call('modelSave', { name: 'fixture', modelId: 'fixture', baseUrl: api.url, apiKey: 'read-test-key', contextWindow: 32000, maxTokens: 4096 });
    const project = await app.call('projectAdd', { path: root, requestId: randomUUID() }), before = await capture(root);
    const task = await app.call('codingCreate', { intent: 'read', projectId: project.id, requirement: '解释 add 的代码，即使我提到修改也不实际改动', planModelId: model.id, executeModelId: model.id, requestId: randomUUID() }); await eventually(() => !app.coding.active, 20000);
    let detail = await app.call('codingGet', { conversationId: task.conversationId }); assert.equal(detail.task.state, 'completed', detail.task.message); assert.equal(detail.plans.length, 0); assert.equal(detail.task.intent, 'read'); assert.match(detail.messages.at(-1)!.content, /差值/); const session = detail.runs[0].sessionPath;
    await app.shutdown(); store.close(); store = new Store(path); app = new Application(store, credentials, piFactory(dir.path), () => {});
    const input = { taskId: task.id, text: '继续解释刚才的原因', requestId: randomUUID() }; const run = await app.call('codingRead', input); assert.equal((await app.call('codingRead', input)).id, run.id); await eventually(() => !app.coding.active, 20000);
    detail = await app.call('codingGet', { conversationId: task.conversationId }); assert.equal(detail.messages.length, 4); assert.match(detail.messages.at(-1)!.content, /上次/); assert.equal(detail.runs[1].sessionPath, session); assert.equal(detail.plans.length, 0); assert.equal((await capture(root)).fingerprint, before.fingerprint);
    for (const req of api.requests) assert.deepEqual(req.tools.map((t: any) => t.function.name).sort(), ['find_files', 'git_status', 'list_files', 'read_file', 'search_files']);
    await app.call('codingPlan', { taskId: task.id, feedback: '现在帮我生成修改计划', requestId: randomUUID() }); await eventually(() => !app.coding.active, 20000);
    detail = await app.call('codingGet', { conversationId: task.conversationId }); assert.equal(detail.task.intent, 'code'); assert.equal(detail.task.state, 'awaiting_review'); assert.equal(detail.plans.length, 1); assert.equal((await capture(root)).fingerprint, before.fingerprint);
    await app.call('codingRead', { taskId: task.id, text: '先解释这个修改为何有效', requestId: randomUUID() }); await eventually(() => !app.coding.active, 20000); assert.equal(app.coding.db.task(task.id).state, 'awaiting_review');
  } finally { await app.shutdown(); store.close(); await api.close(); dir.cleanup(); }
});

test('project search uses one git query and long files stay windowed', async () => {
  const dir = temp(), root = join(dir.path, 'repo'); mkdirSync(root); fixtureProject(root);
  try {
    writeFileSync(join(root, '.gitignore'), 'secret.txt\n');
    writeFileSync(join(root, 'secret.txt'), 'hidden-token-should-not-appear\n');
    writeFileSync(join(root, 'long.txt'), Array.from({ length: 500 }, (_, index) => `line-${index + 1}`).join('\n') + '\n');
    const hit = await searchProject(root, 'a - b');
    assert.equal(hit.truncated, false);
    assert.ok(hit.matches.some(match => match.path === 'main.mjs' && match.line === 1 && match.text.includes('a - b')));
    assert.deepEqual((await searchProject(root, 'hidden-token-should-not-appear')).matches, []);
    assert.deepEqual((await searchProject(root, 'no-such-token-xyz')).matches, []);
    assert.deepEqual((await searchProject(root, 'a - b', 'notes.txt')).matches, []);
    await assert.rejects(searchProject(root, 'a - b', '../outside'), /路径/);
    const names = await findProjectFiles(root, 'main.mjs');
    assert.ok(names.matches.includes('main.mjs'));
    assert.equal(names.matches.includes('secret.txt'), false);
    const full = await readProjectText(root, 'long.txt');
    assert.equal(full.text.split('\n').filter(Boolean).length, 500);
    const windowed = windowProjectText(full.path, full.text);
    assert.equal(windowed.startLine, 1);
    assert.equal(windowed.totalLines, 500);
    assert.equal(windowed.truncated, true);
    assert.match(windowed.text, /^1\|line-1/);
    assert.equal(windowed.text.includes('line-401'), false);
    assert.match(windowed.note ?? '', /startLine/);
    const page = windowProjectText(full.path, full.text, 401, 50);
    assert.match(page.text, /^401\|line-401/);
    assert.equal(page.truncated, true);
  } finally { dir.cleanup(); }
});
