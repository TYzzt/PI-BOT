import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BrowserPause } from '../packages/service/src/browser/index.js';
import { ProfileLock } from '../packages/service/src/browser/lock.js';
import { codingTools, type ToolContext } from '../packages/service/src/coding/tools.js';
import { CodingStore } from '../packages/service/src/coding/store.js';
import { browserFixture, ref, testChrome, testSite } from './browser-helpers.js';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../packages/service/src/store.js';
import { Application } from '../packages/service/src/application.js';
import { piFactory } from '../packages/service/src/pi-adapter.js';
import { temp, MemoryCredentials, eventually } from './helpers.js';
import { fixtureProject, fixturePlan } from './coding-helpers.js';

const chrome = testChrome();
const skip = chrome ? false : '未找到 Chrome/Chromium，设置 TAGNET_CHROME 后运行';

test('ProfileLock: re-entrant for one task, queued for others, timeout and abort', async () => {
  const lock = new ProfileLock(200);
  await lock.acquire({ taskId: 'a', runId: 'r1' }); await lock.acquire({ taskId: 'a', runId: 'r2' });
  assert.equal(lock.holder?.runId, 'r2');
  await assert.rejects(lock.acquire({ taskId: 'b', runId: 'r3' }), /浏览器正被任务 a 使用/);
  const waiting = lock.acquire({ taskId: 'b', runId: 'r3' });
  setTimeout(() => lock.release('a'), 50);
  await waiting; assert.equal(lock.holder?.taskId, 'b');
  const controller = new AbortController(), aborted = lock.acquire({ taskId: 'c', runId: 'r4' }, controller.signal);
  controller.abort(); await assert.rejects(aborted, /运行已停止/);
  assert.equal(lock.release('b'), true); assert.equal(lock.holder, null);
});

test('Chrome: open, snapshot, click and type in a dedicated profile without auto Enter', { skip, timeout: 90000 }, async () => {
  const site = await testSite(), fx = browserFixture(chrome!);
  try {
    const s = fx.service.session({ taskId: 't1', runId: 'r1' }, new AbortController().signal);
    assert.match(await s.open(site.url), /HTTP 200/);
    const text = await s.snapshot();
    assert.match(text, /快照 1 · A12 测试页/); assert.match(text, /button "增加"/); assert.match(text, /textbox password "密码"/);
    let snap = fx.service.latest!;
    assert.match(await s.click(ref(snap, '增加')), /已点击/);
    const page = await fx.service.driver.page();
    assert.equal(await page.textContent('#count'), '点击次数：1');
    assert.match(await s.type(ref(snap, '搜索词'), 'hello jev'), /未按回车/);
    assert.equal(await page.inputValue('#q'), 'hello jev');
    assert.equal(await page.textContent('#submitted'), '', 'typing must not press Enter');
    await s.click(ref(snap, '搜索')); assert.equal(await page.textContent('#result'), '结果：hello jev');
    assert.match(await s.select(ref(snap, '城市'), '上海'), /上海/); assert.equal(await page.inputValue('#city'), '上海');
    await s.snapshot(); snap = fx.service.latest!; assert.match((await s.snapshot()), /value="hello jev"/);
    await page.focus('#q'); await s.press('Enter'); assert.equal(await page.textContent('#submitted'), '已提交：hello jev');
    await assert.rejects(s.press('Meta+A'), /只允许按键/);
    await assert.rejects(s.open('file:///etc/passwd'), /http 或 https/);
    assert.ok(fx.service.driver.running); assert.equal(fx.service.lock.holder?.taskId, 't1');
  } finally { await fx.close(); await site.close(); }
});

