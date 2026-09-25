import { createServer, type Socket, connect } from 'node:net';
import { mkdirSync, chmodSync, readFileSync, writeFileSync, existsSync, unlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createLog } from './log.js';
import { Store } from './store.js';
import { Keychain } from './keychain.js';
import { piFactory } from './pi-adapter.js';
import { Application, safeFailure } from './application.js';
import { dataDir, socketDir, socketPath, tokenPath } from './paths.js';
import { schemas, type Method, type AppEvent } from '../../protocol/src/index.js';

process.umask(0o077);
for (const p of [dataDir, socketDir]) {
  mkdirSync(p, { recursive: true, mode: 0o700 });
  const stat = lstatSync(p); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error('本地服务目录权限不正确');
  chmodSync(p, 0o700);
}
if (existsSync(socketPath)) {
  const alive = await new Promise<boolean>(resolve => { const s = connect(socketPath); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', e => { resolve((e as NodeJS.ErrnoException).code !== 'ECONNREFUSED' && (e as NodeJS.ErrnoException).code !== 'ENOENT'); }); });
  if (alive) { console.error('本地服务已运行'); process.exit(1); } unlinkSync(socketPath);
}
if (!existsSync(tokenPath)) { try { writeFileSync(tokenPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } }
chmodSync(tokenPath, 0o600); const token = readFileSync(tokenPath, 'utf8');
const peers = new Set<Socket>();
function send(s: Socket, value: unknown) { if (!s.destroyed) { if (s.writableLength > 2_000_000) s.destroy(); else s.write(JSON.stringify(value) + '\n'); } }
function broadcast(event: AppEvent) { for (const peer of peers) send(peer, { event }); }
const log = createLog(dataDir);
let store: Store;
const helper = process.env.T_AGNET_KEYCHAIN_HELPER || fileURLToPath(new URL('../../../native/dist/keychain', import.meta.url));
let application: Application;
const server = createServer(socket => {
  socket.setEncoding('utf8');
  let buffer = '', authed = false, inFlight = 0;
  const timer = setTimeout(() => { if (!authed) socket.destroy(); }, 5000);
  socket.on('error', () => {}); socket.on('close', () => { clearTimeout(timer); peers.delete(socket); });
  socket.on('data', data => {
    buffer += data.toString('utf8'); if (buffer.length > 1_000_000) { socket.destroy(); return; }
    let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      try {
        const packet = JSON.parse(line);
        if (!authed) {
          const supplied = Buffer.from(typeof packet.token === 'string' ? packet.token : ''); const wanted = Buffer.from(token);
          if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) { socket.destroy(); return; }
          authed = true; clearTimeout(timer); peers.add(socket); send(socket, { ready: true }); continue;
        }
        if (typeof packet.id !== 'string' || packet.id.length > 100 || !Object.hasOwn(schemas, packet.method) || ++inFlight > 32) { socket.destroy(); return; }
        void Promise.resolve().then(() => application.call(packet.method as Method, packet.input)).then(result => send(socket, { id: packet.id, result })).catch(error => {
          // Provider failures never return raw bodies/headers. Local validation errors are safe and useful.
          const message = packet.method === 'modelTest' ? safeFailure(error) : error instanceof Error ? error.message : '请求失败';
          send(socket, { id: packet.id, error: message });
        }).finally(() => { inFlight--; });
      } catch { socket.destroy(); return; }
    }
  });
});
server.on('error', () => { console.error('本地服务无法监听，请检查是否已有实例'); process.exit(1); });
server.listen(socketPath, () => {
  chmodSync(socketPath, 0o600);
  store = new Store(join(dataDir, 'app.sqlite'));
  application = new Application(store, new Keychain(helper), piFactory(dataDir), broadcast, { credentials: new Keychain(helper, 'dev.t-agnet.device') });
  log('service.started');
  console.log('T-AGNET service ready');
});
let closing = false;
async function shutdown() { if (closing) return; closing = true; log('service.stopping'); const deadline = setTimeout(() => process.exit(1), 8000); deadline.unref(); await application?.shutdown(); for (const p of peers) p.destroy(); server.close(() => { store?.close(); if (existsSync(socketPath)) unlinkSync(socketPath); process.exit(0); }); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
