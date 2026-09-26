import type { Page } from 'playwright-core';
import type { BrowserStatus } from '../../../protocol/src/index.js';
import { ChromeDriver } from './chrome.js';
import { ProfileLock, type LockOwner } from './lock.js';
import { takeSnapshot, inspectElement, elementHandle, renderSnapshot, describe, type PageSnapshot, type SnapshotElement } from './snapshot.js';
import type { JevConfig } from './jev.js';
import { runBrowserTask, type BrowserTaskInput, type BrowserTaskResult } from './task.js';

import { BrowserPause } from './pause.js';
export { BrowserPause };

export const SENSITIVE = /支付|付款|付钱|购买|下单|提交订单|确认订单|转账|汇款|删除|注销|销户|\bpay\b|payment|checkout|purchase|buy now|place order|transfer|delete|remove account/i;
export const KEYS = ['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'] as const;
const reasons: Record<string, string> = { stale: '快照已过期或页面已跳转，请重新调用 browser_snapshot', changed: '元素位置在快照后发生变化，请重新调用 browser_snapshot', hidden: '元素当前不可见', disabled: '元素处于禁用状态', covered: '元素被其他元素遮挡' };

export interface BrowserOptions { profileDir: string; executable?: string; headless?: boolean; args?: string[]; lockTimeoutMs?: number; jev: JevConfig; }

export class BrowserService {
  readonly lock: ProfileLock;
  readonly driver: ChromeDriver;
  private seq = 0;
  latest: PageSnapshot | null = null;
  constructor(readonly options: BrowserOptions) { this.lock = new ProfileLock(options.lockTimeoutMs); this.driver = new ChromeDriver(options); }
  get jev() { return this.options.jev; }
  async jevReady() { return (await this.jev.status()).configured; }
  session(owner: LockOwner, signal: AbortSignal) { return new BrowserSession(this, owner, signal); }
  release(taskId: string) { if (this.lock.release(taskId)) this.latest = null; }
  nextId() { return ++this.seq; }
  async status(): Promise<BrowserStatus> { return { executable: this.driver.executable, running: this.driver.running, holder: this.lock.holder, jev: await this.jev.status() }; }
  async close() { await this.driver.close(); }
}

export class BrowserSession {
  constructor(private service: BrowserService, readonly owner: LockOwner, readonly signal: AbortSignal) {}
  private async page(): Promise<Page> {
    if (this.signal.aborted) throw new Error('运行已停止');
    if (!this.service.lock.owns(this.owner.taskId)) { await this.service.lock.acquire(this.owner, this.signal); this.service.latest = null; }
    return this.service.driver.page();
  }
  private target(ref: string): { snapshot: PageSnapshot; el: SnapshotElement } {
    const match = /^(\d+)\.(\d+)$/.exec(ref.trim());
    if (!match) throw new Error('元素编号格式应为「快照号.元素号」，例如 3.12');
    const snapshot = this.service.latest, id = Number(match[1]), n = Number(match[2]);
    if (!snapshot || snapshot.id !== id) throw new Error('元素编号来自旧快照，请使用最新一次 browser_snapshot 的编号');
    const el = snapshot.elements.find(e => e.n === n);
    if (!el) throw new Error(`快照 ${id} 中没有元素 ${n}`);
    return { snapshot, el };
  }
  private async ready(page: Page, snapshot: PageSnapshot, el: SnapshotElement) {
    const check = await inspectElement(page, snapshot.id, el.n);
    if (!check.ok) throw new Error(`${reasons[check.reason]}${check.detail ? `（${check.detail}）` : ''}：${describe(el, snapshot.id)}`);
    return elementHandle(page, el.n);
  }
  private async settle(page: Page) { await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {}); await page.waitForTimeout(300); }
  async open(url: string) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error('URL 无效'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('只能打开 http 或 https 页面');
    const page = await this.page();
    const response = await page.goto(parsed.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    this.service.latest = null;
    return `已打开 ${page.url()}（HTTP ${response?.status() ?? '未知'}），请调用 browser_snapshot 查看页面`;
  }
  async snapshotData(): Promise<PageSnapshot> {
    const page = await this.page();
    const snapshot = await takeSnapshot(page, this.service.nextId());
    this.service.latest = snapshot;
    if (snapshot.captcha) throw new BrowserPause(`页面出现验证码或人机验证（${snapshot.url}），请在自动化 Chrome 中手动完成后重新规划`);
    return snapshot;
  }
  async snapshot() { return renderSnapshot(await this.snapshotData()); }
  async click(ref: string) {
    const { snapshot, el } = this.target(ref);
    if (el.inputType === 'password') throw new BrowserPause('需要在密码框中操作，请在自动化 Chrome 中手动登录后重新规划');
    if (SENSITIVE.test(el.name)) throw new BrowserPause(`「${el.name}」可能涉及付款、提交或删除，请在自动化 Chrome 中确认并手动操作`);
    const page = await this.page(), handle = await this.ready(page, snapshot, el);
    try { await handle.click({ timeout: 5000 }); } finally { await handle.dispose(); }
    await this.settle(page);
    return `已点击 ${describe(el, snapshot.id)}；页面现在是 ${page.url()}`;
  }
  async type(ref: string, text: string) {
    const { snapshot, el } = this.target(ref);
    if (el.inputType === 'password') throw new BrowserPause('需要输入密码，请在自动化 Chrome 中手动登录后重新规划');
    if (el.role !== 'textbox' && el.role !== 'combobox') throw new Error(`元素不是输入框：${describe(el, snapshot.id)}`);
    if (text.length > 10000) throw new Error('单次输入上限 10000 字符');
    const page = await this.page(), handle = await this.ready(page, snapshot, el);
    try { await handle.fill(text, { timeout: 5000 }); } finally { await handle.dispose(); }
    return `已在 ${describe(el, snapshot.id).replace(/ value=".*"/, '')} 输入 ${text.length} 个字符（未按回车）`;
  }
  async select(ref: string, option: string) {
    const { snapshot, el } = this.target(ref);
    if (!el.options.includes(option)) throw new Error(`选项不存在：${option}`);
    const page = await this.page(), handle = await this.ready(page, snapshot, el);
    try { await handle.selectOption({ label: option }, { timeout: 5000 }); } finally { await handle.dispose(); }
    await this.settle(page);
    return `已在 ${describe(el, snapshot.id)} 选择「${option}」`;
  }
  async press(key: string) {
    if (!(KEYS as readonly string[]).includes(key)) throw new Error(`只允许按键：${KEYS.join('、')}`);
    const page = await this.page();
    await page.keyboard.press(key);
    await this.settle(page);
    return `已按 ${key}；页面现在是 ${page.url()}`;
  }
  async scroll(direction: 'up' | 'down') {
    const page = await this.page();
    await page.mouse.wheel(0, direction === 'down' ? 600 : -600);
    await page.waitForTimeout(300);
    return `已向${direction === 'down' ? '下' : '上'}滚动`;
  }
  async wait(ms = 1000) { const page = await this.page(); await page.waitForTimeout(ms); return `已等待 ${ms} 毫秒`; }
  async task(input: BrowserTaskInput): Promise<BrowserTaskResult> {
    const client = await this.service.jev.client();
    if (!client) throw new Error('尚未配置 Jev');
    return runBrowserTask(this, client, input);
  }
}
