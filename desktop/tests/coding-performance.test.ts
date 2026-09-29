import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../packages/service/src/store.js';
import { Application } from '../packages/service/src/application.js';
import { piFactory } from '../packages/service/src/pi-adapter.js';
import { CodingStore } from '../packages/service/src/coding/store.js';
import { codingTools, type ToolContext } from '../packages/service/src/coding/tools.js';
import { RunQueue } from '../packages/service/src/coding/queue.js';
import { createPerformanceLog, monotonicMs } from '../packages/service/src/coding/performance-log.js';
import { OutputBuffer } from '../packages/service/src/coding/text-limit.js';
import { fitModelValue } from '../packages/service/src/coding/shape.js';
import { DuplicateTracker } from '../packages/service/src/coding/duplicates.js';
import { temp, MemoryCredentials, eventually } from './helpers.js';
import { fixturePlan, fixtureProject } from './coding-helpers.js';

function harness(root: string, dir: string, key = 'super-secret-token') {
  const store = new Store(join(dir, 'tools.sqlite'));
  store.db.exec('PRAGMA foreign_keys=OFF');
  const coding = new CodingStore(store);
  const controller = new AbortController();
  const taskId = randomUUID(), runId = randomUUID();
  const perf = createPerformanceLog(dir);
  const ctx: ToolContext = {
    taskId, runId, root, mode: 'execute', store: coding, key, dataDir: dir, performance: perf,
    cancelled: () => controller.signal.aborted, signal: controller.signal, notify: () => {}, readImages: new Map(), calls: 0,
  };
  const tools = Object.fromEntries(codingTools(ctx).map(tool => [tool.name, tool]));
  const run = async (name: string, params: unknown) => {
    const result = await tools[name].execute('call', params as never, undefined, undefined, undefined as never);
    const text = (result as { content: { text: string }[] }).content[0].text;
    let json: Record<string, unknown> = {};
    try { const parsed = JSON.parse(text); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>; } catch { /* status strings stay plain text */ }
    return { text, json };
  };
  return { ctx, tools, run, controller, store, coding, taskId, perf };
}

test('read reuse follows file changes, force, compaction and overwrite checks', async () => {
  const dir = temp(), root = join(dir.path, 'repo'); mkdirSync(root); fixtureProject(root);
  try {
    const original = readFileSync(join(root, 'main.mjs'), 'utf8');
    writeFileSync(join(root, 'main.mjs'), `/* ${'x'.repeat(3000)} */\n${original}`);
    const { ctx, run } = harness(root, dir.path);
    const first = await run('read_file', { path: 'main.mjs' });
    assert.match(first.text, /a - b/);
    const second = await run('read_file', { path: 'main.mjs' });
    assert.equal(second.json.unchanged, true);
    assert.match(String(second.json.note), /未变化/);
    assert.ok(second.text.length < first.text.length);
    const forced = await run('read_file', { path: 'main.mjs', force: true });
    assert.match(forced.text, /a - b/);
    assert.equal(forced.json.unchanged, undefined);
    ctx.reads!.clearInContext();
    const afterCompaction = await run('read_file', { path: 'main.mjs' });
    assert.match(afterCompaction.text, /a - b/);
    assert.equal(afterCompaction.json.unchanged, undefined);
    writeFileSync(join(root, 'main.mjs'), 'export function add(a, b) { return a + b; }\n');
    const external = await run('read_file', { path: 'main.mjs' });
    assert.match(external.text, /a \+ b/);
    assert.equal(external.json.unchanged, undefined);
    await run('read_file', { path: 'notes.txt' });
    writeFileSync(join(root, 'notes.txt'), 'changed outside\n');
    await assert.rejects(run('write_file', { path: 'notes.txt', content: 'should not land\n' }), /覆盖现有文件前必须读取/);
    assert.equal(readFileSync(join(root, 'notes.txt'), 'utf8'), 'changed outside\n');
    await run('read_file', { path: 'notes.txt' });
    await run('write_file', { path: 'notes.txt', content: 'local write\n' });
    const reread = await run('read_file', { path: 'notes.txt' });
    assert.match(reread.text, /local write/);
    assert.equal(reread.json.unchanged, undefined);
  } finally { dir.cleanup(); }
});

