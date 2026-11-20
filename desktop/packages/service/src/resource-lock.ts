import { relative, isAbsolute, sep } from 'node:path';

export type WaitReason = 'host_shell' | 'file_resource' | 'desktop_input';
export type Access = { kind: 'shell' | 'input' } | { kind: 'file'; path: string; mode: 'read' | 'write' };
type Entry = { access: Access; admit: () => void };

function contains(parent: string, path: string) {
  const delta = relative(parent, path);
  return !isAbsolute(delta) && delta !== '..' && !delta.startsWith('..' + sep);
}

function conflict(a: Access, b: Access): WaitReason | undefined {
  if (a.kind === 'shell' || b.kind === 'shell') return 'host_shell';
  if (a.kind === 'input' && b.kind === 'input') return 'desktop_input';
  if (a.kind === 'file' && b.kind === 'file' && (a.mode === 'write' || b.mode === 'write') &&
      (contains(a.path, b.path) || contains(b.path, a.path))) return 'file_resource';
}

/** Independent requests can bypass waiters; conflicting requests remain FIFO. */
export class ResourceLocks {
  private active = new Set<Entry>();
  private queue: Entry[] = [];

  private drain() {
    const blocked: Entry[] = [];
    for (const entry of this.queue) {
      if ([...this.active, ...blocked].some(other => conflict(entry.access, other.access))) blocked.push(entry);
      else { this.active.add(entry); entry.admit(); }
    }
    this.queue = blocked;
  }

  async run<T>(access: Access, signal: AbortSignal | undefined, work: () => Promise<T>, waiting?: (reason: WaitReason) => void): Promise<T> {
    if (signal?.aborted) throw new Error('CANCELLED');
    let admit!: () => void;
    let reject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, fail) => { admit = resolve; reject = fail; });
    const entry = { access, admit };
    const abort = () => {
      if (!this.queue.includes(entry)) return;
      this.queue = this.queue.filter(other => other !== entry);
      reject(new Error('CANCELLED'));
      this.drain();
    };
    const reason = [...this.active, ...this.queue].map(other => conflict(access, other.access)).find(Boolean);
    this.queue.push(entry);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      this.drain();
      await (reason ? Promise.all([ready, Promise.resolve().then(() => waiting?.(reason))]) : ready);
      if (signal?.aborted) throw new Error('CANCELLED');
      return await work();
    } finally {
      signal?.removeEventListener('abort', abort);
      this.queue = this.queue.filter(other => other !== entry);
      this.active.delete(entry);
      this.drain();
    }
  }
}

export const deviceResources = new ResourceLocks();
