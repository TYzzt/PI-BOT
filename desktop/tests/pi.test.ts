import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { piFactory, isolatedResources } from '../packages/service/src/pi-adapter.js';
import { Application, safeFailure } from '../packages/service/src/application.js';
import { Store } from '../packages/service/src/store.js';
import { endpoint, temp, MemoryCredentials, eventually } from './helpers.js';

test('真实 Pi SDK + 可控端点：隔离、流式定稿、多轮恢复、取消、错误和幂等', { timeout: 90000 }, async () => {
  const dir = temp(), api = await endpoint(), credentials = new MemoryCredentials(); const path = join(dir.path, 'db.sqlite'); let store = new Store(path);
  const events: any[] = []; let app = new Application(store, credentials, piFactory(dir.path), e => events.push(e));
  try {
    const config = await app.call('modelSave', { name: 'fixture', baseUrl: api.url, modelId: 'fixture-model', apiKey: 'fixture-secret', contextWindow: 32768, maxTokens: 512 });
    assert.equal(JSON.stringify(await app.call('snapshot', {})).includes('fixture-secret'), false);
    assert.equal((await app.call('modelTest', { id: config.id })).ok, true);
    const c = await app.call('conversationCreate', { modelConfigId: config.id }); const requestId = randomUUID();
    const run = await app.call('messageSend', { conversationId: c.id, text: '记住蓝鲸', requestId });
    const duplicate = await app.call('messageSend', { conversationId: c.id, text: '记住蓝鲸', requestId }); assert.equal(run.id, duplicate.id);
    await eventually(() => store.run(run.id).state !== 'running'); assert.equal(store.run(run.id).state, 'completed', store.run(run.id).error ?? '');
    assert.equal(store.messages(c.id)[1].content, '好的，我记住了蓝鲸。');
    assert.ok(events.some(e => e.type === 'message.delta')); assert.equal(events.filter(e => e.type === 'run.completed').length, 1);
    assert.ok(store.sessionPath(c.id)); const sessionPath = store.sessionPath(c.id)!; assert.ok(existsSync(sessionPath));
    await app.shutdown(); store.close(); store = new Store(path); app = new Application(store, credentials, piFactory(dir.path), e => events.push(e));
    const next = await app.call('messageSend', { conversationId: c.id, text: '我之前说的是什么？', requestId: randomUUID() }); await eventually(() => store.run(next.id).state !== 'running'); assert.equal(store.run(next.id).state, 'completed'); assert.match(store.messages(c.id).at(-1)!.content, /蓝鲸/);
    const c2 = await app.call('conversationCreate', { modelConfigId: config.id }); const slash = await app.call('messageSend', { conversationId: c2.id, text: '/bash rm test', requestId: randomUUID() }); await eventually(() => store.run(slash.id).state !== 'running'); assert.equal(store.run(slash.id).state, 'completed'); assert.match(JSON.stringify(api.requests.at(-1).messages), /\/bash rm test/);
    for (const request of api.requests) assert.equal(request.tools?.length ?? 0, 0);
    const slow = await app.call('messageSend', { conversationId: c.id, text: '慢慢回复', requestId: randomUUID() }); await eventually(() => store.messages(c.id).at(-1)!.content.length > 1); await app.call('runCancel', { id: slow.id }); await eventually(() => store.run(slow.id).state === 'cancelled'); assert.ok(store.messages(c.id).at(-1)!.content.length > 0);
    await app.call('modelSave', { id: config.id, name: config.name, baseUrl: config.baseUrl, modelId: config.modelId, contextWindow: config.contextWindow, maxTokens: config.maxTokens, apiKey: 'invalid-key' });
    const failed = await app.call('messageSend', { conversationId: c.id, text: 'hello', requestId: randomUUID() }); await eventually(() => store.run(failed.id).state === 'failed'); assert.ok(!store.run(failed.id).error?.includes('invalid-key'));
    assert.ok(!readFileSync(sessionPath, 'utf8').includes('invalid-key'), 'Pi session must redact provider credential echoes');
    const removedPath = store.sessionPath(c2.id)!;
    await app.call('conversationDelete', { id: c2.id }); assert.equal(existsSync(removedPath), false);
    const resources = isolatedResources(); assert.equal(resources.getExtensions().extensions.length, 0); assert.equal(resources.getAgentsFiles().agentsFiles.length, 0); assert.equal(resources.getSkills().skills.length, 0);
    assert.ok(!readFileSync(join(dir.path, 'db.sqlite')).includes(Buffer.from('fixture-secret')));
  } finally { await app.shutdown(); store.close(); await api.close(); dir.cleanup(); }
});


test('Pi model failures stay distinct from local credential errors after sanitizing', () => {
  const message = safeFailure(new Error('模型请求失败，请检查凭据、模型名称、接口兼容性和网络'));
  assert.match(message, /模型请求失败/);
  assert.equal(safeFailure(new Error(message)), message);
  assert.match(safeFailure(new Error('凭据文件不安全')), /无法读取模型凭据/);
});
