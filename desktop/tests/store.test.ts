import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Store } from '../packages/service/src/store.js';
import { temp } from './helpers.js';

test('持久化、会话隔离、幂等校验和中断恢复', () => {
  const dir = temp(); const path = join(dir.path, 'test.sqlite'); let store = new Store(path);
  try {
    const id = randomUUID(); store.putModel({ id, name: 'test', baseUrl: 'https://example.com/v1', modelId: 'test', contextWindow: 32000, maxTokens: 512, isDefault: true, hasKey: true });
    const a = store.createConversation(id), b = store.createConversation(id), request = randomUUID(); const started = store.start(a.id, 'hello', request);
    store.updateMessage(started.assistantId, 'partial', 'running');
    assert.equal(store.messages(a.id).length, 2); assert.equal(store.messages(b.id).length, 0);
    assert.equal(store.existing(request, a.id, 'hello')?.id, started.run.id);
    assert.throws(() => store.existing(request, a.id, 'other'), /不一致/);
    assert.throws(() => store.deleteModel(id), /替代/);
    store.close(); store = new Store(path);
    assert.equal(store.run(started.run.id).state, 'interrupted'); assert.equal(store.messages(a.id)[1].content, 'partial'); assert.equal(store.messages(a.id)[1].status, 'interrupted');
    store.deleteConversation(a.id); assert.equal(store.messages(a.id).length, 0);
  } finally { store.close(); dir.cleanup(); }
});

test('删除模型时显式迁移会话，默认模型始终有效', () => {
  const store = new Store(':memory:');
  try { const a = randomUUID(), b = randomUUID(); for (const id of [a, b]) store.putModel({ id, name: id, baseUrl: 'https://example.com', modelId: 'x', contextWindow: 32000, maxTokens: 512, isDefault: id === a, hasKey: true });
    const c = store.createConversation(a); store.deleteModel(a, b); assert.equal(store.conversation(c.id).modelConfigId, b); assert.equal(store.model(b).isDefault, true);
  } finally { store.close(); }
});
