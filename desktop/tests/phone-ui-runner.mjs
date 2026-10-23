import { app, BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.PHONE_UI_DIR;
if (!dir) { process.stderr.write('missing PHONE_UI_DIR\n'); app.exit(2); }
app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

async function runPage(file) {
  const win = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: { contextIsolation: false, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
  });
  const logs = [];
  win.webContents.on('console-message', event => {
    const message = typeof event?.message === 'string' ? event.message : String(event?.message ?? '');
    if (message) logs.push(message);
  });
  await win.loadFile(join(dir, file));
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const result = await win.webContents.executeJavaScript('window.__phoneResult ?? null');
    if (result) { win.destroy(); return { result, logs }; }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  const snapshot = await win.webContents.executeJavaScript('({text: document.body ? document.body.innerText.slice(0, 800) : "", errors: window.__errors || []})').catch(error => ({ text: String(error), errors: [] }));
  win.destroy();
  return { result: { ok: false, failures: [{ name: file, message: `页面没有返回结果 ${JSON.stringify(snapshot)}` }] }, logs };
}

app.whenReady().then(async () => {
  try {
    const panel = await runPage('panel.html');
    const entry = await runPage('entry.html');
    const failures = [...(panel.result.failures ?? []), ...(entry.result.failures ?? [])];
    const payload = {
      ok: panel.result.ok === true && entry.result.ok === true,
      failures,
      panel: panel.result.scenarios ?? [],
      entryCalls: entry.result.calls ?? [],
      logs: [...panel.logs, ...entry.logs].slice(-30),
    };
    writeFileSync(join(dir, 'result.json'), JSON.stringify(payload, null, 2));
    app.exit(payload.ok ? 0 : 1);
  } catch (error) {
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ ok: false, failures: [{ name: 'runner', message: error instanceof Error ? error.stack || error.message : String(error) }] }, null, 2));
    app.exit(1);
  }
}).catch(error => {
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ ok: false, failures: [{ name: 'ready', message: String(error) }] }, null, 2));
  app.exit(1);
});
setTimeout(() => { try { writeFileSync(join(dir, 'result.json'), JSON.stringify({ ok: false, failures: [{ name: 'runner', message: 'Electron 超时' }] }, null, 2)); } catch { /* already exiting */ } app.exit(2); }, 70000);
