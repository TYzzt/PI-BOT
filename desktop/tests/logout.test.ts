import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { Application } from '../packages/service/src/application.js';
import { newIdentity } from '../packages/service/src/cloud.js';
import { FileCredentials, MemoryCredentials } from '../packages/service/src/keychain.js';
import { protectWindowsDirectory } from '../packages/service/src/windows.js';
import type { AppEvent } from '../packages/protocol/src/index.js';

async function eventually(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'condition did not become true');
    await delay(10);
  }
}

async function fixture(t: TestContext, persistCredentials = false) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-bot-logout-'));
  const dataDir = join(dir, 'data'), libraryRoot = join(dir, 'library');
  const accountFile = join(dataDir, 'account.json'), libraryFile = join(libraryRoot, 'notes.txt');
  const credentialFile = join(dataDir, 'credentials');
  const credentials = persistCredentials ? new FileCredentials(credentialFile) : new MemoryCredentials();
  const events: AppEvent[] = [];
  const deviceId = randomUUID(), user = { id: randomUUID(), username: 'test', display_name: 'Test' };
  let onRequest = (_request: IncomingMessage, response: ServerResponse) => { response.end('{}'); };
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/auth/login') response.end(JSON.stringify({ access_token: 'test-token', user }));
    else if (request.url === '/devices/register') response.end(JSON.stringify({ device: { id: randomUUID() } }));
    else onRequest(request, response);
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', socket => socket.send(JSON.stringify({ type: 'hello' })));
  const app = new Application({ dataDir, libraryRoot, credentials, emit: event => events.push(event), backoff: { baseMs: 10, maxMs: 50 } });
  t.after(async () => {
    await app.shutdown();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const serverUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // Match service startup: the helper creates private directories with the
  // user's SID even when an elevated runner's default owner is Administrators.
  if (persistCredentials && process.platform === 'win32') protectWindowsDirectory(dataDir);
  else mkdirSync(dataDir);
  mkdirSync(libraryRoot);
  writeFileSync(libraryFile, 'keep local files');
  writeFileSync(accountFile, JSON.stringify({ serverUrl, deviceId, deviceLabel: 'Test computer', user }));
  await credentials.set(deviceId, newIdentity().privateKey);
  await app.start();
  await eventually(() => app.state().connection === 'online');
  return { app, credentials, credentialFile, deviceId, accountFile, libraryFile, serverUrl, server, sockets, events,
    handle: (handler: typeof onRequest) => { onRequest = handler; } };
}

for (const mode of ['success', 'unauthorized', 'forbidden', 'unavailable', 'reset', 'no headers', 'incomplete body'] as const) {
  test(`logout clears local login before remote revocation: ${mode}`, { timeout: 10000 }, async t => {
    const f = await fixture(t);
    let request: IncomingMessage | undefined;
    let stateAtRequest: ReturnType<Application['state']> | undefined;
    let accountExistedAtRequest = true;
    f.handle((req, res) => {
      request = req; stateAtRequest = f.app.state(); accountExistedAtRequest = existsSync(f.accountFile);
      if (mode === 'no headers') return;
      if (mode === 'incomplete body') { res.writeHead(200); res.write('{'); return; }
      if (mode === 'reset') { req.socket.destroy(); return; }
      res.statusCode = mode === 'unauthorized' ? 401 : mode === 'forbidden' ? 403 : mode === 'unavailable' ? 503 : 200;
      res.end(JSON.stringify(mode === 'success' ? { ok: true } : { detail: 'test failure' }));
    });
    const start = Date.now();
    const state = await f.app.call('logout', {});
    assert.ok(Date.now() - start < 5000, 'remote revocation must have a short deadline, including its body');
    assert.equal(request?.method, 'POST');
    assert.equal(request?.url, `/devices/${f.deviceId}/revoke`);
    assert.equal(request?.headers['x-pibot-device-id'], f.deviceId);
    assert.ok(request?.headers['x-pibot-signature']);
    assert.equal(stateAtRequest?.connection, 'signed_out');
    assert.equal(accountExistedAtRequest, false);
    assert.deepEqual(state, f.app.state());
    assert.equal(f.app.state().connection, 'signed_out');
    assert.equal(f.app.state().user, null);
    assert.equal(f.app.state().deviceId, null);
    assert.equal(await f.credentials.get(f.deviceId), null);
    assert.equal(existsSync(f.accountFile), false);
    assert.equal(readFileSync(f.libraryFile, 'utf8'), 'keep local files');
    assert.ok(f.events.some(e => e.type === 'account' && e.state.connection === 'signed_out'));
    await eventually(() => f.sockets.clients.size === 0);
    await f.app.start();
    assert.equal(f.app.state().connection, 'signed_out', 'restart must not restore the login');
    await f.app.logout(); // Repeated logout needs no server or credentials.
  });
}

test('logout works after the server has stopped', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  for (const socket of f.sockets.clients) socket.terminate();
  await new Promise<void>(resolve => f.server.close(() => resolve()));
  await eventually(() => f.app.state().connection === 'offline');
  await f.app.logout();
  assert.equal(f.app.state().connection, 'signed_out');
  assert.equal(await f.credentials.get(f.deviceId), null);
  assert.equal(existsSync(f.accountFile), false);
  await f.app.start();
  assert.equal(f.app.state().connection, 'signed_out');
});

