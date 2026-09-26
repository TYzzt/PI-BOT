export interface LockOwner { taskId: string; runId: string; }
export interface LockHolder extends LockOwner { since: number; }
interface Waiter { owner: LockOwner; grant: () => void; }

// One holder per Chrome profile. The same task re-enters freely; other tasks queue in arrival order.
export class ProfileLock {
  private current: LockHolder | null = null;
  private queue: Waiter[] = [];
  constructor(private timeoutMs = 60000) {}
  get holder(): LockHolder | null { return this.current ? { ...this.current } : null; }
  async acquire(owner: LockOwner, signal?: AbortSignal): Promise<void> {
    if (!this.current) { this.current = { ...owner, since: Date.now() }; return; }
    if (this.current.taskId === owner.taskId) { this.current.runId = owner.runId; return; }
    const busy = this.current.taskId;
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { owner, grant: () => { cleanup(); resolve(); } };
      const fail = (message: string) => { cleanup(); this.queue = this.queue.filter(w => w !== waiter); reject(new Error(message)); };
      const timer = setTimeout(() => fail(`浏览器正被任务 ${busy} 使用，等待 ${Math.round(this.timeoutMs / 1000)} 秒后仍未释放`), this.timeoutMs);
      const abort = () => fail('运行已停止');
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      this.queue.push(waiter);
    });
  }
  release(taskId: string): boolean {
    if (this.current?.taskId !== taskId) { this.queue = this.queue.filter(w => w.owner.taskId !== taskId); return false; }
    const next = this.queue.shift();
    this.current = next ? { ...next.owner, since: Date.now() } : null;
    next?.grant();
    return true;
  }
  owns(taskId: string) { return this.current?.taskId === taskId; }
}
