import type { Page } from 'playwright-core';

export interface SnapshotElement { n: number; role: string; name: string; inputType: string | null; value: string | null; disabled: boolean; offscreen: boolean; options: string[]; }
export interface PageSnapshot { id: number; title: string; url: string; elements: SnapshotElement[]; text: string; captcha: boolean; truncated: boolean; }
export type Inspection = { ok: true; x: number; y: number } | { ok: false; reason: 'stale' | 'changed' | 'hidden' | 'disabled' | 'covered'; detail?: string };

const MAX_ELEMENTS = 200;
export const SNAPSHOT_LIMIT = 12000;

// Runs inside the page. Elements are kept in a page-local array so refs never touch the DOM.
function collect(args: { id: number; max: number }) {
  const w = window as any;
  const selector = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=textbox],[role=combobox],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const roleOf = (el: any): string => {
    const explicit = el.getAttribute('role'); if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'range') return 'slider';
      if (type === 'file') return 'file';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'clickable';
  };
  const nameOf = (el: any): string => {
    const labelled = el.getAttribute('aria-labelledby');
    const byId = labelled ? labelled.split(/\s+/).map((id: string) => document.getElementById(id)?.textContent ?? '').join(' ') : '';
    const label = el.labels?.length ? Array.from(el.labels as ArrayLike<any>).map((l: any) => l.innerText).join(' ') : '';
    const own = el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' ? '' : el.innerText;
    const buttonValue = el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type) ? el.value : '';
    return clean(el.getAttribute('aria-label') || byId || label || own || buttonValue || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name'));
  };
  const visible = (el: any) => {
    const rect = el.getBoundingClientRect(); if (rect.width < 1 || rect.height < 1) return false;
    return typeof el.checkVisibility === 'function' ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : getComputedStyle(el).visibility !== 'hidden';
  };
  const all = Array.from(document.querySelectorAll(selector)).filter(visible) as any[];
  const unique = all.filter(el => !(roleOf(el) === 'clickable' && all.some(o => o !== el && el.contains(o))) && !all.some(o => o !== el && o.contains(el) && ['link', 'button'].includes(roleOf(o))));
  const els = unique.slice(0, args.max);
  const vw = innerWidth, vh = innerHeight;
  const elements = els.map((el, n) => {
    const rect = el.getBoundingClientRect(), role = roleOf(el);
    const inputType = el.tagName === 'INPUT' ? (el.type || 'text').toLowerCase() : null;
    const secret = inputType === 'password';
    const value = secret ? null : role === 'textbox' ? clean(el.isContentEditable ? el.innerText : el.value) : role === 'combobox' && el.tagName === 'SELECT' ? clean(el.selectedOptions?.[0]?.text) : role === 'checkbox' || role === 'radio' ? String(!!el.checked) : null;
    const options = el.tagName === 'SELECT' ? Array.from(el.options as ArrayLike<any>).slice(0, 20).map((o: any) => clean(o.text)) : [];
    return { n: n + 1, role, name: nameOf(el), inputType, value, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', offscreen: rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw, options };
  });
  w.__tagnet = { id: args.id, els, rects: els.map(el => { const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY }; }) };
  const frames = Array.from(document.querySelectorAll('iframe')).some((f: any) => /recaptcha|hcaptcha|turnstile|captcha/i.test(f.src || ''));
  const text = (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n').slice(0, 4000);
  return { title: clean(document.title), url: location.href, elements, text, captcha: frames || /验证码|人机验证|captcha|verify you are human/i.test(text), truncated: unique.length > args.max };
}

function inspect(args: { id: number; n: number }) {
  const state = (window as any).__tagnet;
  if (!state || state.id !== args.id) return { ok: false, reason: 'stale' };
  const el = state.els[args.n - 1], origin = state.rects[args.n - 1];
  if (!el || !el.isConnected) return { ok: false, reason: 'stale' };
  let rect = el.getBoundingClientRect();
  if (Math.abs(rect.left + scrollX - origin.x) > 40 || Math.abs(rect.top + scrollY - origin.y) > 40) return { ok: false, reason: 'changed' };
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'disabled' };
  if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) { el.scrollIntoView({ block: 'center', inline: 'center' }); rect = el.getBoundingClientRect(); }
  if (rect.width < 1 || rect.height < 1) return { ok: false, reason: 'hidden' };
  const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(x, y) as any;
  const owns = (node: any) => node && (node === el || el.contains(node) || (node.tagName === 'LABEL' && node.control === el) || node.closest?.('label')?.control === el);
  if (!owns(hit)) {
    const desc = hit ? `${hit.tagName.toLowerCase()}${hit.id ? '#' + hit.id : ''} ${(hit.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)}` : '无元素';
    return { ok: false, reason: 'covered', detail: desc.trim() };
  }
  return { ok: true, x, y };
}

// Serialized as source so page code never depends on helpers injected by the Node-side bundler.
function script<A, R>(fn: (args: A) => R, args: A) { return `(() => { const __name = (f) => f; return (${fn.toString()})(${JSON.stringify(args)}); })()`; }
export async function takeSnapshot(page: Page, id: number): Promise<PageSnapshot> {
  const result = await page.evaluate(script(collect, { id, max: MAX_ELEMENTS })) as ReturnType<typeof collect>;
  return { id, ...result };
}
export async function inspectElement(page: Page, id: number, n: number): Promise<Inspection> {
  return await page.evaluate(script(inspect, { id, n })) as Inspection;
}
export async function elementHandle(page: Page, n: number) {
  const handle = await page.evaluateHandle((i: number) => (window as any).__tagnet?.els[i - 1] ?? null, n);
  const element = handle.asElement();
  if (!element) { await handle.dispose(); throw new Error('元素已失效，请重新调用 browser_snapshot'); }
  return element;
}
export function describe(el: SnapshotElement, snapshotId: number) {
  const parts = [`[${snapshotId}.${el.n}] ${el.role}${el.inputType === 'password' ? ' password' : ''} "${el.name}"`];
  if (el.value !== null && el.value !== '') parts.push(`value="${el.value}"`);
  if (el.options.length) parts.push(`options=${JSON.stringify(el.options)}`);
  if (el.disabled) parts.push('disabled');
  if (el.offscreen) parts.push('offscreen');
  return parts.join(' ');
}
export function renderSnapshot(s: PageSnapshot) {
  const lines = [`快照 ${s.id} · ${s.title || '(无标题)'} · ${s.url}`, ...s.elements.map(e => describe(e, s.id))];
  if (s.truncated) lines.push(`（只列出前 ${MAX_ELEMENTS} 个可交互元素）`);
  if (s.captcha) lines.push('页面疑似出现验证码或人机验证');
  lines.push('页面文字（节选）：', s.text);
  const text = lines.join('\n');
  return text.length > SNAPSHOT_LIMIT ? text.slice(0, SNAPSHOT_LIMIT) + '\n（已截断）' : text;
}
