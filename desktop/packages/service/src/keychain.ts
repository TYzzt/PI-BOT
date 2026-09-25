import { spawn } from 'node:child_process';
export interface Credentials { get(id: string): Promise<string | null>; set(id: string, value: string): Promise<void>; delete(id: string): Promise<void>; }
// Process-local fallback so an unpaired service never needs the device Keychain entry.
export class MemoryCredentials implements Credentials { private values = new Map<string, string>(); async get(id: string) { return this.values.get(id) ?? null; } async set(id: string, value: string) { this.values.set(id, value); } async delete(id: string) { this.values.delete(id); } }
export class Keychain implements Credentials {
  constructor(private binary: string, private service = 'dev.t-agnet.models') {}
  private request(operation: string, account: string, value?: string): Promise<{ value?: string | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Keychain 响应超时，请在本机完成授权')); }, 60000);
      child.stdout.on('data', b => { output += b.toString(); }); child.stderr.resume();
      child.on('error', () => { clearTimeout(timer); reject(new Error('无法启动 Keychain helper')); });
      child.on('close', code => { clearTimeout(timer); try { const result = JSON.parse(output); if (code !== 0 || result.error) reject(new Error(result.error || 'Keychain 操作失败')); else resolve(result); } catch { reject(new Error('Keychain 返回无效响应')); } });
      child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify({ operation, account, value, service: this.service }));
    });
  }
  async get(id: string) { return (await this.request('get', id)).value ?? null; }
  async set(id: string, value: string) { await this.request('set', id, value); }
  async delete(id: string) { await this.request('delete', id); }
}
