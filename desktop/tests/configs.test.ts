import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigSync, secretAccount } from '../packages/service/src/cloud/configs.js';
import { CloudHttpError, CloudNetworkError } from '../packages/service/src/cloud/client.js';
import { Store } from '../packages/service/src/store.js';
import { MemoryCredentials, temp, endpoint, eventually } from './helpers.js';
import { piFactory } from '../packages/service/src/pi-adapter.js';
import { Application } from '../packages/service/src/application.js';

const hash = (c: unknown) => createHash('sha256').update(JSON.stringify(c)).digest('hex');
function server() {
  const docs = { skills: [] as any[], mcp_servers: [] as any[] }; const calls: { method: string; path: string; body?: any }[] = []; let offline = false;
  const add = (kind: "skills" | "mcp_servers", config: any, id: string = randomUUID()) => { const d = { id, version: 1, content_hash: hash(config), deleted: false, devices: [], config }; docs[kind].push(d); return d; };
  const bump = (d: any, config: any) => { d.version++; d.config = config; d.content_hash = hash(config); };
  async function request<T>(method: string, path: string, body?: any): Promise<T> {
    if (offline) throw new CloudNetworkError('无法连接云端服务器');
    calls.push({ method, path, body });
    if (method === 'GET' && path === '/device/configs/bundle') return structuredClone(docs) as T;
    const applied = path.match(/^\/device\/configs\/(skills|mcp-servers)\/(.+)\/applied$/);
    if (applied) {
      const d = [...docs.skills, ...docs.mcp_servers].find(x => x.id === applied[2]);
      if (!d || d.version !== body.version || d.content_hash !== body.hash) throw new CloudHttpError(409, '配置版本已变化');
      d.devices = [{ device_id: 'mac', label: 'Mac', state: body.state, checked_version: body.version, applied_version: body.version, reasons: body.reasons }]; return d as T;
    }
    const put = path.match(/^\/device\/configs\/(skills|mcp-servers)\/([^/]+)$/);
    if (put) {
      const list = put[1] === 'skills' ? docs.skills : docs.mcp_servers; const d = list.find(x => x.id === put[2]);
      if ((d?.version ?? 0) !== body.expected_version) throw new CloudHttpError(409, '云端拒绝请求（HTTP 409）');
      if (d) bump(d, body.config); else add(put[1] === 'skills' ? 'skills' : 'mcp_servers', body.config, put[2]); return {} as T;
    }
    throw new CloudHttpError(404, '记录不存在');
  }
  return { docs, calls, add, bump, request, setOffline: (v: boolean) => { offline = v; } };
}
const skill = (over: any = {}) => ({ name: 'pdf', description: '', content: '# PDF', files: [{ path: 'scripts/run.sh', content: '#!/bin/sh\ntouch "$MARKER"' }], runtime: 'mac', enabled: true, requires: { commands: ['pdftotext'], platforms: ['darwin'], scripts: ['scripts/run.sh'], mcp: [] }, install_hint: 'brew install poppler', ...over });
const mcp = (over: any = {}) => ({ name: 'fs', transport: 'stdio', command: 'mcp-fs', args: [], url: null, timeout_ms: 30000, env: [], runtime: 'mac', enabled: true, disabled_tools: [], ...over });

function setup() {
  const dir = temp(); const bin = join(dir.path, 'bin'); mkdirSync(bin); const store = new Store(join(dir.path, 'db.sqlite')); const keys = new MemoryCredentials(); const s = server();
  const sync = new ConfigSync({ paired: () => true, connected: () => true, request: s.request, keys, db: store.db, dir: join(dir.path, 'skills'), env: { path: bin, platform: 'darwin' }, emit: () => {} }, 3_600_000);
  const install = (name: string) => { const p = join(bin, name); writeFileSync(p, '#!/bin/sh\n'); chmodSync(p, 0o755); };
  return { dir, bin, store, keys, s, sync, install, close: async () => { await sync.stop(); store.close(); dir.cleanup(); } };
}

