import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Store } from '../packages/service/src/store.js';
import { Application } from '../packages/service/src/application.js';
import { piFactory } from '../packages/service/src/pi-adapter.js';
import { JevClient, JEV_KEY } from '../packages/service/src/browser/jev.js';
import { actionCriteria, decisionQuestions } from '../packages/service/src/browser/task.js';
import { MemoryCredentials, temp } from './helpers.js';
import { browserFixture, testChrome, testSite } from './browser-helpers.js';

type Script = (body: any) => { action: string; done?: number; stuck?: number } | { status: number };
async function fakeJev(script: Script) {
  const requests: { path: string; auth: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push({ path: req.url ?? '', auth: req.headers.authorization ?? '', body });
    const out = script(body);
    if ('status' in out) { res.writeHead(out.status).end('{"error":"x"}'); return; }
    const answers: Record<string, unknown> = {};
    if (out.action !== 'broken') for (const [name, q] of Object.entries<any>(body.questions)) {
      if (q.type === 'choice') answers[name] = { type: 'choice', choice: out.action, confidence: 0.9, probabilities: { [out.action]: 0.9 } };
      else answers[name] = { type: 'noul', noul: name === 'done' ? out.done ?? 0 : name === 'stuck' ? out.stuck ?? 0 : 0.99 };
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests, close: async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } };
}
const pick = (criteria: Record<string, string>, prefix: string, text: string) => Object.keys(criteria).find(k => k.startsWith(prefix) && criteria[k].includes(text)) ?? 'wait';

const chrome = testChrome();
const skip = chrome ? false : '未找到 Chrome/Chromium，设置 TAGNET_CHROME 后运行';

