import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { endpoint, temp, eventually } from './helpers.js';
import { Keychain } from '../packages/service/src/keychain.js';

test('desktop configuration chat cancellation restart and reconnect', async () => {
  const dir = temp(), api = await endpoint(), modelIds: string[] = []; let service: ChildProcess | undefined; let app: ElectronApplication | undefined;
  const env = { ...process.env, T_AGNET_DATA_DIR: dir.path, T_AGNET_KEYCHAIN_HELPER: resolve('native/dist/keychain') };
  let serviceLogs = '';
  const startService = () => { service = spawn(resolve('node_modules/node/bin/node'), ['packages/service/dist/server.mjs'], { cwd: process.cwd(), env, stdio: 'pipe' }); service.stdout?.on('data', b => serviceLogs += b); service.stderr?.on('data', b => serviceLogs += b); };
  const stopService = async () => { if (service && service.exitCode === null) { const stopped = new Promise<void>(r => service!.once('exit', () => r())); service.kill('SIGTERM'); await stopped; } };
  const launch = async () => { app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [resolve('apps/desktop')], env }); const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded'); return page; };
  try {
    startService(); let page = await launch(); await expect(page.getByText('本地服务已连接', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '先连接你的模型' })).toBeVisible();
    await page.getByRole('button', { name: '配置模型 →' }).click();
    await page.getByLabel('显示名称', { exact: true }).fill('集成测试模型'); await page.getByLabel('Base URL', { exact: true }).fill(api.url); await page.getByLabel('模型 ID', { exact: true }).fill('fixture-model'); await page.getByLabel('API Key', { exact: true }).fill('fixture-ui-secret');
    await page.getByRole('button', { name: '保存配置' }).click(); await expect(page.getByText('● 密钥已配置')).toBeVisible();
    const snapshot = await page.evaluate(() => window.agent.call('snapshot', {})); modelIds.push(...snapshot.models.map(m => m.id));
    expect(JSON.stringify(snapshot)).not.toContain('fixture-ui-secret'); await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: '测试连接', exact: true }).click(); await expect(page.getByText('✓ 集成测试模型：连接成功')).toBeVisible();
    await page.getByRole('button', { name: '新建会话' }).click(); await page.getByRole('textbox', { name: '输入问题' }).fill('记住蓝鲸'); await page.getByRole('button', { name: '发送 ↑' }).click(); await expect(page.getByText('好的，我记住了蓝鲸。', { exact: true })).toBeVisible(); await expect(page.getByText('已完成', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '重命名', exact: true }).click(); await page.getByRole('textbox', { name: '会话名称' }).fill('我的测试对话'); await page.getByRole('button', { name: '保存名称' }).click(); await expect(page.getByRole('heading', { name: '我的测试对话' })).toBeVisible();
    await page.getByRole('textbox', { name: '输入问题' }).fill('慢慢回复'); await page.getByRole('button', { name: '发送 ↑' }).click(); await expect(page.getByRole('button', { name: '■ 停止生成' })).toBeVisible(); await page.getByRole('button', { name: '■ 停止生成' }).click(); await expect(page.getByText('已停止', { exact: true })).toBeVisible();
    await app!.close(); app = undefined; await stopService(); startService(); page = await launch(); await expect(page.getByText('本地服务已连接', { exact: true })).toBeVisible(); await page.getByRole('button', { name: /我的测试对话/ }).click(); await expect(page.getByText('好的，我记住了蓝鲸。', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: '输入问题' }).fill('我之前说的是什么？'); await page.getByRole('button', { name: '发送 ↑' }).click(); await expect(page.getByText('你之前说的是蓝鲸。', { exact: true })).toBeVisible();
    mkdirSync('work', { recursive: true }); await page.screenshot({ animations: 'disabled', path: 'work/chat-light.png' }); await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ animations: 'disabled', path: 'work/chat-dark.png' }); await page.emulateMedia({ colorScheme: 'light' });
    await stopService(); await expect(page.getByText('正在连接本地服务…')).toBeVisible(); startService(); await expect(page.getByText('本地服务已连接', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '模型设置' }).click(); await page.getByRole('button', { name: /集成测试模型.*默认/ }).click(); await page.getByLabel('API Key', { exact: true }).fill('invalid-key'); await page.getByRole('button', { name: '保存配置' }).click(); await expect(page.getByText(/配置已保存/)).toBeVisible(); await page.getByRole('button', { name: '测试连接', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('模型请求失败'); await expect(page.getByRole('alert')).not.toContainText('invalid-key');
    await page.screenshot({ animations: 'disabled', path: 'work/settings.png' });
    expect(serviceLogs).not.toContain('fixture-ui-secret'); expect(serviceLogs).not.toContain('invalid-key');
    expect(readFileSync(join(dir.path, 'app.sqlite')).includes(Buffer.from('fixture-ui-secret'))).toBe(false);
    expect(api.requests.every(r => !r.tools?.length)).toBe(true);
  } finally {
    await app?.close(); await stopService(); const keychain = new Keychain(resolve('native/dist/keychain')); for (const id of modelIds) await keychain.delete(id); await api.close(); dir.cleanup();
  }
});
