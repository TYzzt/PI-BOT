import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CloudChat } from '../packages/service/src/cloud/chat.js';
import { CloudHttpError, CloudNetworkError } from '../packages/service/src/cloud/client.js';
import { Application } from '../packages/service/src/application.js';
import { Store } from '../packages/service/src/store.js';
import { piFactory } from '../packages/service/src/pi-adapter.js';
import { MemoryCredentials, temp } from './helpers.js';

const conversation = { id: randomUUID(), device_id: null, version: 1, title: '云端', kind: 'ask', target: 'cloud', model_config_id: randomUUID(), handoff: { from_conversation_id: randomUUID(), message_count: 2 } };
function host(routes: Record<string, (body?: any) => unknown>, paired = true) {
  const calls: { method: string; path: string; body?: any }[] = [];
  return { calls, paired: () => paired, async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    calls.push({ method, path, body }); const route = routes[`${method} ${path}`]; if (!route) throw new CloudHttpError(404, '记录不存在'); return await route(body) as T;
  } };
}

test('cloud chat maps server documents and pages messages', async () => {
  const handoffRun = randomUUID(), runId = randomUUID();
  const message = (sequence: number, run: string, role = 'user', status = 'completed') => ({ id: randomUUID(), device_id: null, version: 1, conversation_id: conversation.id, run_id: run, role, content: `m${sequence}`, status, sequence });
  const h = host({
    'GET /device/cloud/conversations': () => [conversation],
    [`GET /device/cloud/conversations/${conversation.id}/messages?after=0&limit=500`]: () => ({ messages: [message(1, handoffRun), message(2, handoffRun, 'assistant')], pending_messages: [], next_cursor: 2, has_more: true }),
    [`GET /device/cloud/conversations/${conversation.id}/messages?after=2&limit=500`]: () => ({ messages: [message(3, runId), message(4, runId, 'assistant', 'running')], pending_messages: [], next_cursor: 4, has_more: false }),
    [`GET /device/cloud/chat-runs/${runId}`]: () => ({ id: runId, conversation_id: conversation.id, state: 'running', cancel_requested: false, error: null }),
  });
  const detail = await new CloudChat(h).dispatch('cloudChatGet', { id: conversation.id });
  assert.deepEqual(detail.conversation, { id: conversation.id, version: 1, title: '云端', modelId: conversation.model_config_id, handoff: { fromConversationId: conversation.handoff.from_conversation_id, messageCount: 2 } });
  assert.deepEqual(detail.messages.map(m => [m.sequence, m.role, m.status]), [[1, 'user', 'completed'], [2, 'assistant', 'completed'], [3, 'user', 'completed'], [4, 'assistant', 'running']]);
  assert.deepEqual(detail.run, { id: runId, conversationId: conversation.id, state: 'running', cancelRequested: false, error: null });

  // A conversation holding only handed-off history has no run record.
  const only = host({
    'GET /device/cloud/conversations': () => [conversation],
    [`GET /device/cloud/conversations/${conversation.id}/messages?after=0&limit=500`]: () => ({ messages: [message(1, handoffRun)], pending_messages: [], next_cursor: 1, has_more: false }),
  });
  assert.equal((await new CloudChat(only).dispatch('cloudChatGet', { id: conversation.id })).run, null);
});

test('cloud chat sends the documented request bodies', async () => {
  const model = { id: randomUUID(), device_id: null, version: 1, config: { name: 'm', base_url: 'https://x/v1', model_id: 'gpt', context_window: 32000, max_tokens: 1000, is_default: true }, has_key: true, deleted: false, source_model_id: randomUUID() };
  const run = { id: randomUUID(), conversation_id: conversation.id, state: 'queued', cancel_requested: false };
  const id = randomUUID(), source = randomUUID(), requestId = randomUUID();
  const h = host({
    'GET /device/cloud/models': () => [model, { ...model, id: randomUUID(), deleted: true }],
    'POST /device/cloud/models/from-mac': () => model,
    [`PUT /device/cloud/conversations/${id}`]: () => ({ ...conversation, id, handoff: null }),
    [`POST /device/cloud/conversations/${id}/handoff-from/${source}`]: () => ({ ...conversation, id }),
    [`POST /device/cloud/conversations/${conversation.id}/messages`]: () => run,
    [`POST /device/cloud/chat-runs/${run.id}/cancel`]: () => ({ ...run, cancel_requested: true }),
  });
  const chat = new CloudChat(h);
  assert.deepEqual(await chat.dispatch('cloudModelList', {}), [{ id: model.id, version: 1, name: 'm', modelId: 'gpt', isDefault: true, sourceModelId: model.source_model_id }]);
  await chat.dispatch('cloudModelFromLocal', { modelId: source, requestId });
  assert.equal((await chat.dispatch('cloudChatCreate', { id, modelId: model.id, title: '云端问答' })).handoff, null);
  await chat.dispatch('cloudChatHandoff', { id, conversationId: source, modelId: model.id, requestId });
  assert.equal((await chat.dispatch('cloudChatSend', { conversationId: conversation.id, text: '你好', requestId })).state, 'queued');
  assert.equal((await chat.dispatch('cloudChatCancel', { runId: run.id })).cancelRequested, true);
  assert.deepEqual(h.calls.find(c => c.path === '/device/cloud/models/from-mac')!.body, { request_id: requestId, model_id: source });
  assert.deepEqual(h.calls.find(c => c.method === 'PUT')!.body, { expected_version: 0, request_id: id, title: '云端问答', model_config_id: model.id });
  assert.deepEqual(h.calls.find(c => c.path.includes('handoff-from'))!.body, { request_id: requestId, model_config_id: model.id });
  assert.deepEqual(h.calls.find(c => c.path.endsWith('/messages'))!.body, { text: '你好', request_id: requestId });
  assert.ok(!JSON.stringify(h.calls).includes('api_key'));
});

test('cloud chat explains unpaired, offline and not-yet-synced states', async () => {
  await assert.rejects(new CloudChat(host({}, false)).dispatch('cloudChatList', {}), /先在「模型设置」中配对云端/);
  const offline = { paired: () => true, request: async () => { throw new CloudNetworkError('无法连接云端服务器'); } };
  await assert.rejects(new CloudChat(offline).dispatch('cloudChatList', {}), /云端离线/);
  await assert.rejects(new CloudChat(host({})).dispatch('cloudModelFromLocal', { modelId: randomUUID(), requestId: randomUUID() }), /还没有同步到云端/);
  await assert.rejects(new CloudChat(host({})).dispatch('cloudChatHandoff', { id: randomUUID(), conversationId: randomUUID(), modelId: randomUUID(), requestId: randomUUID() }), /原会话还没有同步到云端/);
});

test('application routes cloud chat outside the local run queue and validates input', async () => {
  const dir = temp(), store = new Store(join(dir.path, 'app.sqlite'));
  const app = new Application(store, new MemoryCredentials(), piFactory(dir.path), () => {});
  try {
    await assert.rejects(app.call('cloudChatList', {}), /配对云端/);
    await assert.rejects(async () => app.call('cloudChatSend', { conversationId: 'not-a-uuid', text: 'x', requestId: randomUUID() } as any), /Invalid UUID/);
    // Local cloud conversations are never written to SQLite.
    assert.equal((await app.call('snapshot', {})).conversations.length, 0);
  } finally { await app.shutdown(); store.close(); dir.cleanup(); }
});
