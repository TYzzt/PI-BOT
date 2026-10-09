import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../packages/service/src/store.js';
import { Application } from '../packages/service/src/application.js';
import type { AgentFactory } from '../packages/service/src/pi-adapter.js';
import { temp, MemoryCredentials, eventually } from './helpers.js';
import { fixtureProject } from './coding-helpers.js';

test('review follows actual mutations, invalidates stale checks and preserves failures', async () => {
  const dir = temp(), root = join(dir.path, 'repo'); mkdirSync(root); fixtureProject(root);
  const store = new Store(join(dir.path, 'app.sqlite'));
  const factory: AgentFactory = async (_model, _key, _session, _id, _ephemeral, options) => ({
    tools: options!.tools.map(t => t.name), abort: async () => {}, dispose: () => {},
    prompt: async (text, onText) => {
      const message = JSON.parse(text).message;
      const tool = async (name: string, args: unknown) => options!.tools.find(t => t.name === name)!.execute(randomUUID(), args as never, undefined, undefined, undefined as never);
      const edit = async (oldText: string, newText: string) => { await tool('read_file', { path: 'main.mjs' }); await tool('edit_file', { path: 'main.mjs', oldText, newText }); };
      if (message === 'repair') { await edit('a - b', 'a + b'); await tool('run_command', { command: 'node test.mjs', verification: true }); }
      if (message === 'check-only') await tool('run_command', { command: 'git status --short', verification: false });
      if (message === 'verify-then-edit') { await tool('run_command', { command: 'node test.mjs', verification: true }); await edit('a + b', 'a - b'); }
      if (message === 'failed-check') await tool('run_command', { command: 'node test.mjs', verification: true });
      if (message === 'mutating-command') await tool('run_command', { command: "printf '// changed by command\\n' >> main.mjs", verification: false });
      if (message === 'check-that-mutates') await tool('run_command', { command: "printf '// changed during check\\n' >> main.mjs", verification: true });
      onText('运行结束。');
    },
  });
  const app = new Application(store, new MemoryCredentials(), factory, () => {}, { dataDir: dir.path });
  try {
    const model = await app.call('modelSave', { name: 'scripted', modelId: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'secret', contextWindow: 32000, maxTokens: 4096 });
    const project = await app.call('projectAdd', { path: root, requestId: randomUUID() });
    const task = await app.call('codingCreate', { mode: 'agent', projectId: project.id, requirement: 'repair', planModelId: model.id, executeModelId: model.id, requestId: randomUUID() });
    const wait = () => eventually(() => !app.coding.active);
    await wait();
    const get = () => app.call('codingGet', { conversationId: task.conversationId });
    const send = async (text: string) => { const run = await app.call('codingSend', { conversationId: task.conversationId, text, modelId: model.id, requestId: randomUUID() }); await wait(); return run; };
    const changes = () => app.call('codingChanges', { taskId: task.id, view: 'baseline', path: 'main.mjs' });
    let detail = await get(); assert.equal(detail.verification, 'passed'); assert.equal(detail.verificationFreshness, 'current');
    const originalDiff = (await changes()).diff;
    const check = await send('check-only');
    assert.equal(app.coding.db.hasBaseline(check.id), false);
    assert.equal((await changes()).diff, originalDiff);
    assert.equal((await get()).verification, 'passed');
    await send('verify-then-edit'); detail = await get();
    assert.equal(detail.verification, 'not_run'); assert.equal(detail.verificationFreshness, 'stale'); assert.match(detail.task.message, /修改后未验证/);
    await send('failed-check'); detail = await get();
    assert.equal(detail.verification, 'failed'); assert.match(detail.task.message, /验证未通过/);
    const mutation = await send('mutating-command'); assert.equal(app.coding.db.hasBaseline(mutation.id), true); assert.equal((await get()).hasChanges, true); assert.match((await changes()).diff, /changed by command/);
    await send('check-that-mutates'); detail = await get();
    assert.equal(detail.verification, 'not_run'); assert.equal(detail.verificationFreshness, 'stale');
    await send('repair'); detail = await get(); assert.equal(detail.verification, 'passed');
    writeFileSync(join(root, 'main.mjs'), 'external change\n');
    detail = await get(); assert.equal(detail.verificationFreshness, 'stale');
    const latest = app.coding.db.verificationTools(detail.runs.at(-1)!.run.id)[0];
    const { verificationFingerprint, verificationChanged, ...legacy } = latest;
    app.coding.db.putTool(legacy); detail = await get();
    assert.equal(detail.verification, 'not_run'); assert.equal(detail.verificationFreshness, 'historical');
    // Cursor pagination remains stable when new activity arrives between requests.
    const base = app.coding.db.tools(task.id).at(-1)!;
    const ids = Array.from({ length: 180 }, () => randomUUID());
    for (const id of ids) app.coding.db.putTool({ ...base, id, name: 'git_status', verification: false });
    const first = await app.call('codingLogs', { taskId: task.id, offset: 0 });
    app.coding.db.putTool({ ...base, id: randomUUID(), verification: false });
    const second = await app.call('codingLogs', { taskId: task.id, offset: 0, beforeId: first.at(-1)!.id });
    assert.equal(second.length, 25); assert.equal(second[0].id, ids[154]);
    assert.equal(second.some(t => first.some(f => f.id === t.id)), false);
    assert.ok((await get()).toolCount! > 180);
  } finally { await app.shutdown(); store.close(); dir.cleanup(); }
});
