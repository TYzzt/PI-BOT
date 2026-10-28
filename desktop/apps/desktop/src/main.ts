import { ClientUpdater } from './client-updater.js';
import { hasActiveWork } from './update-policy.js';
import { protectWindowsDirectory } from '../../../packages/service/src/windows.js';
import { app, BrowserWindow, ipcMain, shell, dialog, nativeImage } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { join, basename, dirname } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dataDir, libraryRoot } from '../../../packages/service/src/paths.js';
import { libraryDir } from '../../../packages/service/src/library.js';
import { ServiceClient, serviceRunning } from './service-client.js';
import { computerName } from '../../../packages/service/src/platform.js';
import { parseInput, type Method } from '../../../packages/protocol/src/index.js';

if (process.platform === 'win32') {
  if (app.isPackaged) process.env.PI_BOT_WINDOWS_HELPER = join(process.resourcesPath, 'runtime', 'pi-bot-windows.exe');
  if (!existsSync(process.env.PI_BOT_WINDOWS_HELPER || '')) { dialog.showErrorBox('安装不完整', '缺少 Windows 安全 helper，请重新安装完整测试包。'); app.exit(1); }
  protectWindowsDirectory(dataDir);
}
mkdirSync(join(dataDir, 'electron'), { recursive: true, mode: 0o700 });
app.setPath('userData', join(dataDir, 'electron'));
let window: BrowserWindow | null = null;
let serviceProcess: ChildProcess | undefined;
let quitting = false;
const page = pathToFileURL(join(__dirname, '../ui-dist/index.html')).href;
const iconPath = join(__dirname, '../assets/pi-bot.png');
const client = new ServiceClient(event => window?.webContents.send('agent:event', event));
function validSender(event: Electron.IpcMainInvokeEvent) { if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page) throw new Error('不受信任的 IPC 来源'); }
declare const __PI_BOT_BUILD__: { version: string; buildNumber: number };
const identity = typeof __PI_BOT_BUILD__ === 'undefined' ? { version: app.getVersion(), buildNumber: 0 } : __PI_BOT_BUILD__;
const updater = new ClientUpdater(join(dataDir, 'updates'), identity.version, identity.buildNumber);
const DEFAULT_SERVER_URL = 'http://127.0.0.1:8000';
async function startBundledService() {
  if (!app.isPackaged || serviceProcess) return;
  if (await serviceRunning()) return;
  const root = join(process.resourcesPath, 'runtime');
  serviceProcess = spawn(join(root, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'), [join(root, 'server.mjs')], {
    cwd: root,
    detached: false,
    windowsHide: true,
    env: { ...process.env, PI_BOT_PARENT_LEASE: '1', ...(process.platform === 'darwin' ? { PI_BOT_KEYCHAIN_HELPER: join(root, 'keychain') } : {}) },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  serviceProcess.stdin?.on('error', () => {});
  let diagnostic = '';
  serviceProcess.stderr?.on('data', b => { diagnostic = (diagnostic + b.toString()).slice(-2000); });
  serviceProcess.on('error', () => { dialog.showErrorBox('本地服务启动失败', '无法启动随包 Node 运行时，请检查安装是否完整。'); });
  serviceProcess.on('exit', code => {
    if (!quitting && code !== 0) dialog.showErrorBox('本地服务已停止', diagnostic || `服务退出码：${code}`);
  });
}
function present(target: BrowserWindow) {
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  app.focus({ steal: true });
}
const squirrelEvent = process.argv[1];
if (process.platform === 'win32' && ['--squirrel-install', '--squirrel-updated', '--squirrel-uninstall', '--squirrel-obsolete'].includes(squirrelEvent)) {
  if (squirrelEvent === '--squirrel-obsolete') app.quit();
  else {
    const updater = spawn(join(dirname(process.execPath), '..', 'Update.exe'), [squirrelEvent === '--squirrel-uninstall' ? '--removeShortcut' : '--createShortcut', basename(process.execPath)], { windowsHide: true });
    updater.once('error', () => app.quit()); updater.once('exit', () => app.quit());
    setTimeout(() => app.quit(), 10000).unref();
  }
} else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.setName('Pi Bot');
  if (process.platform === 'darwin') app.setActivationPolicy('regular');
  app.on('second-instance', () => { if (window) present(window); });
  app.whenReady().then(() => {
    if (process.platform === 'darwin') app.dock?.setIcon(nativeImage.createFromPath(iconPath));
    ipcMain.handle('updates:state', event => { validSender(event); return updater.state(); });
    ipcMain.handle('updates:check', (event, channel: unknown) => { validSender(event); return updater.check(channel); });
    ipcMain.handle('updates:download', event => { validSender(event); return updater.download(); });
    ipcMain.handle('updates:install', async event => {
      validSender(event);
      const launched = await updater.install(async () => {
        const answer = await dialog.showMessageBox(window!, { type: 'question', buttons: ['稍后', '已结束活动，继续升级'], defaultId: 0, cancelId: 0,
          title: '确认客户端升级', message: '请先结束任务、通话和手机控制。',
          detail: '安装器未签名，Windows 可能显示警告。升级会关闭客户端，保留本地设置和资料库。不会自动卸载旧版。' });
        if (answer.response !== 1) return false;
        const status = await client.call('status', {}) as { activities: unknown[]; connection: string };
        let bots: unknown = { bots: [] };
        try { bots = await client.call('bots', {}); } catch {
          // Local service is authoritative for tasks on this PC; no NAS dependency.
          const offline = await dialog.showMessageBox(window!, { type: 'warning', buttons: ['稍后', '确认所有活动均已结束'], defaultId: 0, cancelId: 0,
            message: '无法刷新服务器任务状态', detail: '本地任务仍会检查，但远端任务信息可能不完整。请自行确认已结束通话、任务和手机控制。' });
          if (offline.response !== 1) return false;
        }
        if (hasActiveWork(status, bots)) throw new Error('仍有活动任务，请结束后再安装；安装包已保留');
        return true;
      });
      if (launched) app.quit();
      return launched;
    });
    ipcMain.handle('agent:computerName', event => { validSender(event); return computerName(); });
    ipcMain.handle('agent:defaultServerUrl', event => { validSender(event); return process.env.PI_BOT_SERVER_URL || DEFAULT_SERVER_URL; });
    ipcMain.handle('agent:call', async (event, method: Method, input: unknown) => { validSender(event); return client.call(method, parseInput(method, input)); });
    ipcMain.handle('agent:openExternal', async (event, url: string) => { validSender(event); const parsed = new URL(url); if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('不支持此链接'); await shell.openExternal(parsed.href); });
    ipcMain.handle('agent:openLibrary', async (event, slug: unknown) => {
      validSender(event);
      if (typeof slug !== 'string') throw new Error('资料库无效');
      const error = await shell.openPath(await libraryDir(libraryRoot, slug));
      if (error) throw new Error('无法在文件管理器中打开资料库');
    });
    const createWindow = () => {
      window = new BrowserWindow({ width: 1180, height: 820, minWidth: 900, minHeight: 600, show: false, icon: iconPath, title: 'Pi Bot', backgroundColor: '#f6f4f1', titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default', webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      window.once('ready-to-show', () => { if (window) present(window); });
      window.on('closed', () => { window = null; });
      void window.loadURL(page);
    };
    createWindow(); client.start(); void startBundledService();
    app.on('activate', () => { if (!window) createWindow(); else present(window); });
  }).catch(() => { dialog.showErrorBox('启动失败', '无法启动 Pi Bot，请查看开发终端'); app.quit(); });
  app.on('before-quit', event => {
    if (quitting) return;
    quitting = true; client.stop();
    if (serviceProcess && serviceProcess.exitCode === null) {
      event.preventDefault();
      const deadline = setTimeout(() => { serviceProcess?.kill(); app.quit(); }, 10000);
      serviceProcess.once('exit', () => { clearTimeout(deadline); app.quit(); });
      serviceProcess.stdin?.end();
    }
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
