import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { temp } from './helpers.js';
import { codingEndpoint, fixtureProject } from './coding-helpers.js';
import { Store } from '../packages/service/src/store.js';
import { CloudStore } from '../packages/service/src/cloud/store.js';

test('coding review preserves history, opens project links and isolates stop controls at every window size', async () => {
  const dir = temp(), root = join(dir.path, 'repo'); mkdirSync(root); fixtureProject(root);
  const api = await codingEndpoint(true); let app: ElectronApplication | undefined, service: ChildProcess | undefined;
  const env = { ...process.env, T_AGNET_DATA_DIR: dir.path };
  try {
    const seeded = new Store(join(dir.path, 'app.sqlite'));
    new CloudStore(seeded).putLink({ account: 'review-ui', serverUrl: 'http://127.0.0.1:1', deviceId: randomUUID(), label: '审阅测试 Mac', publicKey: '', pairedAt: Date.now(), producerSeq: 0, lastSyncAt: null }); seeded.close();
    service = spawn(resolve('node_modules/node/bin/node'), ['packages/service/dist/server.mjs'], { env, stdio: 'ignore' });
    app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [resolve('apps/desktop')], env });
    const page = await app.firstWindow(); await expect(page.getByText('离线 · 等待自动同步', { exact: true })).toBeVisible();
    const modelId = await page.evaluate(async baseUrl => (await window.agent.call('modelSave', { name: 'review', baseUrl, modelId: 'fixture', apiKey: 'review-test-only', contextWindow: 200000, maxTokens: 4096 })).id, api.url);
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, root);
    await page.getByRole('button', { name: '添加项目', exact: true }).click();
    await page.getByLabel('对话模式').selectOption('plan');
    await page.getByLabel('项目消息').fill('修复 add review-history'); await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByRole('button', { name: '确认执行 →', exact: true }).click();
    await expect(page.locator('.state-pill')).toHaveText('已完成', { timeout: 30000 });
    const snapshot = await page.evaluate(() => window.agent.call('snapshot', {}));
    const conversation = snapshot.conversations.find(c => c.title.includes('review-history'))!;
    await page.reload(); await page.getByRole('button', { name: /修复 add review-history/ }).click();
    const transcript = page.getByLabel('项目对话记录');
    const trace = transcript.getByLabel('工具活动').last(); await trace.locator('summary').first().click();
    await expect(trace.getByRole('group')).toHaveCount(150);
    await transcript.getByRole('button', { name: '加载更早记录' }).click();
    await expect(trace.getByRole('group')).toHaveCount(175);
    await expect(trace).toHaveAttribute('open', '');
    await page.getByLabel('项目消息').fill('file-link'); await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(transcript.getByRole('link', { name: 'main.mjs' })).toBeVisible({ timeout: 20000 });
    await app.evaluate(({ shell }) => { shell.openPath = async path => { (globalThis as any).__reviewOpenedPath = path; return ''; }; });
    await transcript.getByRole('link', { name: 'main.mjs' }).click();
    await expect(page.locator('.file-link-notice')).toContainText('不支持自动跳转至第 1 行');
    expect(await app.evaluate(() => (globalThis as any).__reviewOpenedPath)).toBe(join(root, 'main.mjs'));
    await page.getByLabel('关闭文件提示').click();
    const projectId = (await page.evaluate(() => window.agent.call('projectList', {})))[0].id;
    const active = await page.evaluate(async input => window.agent.call('codingCreate', { mode: 'agent', requirement: 'slow-command review-ui', ...input, requestId: crypto.randomUUID() }), { projectId, planModelId: modelId, executeModelId: modelId });
    await expect(page.getByRole('button', { name: '查看正在运行的会话 →' })).toBeVisible();
    await expect(page.getByRole('button', { name: '■ 停止任务' })).toHaveCount(0);
    expect((await page.evaluate(() => window.agent.call('snapshot', {}))).activeRun?.conversationId).toBe(active.conversationId);
    await page.getByRole('button', { name: '查看正在运行的会话 →' }).click();
    await expect(page.getByLabel('执行进度', { exact: true })).toContainText('started', { timeout: 20000 });
    await page.getByLabel('项目消息').fill('保留这段草稿');
    await page.getByLabel('执行进度', { exact: true }).getByRole('button', { name: '查看活动 ↗' }).click();
    mkdirSync('work', { recursive: true });
    for (const [width, height] of [[1160, 800], [900, 720], [880, 600]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), [width, height]);
      await expect(page.locator('.execution-progress:visible')).toHaveCount(1);
      await expect(page.getByLabel('关闭审阅面板')).toBeInViewport();
      await expect(page.getByRole('button', { name: '■ 停止任务' })).toBeInViewport();
      if (width <= 900) { await expect(page.locator('.project-conversation')).toBeHidden(); await expect(page.getByLabel('计划执行状态')).toBeInViewport(); }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `work/review-fixed-${width}.png`, animations: 'disabled' });
    }
    await page.getByLabel('关闭审阅面板').click();
    await expect(page.getByLabel('项目消息')).toHaveValue('保留这段草稿');
    await page.getByRole('button', { name: '■ 停止任务' }).click(); await expect(page.locator('.state-pill')).toHaveText('已停止');
    expect((await page.evaluate(conversationId => window.agent.call('codingGet', { conversationId }), conversation.id)).task.state).toBe('completed');
    await page.evaluate(async input => window.agent.call('codingCreate', { mode: 'agent', requirement: 'check-failure', ...input, requestId: crypto.randomUUID() }), { projectId, planModelId: modelId, executeModelId: modelId });
    await page.getByRole('button', { name: 'check-failure', exact: true }).click();
    await expect(page.locator('.state-pill')).toHaveText('执行结束，验证未通过', { timeout: 20000 });
    await expect(page.getByText('验证：未通过', { exact: true })).toBeVisible();
  } finally {
    await app?.close();
    if (service && service.exitCode === null) { const stopped = new Promise(r => service!.once('exit', r)); service.kill('SIGTERM'); await stopped; }
    await api.close(); dir.cleanup();
  }
});
