import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = dirname(here);
const require = createRequire(import.meta.url);

test('mounted phone entry and panel do not acquire until asked, and release on switch, close, or background', async () => {
  const scratch = join(desktop, 'test-results');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'phone-ui-'));
  try {
    await esbuild.build({
      absWorkingDir: desktop,
      entryPoints: [join(here, 'phone-panel.harness.tsx')],
      bundle: true, format: 'iife', platform: 'browser', outfile: join(dir, 'panel.js'),
      jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"development"' },
    });
    await esbuild.build({
      absWorkingDir: desktop,
      entryPoints: [join(desktop, 'apps/desktop/ui/main.tsx')],
      bundle: true, format: 'iife', platform: 'browser', outfile: join(dir, 'app.js'),
      jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' },
    });
    cpSync(join(here, 'phone-entry-mock.js'), join(dir, 'entry-mock.js'));
    cpSync(join(here, 'phone-entry-driver.js'), join(dir, 'entry-driver.js'));
    writeFileSync(join(dir, 'panel.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="panel.js"></script>');
    writeFileSync(join(dir, 'entry.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="entry-mock.js"></script><script src="app.js"></script><script src="entry-driver.js"></script>');
    const electron = require('electron') as string;
    const child = spawn(electron, ['--no-sandbox', '--disable-gpu', '--headless=new', join(here, 'phone-ui-runner.mjs')], {
      env: { ...process.env, PHONE_UI_DIR: dir, ELECTRON_DISABLE_SANDBOX: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const exit = await new Promise<number>(resolve => child.once('exit', code => resolve(code ?? 1)));
    const resultPath = join(dir, 'result.json');
    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as { ok?: boolean; failures?: Array<{ name: string; message: string }>; logs?: string[] };
    assert.equal(result.ok, true, JSON.stringify({ exit, failures: result.failures, logs: result.logs, stderr: stderr.slice(-2000), stdout: stdout.slice(-1000) }, null, 2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

