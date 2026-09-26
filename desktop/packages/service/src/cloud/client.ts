import WebSocket from 'ws';
import type { Signer } from './identity.js';

export class CloudHttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export class CloudNetworkError extends Error {}
const TIMEOUT_MS = 15000;

// Only the server's short `detail` string is surfaced; bodies, headers and credentials never reach errors or logs.
async function detail(response: Response) {
  try { const json = await response.json() as { detail?: unknown }; if (typeof json.detail === 'string') return json.detail.slice(0, 300); } catch { /* Non-JSON error body is ignored. */ }
  return `云端拒绝请求（HTTP ${response.status}）`;
}
export async function cloudFetch<T>(serverUrl: string, method: string, path: string, options: { body?: unknown; headers?: Record<string, string>; signer?: Signer } = {}): Promise<T> {
  const transport = new URL(serverUrl);
  if (transport.protocol !== 'https:' && !(transport.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(transport.hostname))) throw new CloudNetworkError('云端连接必须使用 HTTPS');
  const body = options.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(options.body), 'utf8');
  const headers: Record<string, string> = { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers, ...(options.signer ? options.signer(method, path.split('?')[0], body) : {}) };
  let response: Response;
  try { response = await fetch(serverUrl.replace(/\/$/, '') + path, { method, headers, body: options.body === undefined ? undefined : body, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' }); }
  catch { throw new CloudNetworkError('无法连接云端服务器'); }
  if (!response.ok) throw new CloudHttpError(response.status, await detail(response));
  return await response.json() as T;
}

export interface SocketHandlers { command(message: Record<string, any>): void; open(): void; close(authFailed: boolean): void; }
export class CloudSocket {
  private socket: WebSocket | null = null; private stopped = true; private retry: NodeJS.Timeout | undefined; private ping: NodeJS.Timeout | undefined; private attempts = 0; private lastPong = 0;
  connected = false;
  constructor(private serverUrl: string, private sign: Signer, private handlers: SocketHandlers, private backoff = { baseMs: 1000, maxMs: 30000 }) {}
  start() { if (!this.stopped) return; this.stopped = false; this.open(); }
  stop() { this.stopped = true; clearTimeout(this.retry); clearInterval(this.ping); const socket = this.socket; this.socket = null; this.connected = false; socket?.removeAllListeners(); socket?.on('error', () => {}); socket?.terminate(); }
  reconnectNow() { if (this.stopped || this.connected) return; clearTimeout(this.retry); this.open(); }
  private open() {
    const url = new URL('/ws/device', this.serverUrl); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, { headers: this.sign('GET', '/ws/device', Buffer.alloc(0)), handshakeTimeout: TIMEOUT_MS, maxPayload: 1_000_000, followRedirects: false });
    this.socket = socket; let authFailed = false;
    socket.on('open', () => {
      this.connected = true; this.attempts = 0; this.lastPong = Date.now();
      this.ping = setInterval(() => { if (Date.now() - this.lastPong > 45000) { socket.terminate(); return; } if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' })); }, 15000);
      this.handlers.open();
    });
    socket.on('message', raw => { let message: any; try { message = JSON.parse(raw.toString()); } catch { return; } if (message?.type === 'pong') this.lastPong = Date.now(); else if (message?.type === 'command') this.handlers.command(message); });
    socket.on('unexpected-response', (_request, response) => { authFailed = response.statusCode === 401 || response.statusCode === 403; socket.terminate(); });
    socket.on('error', () => {});
    socket.on('close', code => {
      clearInterval(this.ping); if (this.socket !== socket) return;
      authFailed ||= code === 4401; const wasConnected = this.connected; this.connected = false; this.socket = null;
      if (wasConnected || authFailed) this.handlers.close(authFailed);
      if (this.stopped) return;
      const delay = Math.min(this.backoff.maxMs, this.backoff.baseMs * 2 ** this.attempts++) * (authFailed ? 2 : 1);
      this.retry = setTimeout(() => this.open(), delay);
    });
  }
}