test('missing command fails explicitly; installing it and rechecking makes the skill available', async () => {
  const t = setup(); try {
    const d = t.s.add('skills', skill());
    let list = await t.sync.dispatch('configRecheck', {});
    assert.equal(list.skills[0].local.state, 'unavailable');
    assert.deepEqual(list.skills[0].local.reasons, [{ code: 'command_missing', detail: 'pdftotext' }]);
    assert.equal(list.skills[0].local.activeVersion, 0);
    assert.equal(list.skills[0].config.installHint, 'brew install poppler');
    const report = t.s.calls.find(c => c.path.endsWith('/applied'))!;
    assert.deepEqual(report.body, { version: 1, hash: d.content_hash, state: 'unavailable', reasons: [{ code: 'command_missing', detail: 'pdftotext' }] });
    assert.equal(existsSync(join(t.dir.path, 'skills', d.id)), false);

    // A non-executable file with the right name does not count.
    writeFileSync(join(t.bin, 'pdftotext'), ''); chmodSync(join(t.bin, 'pdftotext'), 0o644);
    assert.equal((await t.sync.dispatch('configRecheck', {})).skills[0].local.state, 'unavailable');
    t.install('pdftotext');
    list = await t.sync.dispatch('configRecheck', {});
    assert.equal(list.skills[0].local.state, 'available'); assert.equal(list.skills[0].local.activeHash, d.content_hash);
    const root = join(t.dir.path, 'skills', d.id, d.content_hash);
    assert.equal(readFileSync(join(root, 'SKILL.md'), 'utf8'), '# PDF');
    assert.equal(statSync(join(root, 'scripts/run.sh')).mode & 0o777, 0o644);
    assert.equal(list.skills[0].devices[0].state, 'available');
  } finally { await t.close(); }
});

test('a failing new version keeps the last usable version active', async () => {
  const t = setup(); try {
    t.install('pdftotext'); const d = t.s.add('skills', skill());
    await t.sync.dispatch('configRecheck', {}); const v1 = d.content_hash;
    t.s.bump(d, skill({ content: '# PDF v2', requires: { commands: ['pdftotext', 'ffmpeg'], platforms: [], scripts: [], mcp: [] } }));
    const list = await t.sync.dispatch('configRecheck', {});
    const local = list.skills[0].local;
    assert.equal(local.state, 'unavailable'); assert.equal(local.checkedVersion, 2); assert.equal(local.activeVersion, 1); assert.equal(local.activeHash, v1);
    assert.deepEqual(readdirSync(join(t.dir.path, 'skills', d.id)), [v1]);
    assert.equal(readFileSync(join(t.dir.path, 'skills', d.id, v1, 'SKILL.md'), 'utf8'), '# PDF');
    // Removed from the server: local copy is removed as well.
    t.s.docs.skills.length = 0; await t.sync.dispatch('configRecheck', {});
    assert.equal(existsSync(join(t.dir.path, 'skills', d.id)), false);
  } finally { await t.close(); }
});

test('checks never start a process and never run install hints or scripts', async () => {
  const t = setup(); const cp = createRequire(import.meta.url)('node:child_process'); const names = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
  const original = Object.fromEntries(names.map(n => [n, cp[n]])); const used: string[] = [];
  for (const n of names) cp[n] = (...args: unknown[]) => { used.push(n); throw new Error(`blocked ${n} ${String(args[0])}`); };
  syncBuiltinESMExports();
  try {
    const marker = join(t.dir.path, 'installed');
    t.s.add('skills', skill({ install_hint: `touch ${marker}`, requires: { commands: ['pdftotext'], platforms: [], scripts: ['scripts/run.sh'], mcp: ['fs'] } }));
    t.s.add('mcp_servers', mcp({ command: 'mcp-fs', args: [marker] }));
    const list = await t.sync.dispatch('configRecheck', {});
    t.install('pdftotext'); t.install('mcp-fs'); await t.sync.dispatch('configRecheck', {});
    assert.deepEqual(used, []); assert.equal(existsSync(marker), false);
    assert.equal(list.mcpServers[0].local.state, 'unavailable');
    assert.equal(readFileSync(new URL('../packages/service/src/cloud/configs.ts', import.meta.url), 'utf8').includes('child_process'), false);
  } finally { Object.assign(cp, original); syncBuiltinESMExports(); await t.close(); }
});

