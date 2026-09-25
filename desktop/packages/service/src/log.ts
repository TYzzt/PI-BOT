import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Only fixed event names and timestamps are accepted; no prompts, headers or provider errors.
export function createLog(dataDir: string) {
  const directory = join(dataDir, 'logs'), path = join(directory, 'service.log');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return (event: 'service.started' | 'service.stopping') => {
    try {
      try { if (statSync(path).size > 1_000_000) renameSync(path, path + '.1'); } catch {}
      appendFileSync(path, JSON.stringify({ time: new Date().toISOString(), event }) + '\n', { mode: 0o600 });
    } catch { /* Logging must not interrupt a conversation. */ }
  };
}
