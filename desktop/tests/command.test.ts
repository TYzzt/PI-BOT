import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { command } from '../packages/service/src/coding/command.js';
import { eventually, temp } from './helpers.js';

test('managed commands: success, failure, timeout, interaction, truncation and cancellation', { timeout: 30000 }, async () => {
  const dir = temp();
  try {
    let output = '';
    const ok = await command('printf success', dir.path, 5000, undefined, (_, text) => output += text); assert.equal(ok.code, 0); assert.equal(output, 'success');
    assert.equal((await command('false; echo masked', dir.path, 5000, undefined, () => {})).code, 1);
    assert.equal((await command('exit 7', dir.path, 5000, undefined, () => {})).code, 7);
    assert.equal((await command('/bin/sleep 5', dir.path, 50, undefined, () => {})).timedOut, true);
    assert.equal((await command('sudo whoami', dir.path, 5000, undefined, () => {})).interaction, true);
    assert.equal((await command("printf 'Password:'; /bin/sleep 5", dir.path, 5000, undefined, () => {})).interaction, true);
    let truncated = false, length = 0;
    await command("node -e \"process.stdout.write('a'.repeat(200000))\"", dir.path, 5000, undefined, (_, text, trim) => { length += text.length; truncated ||= !!trim; }); assert.ok(length <= 128000); assert.ok(truncated);
    const controller = new AbortController(); let pid = 0;
    const pending = command("echo $$; /bin/sleep 30", dir.path, 10000, controller.signal, (_, text) => { pid ||= Number(text.trim()); });
    await eventually(() => pid > 0); controller.abort(); assert.equal((await pending).cancelled, true); assert.throws(() => process.kill(pid, 0));
    assert.throws(() => command('git reset --hard', dir.path, 1000, undefined, () => {}), /不允许/);
  } finally { dir.cleanup(); }
});

test('command supervisor terminates shell when its service process is killed', { timeout: 20000 }, async () => {
  const dir = temp(); let runner: ReturnType<typeof spawn> | undefined; let pid = 0;
  try {
    const moduleUrl = new URL('../packages/service/src/coding/command.ts', import.meta.url).href;
    const script = `import {command} from ${JSON.stringify(moduleUrl)}; await command('echo $$; /bin/sleep 30', ${JSON.stringify(dir.path)}, 30000, undefined, (_, text) => process.stdout.write(text));`;
    runner = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] });
    runner.stdout!.on('data', data => { pid ||= Number(data.toString().trim()); });
    await eventually(() => pid > 0); runner.kill('SIGKILL');
    await eventually(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 8000);
  } finally { runner?.kill('SIGKILL'); dir.cleanup(); }
});