test('tool results stay valid JSON, keep command tails, redact secrets and can be reread', async () => {
  const dir = temp(), root = join(dir.path, 'repo'); mkdirSync(root); fixtureProject(root);
  const line = '中'.repeat(15000);
  writeFileSync(join(root, 'wide.txt'), line + '\n');
  try {
    const { run, coding, taskId, ctx } = harness(root, dir.path);
    const wide = await run('read_file', { path: 'wide.txt' });
    assert.equal(wide.json.lineTooLong, true);
    assert.equal(wide.json.text, undefined);
    assert.match(String(wide.json.readMore), /read_tool_output/);
    const saved = coding.tools(taskId).find(tool => tool.name === 'read_file')!;
    const opened = await run('read_tool_output', { callId: saved.id, offset: 0, maxChars: 4000 });
    assert.match(opened.text, /中中中/);
    const next = await run('read_tool_output', { callId: saved.id, offset: Number(opened.json.nextOffset), maxChars: 4000 });
    assert.equal(next.json.offset, opened.json.nextOffset);
    await assert.rejects(run('read_tool_output', { callId: '../secret' }), /没有保留的输出/);
    const command = `node -e "require('fs').writeSync(1,'FAIL_EARLY\\n'+'A'.repeat(150000)+'\\nsuper-secret-token\\nFAIL_AT_END\\n'); process.exit(1)"`;
    const failed = await run('run_command', { command, verification: false, timeoutSeconds: 20 });
    assert.equal(failed.json.code, 1);
    assert.match(failed.text, /FAIL_AT_END/);
    assert.ok(!failed.text.includes('super-secret-token'));
    const stored = coding.tools(taskId).find(tool => tool.id === failed.json.outputCallId)!;
    assert.match(stored.output, /FAIL_AT_END/);
    const early = await run('read_tool_output', { callId: String(failed.json.outputCallId), offset: 0, maxChars: 200 });
    assert.match(early.text, /FAIL_EARLY/);
    assert.ok(!early.text.includes('super-secret-token'));
    await run('run_command', { command: 'node test.mjs', verification: true, timeoutSeconds: 20 });
    const repeated = await run('run_command', { command: 'node test.mjs', verification: true, timeoutSeconds: 20 });
    assert.equal(repeated.json.code, 1);
    assert.match(repeated.text, /重新执行/);
    const checks = coding.tools(taskId).filter(tool => tool.verification);
    assert.equal(checks.length, 2);
    assert.equal(checks[0].exitCode, 1);
    const log = readFileSync(join(dir.path, 'logs', 'coding-performance.jsonl'), 'utf8');
    for (const secret of ['super-secret-token', 'FAIL_EARLY', line.slice(0, 40), 'A'.repeat(80)]) assert.ok(!log.includes(secret), secret);
    ctx.outputs!.removeTask(taskId);
    await assert.rejects(run('read_tool_output', { callId: saved.id }), /没有保留的输出/);
  } finally { dir.cleanup(); }
});

