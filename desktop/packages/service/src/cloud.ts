import WebSocket from 'ws';
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

export class CloudHttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export class CloudNetworkError extends Error {}
const TIMEOUT_MS = 15000;

export interface DeviceIdentity { privateKey: string; publicKey: string }
export function newIdentity(): DeviceIdentity {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') };
}
export type Signer = (method: string, path: string, body: Buffer) => Record<string, string>;
export function signer(deviceId: string, privateKey: string): Signer {
  const key: KeyObject = createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  return (method, path, body) => {
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString('hex');
    const message = `${timestamp}.${nonce}.${method.toUpperCase()}.${path}.${createHash('sha256').update(body).digest('hex')}`;
    return { 'x-pibot-device-id': deviceId, 'x-pibot-timestamp': timestamp, 'x-pibot-nonce': nonce, 'x-pibot-signature': sign(null, Buffer.from(message), key).toString('base64') };
  };
}

export function checkServerUrl(serverUrl: string) {
  const url = new URL(serverUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new CloudNetworkError('服务器地址必须使用 HTTPS');
  if (url.username || url.password || url.search || url.hash) throw new CloudNetworkError('服务器地址格式不正确');
  return url.href.replace(/\/+$/, '');
}

// Only the server's short `detail` string is surfaced; bodies, headers and credentials never reach errors or logs.
async function detail(response: Response) {
  try {
    const json = await response.json() as { detail?: unknown };
    if (typeof json.detail === 'string') return json.detail.slice(0, 300);
    if (Array.isArray(json.detail)) return json.detail.map(d => (d && typeof d === 'object' && 'msg' in d ? String(d.msg) : '')).filter(Boolean).join('；').slice(0, 300) || '参数无效';
  } catch { /* Non-JSON error body is ignored. */ }
  return `服务器拒绝请求（HTTP ${response.status}）`;
}
/** `path` is signed exactly as given, without the server URL's path prefix. */
export async function cloudFetch<T>(serverUrl: string, method: string, path: string, options: { body?: unknown; headers?: Record<string, string>; signer?: Signer; timeoutMs?: number } = {}): Promise<T> {
  const base = checkServerUrl(serverUrl);
  const body = options.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(options.body), 'utf8');
  const headers: Record<string, string> = { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers, ...(options.signer ? options.signer(method, path.split('?')[0], body) : {}) };
  let response: Response;
  try { response = await fetch(base + path, { method, headers, body: options.body === undefined ? undefined : body, signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS), redirect: 'error' }); }
  catch { throw new CloudNetworkError('无法连接服务器'); }
  if (!response.ok) throw new CloudHttpError(response.status, await detail(response));
  return await response.json() as T;
}

export interface SocketHandlers { message(message: Record<string, any>): void; open(): void; close(authFailed: boolean): void }
/** The harness connection: runs, cancels, approvals and file RPCs arrive here. */
export class CloudSocket {
  private socket: WebSocket | null = null; private stopped = true; private retry: NodeJS.Timeout | undefined; private ping: NodeJS.Timeout | undefined; private attempts = 0; private lastPong = 0;
  connected = false;
  constructor(private serverUrl: string, private sign: Signer, private handlers: SocketHandlers, private backoff = { baseMs: 1000, maxMs: 30000 }) {}
  start() { if (!this.stopped) return; this.stopped = false; this.open(); }
  stop() { this.stopped = true; clearTimeout(this.retry); clearInterval(this.ping); const socket = this.socket; this.socket = null; this.connected = false; socket?.removeAllListeners(); socket?.on('error', () => {}); socket?.terminate(); }
  reconnectNow() { if (this.stopped || this.connected) return; clearTimeout(this.retry); this.attempts = 0; this.open(); }
  send(message: Record<string, unknown>) { if (this.socket?.readyState === WebSocket.OPEN) { this.socket.send(JSON.stringify(message)); return true; } return false; }
  private open() {
    const url = new URL(`${this.serverUrl.replace(/\/$/, '')}/ws/device`); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, { headers: this.sign('GET', '/ws/device', Buffer.alloc(0)), handshakeTimeout: TIMEOUT_MS, maxPayload: 8_000_000, followRedirects: false });
    this.socket = socket; let authFailed = false;
    socket.on('open', () => {
      this.attempts = 0; this.lastPong = Date.now();
      this.ping = setInterval(() => { if (Date.now() - this.lastPong > 45000) { socket.terminate(); return; } if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' })); }, 15000);
    });
    socket.on('message', raw => {
      let message: any; try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message?.type === 'pong') this.lastPong = Date.now();
      else if (message?.type === 'hello') { this.connected = true; this.handlers.open(); }
      else this.handlers.message(message);
    });
    socket.on('unexpected-response', (_request, response) => { authFailed = response.statusCode === 401 || response.statusCode === 403; socket.terminate(); });
    socket.on('error', () => {});
    socket.on('close', code => {
      clearInterval(this.ping); if (this.socket !== socket) return;
      authFailed ||= code === 4401; const wasConnected = this.connected; this.connected = false; this.socket = null;
      if (wasConnected || authFailed) this.handlers.close(authFailed);
      if (this.stopped || authFailed) return;
      const delay = Math.min(this.backoff.maxMs, this.backoff.baseMs * 2 ** this.attempts++);
      this.retry = setTimeout(() => this.open(), code === 4409 ? Math.max(delay, 5000) : delay);
    });
  }
}
