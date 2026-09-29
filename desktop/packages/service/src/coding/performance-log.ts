import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function monotonicMs() { return Number(process.hrtime.bigint() / 1_000_000n); }

export interface TokenUsage { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }
const usageKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const;
const fields = ['kind', 'taskId', 'runId', 'callId', 'name', 'round', 'durationMs', 'queueMs', 'execMs', 'parallel', 'duplicateHits', 'occupancyMs', 'execSumMs', 'slots', 'inputChars', 'outputChars', 'wallMs', 'modelRoundMs', 'toolExecSumMs', 'toolOccupancyMs', 'compactionMs'] as const;

function sanitize(event: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { time: new Date().toISOString() };
  for (const key of fields) if (event[key] !== undefined) out[key] = event[key];
  if ('usage' in event) {
    const raw = event.usage;
    if (!raw || typeof raw !== 'object') out.usage = null;
    else {
      const usage: Record<string, number> = {};
      for (const key of usageKeys) { const value = (raw as Record<string, unknown>)[key]; if (typeof value === 'number' && Number.isFinite(value)) usage[key] = value; }
      out.usage = Object.keys(usage).length ? usage : null;
    }
  }
  return out;
}

export function createPerformanceLog(dataDir: string, maxBytes = 5 * 1024 * 1024) {
  const path = join(dataDir, 'logs', 'coding-performance.jsonl');
  const totals = { modelRoundMs: 0, toolExecSumMs: 0, toolOccupancyMs: 0, compactionMs: 0, inputChars: 0, outputChars: 0, duplicateHits: 0, usage: null as TokenUsage | null };
  const addUsage = (usage: TokenUsage | null) => {
    if (!usage) return;
    if (!totals.usage) totals.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    for (const key of usageKeys) totals.usage[key] += usage[key];
  };
  const write = (event: Record<string, unknown>) => {
    try {
      const line = sanitize(event);
      if (line.kind === 'model_round') {
        totals.modelRoundMs += Number(line.durationMs) || 0;
        totals.inputChars += Number(line.inputChars) || 0;
        totals.outputChars += Number(line.outputChars) || 0;
        addUsage(line.usage as TokenUsage | null);
      } else if (line.kind === 'tool') {
        totals.toolExecSumMs += Number(line.execMs) || 0;
        if (!line.parallel) totals.toolOccupancyMs += Number(line.execMs) || 0;
        totals.duplicateHits += Number(line.duplicateHits) || 0;
      } else if (line.kind === 'parallel_batch') totals.toolOccupancyMs += Number(line.occupancyMs) || 0;
      else if (line.kind === 'compaction') totals.compactionMs += Number(line.durationMs) || 0;
      mkdirSync(join(dataDir, 'logs'), { recursive: true, mode: 0o700 });
      try {
        if (existsSync(path) && statSync(path).size >= maxBytes) {
          rmSync(path + '.3', { force: true });
          if (existsSync(path + '.2')) renameSync(path + '.2', path + '.3');
          if (existsSync(path + '.1')) renameSync(path + '.1', path + '.2');
          renameSync(path, path + '.1');
        }
      } catch { /* rotation failure still attempts the append */ }
      appendFileSync(path, JSON.stringify(line) + '\n', { mode: 0o600 });
    } catch { /* Logging must not interrupt a coding run. */ }
  };
  return {
    path,
    write,
    summary(info: { taskId: string; runId: string; wallMs: number }) {
      write({
        kind: 'run_summary', taskId: info.taskId, runId: info.runId, wallMs: info.wallMs,
        modelRoundMs: totals.modelRoundMs, toolExecSumMs: totals.toolExecSumMs, toolOccupancyMs: totals.toolOccupancyMs,
        compactionMs: totals.compactionMs, inputChars: totals.inputChars, outputChars: totals.outputChars,
        duplicateHits: totals.duplicateHits, usage: totals.usage,
      });
    },
  };
}
export type PerformanceLog = ReturnType<typeof createPerformanceLog>;