test('parallel queue caps at 4, stays faster than serial, and honors cancel plus pause', async () => {
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const wave = async (limit: number) => {
    const queue = new RunQueue(limit, () => false, () => false);
    const start = monotonicMs();
    await Promise.all(Array.from({ length: 4 }, () => queue.acquire().then(async slot => { await delay(60); slot.release(60); })));
    return monotonicMs() - start;
  };
  const parallel = await wave(4), serial = await wave(1);
  assert.ok(parallel < serial * 0.6, `parallel ${parallel}ms should be below serial ${serial}ms`);
  let active = 0, peak = 0;
  const capped = new RunQueue(4, () => false, () => false);
  await Promise.all(Array.from({ length: 6 }, () => capped.acquire().then(async slot => {
    active++; peak = Math.max(peak, active); await delay(40); active--; slot.release(40);
  })));
  assert.equal(peak, 4);
  const ac = new AbortController();
  let started = 0;
  const cancelling = new RunQueue(4, () => ac.signal.aborted, () => false, undefined, ac.signal);
  const pending = Array.from({ length: 6 }, () => cancelling.acquire().then(async slot => { started++; await delay(80); slot.release(80); }));
  setTimeout(() => ac.abort(), 15);
  const settled = await Promise.allSettled(pending);
  assert.equal(started, 4);
  assert.equal(settled.filter(item => item.status === 'rejected').length, 2);
  let paused = false, resumed = false;
  const gate = new RunQueue(1, () => false, () => paused);
  const first = await gate.acquire();
  const second = gate.acquire().then(slot => { resumed = true; slot.release(0); });
  paused = true; first.release(1);
  await assert.rejects(second, /暂停/);
  assert.equal(resumed, false);
});

test('duplicate reminders stay short without skipping commands or stopping a long run', () => {
  const tracker = new DuplicateTracker();
  const notes = Array.from({ length: 30 }, () => tracker.observe('git_status', {}, 'same', 'readonly'));
  assert.equal(notes[2].note?.includes('3 次'), true);
  assert.equal(notes[2].shorten, false);
  assert.equal(notes[5].shorten, true);
  assert.equal(notes[25].shorten, true);
  tracker.bump();
  assert.equal(tracker.observe('git_status', {}, 'same', 'readonly').shorten, false);
  const commands = Array.from({ length: 5 }, () => tracker.observe('run_command', { command: 'npm test' }, 'exit:1', 'command'));
  assert.equal(commands[4].shorten, false);
  assert.match(commands[4].note ?? '', /诊断方法/);
  const many = new DuplicateTracker();
  for (let i = 0; i < 200; i++) many.observe('git_status', {}, 'same', 'readonly');
  assert.equal(many.observe('git_status', {}, 'same', 'readonly').shorten, true);
});

test('retained output marks the omitted middle and model JSON is never sliced open', () => {
  const buffer = new OutputBuffer(32, 8);
  buffer.push('EARLY-');
  buffer.push('中文'.repeat(40));
  buffer.push('-LATE');
  const snap = buffer.snapshot();
  assert.match(snap.body, /已省略/);
  assert.match(snap.body, /EARLY-/);
  assert.match(snap.body, /-LATE/);
  assert.ok(!snap.body.includes('\uFFFD'));
  const fitted = fitModelValue({ code: 1, cancelled: false, output: 'x'.repeat(20000) + 'TAIL_ERROR', truncated: true }, randomUUID());
  const parsed = JSON.parse(fitted.text);
  assert.equal(fitted.truncated, true);
  assert.match(parsed.output, /TAIL_ERROR$/);
  assert.ok(fitted.text.length <= 12000);
});

test('performance log rotates three generations and ignores write failures', () => {
  const dir = temp();
  try {
    const log = createPerformanceLog(dir.path, 180);
    for (let i = 0; i < 30; i++) log.write({ kind: 'tool', taskId: randomUUID(), runId: randomUUID(), callId: randomUUID(), name: 'read_file', queueMs: 1, execMs: 2, parallel: true, duplicateHits: 0, prompt: 'do not store', command: 'secret' });
    log.summary({ taskId: randomUUID(), runId: randomUUID(), wallMs: 10 });
    assert.equal(existsSync(log.path), true);
    assert.equal(existsSync(log.path + '.1'), true);
    assert.equal(existsSync(log.path + '.3') || existsSync(log.path + '.2'), true);
    assert.equal(existsSync(log.path + '.4'), false);
    const body = readFileSync(log.path, 'utf8') + (existsSync(log.path + '.1') ? readFileSync(log.path + '.1', 'utf8') : '');
    assert.ok(!body.includes('do not store'));
    assert.ok(!body.includes('secret'));
    assert.doesNotThrow(() => createPerformanceLog('/dev/null/not-a-directory').write({ kind: 'tool', name: 'read_file' }));
  } finally { dir.cleanup(); }
});

