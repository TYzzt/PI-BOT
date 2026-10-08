import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { dataDir } from '../../../packages/service/src/paths.js';
import { pathToFileURL } from 'node:url';
import { ServiceClient } from './service-client.js';
import { parseInput, type Method } from '../../../packages/protocol/src/index.js';

mkdirSync(join(dataDir, 'electron'), { recursive: true, mode: 0o700 });
app.setPath('userData', join(dataDir, 'electron'));
let window: BrowserWindow | null = null;
let serviceProcess: ChildProcess | undefined;
const page = pathToFileURL(join(__dirname, '../ui-dist/index.html')).href;
const client = new ServiceClient(event => window?.webContents.send('agent:event', event));
function validSender(event: Electron.IpcMainInvokeEvent) { if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page) throw new Error('不受信任的 IPC 来源'); }
const CLOUD_SERVER_URL = 'https://aicloud-app.lenovo.com.cn/tagent';
function computerName() {
  try {
    const name = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }).trim();
    if (name) return name.slice(0, 80);
  } catch { /* 取不到电脑名称时用主机名。 */ }
  return (hostname().replace(/\.local$/, '') || 'Mac').slice(0, 80);
}
function startBundledService() {
  if (!app.isPackaged) return;
  const root = join(process.resourcesPath, 'runtime');
  serviceProcess = spawn(join(root, 'bin', 'node'), [join(root, 'server.mjs')], {
    cwd: root,
    env: { ...process.env, T_AGNET_KEYCHAIN_HELPER: join(root, 'keychain') },
    stdio: 'ignore',
  });
  serviceProcess.on('error', () => {});
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.setName('T-AGNET');
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(() => {
    ipcMain.handle('agent:chooseProjectDirectory', async event => { validSender(event); const result = await dialog.showOpenDialog(window!, { title: '选择 Git 项目目录', properties: ['openDirectory'] }); return result.canceled ? null : result.filePaths[0] ?? null; });
    ipcMain.handle('agent:computerName', event => { validSender(event); return computerName(); });
    ipcMain.handle('agent:cloudServerUrl', event => { validSender(event); return process.env.T_AGNET_SHARED_URL || CLOUD_SERVER_URL; });
    ipcMain.handle('agent:call', async (event, method: Method, input: unknown) => { validSender(event); return client.call(method, parseInput(method, input)); });
    ipcMain.handle('agent:openExternal', async (event, url: string) => { validSender(event); const parsed = new URL(url); if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('不支持此链接'); await shell.openExternal(parsed.href); });
    const createWindow = () => {
      window = new BrowserWindow({ width: 1160, height: 800, minWidth: 880, minHeight: 600, title: 'T-AGNET', backgroundColor: '#f7f8fa', titleBarStyle: 'hiddenInset', webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      window.on('closed', () => { window = null; });
      void window.loadURL(page);
    };
    startBundledService(); createWindow(); client.start();
    app.on('activate', () => { if (!window) createWindow(); });
  }).catch(() => { dialog.showErrorBox('启动失败', '无法启动桌面应用，请查看开发终端'); app.quit(); });
  app.on('before-quit', () => { client.stop(); serviceProcess?.kill('SIGTERM'); });
  app.on('window-all-closed', () => { /* macOS keeps UI process alive until Cmd+Q */ });
}
