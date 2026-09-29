import { digest } from './workspace.js';

export type DuplicateKind = 'readonly' | 'command' | 'browser' | 'other';
export interface DuplicateNotice { hits: number; note?: string; shorten: boolean }

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as object).sort().map(key => [key, normalize((value as Record<string, unknown>)[key])]));
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  return value;
}

export class DuplicateTracker {
  private recent: string[] = [];
  private counts = new Map<string, number>();
  progress = 0;
  bump() { this.progress++; }
  observe(name: string, params: unknown, summary: string, kind: DuplicateKind, suppress = false): DuplicateNotice {
    if (suppress) return { hits: 0, shorten: false };
    const sig = digest([name, normalize(params), summary, this.progress]);
    this.recent.push(sig);
    this.counts.set(sig, (this.counts.get(sig) ?? 0) + 1);
    if (this.recent.length > 20) {
      const old = this.recent.shift()!;
      const next = (this.counts.get(old) ?? 1) - 1;
      if (next <= 0) this.counts.delete(old); else this.counts.set(old, next);
    }
    const hits = this.counts.get(sig) ?? 0;
    if (hits < 3) return { hits, shorten: false };
    const note = hits === 3
      ? '该操作与相同结果已出现 3 次。请改变搜索范围、读取窗口或诊断方法。'
      : '仍在重复同一操作和结果。请改变搜索范围、读取窗口或诊断方法。';
    return { hits, note, shorten: hits > 3 && kind === 'readonly' };
  }
}
