import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceClient } from '../apps/desktop/src/service-client.js';
import { createRefreshScheduler } from '../apps/desktop/ui/refresh.js';
import { temp, eventually } from './helpers.js';

async function fixture(drop = false) {
  const dir = temp(), socketPath = join(dir.path, 'service.sock'), tokenPath = join(dir.path, 'token');
  writeFileSync(tokenPath, 'fixture-token');
  const peers = new Set<Socket>(), timers = new Set<ReturnType<typeof setTimeout>>();
  let peak = 0, received = 0, overloaded = false, connected = false, disconnects = 0;
  const server = createServer(socket => {
    peers.add(socket); socket.on('close', () => peers.delete(socket)); socket.on('error', () => {});
    socket.setEncoding('utf8'); let buffer = '', authed = false, inFlight = 0;
    socket.on('data', data => {
      buffer += data; let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const packet = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        if (!authed) { assert.equal(packet.token, 'fixture-token'); authed = true; socket.write('{"ready":true}\n'); continue; }
        received++; inFlight++; peak = Math.max(peak, inFlight);
        if (inFlight > 32) { overloaded = true; socket.destroy(); return; }
        if (drop) continue;
        const timer = setTimeout(() => {
          timers.delete(timer); inFlight--;
          if (!socket.destroyed) socket.write(JSON.stringify({ id: packet.id, result: packet.input, ...(packet.input.fail ? { error: 'fixture failure' } : {}) }) + '\n');
        }, 15);
        timers.add(timer);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const client = new ServiceClient(event => { if (event.type === 'service.status') { connected = !!event.connected; if (!connected) disconnects++; } }, { socketPath, tokenPath });
  client.start(); client.start();
  await eventually(() => connected);
  return {
    client, peers, stats: () => ({ peak, received, overloaded, connected, disconnects }), restore: () => { drop = false; },
    close: async () => { client.stop(); for (const timer of timers) clearTimeout(timer); for (const peer of peers) peer.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); dir.cleanup(); },
  };
}

test('service client queues event bursts below the server limit and releases slots on success and error', async () => {
  const f = await fixture();
  try {
    const inputs = Array.from({ length: 100 }, (_, index) => ({ index, fail: index % 17 === 0 }));
    const results = await Promise.allSettled(inputs.map(input => f.client.call('snapshot', input)));
    assert.equal(f.stats().received, 100);
    assert.ok(f.stats().peak <= 16, JSON.stringify(f.stats()));
    assert.equal(f.stats().overloaded, false); assert.equal(f.stats().disconnects, 0); assert.equal(f.peers.size, 1);
    results.forEach((result, index) => {
      if (inputs[index].fail) { assert.equal(result.status, 'rejected'); if (result.status === 'rejected') assert.match(result.reason.message, /fixture failure/); }
      else { assert.equal(result.status, 'fulfilled'); if (result.status === 'fulfilled') assert.deepEqual(result.value, inputs[index]); }
    });
  } finally { await f.close(); }
});

test('disconnect rejects queued mutations and reconnection never replays them', async () => {
  const f = await fixture(true);
  try {
    const pending = Promise.allSettled(Array.from({ length: 50 }, (_, index) => f.client.call('codingApprove', { index })));
    await eventually(() => f.stats().received === 16);
    for (const peer of f.peers) peer.destroy();
    const results = await pending;
    assert.ok(results.every(r => r.status === 'rejected' && /本地服务连接中断/.test(r.reason.message)));
    assert.equal(f.stats().received, 16);
    f.restore(); await eventually(() => f.stats().connected, 4000);
    assert.deepEqual(await f.client.call('snapshot', { resumed: true }), { resumed: true });
    assert.equal(f.stats().received, 17, 'Reconnect must not resend an approval with unknown outcome');
    f.client.stop(); await assert.rejects(f.client.call('snapshot', {}), /尚未连接/);
  } finally { await f.close(); }
});

test('refresh scheduler merges tool events, catches up once after loading, and stops on unmount', async () => {
  let calls = 0, active = 0, peak = 0, release!: () => void;
  const first = new Promise<void>(resolve => { release = resolve; });
  const errors: unknown[] = [];
  const scheduler = createRefreshScheduler(async () => {
    calls++; active++; peak = Math.max(peak, active);
    try { if (calls === 1) await first; else throw new Error('offline'); } finally { active--; }
  }, error => errors.push(error), 5);
  scheduler.request(true); for (let i = 0; i < 100; i++) scheduler.request();
  assert.equal(calls, 1); release(); await eventually(() => calls === 2 && errors.length === 1);
  assert.equal(peak, 1); for (let i = 0; i < 100; i++) scheduler.request();
  scheduler.stop(); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls, 2);
});
