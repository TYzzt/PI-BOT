import type { FileVersion } from './workspace.js';

export interface ReadCacheEntry {
  realPath: string;
  relativePath: string;
  version: FileVersion;
  startLine: number;
  maxLines: number;
  callId: string;
  versionKey: string;
  inContext: boolean;
}

export class ReadCache {
  private entries = new Map<string, ReadCacheEntry>();
  private key(realPath: string, startLine: number, maxLines: number) { return `${realPath}\0${startLine}\0${maxLines}`; }
  find(realPath: string, startLine: number, maxLines: number) { return this.entries.get(this.key(realPath, startLine, maxLines)); }
  remember(entry: ReadCacheEntry) { this.entries.set(this.key(entry.realPath, entry.startLine, entry.maxLines), entry); }
  invalidateRealPath(realPath: string) { for (const [key, entry] of this.entries) if (entry.realPath === realPath) this.entries.delete(key); }
  invalidateAll() { this.entries.clear(); }
  clearInContext() { for (const entry of this.entries.values()) entry.inContext = false; }
}

export class VerificationMemory {
  private last: { command: string; exitCode: number | null; stale: boolean } | null = null;
  markStale() { if (this.last) this.last.stale = true; }
  hint(command: string) {
    if (!this.last || this.last.command !== command) return null;
    return this.last.stale
      ? `上次该验证命令退出码为 ${this.last.exitCode}，此后工作区可能已变化，本次已重新执行。`
      : `上次该验证命令退出码为 ${this.last.exitCode}，期间没有新的写入或其他命令，本次仍重新执行。`;
  }
  record(command: string, exitCode: number | null) { this.last = { command, exitCode, stale: false }; }
}
