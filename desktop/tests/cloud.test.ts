import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { checkServerUrl } from '../packages/service/src/cloud.js';

test('public HTTP requires an explicit matching backend and cannot expand to other endpoints', () => {
  const previous = process.env.PI_BOT_HTTP_SERVER_URL;
  try {
    delete process.env.PI_BOT_HTTP_SERVER_URL;
    assert.equal(checkServerUrl('https://backend.example/pibot/'), 'https://backend.example/pibot');
    assert.equal(checkServerUrl('http://localhost:8000'), 'http://localhost:8000');
    assert.equal(checkServerUrl('http://127.0.0.1:8000/'), 'http://127.0.0.1:8000');
    assert.equal(checkServerUrl('http://[::1]:8000/'), 'http://[::1]:8000');
    assert.throws(() => checkServerUrl('http://192.0.2.10:8000'), /HTTPS/);
    assert.throws(() => checkServerUrl('http://backend.example:8000'), /HTTPS/);

    process.env.PI_BOT_HTTP_SERVER_URL = 'http://BACKEND.example:8000/pibot/';
    assert.equal(checkServerUrl('http://backend.example:8000/pibot///'), 'http://backend.example:8000/pibot');
    for (const address of [
      'http://other.example:8000/pibot',
      'http://backend.example:8001/pibot',
      'http://backend.example:8000/other',
      'http://backend.example:8000/pibot?token=value',
      'http://backend.example:8000/pibot#fragment',
      'http://user:password@backend.example:8000/pibot',
      'ftp://backend.example:8000/pibot',
    ]) assert.throws(() => checkServerUrl(address));

    process.env.PI_BOT_HTTP_SERVER_URL = 'invalid';
    assert.throws(() => checkServerUrl('http://backend.example:8000'), /HTTPS/);
  } finally {
    if (previous === undefined) delete process.env.PI_BOT_HTTP_SERVER_URL;
    else process.env.PI_BOT_HTTP_SERVER_URL = previous;
  }
});

for (const secure of [false, true]) test(`${secure ? 'secure' : 'plain'} device WebSocket uses Node's environment proxy`, async t => {
  const proxy = createServer();
  const sockets = new WebSocketServer({ noServer: true });
  const requests: { method: string; target: string }[] = [];
  let child: ReturnType<typeof spawn> | undefined;
  proxy.on('upgrade', (request, socket, head) => {
    requests.push({ method: 'GET', target: request.url! });
    sockets.handleUpgrade(request, socket, head, ws => ws.send(JSON.stringify({ type: 'hello' })));
  });
  proxy.on('connect', (request, socket) => {
    requests.push({ method: 'CONNECT', target: request.url! });
    // Observing CONNECT proves HTTPS uses the proxy, without bypassing TLS verification.
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    child!.stdin!.end('stop');
  });
  t.after(() => {
    child?.kill();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    proxy.closeAllConnections();
    proxy.close();
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address() as { port: number };
  const proxyUrl = `http://127.0.0.1:${address.port}`;
  const source = `
    import { CloudSocket } from ${JSON.stringify(new URL('../packages/service/src/cloud.ts', import.meta.url).href)};
    const socket = new CloudSocket('${secure ? 'https' : 'http'}://pi-bot-proxy.invalid', () => ({}), {
      message() {}, close() {}, open() { finish(); }
    });
    const timeout = setTimeout(() => {
      console.error('WebSocket did not reach the configured proxy');
      process.exitCode = 1;
      finish();
    }, 5000);
    function finish() { clearTimeout(timeout); socket.stop(); process.stdin.destroy(); }
    process.stdin.once('data', finish);
    socket.start();
  `;
  child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    env: { ...process.env, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl, https_proxy: proxyUrl, NO_PROXY: '', no_proxy: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr!.on('data', chunk => { errors += String(chunk); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child!.once('error', reject);
    child!.once('close', resolve);
  });
  assert.equal(code, 0, errors);
  assert.deepEqual(requests, [secure
    ? { method: 'CONNECT', target: 'pi-bot-proxy.invalid:443' }
    : { method: 'GET', target: 'http://pi-bot-proxy.invalid/ws/device' }]);
});
