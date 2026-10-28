import { randomUUID } from 'node:crypto';
import { nativeWindows, protectWindowsDirectory } from './windows.js';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
export interface Credentials { get(id: string): Promise<string | null>; set(id: string, value: string): Promise<void>; delete(id: string): Promise<void>; }
// Local secret file. The running service uses this instead of macOS Keychain, which prompts on every unsigned helper rebuild.
export class FileCredentials implements Credentials {
  constructor(private file: string) {}
  private load(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    const stat = lstatSync(this.file);
    if (!stat.isFile() || stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('凭据文件不安全');
    if (process.platform === 'win32') {
      protectWindowsDirectory(dirname(this.file));
      nativeWindows('protect-file', Buffer.from(this.file, 'utf8'));
    } else chmodSync(this.file, 0o600);
    const raw = readFileSync(this.file);
    const parsed = JSON.parse((process.platform === 'win32' ? nativeWindows('decrypt', raw) : raw).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      if (process.platform === 'win32') throw new Error('加密凭据内容无效');
      return {};
    }
    if (process.platform === 'win32' && Object.values(parsed).some(value => typeof value !== 'string')) throw new Error('加密凭据内容无效');
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  }
  private save(data: Record<string, string>) {
    if (process.platform === 'win32') protectWindowsDirectory(dirname(this.file));
    else mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    const plain = Buffer.from(JSON.stringify(data));
    try { writeFileSync(tmp, process.platform === 'win32' ? nativeWindows('encrypt', plain) : plain, { mode: 0o600, flag: 'wx' }); }
    finally { plain.fill(0); }
    if (process.platform !== 'win32') chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
    if (process.platform !== 'win32') chmodSync(this.file, 0o600);
  }
  async get(id: string) { return this.load()[id] ?? null; }
  async set(id: string, value: string) { const data = this.load(); data[id] = value; this.save(data); }
  async delete(id: string) { const data = this.load(); delete data[id]; this.save(data); }
}
// Process-local fallback so an unpaired service never needs the device Keychain entry.
export class MemoryCredentials implements Credentials { private values = new Map<string, string>(); async get(id: string) { return this.values.get(id) ?? null; } async set(id: string, value: string) { this.values.set(id, value); } async delete(id: string) { this.values.delete(id); } }
export class Keychain implements Credentials {
  constructor(private binary: string, private service = 'dev.pi-bot.device') {}
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
