import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questionItems } from '../apps/desktop/ui/navigation.js';
import type { Conversation, CloudChatConversation } from '../packages/protocol/src/index.js';
test('questions exclude project chats, deduplicate per source and sort by activity', () => {
  const ask: Conversation = { id: 'same', title: 'Local', modelConfigId: 'm', createdAt: 1, updatedAt: 20, kind: 'ask', shared: true };
  const cloud: CloudChatConversation = { id: 'same', title: 'Cloud continuation', modelId: 'm', version: 1, updatedAt: 30, handoff: { fromConversationId: 'same', messageCount: 2 } };
  const rows = questionItems([ask, ask, { ...ask, id: 'project', projectId: 'p', kind: 'coding' }], [cloud, cloud]);
  assert.deepEqual(rows.map(c => `${c.source}:${c.id}`), ['cloud:same', 'local:same']);
  assert.equal(rows[0].title, 'Cloud continuation');
});
