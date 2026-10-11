import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/src/app.js';
import { settings } from '../../server/src/config.js';
import { eventually, resetDatabase, TEST_DB, vaultFile } from '../../server/tests/helpers.js';
import { Application } from '../packages/service/src/application.js';
import { MemoryCredentials } from '../packages/service/src/keychain.js';
import type { AppEvent, Bot, MessagePage } from '../packages/protocol/src/index.js';

const skip = !TEST_DB && '需要 PI_BOT_TEST_DATABASE_URL';
const text = (c: any): string => (Array.isArray(c) ? c.map(p => p.text ?? '').join('') : String(c ?? ''));

/** A provider double that drives the agent through tool calls based on the latest user text. */
async function scriptedProvider(outside: string) {
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const json = JSON.parse(raw);
    const messages: any[] = json.messages;
    const user = text(messages.filter(m => m.role === 'user').at(-1)?.content);
    const last = messages.at(-1);
    const results = messages.filter(m => m.role === 'tool').map(m => text(m.content));
    let reply: { text?: string; tool?: { name: string; args: object } };
    if (user.includes('写文件')) reply = last.role === 'tool' ? { text: `完成：${results.at(-1)}` } : { tool: { name: 'write_file', args: { path: 'notes/hello.md', content: '# Hello from Pi Bot' } } };
    else if (user.includes('桌面')) {
      if (last.role !== 'tool') reply = { tool: { name: 'request_outside_access', args: { path: outside, reason: '需要看看桌面上的文件' } } };
      else if (results.length === 1 && results[0].includes('已批准')) reply = { tool: { name: 'list_files', args: { path: outside } } };
      else reply = { text: `桌面上有：${results.at(-1)}` };
    } else reply = { text: '你好，我在。' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: object, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: json.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (reply.tool) {
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${messages.length}`, type: 'function', function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }] });
      chunk({}, 'tool_calls');
    } else {
      for (const piece of Array.from(reply.text!)) chunk({ content: piece });
      chunk({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as any).port}/v1`, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

let dir: string, api: Awaited<ReturnType<typeof createApp>>, base: string, provider: Awaited<ReturnType<typeof scriptedProvider>>, app: Application;
const events: AppEvent[] = [];
let adminToken = '';
async function http(method: string, path: string, body?: unknown, token = adminToken) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json() as any };
}

before(async () => {
  if (skip) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'pi-bot-e2e-')));
  mkdirSync(join(dir, 'Desktop'));
  writeFileSync(join(dir, 'Desktop', 'plan.txt'), 'x');
  await resetDatabase(TEST_DB!);
  provider = await scriptedProvider(join(dir, 'Desktop'));
  api = await createApp(settings({ PI_BOT_DATABASE_URL: TEST_DB, PI_BOT_ADMIN_PASSWORD: 'admin-password', PI_BOT_JWT_SECRET: 'j'.repeat(40), PI_BOT_VAULT_FILE: vaultFile(dir) }));
  await api.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(api.server.address() as any).port}`;
  adminToken = (await http('POST', '/auth/login', { username: 'admin', password: 'admin-password' }, '')).json.access_token;
  await http('POST', '/admin/api/users', { username: 'bob', password: 'bob-password' });
  await http('POST', '/admin/api/models', { name: 'Scripted', base_url: provider.url, provider_model: 'scripted', api_key: 'sk-scripted', context_window: 32000, max_tokens: 1000 });
  app = new Application({ dataDir: join(dir, 'data'), libraryRoot: join(dir, 'pi-bot'), credentials: new MemoryCredentials(), emit: e => events.push(e), backoff: { baseMs: 50, maxMs: 200 } });
});
after(async () => {
  if (skip) return;
  await app?.shutdown();
  await api?.close();
  await provider?.close();
  rmSync(dir, { recursive: true, force: true });
});

test('the Mac harness logs in, binds itself and runs bots against its library', { skip }, async () => {
  await assert.rejects(app.login({ serverUrl: base, username: 'bob', password: 'nope', label: 'Bob 的 Mac' }), /用户名或密码错误/);
  const state = await app.login({ serverUrl: base, username: 'bob', password: 'bob-password', label: 'Bob 的 Mac' });
  assert.equal(state.user?.username, 'bob');
  await eventually(() => app.state().connection === 'online');

  const bot = await app.call('botCreate', { name: 'Writer', persona: '', avatar: { shape: 'bean', color: 'mint', scheme: 'light' } }) as Bot;
  assert.equal(bot.slug, 'writer');
  await app.call('send', { botId: bot.id, text: '帮我写文件' });
  const reply = await eventually(async () => {
    const page = await app.call('messages', { botId: bot.id }) as MessagePage;
    const last = page.messages.at(-1)!;
    return last.status !== 'running' && last;
  }, 20000);
  assert.equal(reply.status, 'completed', JSON.stringify(reply));
  assert.equal(reply.executor, 'mac');
  assert.match(reply.content, /完成：已写入 notes\/hello.md/);
  assert.deepEqual(reply.tools.map(t => [t.name, t.state]), [['write_file', 'completed']]);
  assert.equal(readFileSync(join(dir, 'pi-bot', 'writer', 'notes', 'hello.md'), 'utf8'), '# Hello from Pi Bot');
  assert.ok(events.some(e => e.type === 'bot.mood' && e.mood === 'working'), 'boards and UI see the bot working');
  assert.ok(events.some(e => e.type === 'delta'), 'streaming text reaches the UI');

  const bobToken = (await http('POST', '/auth/login', { username: 'bob', password: 'bob-password' }, '')).json.access_token;
  const files = await http('GET', `/bots/${bot.id}/files?path=notes`, undefined, bobToken);
  assert.deepEqual(files.json.entries.map((e: any) => e.name), ['hello.md']);
  const content = await http('GET', `/bots/${bot.id}/files/content?path=notes/hello.md`, undefined, bobToken);
  assert.equal(content.json.content, '# Hello from Pi Bot');
});

test('outside access waits for the user and continues after approval', { skip }, async () => {
  const bot = (await app.call('bots', {}) as { bots: Bot[] }).bots[0];
  await app.call('send', { botId: bot.id, text: '看看我的桌面' });
  const pending = await eventually(async () => {
    const b = (await app.call('bots', {}) as { bots: Bot[] }).bots[0];
    return b.pending_approvals[0];
  }, 20000);
  assert.equal(pending.path, join(dir, 'Desktop'));
  assert.equal(pending.reason, '需要看看桌面上的文件');
  await app.call('decide', { approvalId: pending.id, decision: 'approve' });
  const reply = await eventually(async () => {
    const page = await app.call('messages', { botId: bot.id }) as MessagePage;
    const last = page.messages.at(-1)!;
    return last.status !== 'running' && last;
  }, 20000);
  assert.equal(reply.status, 'completed', JSON.stringify(reply));
  assert.match(reply.content, /plan\.txt/);
});

test('logout unbinds the Mac and the server falls back to the cloud', { skip }, async () => {
  await app.logout();
  assert.equal(app.state().connection, 'signed_out');
  const bobToken = (await http('POST', '/auth/login', { username: 'bob', password: 'bob-password' }, '')).json.access_token;
  const me = await http('GET', '/me', undefined, bobToken);
  assert.equal(me.json.mac.online, false);
});
