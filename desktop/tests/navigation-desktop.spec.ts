import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { temp } from './helpers.js';
import { codingEndpoint, fixtureProject } from './coding-helpers.js';
import { Keychain } from '../packages/service/src/keychain.js';

test('navigation separates projects and questions and renders both themes at minimum size', async () => {
  const dir = temp(), root = join(dir.path, 'design-project'); mkdirSync(root); fixtureProject(root);
  const api = await codingEndpoint(); let app: ElectronApplication | undefined, service: ChildProcess | undefined, modelId = '';
  const env = { ...process.env, T_AGNET_DATA_DIR: dir.path, T_AGNET_KEYCHAIN_HELPER: resolve('native/dist/keychain') };
  try {
    mkdirSync('work', { recursive: true });
    service = spawn(resolve('node_modules/node/bin/node'), ['packages/service/dist/server.mjs'], { env, stdio: 'ignore' });
    app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [resolve('apps/desktop')], env });
    const page = await app.firstWindow();
    await expect(page.getByText('待连接云端', { exact: true })).toBeVisible();
    modelId = await page.evaluate(async baseUrl => (await window.agent.call('modelSave', { name: '设计验收模型', baseUrl, modelId: 'fixture', apiKey: 'navigation-test-only', contextWindow: 32000, maxTokens: 4096 })).id, api.url);
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, root);
    await page.getByRole('button', { name: '添加项目', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'design-project', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /添加 Git 项目/ })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '本机项目' })).toHaveCount(0);
    await expect(page.getByLabel('任务项目')).toHaveCount(0);
    await expect(page.getByLabel('项目消息')).toBeInViewport();
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: `work/project-start-${colorScheme}.png`, animations: 'disabled' });
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(880, 600));
    await expect(page.getByLabel('项目消息')).toBeInViewport();
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1180, 800));
    await expect(page.getByLabel('对话模式')).toHaveValue('agent');
    await expect(page.getByLabel('模型', { exact: true })).toHaveCount(1);
    await page.getByLabel('项目消息', { exact: true }).fill('解释 add 的行为');
    await page.getByLabel('项目消息').press('Enter');
    await expect(page.getByLabel('项目对话记录')).toContainText('返回两个参数的差值', { timeout: 20000 });
    const projects = page.getByRole('region', { name: '项目分组' });
    await expect(projects.getByRole('button', { name: '解释 add 的行为', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '问答', exact: true }).getByRole('button', { name: '解释 add 的行为' })).toHaveCount(0);
    await page.getByRole('button', { name: '展开或折叠 design-project' }).click();
    await expect(projects.getByRole('button', { name: '解释 add 的行为', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '展开或折叠 design-project' }).click();
    await expect(page.getByLabel('新对话运行位置')).toHaveCount(0);
    await page.getByRole('button', { name: '新对话', exact: true }).click();
    await expect(page.getByRole('navigation', { name: '问答', exact: true }).getByRole('button', { name: '新会话', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '新对话', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '新对话', exact: true }).click();
    await expect(page.getByRole('navigation', { name: '问答', exact: true }).getByRole('button', { name: '新会话', exact: true })).toHaveCount(1);
    const snapshot = await page.evaluate(() => window.agent.call('snapshot', {}));
    const asks = snapshot.conversations.filter(c => c.kind === 'ask');
    expect(asks).toHaveLength(1);
    const ordinary = asks[0];
    expect(ordinary.projectId).toBeNull(); expect(ordinary.shared).toBe(1);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1680, 1000));
    const composer = await page.getByLabel('输入问题', { exact: true }).boundingBox();
    expect(composer!.width).toBeGreaterThan(500);
    expect((await page.getByText('Enter 发送 · Shift + Enter 换行').boundingBox())!.height).toBeLessThan(24);
    await page.screenshot({ path: 'work/composer-wide.png', animations: 'disabled' });
    await expect(page.getByLabel('输入问题', { exact: true })).toBeVisible();
    await page.getByLabel('输入问题', { exact: true }).fill('中文输入');
    await page.getByLabel('输入问题', { exact: true }).dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    expect((await page.evaluate(id => window.agent.call('conversationGet', { id }), ordinary.id)).messages).toHaveLength(0);
    await page.getByLabel('输入问题', { exact: true }).fill('');
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: `work/navigation-${colorScheme}.png`, animations: 'disabled' });
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(880, 600));
    await expect(page.getByLabel('输入问题', { exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: '插件', exact: true }).click();
    await expect(page.getByRole('heading', { name: '插件', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Skills/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^MCP/ })).toBeVisible();
    await page.screenshot({ path: 'work/plugins-dark.png', animations: 'disabled' });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '模型', exact: true })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /共享|仅本机|同步/ })).toHaveCount(0);
    await page.getByLabel('显示名称', { exact: true }).focus(); await page.keyboard.press('Tab');
    await expect(page.getByLabel('Base URL', { exact: true })).toBeFocused();
    await page.screenshot({ path: 'work/settings-narrow.png', animations: 'disabled' });
  } finally {
    await app?.close();
    if (service && service.exitCode === null) { const stopped = new Promise(r => service!.once('exit', r)); service.kill('SIGTERM'); await stopped; }
    if (modelId) await new Keychain(resolve('native/dist/keychain')).delete(modelId);
    await api.close(); dir.cleanup();
  }
});