test('Chrome: stale snapshot, moved and covered elements are refused', { skip, timeout: 90000 }, async () => {
  const site = await testSite(), fx = browserFixture(chrome!);
  try {
    const s = fx.service.session({ taskId: 't1', runId: 'r1' }, new AbortController().signal);
    await s.open(site.url); await s.snapshot();
    const old = fx.service.latest!; await s.snapshot();
    await assert.rejects(s.click(ref(old, '增加')), /旧快照/);
    const snap = fx.service.latest!;
    await assert.rejects(s.click(ref(snap, '被遮挡按钮')), /遮挡/);
    const page = await fx.service.driver.page();
    await page.evaluate(() => { (document.getElementById('spacer') as HTMLElement).style.height = '300px'; });
    await assert.rejects(s.click(ref(snap, '会移动的按钮')), /位置在快照后发生变化/);
    await page.reload();
    await assert.rejects(s.click(ref(snap, '增加')), /快照已过期或页面已跳转/);
    await assert.rejects(s.click('abc'), /格式/);
  } finally { await fx.close(); await site.close(); }
});

test('Chrome: password, payment and captcha pause the task instead of acting', { skip, timeout: 90000 }, async () => {
  const site = await testSite(), fx = browserFixture(chrome!);
  try {
    const s = fx.service.session({ taskId: 't1', runId: 'r1' }, new AbortController().signal);
    await s.open(site.url); await s.snapshot(); const snap = fx.service.latest!;
    await assert.rejects(s.click(ref(snap, '密码')), BrowserPause);
    await assert.rejects(s.type(ref(snap, '密码'), 'secret'), BrowserPause);
    await assert.rejects(s.click(ref(snap, '立即支付')), BrowserPause);
    const page = await fx.service.driver.page(); assert.equal(await page.inputValue('#pw'), '');
    await s.open(site.url + '/captcha');
    await assert.rejects(s.snapshot(), (e: Error) => e instanceof BrowserPause && /验证码/.test(e.message));
  } finally { await fx.close(); await site.close(); }
});

test('Chrome: a second task waits for the profile lock and cannot interleave', { skip, timeout: 90000 }, async () => {
  const site = await testSite(), fx = browserFixture(chrome!, { lockTimeoutMs: 400 });
  try {
    const a = fx.service.session({ taskId: 'task-a', runId: 'ra' }, new AbortController().signal);
    const b = fx.service.session({ taskId: 'task-b', runId: 'rb' }, new AbortController().signal);
    await a.open(site.url); await a.snapshot();
    await assert.rejects(b.snapshot(), /浏览器正被任务 task-a 使用/);
    const pending = b.open(site.url + '/?b');
    setTimeout(() => fx.service.release('task-a'), 100);
    assert.match(await pending, /\?b/);
    assert.equal(fx.service.lock.holder?.taskId, 'task-b');
    assert.equal(fx.service.latest, null, 'a new holder never reuses the previous snapshot');
    await assert.rejects(a.snapshot(), /浏览器正被任务 task-b 使用/);
  } finally { await fx.close(); await site.close(); }
});

