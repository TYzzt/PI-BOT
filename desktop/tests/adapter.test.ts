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
