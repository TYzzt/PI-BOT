import { connect, type Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { AppEvent, Method } from '../../../packages/protocol/src/index.js';
import { socketPath, tokenPath } from '../../../packages/service/src/paths.js';
export class ServiceClient {
  private socket?: Socket; private connected = false; private stopped = false;
  private timer?: NodeJS.Timeout; private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private emit: (event: AppEvent) => void) {}
  start() {
    if (this.stopped) return;
    let token: string; try { token = readFileSync(tokenPath, 'utf8'); } catch { this.schedule(); return; }
    const socket = connect(socketPath); this.socket = socket; socket.setEncoding('utf8'); let buffer = '';
    socket.once('connect', () => socket.write(JSON.stringify({ token }) + '\n'));
    socket.on('data', (data: string) => {
      buffer += data; if (buffer.length > 4_000_000) { socket.destroy(); return; }
      let i; while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        try { const p = JSON.parse(line); if (p.ready) { this.connected = true; this.emit({ type: 'service.status', connected: true }); }
          else if (p.event) this.emit(p.event);
          else { const pending = this.pending.get(p.id); if (pending) { clearTimeout(pending.timer); this.pending.delete(p.id); if (p.error) pending.reject(new Error(p.error)); else pending.resolve(p.result); } }
        } catch { socket.destroy(); }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => { this.connected = false; this.emit({ type: 'service.status', connected: false }); for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('本地服务连接中断，请重连后检查运行状态')); } this.pending.clear(); this.schedule(); });
  }
  private schedule() { if (!this.stopped) this.timer = setTimeout(() => this.start(), 1000); }
  call(method: Method, input: unknown): Promise<unknown> {
    if (!this.connected || !this.socket) return Promise.reject(new Error('本地服务尚未连接'));
    return new Promise((resolve, reject) => { const id = randomUUID(); const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('请求超时，请检查服务和运行状态')); }, 150000); this.pending.set(id, { resolve, reject, timer }); this.socket!.write(JSON.stringify({ id, method, input }) + '\n'); });
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.socket?.destroy(); }
}