test('MCP secret references, cloud-only entries and MCP dependencies', async () => {
  const t = setup(); try {
    t.install('mcp-fs'); t.install('pdftotext');
    t.s.add('mcp_servers', mcp({ env: [{ name: 'API_TOKEN', value: null, secret_ref: 'fs-token' }, { name: 'LEVEL', value: 'info', secret_ref: null }] }));
    t.s.add('mcp_servers', mcp({ name: 'remote', transport: 'http', command: null, url: 'https://example.com/mcp', runtime: 'cloud' }));
    t.s.add('skills', skill({ name: 'uses-fs', requires: { commands: [], platforms: [], scripts: [], mcp: ['fs', 'remote', 'ghost'] } }));
    t.s.add('skills', skill({ name: 'cloud-only', runtime: 'cloud', requires: { commands: ['nope'], platforms: ['linux'], scripts: [], mcp: [] } }));
    let list = await t.sync.dispatch('configRecheck', {});
    const [fs, remote] = list.mcpServers;
    assert.deepEqual(fs.local.reasons, [{ code: 'secret_missing', detail: 'fs-token' }]);
    assert.equal(remote.local.state, 'not_applicable'); assert.equal(remote.local.activeVersion, 1);
    assert.deepEqual(list.skills[0].local.reasons.map(r => [r.code, r.detail]), [['mcp_unavailable', 'fs'], ['mcp_unavailable', 'remote 只在云端运行'], ['mcp_missing', 'ghost']]);
    assert.equal(list.skills[1].local.state, 'not_applicable');
    assert.deepEqual(list.secrets, [{ name: 'fs-token', present: false }]);

    list = await t.sync.dispatch('configSecretSet', { name: 'fs-token', value: 'super-secret-value' });
    assert.equal(await t.keys.get(secretAccount('fs-token')), 'super-secret-value');
    assert.equal(list.mcpServers[0].local.state, 'available');
    assert.deepEqual(list.skills[0].local.reasons.map(r => r.code), ['mcp_unavailable', 'mcp_missing']);
    assert.equal(JSON.stringify(t.s.calls).includes('super-secret-value'), false);
    list = await t.sync.dispatch('configSecretDelete', { name: 'fs-token' });
    assert.equal(list.mcpServers[0].local.state, 'unavailable');
  } finally { await t.close(); }
});

test('edits go to the server with the seen version; conflicts refresh and offline edits fail clearly', async () => {
  const t = setup(); try {
    const id = randomUUID();
    const config = { name: 'notes', description: '', content: '# notes', files: [], runtime: 'mac' as const, enabled: true, requires: { commands: [], platforms: [], scripts: [], mcp: [] }, installHint: null };
    let list = await t.sync.dispatch('configSkillPut', { id, expectedVersion: 0, requestId: randomUUID(), config });
    assert.equal(list.skills[0].version, 1); assert.equal(list.skills[0].local.state, 'available');
    assert.equal(t.s.calls.find(c => c.method === 'PUT')!.body.config.install_hint, null);
    t.s.bump(t.s.docs.skills[0], { ...t.s.docs.skills[0].config, content: '# from phone' });
    await assert.rejects(t.sync.dispatch('configSkillPut', { id, expectedVersion: 1, requestId: randomUUID(), config: { ...config, content: '# stale' } }), /已被其他端修改/);
    list = t.sync.listing(); assert.equal(list.skills[0].version, 2); assert.equal(list.skills[0].config.content, '# from phone');
    t.s.setOffline(true);
    await assert.rejects(t.sync.dispatch('configSkillPut', { id, expectedVersion: 2, requestId: randomUUID(), config }), /需要连接云端/);
  } finally { await t.close(); }
});


test('cached shared skill loads into local Pi while the sync server is offline', async () => {
  const t = setup(), api = await endpoint();
  try {
    t.s.add('skills', skill({ requires: { commands: [], platforms: [], scripts: [], mcp: [] }, files: [] }));
    await t.sync.pull(true);
    t.s.setOffline(true);
    const app = new Application(t.store, t.keys, piFactory(t.dir.path), () => {}, { dataDir: t.dir.path, configs: { dir: join(t.dir.path, 'skills') }, browser: { profileDir: join(t.dir.path, 'browser') } });
    try {
      const model = await app.call('modelSave', { name: 'local', baseUrl: api.url, modelId: 'fixture', apiKey: 'local-secret', contextWindow: 32000, maxTokens: 1000 });
      const conversation = await app.call('conversationCreate', { modelConfigId: model.id });
      const run = await app.call('messageSend', { conversationId: conversation.id, text: '你好', requestId: randomUUID() });
      await eventually(() => t.store.run(run.id).state !== 'running');
      assert.equal(t.store.run(run.id).state, 'completed', t.store.run(run.id).error ?? '');
      assert.ok(api.requests[0].tools.some((t: any) => t.function.name === 'read_skill'));
      assert.equal(app.configs.listing().skills[0].local.state, 'available');
      assert.ok(existsSync(join(t.dir.path, 'pi', 'empty-workspace')));
    } finally { await app.shutdown(); }
  } finally { await api.close(); await t.close(); }
});
