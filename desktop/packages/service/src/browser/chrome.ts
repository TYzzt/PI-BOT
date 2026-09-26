import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

export const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export interface ChromeOptions { profileDir: string; executable?: string; headless?: boolean; startTimeoutMs?: number; args?: string[]; }

export function chromeExecutable(explicit?: string): string | null {
  const candidate = explicit || process.env.TAGNET_CHROME || MAC_CHROME;
  return existsSync(candidate) ? candidate : null;
}

// Controls a dedicated Chrome profile over CDP. The user's everyday profile is never touched.
export class ChromeDriver {
  private browser: Browser | null = null;
  private child: ChildProcess | null = null;
  private current: Page | null = null;
  private connecting: Promise<BrowserContext> | null = null;
  constructor(private options: ChromeOptions) {}
  get executable() { return chromeExecutable(this.options.executable); }
  get running() { return !!this.browser?.isConnected(); }
  private portFile() { return join(this.options.profileDir, 'DevToolsActivePort'); }
  private async attach(): Promise<BrowserContext | null> {
    let port: string | undefined;
    try { port = readFileSync(this.portFile(), 'utf8').split('\n')[0]?.trim(); } catch { return null; }
    if (!port || !/^\d+$/.test(port)) return null;
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 3000 });
      browser.on('disconnected', () => { if (this.browser === browser) { this.browser = null; this.current = null; } });
      this.browser = browser;
      return browser.contexts()[0] ?? null;
    } catch { return null; }
  }
  private async launch(): Promise<BrowserContext> {
    const executable = this.executable;
    if (!executable) throw new Error('未找到 Google Chrome，请安装 Chrome 或设置 TAGNET_CHROME 指向可执行文件');
    mkdirSync(this.options.profileDir, { recursive: true, mode: 0o700 });
    rmSync(this.portFile(), { force: true });
    const args = [`--user-data-dir=${this.options.profileDir}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', '--disable-sync', 'about:blank'];
    if (this.options.headless) args.unshift('--headless=new');
    args.unshift(...this.options.args ?? []);
    const child = spawn(executable, args, { stdio: 'ignore' });
    this.child = child;
    child.once('exit', () => { if (this.child === child) this.child = null; });
    const deadline = Date.now() + (this.options.startTimeoutMs ?? 20000);
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('Chrome 启动后立即退出，请检查自动化 profile 是否被其他 Chrome 占用');
      const context = await this.attach();
      if (context) return context;
      await new Promise(r => setTimeout(r, 200));
    }
    child.kill();
    throw new Error('Chrome 启动超时');
  }
  private async context(): Promise<BrowserContext> {
    if (this.browser?.isConnected()) { const context = this.browser.contexts()[0]; if (context) return context; }
    this.connecting ??= (async () => (await this.attach()) ?? await this.launch())().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async page(): Promise<Page> {
    const context = await this.context();
    if (this.current && !this.current.isClosed()) return this.current;
    const pages = context.pages().filter(p => !p.isClosed());
    this.current = pages.at(-1) ?? await context.newPage();
    return this.current;
  }
  async close() {
    const browser = this.browser, child = this.child;
    this.browser = null; this.current = null; this.child = null;
    if (child) {
      await browser?.close().catch(() => {});
      if (child.exitCode === null) {
        const exited = new Promise(r => child.once('exit', r));
        child.kill('SIGTERM');
        await Promise.race([exited, new Promise(r => setTimeout(r, 3000))]);
        if (child.exitCode === null) child.kill('SIGKILL');
      }
    } else await browser?.close().catch(() => {});
  }
}