async function toolServer(script: (json: any, count: number) => { calls?: { name: string; args: unknown }[]; text?: string }) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; const json = JSON.parse(body); requests.push(json);
    const count = json.messages.filter((message: any) => message.role === 'tool').length;
    const step = script(json, count);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta: unknown, finish: string | null = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: json.model, choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
    if (step.calls) {
      emit({ role: 'assistant', tool_calls: step.calls.map((call, index) => ({ index, id: 'call_' + count + '_' + index, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) });
      emit({}, 'tool_calls');
    } else { emit({ role: 'assistant', content: step.text ?? '完成' }); emit({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, requests, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

function overlap(items: { startedAt: number; endedAt: number | null }[]) {
  return Math.max(...items.map(item => items.filter(other => other.startedAt <= item.startedAt && (other.endedAt ?? 0) >= item.startedAt).length));
}

test('four independent reads finish together and logs keep occupancy separate from the sum', { timeout: 60000 }, async () => {
  process.env.T_AGNET_TOOL_DELAY_MS = '80';
  const dir = temp(), root = join(dir.path, 'repo'); mkdirSync(root); fixtureProject(root);
  const api = await toolServer((_json, count) => count === 0 ? { calls: [...['main.mjs', 'test.mjs', 'notes.txt'].map(path => ({ name: 'read_file', args: { path } as unknown })), { name: 'find_files', args: { query: 'mjs' } }] } : { text: '四处读取已完成。' });
  const store = new Store(join(dir.path, 'app.sqlite')), app = new Application(store, new MemoryCredentials(), piFactory(dir.path), () => {}, { dataDir: dir.path });
  try {
    const model = await app.call('modelSave', { name: 'fixture', modelId: 'fixture', baseUrl: api.url, apiKey: 'parallel-secret', contextWindow: 32000, maxTokens: 4096 });
    const project = await app.call('projectAdd', { path: root, requestId: randomUUID() });
    const task = await app.call('codingCreate', { intent: 'read', projectId: project.id, requirement: '同时查看几个文件', planModelId: model.id, executeModelId: model.id, requestId: randomUUID() });
    await eventually(() => !app.coding.active, 20000);
    const detail = await app.call('codingGet', { conversationId: task.conversationId });
    assert.equal(detail.task.state, 'completed', detail.task.message);
    const reads = detail.tools.filter(tool => tool.name === 'read_file' || tool.name === 'find_files');
    assert.equal(reads.length, 4);
    const span = Math.max(...reads.map(tool => tool.endedAt ?? 0)) - Math.min(...reads.map(tool => tool.startedAt));
    assert.ok(span < 280, `parallel span ${span}ms`);
    assert.equal(overlap(reads), 4);
    const log = readFileSync(join(dir.path, 'logs', 'coding-performance.jsonl'), 'utf8');
    const batch = log.split('\n').map(line => line ? JSON.parse(line) : null).find(event => event?.kind === 'parallel_batch');
    assert.ok(batch);
    assert.equal(batch.slots, 4);
    assert.ok(batch.occupancyMs < batch.execSumMs, `occupancy ${batch.occupancyMs} should stay below sum ${batch.execSumMs}`);
    assert.ok(!log.includes('parallel-secret'));
    assert.ok(!log.includes('a - b'));
  } finally { delete process.env.T_AGNET_TOOL_DELAY_MS; await app.shutdown(); store.close(); await api.close(); dir.cleanup(); }
});

test('a serial tool in the same turn blocks reads, and repeated reads shrink later model input', { timeout: 90000 }, async () => {
  process.env.T_AGNET_TOOL_DELAY_MS = '100';
  const dir = temp(), root = join(dir.path, 'repo'); mkdirSync(root); fixtureProject(root);
  const original = readFileSync(join(root, 'main.mjs'), 'utf8');
  writeFileSync(join(root, 'main.mjs'), `/* ${'x'.repeat(3000)} */\n${original}`);
  const api = await toolServer((json, count) => {
    const names = (json.tools ?? []).map((tool: any) => tool.function.name);
    if (names.includes('update_plan')) {
      if (count === 0) return { calls: [{ name: 'read_file', args: { path: 'main.mjs' } }] };
      if (count === 1) return { calls: [{ name: 'read_file', args: { path: 'main.mjs' } }] };
      if (count === 2) return { calls: [{ name: 'update_plan', args: { plan: fixturePlan } }] };
      return { text: '计划已生成，请审阅。' };
    }
    if (count === 0) return { calls: [{ name: 'read_file', args: { path: 'main.mjs' } }, { name: 'edit_file', args: { path: 'main.mjs', oldText: 'a - b', newText: 'a + b' } }] };
    if (count === 2) return { calls: [{ name: 'run_command', args: { command: 'node test.mjs', verification: true, timeoutSeconds: 20 } }] };
    return { text: '执行结束，请查看真实验证和差异。' };
  });
  const store = new Store(join(dir.path, 'app.sqlite')), app = new Application(store, new MemoryCredentials(), piFactory(dir.path), () => {}, { dataDir: dir.path });
  try {
    const model = await app.call('modelSave', { name: 'fixture', modelId: 'fixture', baseUrl: api.url, apiKey: 'barrier-secret', contextWindow: 32000, maxTokens: 4096 });
    const project = await app.call('projectAdd', { path: root, requestId: randomUUID() });
    const task = await app.call('codingCreate', { projectId: project.id, requirement: '修复 add', planModelId: model.id, executeModelId: model.id, requestId: randomUUID() });
    await eventually(() => !app.coding.active, 20000);
    const planning = api.requests.filter(request => request.tools?.some((tool: any) => tool.function.name === 'update_plan') && request.messages.filter((message: any) => message.role === 'tool').length >= 2);
    const repeated = planning.at(-1).messages.filter((message: any) => message.role === 'tool');
    assert.ok(String(repeated[1].content).length < String(repeated[0].content).length);
    assert.match(String(repeated[1].content), /未变化/);
    const plan = app.coding.db.plans(task.id).at(-1)!;
    await app.call('codingApprove', { taskId: task.id, planId: plan.id, hash: plan.hash, requestId: randomUUID() });
    await eventually(() => !app.coding.active, 30000);
    assert.equal(app.coding.db.task(task.id).state, 'completed', app.coding.db.task(task.id).message);
    assert.match(readFileSync(join(root, 'main.mjs'), 'utf8'), /a \+ b/);
    assert.equal((await app.call('codingGet', { conversationId: task.conversationId })).verification, 'passed');
    const detail = await app.call('codingGet', { conversationId: task.conversationId });
    const read = detail.tools.find(tool => tool.name === 'read_file' && tool.runId !== detail.runs[0].run.id);
    const edit = detail.tools.find(tool => tool.name === 'edit_file');
    assert.ok(read && edit && read.endedAt && edit.startedAt >= read.endedAt - 20, 'edit overlaps the read');
    const modes = api.requests.at(-1).tools.map((tool: any) => tool.function.name);
    assert.ok(modes.includes('read_file') && modes.includes('edit_file') && modes.includes('run_command'));
  } finally { delete process.env.T_AGNET_TOOL_DELAY_MS; await app.shutdown(); store.close(); await api.close(); dir.cleanup(); }
});