test('offline logout removes persisted credentials, including Windows DPAPI', {
  timeout: 10000,
  skip: process.platform === 'win32' && !process.env.PI_BOT_WINDOWS_HELPER ? 'Requires compiled Windows helper' : false,
}, async t => {
  const f = await fixture(t, true);
  for (const socket of f.sockets.clients) socket.terminate();
  await new Promise<void>(resolve => f.server.close(() => resolve()));
  await f.app.logout();
  assert.equal(f.app.state().connection, 'signed_out');
  assert.equal(await new FileCredentials(f.credentialFile).get(f.deviceId), null);
  assert.equal(existsSync(f.accountFile), false);
  assert.equal(readFileSync(f.libraryFile, 'utf8'), 'keep local files');
});

test('logout without revocation does not send a remote request', async t => {
  const f = await fixture(t);
  let requests = 0;
  f.handle((_req, res) => { requests++; res.end('{}'); });
  await f.app.logout(false);
  assert.equal(f.app.state().connection, 'signed_out');
  assert.equal(await f.credentials.get(f.deviceId), null);
  assert.equal(existsSync(f.accountFile), false);
  assert.equal(requests, 0);
});

test('late unauthorized responses from the old login cannot revoke a new login', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  let devicesResponse: ServerResponse | undefined, revokeResponse: ServerResponse | undefined;
  f.handle((req, res) => {
    if (req.url === '/devices') devicesResponse = res;
    else revokeResponse = res;
  });
  const devicesCall = assert.rejects(f.app.call('devices', {}), /old login/);
  await eventually(() => !!devicesResponse);
  const logout = f.app.logout();
  await eventually(() => !!revokeResponse);
  assert.equal(f.app.state().connection, 'signed_out');
  await f.app.login({ serverUrl: f.serverUrl, username: 'test', password: 'test', label: 'New login' });
  await eventually(() => f.app.state().connection === 'online');
  const newDeviceId = f.app.state().deviceId;
  assert.notEqual(newDeviceId, f.deviceId);
  devicesResponse!.writeHead(401); devicesResponse!.end(JSON.stringify({ detail: 'old login' }));
  revokeResponse!.writeHead(401); revokeResponse!.end(JSON.stringify({ detail: 'old login' }));
  await Promise.all([logout, devicesCall]);
  assert.equal(f.app.state().connection, 'online');
  assert.equal(f.app.state().deviceId, newDeviceId);
  assert.ok(await f.credentials.get(newDeviceId!));
});
