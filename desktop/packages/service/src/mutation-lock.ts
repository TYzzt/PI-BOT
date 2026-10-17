/** One FIFO lock per library. Aborted waiters never acquire or strand the lock. */
const tails = new Map<string, Promise<void>>();

export async function withLibraryMutation<T>(root: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  if (signal?.aborted) throw new Error('CANCELLED');
  const previous = tails.get(root) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>(resolve => { release = resolve; });
  tails.set(root, next);
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('CANCELLED'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  try {
    await Promise.race([previous, cancelled]);
    if (signal?.aborted) throw new Error('CANCELLED');
    return await work();
  } finally {
    signal?.removeEventListener('abort', abort);
    // A cancelled waiter must keep its place until its predecessor releases.
    void previous.then(() => {
      release();
      if (tails.get(root) === next) tails.delete(root);
    });
  }
}
