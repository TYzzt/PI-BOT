import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Application } from '../packages/service/src/application.js';
import { Store } from '../packages/service/src/store.js';
import { piFactory } from '../packages/service/src/pi-adapter.js';
import { MemoryCredentials, temp, eventually } from './helpers.js';

// Run through server/scripts/check_shared.py with T_AGNET_TEST_FILE=tests/configs-e2e.test.ts.
const url = process.env.T_AGNET_CLOUD_URL, password = process.env.T_AGNET_CLOUD_PASSWORD;
test('phone edits a shared skill, the Mac shows the new version and reports missing dependencies without installing', { skip: !url, timeout: 120000 }, async () => {
  const dir = temp(), bin = join(dir.path, 'bin'); mkdirSync(bin);
  const store = new Store(join(dir.path, 'app.sqlite'));
  const app = new Application(store, new MemoryCredentials(), piFactory(dir.path), () => {}, { credentials: new MemoryCredentials(), configs: { dir: join(dir.path, 'skills'), intervalMs: 200, env: { path: bin, platform: 'darwin' } } });
  const token = (await (await fetch(`${url}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) })).json()).access_token;
  const phone = async (method: string, path: string, body?: unknown) => { const r = await fetch(url + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); assert.ok(r.ok, `${path} ${r.status} ${await r.clone().text()}`); return r.json() as Promise<any>; };
  try {
    await app.call('cloudPair', { serverUrl: url!, label: 'Config Mac', password: password! });
    const marker = join(dir.path, 'installed'), id = randomUUID();
    const config = { name: 'video', description: '', content: '# Video v1', files: [], runtime: 'mac', enabled: true, requires: { commands: ['ffmpeg'], platforms: ['darwin'], scripts: [], mcp: [] }, install_hint: `touch ${marker}` };
    await phone('PUT', `/configs/skills/${id}`, { expected_version: 0, request_id: randomUUID(), config });

    await eventually(async () => (await app.call('configList', {})).skills[0]?.local.state === 'unavailable', 30000);
    let mac = (await app.call('configList', {})).skills[0];
    assert.equal(mac.version, 1); assert.deepEqual(mac.local.reasons, [{ code: 'command_missing', detail: 'ffmpeg' }]);
    await eventually(async () => (await phone('GET', '/configs/skills'))[0].devices[0]?.state === 'unavailable', 30000);
    let seen = (await phone('GET', '/configs/skills'))[0].devices[0];
    assert.equal(seen.label, 'Config Mac'); assert.equal(seen.applied_version, 0); assert.equal(seen.reasons[0].detail, 'ffmpeg');
    assert.equal(existsSync(marker), false);

    writeFileSync(join(bin, 'ffmpeg'), '#!/bin/sh\n'); chmodSync(join(bin, 'ffmpeg'), 0o755);
    await phone('PUT', `/configs/skills/${id}`, { expected_version: 1, request_id: randomUUID(), config: { ...config, content: '# Video v2' } });
    await eventually(async () => { const s = (await app.call('configList', {})).skills[0]; return s.version === 2 && s.local.state === 'available'; }, 30000);
    mac = (await app.call('configList', {})).skills[0];
    assert.equal(mac.config.content, '# Video v2'); assert.equal(mac.local.activeVersion, 2);
    await eventually(async () => (await phone('GET', '/configs/skills'))[0].devices[0]?.applied_version === 2, 30000);

    const edited = await app.call('configSkillPut', { id, expectedVersion: 2, requestId: randomUUID(), config: { ...mac.config, content: '# Video v3 from Mac' } });
    assert.equal(edited.skills[0].version, 3);
    seen = (await phone('GET', '/configs/skills'))[0]; assert.equal(seen.version, 3); assert.equal(seen.config.content, '# Video v3 from Mac');
    assert.equal(existsSync(marker), false);
  } finally { await app.shutdown(); store.close(); dir.cleanup(); }
});
