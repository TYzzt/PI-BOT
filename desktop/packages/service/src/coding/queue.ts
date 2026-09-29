import { monotonicMs } from './performance-log.js';

export interface ParallelBatch { occupancyMs: number; execSumMs: number; slots: number }
export interface Slot { queueMs: number; release: (execMs: number) => void }

export class RunQueue {
  private active = 0;
  private waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private waveStart = 0;
  private waveExec = 0;
  private waveCount = 0;
  constructor(
    private limit: number,
    private cancelled: () => boolean,
    private paused: () => boolean,
    private onBatch?: (batch: ParallelBatch) => void,
    signal?: AbortSignal,
  ) { signal?.addEventListener('abort', () => this.rejectWaiters(new Error('运行已停止')), { once: true }); }

  async acquire(): Promise<Slot> {
    const queued = monotonicMs();
    if (this.cancelled()) throw new Error('运行已停止');
    if (this.paused()) throw new Error('任务已暂停，不得继续调用工具');
    if (this.active >= this.limit) await new Promise<void>((resolve, reject) => { this.waiters.push({ resolve, reject }); });
    else this.reserve();
    if (this.cancelled() || this.paused()) {
      this.finishOne(0);
      throw new Error(this.cancelled() ? '运行已停止' : '任务已暂停，不得继续调用工具');
    }
    const queueMs = monotonicMs() - queued;
    let released = false;
    return { queueMs, release: (execMs: number) => { if (released) return; released = true; this.finishOne(execMs); } };
  }

  private reserve() {
    if (this.active === 0 && this.waveCount === 0) this.waveStart = monotonicMs();
    this.active++;
  }
  private grant() {
    if (this.cancelled()) { this.rejectWaiters(new Error('运行已停止')); return; }
    if (this.paused()) { this.rejectWaiters(new Error('任务已暂停，不得继续调用工具')); return; }
    while (this.waiters.length && this.active < this.limit) { this.reserve(); this.waiters.shift()!.resolve(); }
  }
  private rejectWaiters(error: Error) {
    const pending = this.waiters.splice(0);
    for (const waiter of pending) waiter.reject(error);
  }
  private finishOne(execMs: number) {
    this.waveExec += execMs;
    this.waveCount++;
    this.active = Math.max(0, this.active - 1);
    if (this.cancelled()) this.rejectWaiters(new Error('运行已停止'));
    else this.grant();
    if (this.active === 0 && this.waiters.length === 0 && this.waveCount > 0) {
      const batch = { occupancyMs: Math.max(0, monotonicMs() - this.waveStart), execSumMs: this.waveExec, slots: this.limit };
      this.waveExec = 0; this.waveCount = 0; this.waveStart = 0;
      try { this.onBatch?.(batch); } catch { /* batch stats must not break the run */ }
    }
  }
}
