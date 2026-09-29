import { spawn, type ChildProcess } from 'node:child_process';
import { OutputBuffer } from './text-limit.js';
let child: ChildProcess | undefined, killed = false, timedOut = false, interaction = false, closing = false;
let truncationSent = false;
function send(message: unknown, after?: () => void) {
  if (!process.connected) { after?.(); return; }
  try { process.send?.(message as any, () => after?.()); }
  catch { after?.(); }
}
let timeout: NodeJS.Timeout | undefined, force: NodeJS.Timeout | undefined;
function group(signal: NodeJS.Signals) { if (child?.pid) { try { process.kill(-child.pid, signal); } catch {} } }
function stop() { killed = true; group('SIGTERM'); force ??= setTimeout(() => group('SIGKILL'), 1000); }
process.on('disconnect', () => { if (closing) return; stop(); setTimeout(() => process.exit(1), 1500); });
process.on('SIGTERM', stop); process.on('SIGINT', stop);
process.on('message', (m: any) => {
  if (m.cancel) { stop(); return; }
  if (child || !m.command) return;
  if (killed) { send({ done: true, code: null, cancelled: true }, () => { if (process.connected) process.disconnect(); }); return; }
  const start = Date.now();
  child = spawn('/bin/zsh', ['-c', 'set -e; set -o pipefail;\n' + m.command], { cwd: m.cwd, env: { ...process.env, PATH: m.path, GIT_TERMINAL_PROMPT: '0', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  timeout = setTimeout(() => { timedOut = true; stop(); }, m.timeoutMs);
  let bytes = 0, tail = '';
  const retained = new OutputBuffer();
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]] as const) {
    stream?.setEncoding('utf8'); stream?.on('data', (text: string) => {
      tail = (tail + text).slice(-2000);
      retained.push(`[${name}] ${text}`);
      if (/(?:password|passphrase|verification code|authentication required|enter.*(?:token|code)|密码|验证码)\s*[:：]?\s*$/im.test(tail)) { interaction = true; stop(); }
      if (bytes < 128000) { const limited = text.slice(0, 128000 - bytes); bytes += limited.length; send({ stream: name, text: limited, truncated: text.length > limited.length }); }
      else if (!truncationSent) { truncationSent = true; send({ truncated: true }); }
    });
  }
  const finish = (code: number | null) => {
    if (closing) return; closing = true; clearTimeout(timeout); group('SIGTERM');
    // Reap any descendants before reporting completion; detached background jobs are unsupported.
    setTimeout(() => {
      group('SIGKILL'); clearTimeout(force);
      const snap = retained.snapshot();
      // One copy of the text. Disconnect only after it is queued, or a large result is dropped.
      const omitted = snap.omittedChars > 0;
      send({ done: true, code, cancelled: killed && !timedOut && !interaction, timedOut, interaction, elapsedMs: Date.now() - start, outputHead: omitted ? snap.head : '', outputTail: omitted ? snap.tail : '', omittedChars: snap.omittedChars, retained: omitted ? '' : snap.body }, () => { if (process.connected) process.disconnect(); });
    }, 250);
  };
  child.on('error', () => finish(null)); child.on('close', finish);
});
