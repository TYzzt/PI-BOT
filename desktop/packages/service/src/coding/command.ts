import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export interface CommandResult { code: number | null; cancelled: boolean; timedOut: boolean; interaction: boolean; elapsedMs: number; outputHead: string; outputTail: string; omittedChars: number; retained: string; }
export const commandPath = () => [...new Set([...(process.env.PATH ?? '').split(':'), '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean))].join(':');
export function command(command: string, cwd: string, timeoutMs: number, signal: AbortSignal | undefined, output: (stream: string, text: string, truncated?: boolean) => void): Promise<CommandResult> {
  const empty = { outputHead: '', outputTail: '', omittedChars: 0, retained: '' };
  if (signal?.aborted) return Promise.resolve({ code: null, cancelled: true, timedOut: false, interaction: false, elapsedMs: 0, ...empty });
  if (/(^|[;&|\s])sudo(?:\s|$)/.test(command)) return Promise.resolve({ code: null, cancelled: false, timedOut: false, interaction: true, elapsedMs: 0, ...empty });
  if (/\bgit\s+(?:[^;&|]*\s)?(?:commit|push|reset|clean)\b/.test(command) || /\b(?:nohup|disown)\b/.test(command)) throw new Error('不允许自动提交、推送、重置、清理或后台常驻命令');
  return new Promise((resolve, reject) => {
    const compiled = new URL('./command-worker.mjs', import.meta.url); const source = new URL('./command-worker.ts', import.meta.url);
    const isCompiled = existsSync(fileURLToPath(compiled));
    const worker = fork(fileURLToPath(isCompiled ? compiled : source), [], { execArgv: isCompiled ? [] : ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let result: CommandResult | undefined;
    const abort = () => { if (worker.connected) worker.send({ cancel: true }); };
    signal?.addEventListener('abort', abort, { once: true });
    worker.on('message', (m: any) => {
      if (!m.done) { output(m.stream ?? 'system', m.text ?? '', !!m.truncated); return; }
      if (!(m.omittedChars > 0)) { m.outputHead = m.retained ?? ''; m.outputTail = m.retained ?? ''; }
      else if (!m.retained) m.retained = `${m.outputHead ?? ''}\n[已省略 ${m.omittedChars} 个字符]\n${m.outputTail ?? ''}`;
      result = m;
    });
    worker.once('error', reject);
    worker.once('exit', () => { signal?.removeEventListener('abort', abort); if (result) resolve(result); else reject(new Error('命令监控进程中断')); });
    worker.send({ command, cwd, path: commandPath(), timeoutMs: Math.min(Math.max(timeoutMs, 1), 600000) });
    if (signal?.aborted) abort();
  });
}
