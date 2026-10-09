import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { Credentials } from '../packages/service/src/keychain.js';
import { randomUUID } from 'node:crypto';
export async function seedOfflinePairing(dir: string) {
  const { Store } = await import('../packages/service/src/store.js');
  const { CloudStore } = await import('../packages/service/src/cloud/store.js');
  const store = new Store(join(dir, 'app.sqlite'));
  new CloudStore(store).putLink({ account: 'offline-ui-fixture', serverUrl: 'http://127.0.0.1:1', deviceId: randomUUID(), label: '离线测试 Mac', publicKey: '', pairedAt: Date.now(), producerSeq: 0, lastSyncAt: null });
  store.close();
}
export class MemoryCredentials implements Credentials { values = new Map<string, string>(); async get(id: string) { return this.values.get(id) ?? null; } async set(id: string, value: string) { this.values.set(id, value); } async delete(id: string) { this.values.delete(id); } }
export function temp() { const path = realpathSync(mkdtempSync(join(tmpdir(), 't-agnet-test-'))); return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }; }
export async function eventually(fn: () => boolean | Promise<boolean>, timeout = 10000) { const start = Date.now(); while (!(await fn())) { if (Date.now() - start > timeout) throw new Error('等待条件超时'); await new Promise(r => setTimeout(r, 25)); } }
export async function endpoint() {
  const requests: any[] = []; let connections = 0;
  const server = createServer(async (req, res) => {
    connections++;
    if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const json = JSON.parse(body); requests.push(json);
    if (req.headers.authorization === 'Bearer invalid-key') { res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'invalid-key', type: 'authentication_error' } })); return; }
    const last = json.messages.filter((m: any) => m.role === 'user').at(-1)?.content ?? '';
    const text = typeof last === 'string' ? last : JSON.stringify(last);
    const answer = text.includes('记住') ? '好的，我记住了蓝鲸。' : text.includes('之前') ? (JSON.stringify(json.messages).includes('蓝鲸') ? '你之前说的是蓝鲸。' : '没有记录。') : text.includes('慢') ? '这是一条需要慢慢生成的回复，用来验证停止功能。' : '这是测试端点的回复。';
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const piece of Array.from(answer)) {
      if (res.destroyed) break;
      res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1, model: json.model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }) + '\n\n');
      await new Promise(r => setTimeout(r, text.includes('慢') ? 120 : 2));
    }
    if (!res.destroyed) { res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1, model: json.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'); res.end(); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/v1`, requests, server, close: async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } };
}
