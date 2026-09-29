import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { PiAgent } from '../packages/service/src/pi-adapter.js';

test('Pi adapter waits beyond intermediate turn end and emits authoritative text', async () => {
  let listener: (event: AgentSessionEvent) => void = () => {};
  let finish!: () => void;
  const final = new Promise<void>(resolve => { finish = resolve; });
  const fake = {
    getActiveToolNames: () => [],
    subscribe: (callback: typeof listener) => { listener = callback; return () => {}; },
    prompt: async () => { await final; listener({ type: 'agent_settled' } as AgentSessionEvent); },
    waitForIdle: async () => {},
    dispose: () => {},
  } as unknown as AgentSession;
  const agent = new PiAgent(fake), values: string[] = []; let completed = false;
  const pending = agent.prompt('hello', text => values.push(text)).then(() => { completed = true; });
  listener({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hi' } } as AgentSessionEvent);
  listener({ type: 'turn_end' } as AgentSessionEvent);
  await Promise.resolve(); assert.equal(completed, false);
  listener({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }], stopReason: 'stop' } } as AgentSessionEvent);
  finish(); await pending;
  assert.equal(completed, true); assert.equal(values.at(-1), 'Hi'); assert.equal(values.includes('HiHi'), false);
});

for (const outcome of ['success', 'cancel', 'compaction-error', 'model-error'] as const) test(`Pi compaction lifecycle: ${outcome}`, async () => {
  let listener: (event: AgentSessionEvent) => void = () => {};
  let aborts = 0;
  const progress: unknown[] = [];
  const fake = {
    getActiveToolNames: () => [],
    subscribe: (callback: typeof listener) => { listener = callback; return () => {}; },
    prompt: async () => {
      listener({ type: 'compaction_start', reason: 'overflow' });
      listener({ type: 'compaction_end', reason: 'overflow', result: undefined, aborted: outcome === 'cancel', willRetry: outcome === 'success', errorMessage: outcome === 'compaction-error' ? 'provider secret' : undefined });
      listener({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }], stopReason: outcome === 'cancel' ? 'aborted' : outcome === 'model-error' ? 'error' : 'stop' } } as AgentSessionEvent);
      listener({ type: 'agent_settled' });
    },
    abort: async () => { aborts++; }, dispose: () => {}, waitForIdle: async () => {},
  } as unknown as AgentSession;
  const agent = new PiAgent(fake, true, event => progress.push(event));
  if (outcome === 'success') await agent.prompt('continue', () => {});
  else await assert.rejects(agent.prompt('continue', () => {}), outcome === 'cancel' ? /CANCELLED/ : outcome === 'model-error' ? /模型请求失败/ : /上下文整理失败/);
  assert.equal(progress.length, 2);
  assert.equal(JSON.stringify(progress).includes('provider secret'), false);
  assert.equal(aborts, outcome === 'compaction-error' ? 1 : 0);
});
