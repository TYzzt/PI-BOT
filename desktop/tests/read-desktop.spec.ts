import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { temp } from './helpers.js';
import { codingEndpoint, fixtureProject } from './coding-helpers.js';
import { Keychain } from '../packages/service/src/keychain.js';

test('code reading defaults to direct chat and shows all answers without a plan', async () => {
  const dir = temp(), root = join(dir.path, 'repo'); mkdirSync(root); fixtureProject(root); const api = await codingEndpoint(); let app: ElectronApplication | undefined, service: ChildProcess | undefined, modelId = '';
  const env = { ...process.env, T_AGNET_DATA_DIR: dir.path, T_AGNET_KEYCHAIN_HELPER: resolve('native/dist/keychain') };
  try {
    service = spawn(resolve('node_modules/node/bin/node'), ['packages/service/dist/server.mjs'], { env, stdio: 'ignore' });
    app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [resolve('apps/desktop')], env }); let page = await app.firstWindow(); await expect(page.getByText('本地服务已连接', { exact: true })).toBeVisible();
    modelId = await page.evaluate(async url => (await window.agent.call('modelSave', { name: '代码问答模型', baseUrl: url, modelId: 'fixture', apiKey: 'read-ui-secret', contextWindow: 32000, maxTokens: 4096 })).id, api.url);
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, root);
    await page.getByRole('button', { name: '项目与编程' }).click(); await page.getByRole('button', { name: '＋ 添加 Git 项目' }).click();
    await expect(page.getByRole('button', { name: /读代码.*理解/ })).toHaveAttribute('aria-pressed', 'true');
    await page.getByLabel('代码问题', { exact: true }).fill('解释 add 的行为'); await page.getByRole('button', { name: '开始读代码', exact: true }).click();
    await expect(page.getByLabel('项目对话记录')).toContainText('返回两个参数的差值', { timeout: 20000 }); await expect(page.getByRole('button', { name: '批准并执行' })).toHaveCount(0); await expect(page.getByRole('button', { name: '计划与审阅' })).toHaveCount(0);
    await page.getByLabel('继续问代码').fill('继续解释原因'); await page.getByRole('button', { name: '提问', exact: true }).click(); await expect(page.getByLabel('项目对话记录')).toContainText('接着上次的说明', { timeout: 20000 });
    await expect(page.getByLabel('项目对话记录')).toContainText('返回两个参数的差值'); await expect(page.getByLabel('继续问代码')).toHaveValue('');
    expect(readFileSync(join(root, 'main.mjs'), 'utf8')).toContain('a - b');
    await expect(page.getByRole('button', { name: '提问', exact: true })).toBeInViewport();
    await page.screenshot({ path: 'work/read-chat.png', animations: 'disabled' });
    await app.close(); app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [resolve('apps/desktop')], env }); page = await app.firstWindow();
    await expect(page.getByText('本地服务已连接', { exact: true })).toBeVisible(); await page.getByRole('button', { name: /解释 add 的行为/ }).click(); await expect(page.getByLabel('项目对话记录')).toContainText('接着上次的说明');
    await page.getByLabel('继续问代码').fill('生成修复计划'); await page.getByRole('button', { name: '生成修改计划', exact: true }).click(); await expect(page.getByRole('button', { name: '批准并执行' })).toBeEnabled({ timeout: 20000 });
    await page.getByRole('button', { name: '对话与结果' }).click(); await expect(page.getByLabel('项目对话记录')).toContainText('返回两个参数的差值'); await expect(page.getByLabel('项目对话记录')).toContainText('计划已生成，请审阅');
  } finally { await app?.close(); if (service && service.exitCode === null) { const stopped = new Promise(r => service!.once('exit', r)); service.kill('SIGTERM'); await stopped; } if (modelId) await new Keychain(resolve('native/dist/keychain')).delete(modelId); await api.close(); dir.cleanup(); }
});
