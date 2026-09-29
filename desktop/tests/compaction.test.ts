import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Type } from 'typebox';
import { piFactory, type CompactionProgress } from '../packages/service/src/pi-adapter.js';
import { temp } from './helpers.js';

for (const recovery of ['threshold', 'overflow'] as const) test(`real Pi ${recovery} compaction continues without replaying tools`, { timeout: 30000 }, async () => {
  const dir = temp(), progress: CompactionProgress[] = [], calls: number[] = [];
  let requests = 0, summaries = 0, overflowSent = false;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), summary = !body.tools?.length;
    if (!summary && recovery === 'overflow' && calls.length === 3 && !overflowSent) {
      overflowSent = true; res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'maximum context length exceeded', type: 'invalid_request_error', code: 'context_length_exceeded' } })); return;
    }
    if (summary) summaries++;
    else {
      requests++;
      assert.match(JSON.stringify(body.messages[0]), /APPROVED_SCOPE/);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta: unknown, finish_reason: string | null = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    if (summary) { emit({ role: 'assistant', content: 'Goal: APPROVED_SCOPE. Completed reads 1,2,3; continue remaining work. Preserve approval.' }); emit({}, 'stop'); }
    else if (calls.length < 5) {
      emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + requests, type: 'function', function: { name: 'read_fixture', arguments: JSON.stringify({ index: calls.length + 1 }) } }] }); emit({}, 'tool_calls');
    } else { emit({ role: 'assistant', content: 'Done' }); emit({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = await piFactory(dir.path)({ id: 'fixture', name: 'fixture', modelId: 'fixture', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, contextWindow: recovery === 'threshold' ? 50000 : 200000, maxTokens: 1024 } as any, 'secret', null, recovery, false, {
    cwd: dir.path, systemPrompt: 'APPROVED_SCOPE: read fixture only.', autoCompaction: true, onCompaction: event => progress.push(event),
    tools: [{ name: 'read_fixture', label: 'read', description: 'read fixture', parameters: Type.Object({ index: Type.Number() }), execute: async (_id, args) => {
      calls.push((args as { index: number }).index); return { content: [{ type: 'text', text: 'fixture content '.repeat(8000) }], details: {} };
    } }],
  });
  try {
    await agent.prompt('Complete all five reads.', () => {});
    assert.deepEqual(calls, [1, 2, 3, 4, 5]);
    assert.ok(summaries > 0);
    assert.ok(progress.some(e => e.phase === 'start'));
    assert.ok(progress.some(e => e.phase === 'end' && !e.error));
    assert.match(readFileSync(agent.sessionPath!, 'utf8'), /"type":"compaction"/);
  } finally { agent.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); dir.cleanup(); }
});