test('Jev settings: key stays in credentials, status/test/delete through the service API', { timeout: 30000 }, async () => {
  const jev = await fakeJev(() => ({ action: 'x' })), dir = temp(), store = new Store(join(dir.path, 'app.sqlite')), keys = new MemoryCredentials();
  const app = new Application(store, keys, piFactory(dir.path), () => {}, { browser: { profileDir: join(dir.path, 'chrome'), executable: '/nonexistent/chrome' } });
  try {
    assert.equal((await app.call('jevGet', {})).configured, false);
    await assert.rejects(app.call('jevSave', { baseUrl: jev.url, model: 'jev-latest' }), /请填写 Jev API Key/);
    await assert.rejects(async () => app.call('jevSave', { baseUrl: 'ftp://x', model: 'jev-latest', apiKey: 'k' }));
    const saved = await app.call('jevSave', { baseUrl: jev.url, model: 'jev-latest', apiKey: 'jev-secret' });
    assert.deepEqual(saved, { configured: true, baseUrl: jev.url, model: 'jev-latest', hasKey: true });
    assert.match(JEV_KEY, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(keys.values.get(JEV_KEY), 'jev-secret');
    assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM shared_state').all()).includes('jev-secret'));
    assert.deepEqual(await app.call('jevTest', {}), { ok: true, model: 'jev-1.13.0' });
    assert.equal(jev.requests[0].path, '/v1/systemone'); assert.equal(jev.requests[0].auth, 'Bearer jev-secret'); assert.equal(jev.requests[0].body.model, 'jev-latest');
    const status = await app.call('browserStatus', {});
    assert.equal(status.executable, null); assert.equal(status.running, false); assert.equal(status.holder, null); assert.equal(status.jev.configured, true);
    assert.equal(await app.browser.jevReady(), true);
    assert.equal((await app.call('jevDelete', {})).configured, false); assert.equal(keys.values.has(JEV_KEY), false);
    assert.equal(await app.browser.jevReady(), false);
  } finally { await app.shutdown(); store.close(); await jev.close(); dir.cleanup(); }
});

test('JevClient: HTTP errors and malformed answers are reported without response bodies', async () => {
  let status = 401;
  const jev = await fakeJev(() => status === 200 ? { action: 'broken' } : { status });
  try {
    const client = new JevClient({ baseUrl: jev.url + '/', model: 'jev-latest' }, 'k');
    await assert.rejects(client.ask('s', { a: { type: 'noul', instructions: 'q' } }), /key 无效/);
    status = 500; await assert.rejects(client.ask('s', { a: { type: 'noul', instructions: 'q' } }), /HTTP 500/);
    status = 422; await assert.rejects(client.ask('s', { a: { type: 'noul', instructions: 'q' } }), /HTTP 422.*x/);
    status = 200; await assert.rejects(client.ask('s', { pick: { type: 'choice', instructions: 'q', criteria: { a: 'a' } } }), /未返回问题 pick 的选择/);
    assert.equal(jev.requests.at(-1)!.path, '/v1/systemone');
  } finally { await jev.close(); }
});

test('Jev decision request follows the System One question shape', () => {
  const criteria = actionCriteria({ id: 1, title: 't', url: 'https://example.test', elements: [], text: '', captcha: false, truncated: false }, []);
  const questions = decisionQuestions(criteria);
  assert.equal(Object.keys(criteria).length <= 255, true);
  assert.equal(questions.action.type, 'choice');
  assert.match(questions.action.instructions, /`goal`/);
  assert.equal(questions.action.instructions.includes('搜索'), false);
  assert.equal(questions.done.type, 'noul');
  assert.equal(questions.done.type === 'noul' && !!questions.done.criteria?.true && !!questions.done.criteria.false, true);
  assert.equal(questions.stuck.type, 'noul');
  assert.match(questions.stuck.instructions, /`history`/);
});

test('JevClient retries a rate limit and then reads the answer', async () => {
  let calls = 0;
  const jev = await fakeJev(() => (++calls === 1 ? { status: 429 } : { action: 'wait' }));
  try {
    const client = new JevClient({ baseUrl: jev.url, model: 'jev-latest' }, 'k');
    const result = await client.ask('The page shows a button labelled "Submit".', { check: { type: 'noul', instructions: 'Is there a submit button?' } });
    assert.equal(calls, 2);
    assert.equal(result.answers.check.type, 'noul');
  } finally { await jev.close(); }
});

test('browser_task: Jev drives type and click on the test page, stops when the goal is reached', { skip, timeout: 90000 }, async () => {
  const site = await testSite();
  const jev = await fakeJev(body => {
    const criteria = body.questions.action.criteria, text: string = body.state.page.text;
    if (text.includes('结果：hello jev')) return { action: 'wait', done: 0.95 };
    const typed = body.state.elements.some((e: string) => e.includes('value="hello jev"'));
    return { action: typed ? pick(criteria, 'click_', '"搜索"') : pick(criteria, 'type_', '搜索词'), done: 0.1 };
  });
  const fx = browserFixture(chrome!);
  try {
    await fx.jev.save({ baseUrl: jev.url, model: 'jev-latest', apiKey: 'jev-secret' });
    const s = fx.service.session({ taskId: 't', runId: 'r' }, new AbortController().signal);
    await s.open(site.url);
    const result = await s.task({ goal: '在搜索框输入 hello jev 并点击搜索', inputs: ['hello jev'] });
    assert.equal(result.outcome, 'done', JSON.stringify(result.steps));
    assert.equal(result.model, 'jev-1.13.0');
    assert.deepEqual(result.steps.map(st => st.action.split('_')[0]), ['type', 'click', 'wait']);
    assert.match(result.snapshot, /结果：hello jev/);
    const page = await fx.service.driver.page();
    assert.equal(await page.textContent('#submitted'), '', 'Jev typing must not press Enter');
    const first = jev.requests[0].body;
    assert.ok(Object.keys(first.questions.action.criteria).every((k: string) => /^(done|blocked|scroll_down|scroll_up|wait|click_\d+|type_\d+_0|select_\d+_\d+)$/.test(k)));
    assert.ok(!Object.values<string>(first.questions.action.criteria).some(v => v.includes('password')), 'password fields are never offered to Jev');
    assert.ok(!Object.keys(first.questions.action.criteria).some(k => k.startsWith('type_') && first.questions.action.criteria[k].includes('城市')));
  } finally { await fx.close(); await site.close(); await jev.close(); }
});

test('browser_task: stuck, step limit, unlisted choices and sensitive clicks', { skip, timeout: 90000 }, async () => {
  const site = await testSite();
  let mode = 'stuck';
  const jev = await fakeJev(body => {
    const criteria = body.questions.action.criteria;
    if (mode === 'stuck') return { action: 'wait', stuck: 0.9 };
    if (mode === 'loop') return { action: 'wait' };
    if (mode === 'invent') return { action: 'type_1_5' };
    return { action: pick(criteria, 'click_', '立即支付') };
  });
  const fx = browserFixture(chrome!);
  try {
    await fx.jev.save({ baseUrl: jev.url, model: 'jev-latest', apiKey: 'jev-secret' });
    const s = fx.service.session({ taskId: 't', runId: 'r' }, new AbortController().signal);
    await s.open(site.url);
    assert.equal((await s.task({ goal: '登录' })).outcome, 'blocked');
    mode = 'loop'; const limited = await s.task({ goal: '一直等', maxSteps: 2 });
    assert.equal(limited.outcome, 'max_steps'); assert.equal(limited.steps.length, 2);
    mode = 'invent'; await assert.rejects(s.task({ goal: '输入不存在的文字', inputs: ['a'] }), /未列出的操作/);
    mode = 'pay'; await assert.rejects(s.task({ goal: '付款' }), /付款/);
    const page = await fx.service.driver.page(); assert.equal(await page.textContent('#count'), '点击次数：0');
    await fx.jev.remove(); await assert.rejects(s.task({ goal: 'x' }), /尚未配置 Jev/);
  } finally { await fx.close(); await site.close(); await jev.close(); }
});