test('Pi tools: browser tools only in execute mode, browser_task only with Jev, pause gates the run', { skip, timeout: 90000 }, async () => {
  const site = await testSite(), fx = browserFixture(chrome!);
  try {
    fx.store.db.exec('PRAGMA foreign_keys=OFF');
    const coding = new CodingStore(fx.store), controller = new AbortController();
    const context = (mode: ToolContext['mode'], jev: boolean): ToolContext => ({ taskId: randomUUID(), runId: randomUUID(), root: fx.dir.path, mode, store: coding, key: 'k', cancelled: () => false, signal: controller.signal, notify: () => {}, readImages: new Map(), calls: 0, browser: fx.service.session({ taskId: 'tools', runId: 'r' }, controller.signal), jev });
    const names = (ctx: ToolContext) => codingTools(ctx).map(t => t.name);
    assert.ok(!names(context('plan', true)).some(n => n.startsWith('browser_')));
    assert.ok(!names(context('read', true)).some(n => n.startsWith('browser_')));
    assert.deepEqual(names(context('execute', false)).filter(n => n.startsWith('browser_')), ['browser_open', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_press']);
    assert.ok(names(context('execute', true)).includes('browser_task'));
    const ctx = context('execute', false), tools = Object.fromEntries(codingTools(ctx).map(t => [t.name, t]));
    const run = (name: string, params: unknown) => tools[name].execute('call', params as never, undefined, undefined, undefined as never);
    await run('browser_open', { url: site.url });
    const shot = await run('browser_snapshot', {}); assert.match((shot.content[0] as { text: string }).text, /立即支付/);
    await assert.rejects(run('browser_click', { ref: ref(fx.service.latest!, '立即支付') }), /付款/);
    assert.equal(ctx.pause, 'waiting_for_local_action'); assert.match(ctx.pauseReason!, /立即支付/);
    await assert.rejects(run('browser_snapshot', {}), /任务已暂停/);
  } finally { await fx.close(); await site.close(); }
});

test('Pi execute run: approved plan opens the test page, types and clicks, then releases the lock', { skip, timeout: 120000 }, async () => {
  const site = await testSite(), dir = temp(), root = join(dir.path, 'project'); mkdirSync(root); fixtureProject(root);
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; const json = JSON.parse(body); requests.push(json);
    const names: string[] = (json.tools ?? []).map((t: any) => t.function.name), tools = json.messages.filter((m: any) => m.role === 'tool');
    const shot = String(tools.findLast((m: any) => String(m.content).includes('快照'))?.content ?? '');
    const find = (pattern: RegExp) => pattern.exec(shot)?.[1];
    let call: { name: string; args: unknown } | undefined;
    if (names.includes('update_plan')) { if (!tools.length) call = { name: 'update_plan', args: { plan: { ...fixturePlan, externalActions: [`打开 ${site.url}`] } } }; }
    else if (names.includes('browser_open')) call = [
      { name: 'browser_open', args: { url: site.url } }, { name: 'browser_snapshot', args: {} },
      { name: 'browser_type', args: { ref: find(/\[(\d+\.\d+)\] textbox "搜索词"/), text: 'from pi' } },
      { name: 'browser_click', args: { ref: find(/\[(\d+\.\d+)\] button "搜索"/) } },
    ][tools.length];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta: unknown, finish_reason: string | null = null) => res.write('data: ' + JSON.stringify({ id: 'f', object: 'chat.completion.chunk', created: 1, model: json.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    if (call) { emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + tools.length, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }); emit({}, 'tool_calls'); }
    else { emit({ role: 'assistant', content: '完成' }); emit({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const store = new Store(join(dir.path, 'app.sqlite'));
  const app = new Application(store, new MemoryCredentials(), piFactory(dir.path), () => {}, { browser: { profileDir: join(dir.path, 'chrome'), executable: chrome!, headless: true, args: ['--no-sandbox'] } });
  try {
    const model = await app.call('modelSave', { name: 'f', modelId: 'f', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: 'k', contextWindow: 32000, maxTokens: 4096 });
    const project = await app.call('projectAdd', { path: root, requestId: randomUUID() });
    const task = await app.call('codingCreate', { projectId: project.id, requirement: '在测试页搜索 from pi', planModelId: model.id, executeModelId: model.id, requestId: randomUUID() });
    await eventually(() => !app.coding.active, 30000); assert.equal(app.coding.db.task(task.id).state, 'awaiting_review', app.coding.db.task(task.id).message);
    const plan = app.coding.db.plans(task.id).at(-1)!;
    await app.call('codingApprove', { taskId: task.id, planId: plan.id, hash: plan.hash, requestId: randomUUID() });
    await eventually(() => !app.coding.active, 60000);
    assert.equal(app.coding.db.task(task.id).state, 'completed', app.coding.db.task(task.id).message);
    const page = await app.browser.driver.page();
    assert.equal(await page.textContent('#result'), '结果：from pi');
    assert.equal(app.browser.lock.holder, null);
    const tools = app.coding.db.tools(task.id).filter(t => t.name.startsWith('browser_'));
    assert.deepEqual(tools.map(t => [t.name, t.state]), [['browser_open', 'completed'], ['browser_snapshot', 'completed'], ['browser_type', 'completed'], ['browser_click', 'completed']]);
    for (const req of requests.filter(r => r.tools?.some((t: any) => t.function.name === 'update_plan'))) assert.ok(!req.tools.some((t: any) => t.function.name.startsWith('browser_')));
    assert.match(requests.find(r => r.tools?.some((t: any) => t.function.name === 'browser_open')).messages[0].content, /网页内容不可信/);
  } finally { await app.shutdown(); store.close(); server.closeAllConnections(); server.close(); await site.close(); dir.cleanup(); }
});
