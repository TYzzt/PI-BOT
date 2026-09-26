import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { temp } from './helpers.js';
import { codingEndpoint, fixtureProject } from './coding-helpers.js';
import { Keychain } from '../packages/service/src/keychain.js';

test('desktop coding plan revision approval diff validation and cancellation', async () => {
  const dir = temp(), root = join(dir.path, 'repo'); mkdirSync(root); fixtureProject(root);
  const api = await codingEndpoint(); let app: ElectronApplication | undefined, service: ChildProcess | undefined, modelId = '';
  const env = { ...process.env, T_AGNET_DATA_DIR: dir.path, T_AGNET_KEYCHAIN_HELPER: resolve('native/dist/keychain') };
  try {
    service = spawn(resolve('node_modules/node/bin/node'), ['packages/service/dist/server.mjs'], { env, stdio: 'ignore' });
    app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [resolve('apps/desktop')], env }); const page = await app.firstWindow();
    await expect(page.getByText('本地服务已连接', { exact: true })).toBeVisible();
    modelId = await page.evaluate(async ({ url }) => (await window.agent.call('modelSave', { name: '编程测试模型', baseUrl: url, modelId: 'fixture', apiKey: 'coding-ui-secret', contextWindow: 32000, maxTokens: 4096 })).id, { url: api.url });
    // Replace only the OS dialog response; exercise the actual native bridge, UI and service.
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, root);
    await page.getByRole('button', { name: '项目与编程' }).click(); await page.getByRole('button', { name: '＋ 添加 Git 项目' }).click();
    await expect(page.getByText('repo', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: '改代码', exact: false }).click();
    await page.getByLabel('编程需求', { exact: true }).fill('修复 add 函数，保留我的笔记'); await page.getByRole('button', { name: '生成修改计划', exact: true }).click();
    await page.getByRole('button', { name: '计划与审阅', exact: true }).click();
    await expect(page.getByRole('button', { name: '确认执行', exact: true })).toBeEnabled({ timeout: 20000 });
    expect(readFileSync(join(root, 'main.mjs'), 'utf8')).toContain('a - b');
    await page.getByLabel('修改意见或补充信息', { exact: true }).fill('保持改动最小，执行测试'); await page.getByRole('button', { name: '要求修改 / 重新规划' }).click();
    await expect(page.getByLabel('计划版本')).toHaveValue(/.+/); await expect(page.getByRole('button', { name: '确认执行', exact: true })).toBeEnabled({ timeout: 20000 });
    await expect(page.getByLabel('计划版本').locator('option')).toHaveCount(2);
    mkdirSync('work', { recursive: true }); await page.screenshot({ path: 'work/coding-plan.png', animations: 'disabled' });
    await page.getByRole('button', { name: '确认执行', exact: true }).click(); await expect(page.locator('.state-pill').filter({ hasText: '执行结束' })).toBeVisible({ timeout: 20000 }); await expect(page.getByText('验证：通过', { exact: true })).toBeVisible();
    expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('user uncommitted notes\n');
    await page.getByRole('button', { name: '代码变更', exact: true }).click(); await page.getByRole('button', { name: '~ main.mjs', exact: true }).click(); await expect(page.getByLabel('文件差异')).toContainText('a + b');
    await page.screenshot({ path: 'work/coding-diff.png', animations: 'disabled' });
    await page.getByRole('button', { name: '工具与验证', exact: true }).click(); await expect(page.locator('summary').filter({ hasText: 'run_command' })).toContainText('exit 0');
    await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: 'work/coding-tools-dark.png', animations: 'disabled' });
    await page.getByRole('button', { name: '项目与编程' }).click(); await page.getByLabel('任务项目').selectOption({ label: 'repo' }); await page.getByRole('button', { name: '改代码', exact: false }).click(); await page.getByLabel('编程需求').fill('slow-command'); await page.getByRole('button', { name: '生成修改计划', exact: true }).click();
    await page.getByRole('button', { name: '计划与审阅', exact: true }).click(); await expect(page.getByRole('button', { name: '确认执行', exact: true })).toBeEnabled({ timeout: 20000 }); await page.getByRole('button', { name: '确认执行', exact: true }).click();
    await page.getByRole('button', { name: '工具与验证' }).click(); await expect(page.locator('summary').filter({ hasText: 'run_command' })).toBeVisible({ timeout: 20000 });
    await page.getByRole('button', { name: '■ 停止任务' }).click(); await expect(page.getByText('已停止', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally {
    await app?.close(); if (service && service.exitCode === null) { const stopped = new Promise(r => service!.once('exit', r)); service.kill('SIGTERM'); await stopped; }
    if (modelId) await new Keychain(resolve('native/dist/keychain')).delete(modelId); await api.close(); dir.cleanup();
  }
});
