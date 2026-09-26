import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Application } from '../packages/service/src/application.js';
import { Store } from '../packages/service/src/store.js';
import { piFactory } from '../packages/service/src/pi-adapter.js';
import { MemoryCredentials, temp, endpoint, eventually } from './helpers.js';

// Run through server/scripts/check_shared.py with T_AGNET_TEST_FILE=tests/cloud-chat-e2e.test.ts; it also starts a worker.
const url = process.env.T_AGNET_CLOUD_URL, password = process.env.T_AGNET_CLOUD_PASSWORD, worker = process.env.T_AGNET_CLOUD_WORKER === '1';
test('Mac copies a model to the cloud, asks the worker and hands off a shared conversation', { skip: !url || !worker, timeout: 180000 }, async () => {
  const dir = temp(), api = await endpoint(), keys = new MemoryCredentials();
  const store = new Store(join(dir.path, 'app.sqlite')), app = new Application(store, keys, piFactory(dir.path), () => {}, { credentials: new MemoryCredentials() });
  try {
    const model = await app.call('modelSave', { name: 'cloud fixture', baseUrl: api.url, modelId: 'fixture', apiKey: 'cloud-e2e-key', contextWindow: 32000, maxTokens: 4096 });
    const local = await app.call('conversationCreate', { modelConfigId: model.id });
    await app.call('messageSend', { conversationId: local.id, text: '记住蓝鲸', requestId: randomUUID() });
    await eventually(async () => !(await app.call('snapshot', {})).activeRun);
    await app.call('cloudPair', { serverUrl: url!, label: 'Cloud chat Mac', password: password! });

    const copy = randomUUID();
    const cloudModel = await (async () => { for (let i = 0; ; i++) { try { return await app.call('cloudModelFromLocal', { modelId: model.id, requestId: copy }); } catch (e) { if (i > 80) throw e; await new Promise(r => setTimeout(r, 250)); } } })();
    assert.equal(cloudModel.sourceModelId, model.id);
    assert.deepEqual((await app.call('cloudModelList', {})).map(m => m.id), [cloudModel.id]);

    const conversation = await app.call('cloudChatCreate', { id: randomUUID(), modelId: cloudModel.id, title: '云端问答' });
    const run = await app.call('cloudChatSend', { conversationId: conversation.id, text: '你好', requestId: randomUUID() });
    await eventually(async () => (await app.call('cloudChatGet', { id: conversation.id })).run?.state === 'completed', 30000);
    let detail = await app.call('cloudChatGet', { id: conversation.id });
    assert.equal(detail.run?.id, run.id);
    assert.deepEqual(detail.messages.map(m => [m.role, m.content]), [['user', '你好'], ['assistant', '这是测试端点的回复。']]);
    assert.equal((await app.call('snapshot', {})).conversations.some(c => c.id === conversation.id), false);

    const slow = await app.call('cloudChatSend', { conversationId: conversation.id, text: '慢慢回答', requestId: randomUUID() });
    await eventually(async () => (await app.call('cloudChatGet', { id: conversation.id })).messages.some(m => m.runId === slow.id && m.role === 'assistant' && m.status === 'running' && m.content.length > 0), 30000);
    await app.call('cloudChatCancel', { runId: slow.id });
    await eventually(async () => (await app.call('cloudChatGet', { id: conversation.id })).run?.state === 'cancelled', 30000);

    await app.call('sharedConversation', { ids: [local.id], shared: true });
    await eventually(async () => !!(await app.call('sharedStatus', {})).conversations.find(c => c.id === local.id)?.syncedAt, 30000);
    const handed = await app.call('cloudChatHandoff', { id: randomUUID(), conversationId: local.id, modelId: cloudModel.id, requestId: randomUUID() });
    assert.deepEqual(handed.handoff, { fromConversationId: local.id, messageCount: 2 });
    await app.call('cloudChatSend', { conversationId: handed.id, text: '我之前说的是什么？', requestId: randomUUID() });
    await eventually(async () => (await app.call('cloudChatGet', { id: handed.id })).run?.state === 'completed', 30000);
    detail = await app.call('cloudChatGet', { id: handed.id });
    assert.match(detail.messages.at(-1)!.content, /蓝鲸/);
    assert.equal((await app.call('conversationGet', { id: local.id })).messages.length, 2);
    assert.ok(!JSON.stringify(api.requests.map(r => r.messages)).includes('cloud-e2e-key'));
  } finally { await app.shutdown(); store.close(); await api.close(); dir.cleanup(); }
});
