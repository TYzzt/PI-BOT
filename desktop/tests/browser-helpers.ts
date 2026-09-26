import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { Store } from '../packages/service/src/store.js';
import { BrowserService } from '../packages/service/src/browser/index.js';
import { JevConfig } from '../packages/service/src/browser/jev.js';
import type { PageSnapshot } from '../packages/service/src/browser/snapshot.js';
import { MemoryCredentials, temp } from './helpers.js';

export function testChrome(): string | null {
  for (const candidate of [process.env.TAGNET_CHROME, chromium.executablePath(), '/usr/bin/google-chrome-stable', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) if (candidate && existsSync(candidate)) return candidate;
  return null;
}

const page = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>A12 测试页</title></head><body>
<h1>浏览器测试页</h1>
<p id="count">点击次数：0</p>
<button id="inc" onclick="this.dataset.n=(+(this.dataset.n||0)+1);document.getElementById('count').textContent='点击次数：'+this.dataset.n">增加</button>
<label>搜索词 <input id="q" onkeydown="if(event.key==='Enter')document.getElementById('submitted').textContent='已提交：'+this.value"></label>
<button id="search" onclick="document.getElementById('result').textContent='结果：'+document.getElementById('q').value">搜索</button>
<p id="result"></p><p id="submitted"></p>
<label>城市 <select id="city"><option>北京</option><option>上海</option></select></label>
<label>密码 <input type="password" id="pw"></label>
<button id="pay">立即支付</button>
<div style="position:relative;display:inline-block"><button id="covered">被遮挡按钮</button><div style="position:absolute;inset:0;background:rgba(0,0,0,.4)">遮罩</div></div>
<div id="spacer" style="height:0"></div><button id="mover">会移动的按钮</button>
</body></html>`;

export async function testSite() {
  const server = createServer((req, res) => {
    if (req.url === '/captcha') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<title>验证</title><p>请完成人机验证 captcha</p><button>继续</button>'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } };
}

export function browserFixture(executable: string, options: { lockTimeoutMs?: number; fetch?: typeof fetch } = {}) {
  const dir = temp(), store = new Store(join(dir.path, 'app.sqlite')), keys = new MemoryCredentials();
  const jev = new JevConfig(store.db, keys, options.fetch);
  const service = new BrowserService({ profileDir: join(dir.path, 'chrome-profile'), executable, headless: true, args: ['--no-sandbox'], lockTimeoutMs: options.lockTimeoutMs, jev });
  return { dir, store, keys, jev, service, close: async () => { await service.close(); store.close(); dir.cleanup(); } };
}

export function ref(snapshot: PageSnapshot, name: string) {
  const el = snapshot.elements.find(e => e.name === name) ?? snapshot.elements.find(e => e.name.includes(name));
  if (!el) throw new Error(`快照中没有「${name}」`);
  return `${snapshot.id}.${el.n}`;
}
