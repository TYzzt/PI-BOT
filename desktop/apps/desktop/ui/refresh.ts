/** Collapse event bursts into one refresh, with one follow-up for events received while loading. */
export function createRefreshScheduler(load: () => Promise<unknown>, onError: (error: unknown) => void, delayMs = 120) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false, dirty = false, stopped = false;
  const perform = async () => {
    timer = undefined;
    if (stopped) return;
    running = true; dirty = false;
    try { await load(); } catch (error) { if (!stopped) onError(error); }
    finally { running = false; if (dirty && !stopped) request(); }
  };
  const request = (immediate = false) => {
    if (stopped) return;
    dirty = true;
    if (running || timer) return;
    if (immediate) void perform(); else timer = setTimeout(() => void perform(), delayMs);
  };
  return { request, stop: () => { stopped = true; clearTimeout(timer); timer = undefined; } };
}
