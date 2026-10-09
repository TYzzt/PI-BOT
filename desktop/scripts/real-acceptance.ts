// Opt-in, application-level acceptance against the user's configured endpoint.
// Never print or persist the secret value. Only generated fixture projects are sent.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Store } from '../packages/service/src/store.js';
import { Application } from '../packages/service/src/application.js';
import { FileCredentials } from '../packages/service/src/keychain.js';
import { piFactory } from '../packages/service/src/pi-adapter.js';
import type { ModelConfig } from '../packages/protocol/src/index.js';
const [action, scenario] = process.argv.slice(2);
if (!['plan', 'execute', 'status'].includes(action) || !['bugfix', 'feature'].includes(scenario)) throw new Error('usage: real-acceptance.ts plan|execute|status bugfix|feature');
const base = resolve('work/real-acceptance'), dataDir = join(base, scenario, 'data'), root = join(base, scenario, 'repo');
mkdirSync(dataDir, { recursive: true }); mkdirSync(root, { recursive: true });
const original = new DatabaseSync(join(homedir(), 'Library/Application Support/T-AGNET/app.sqlite'), { readOnly: true });
const models = (original.prepare('SELECT data FROM models').all() as { data: string }[]).map(r => JSON.parse(r.data) as ModelConfig); original.close();
const model = models.find(m => m.isDefault) ?? models[0]; if (!model) throw new Error('请先在桌面应用配置真实模型');
const store = new Store(join(dataDir, 'app.sqlite')); store.putModel(model);
const app = new Application(store, new FileCredentials(join(homedir(), 'Library/Application Support/T-AGNET/secrets.json')), piFactory(dataDir), () => {});
const reportPath = join(base, scenario, 'report.json');
let report: any = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : { scenario, model: model.modelId, provider: new URL(model.baseUrl).hostname, startedAt: new Date().toISOString() };
try {
  if (action === 'plan') {
    if (existsSync(join(root, '.git'))) throw new Error('验收仓库已存在，请先审阅现有记录；不覆盖');
    execFileSync('/usr/bin/git', ['init', '-q', root]);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 't-agnet-acceptance-' + scenario, private: true, type: 'module', scripts: { test: 'node --test test.mjs' } }, null, 2));
    writeFileSync(join(root, 'calculator.mjs'), scenario === 'bugfix' ? 'export function add(a,b) { return a-b; }\n' : 'export function add(a,b) { return a+b; }\n');
    writeFileSync(join(root, 'test.mjs'), 'import {test} from "node:test"; import assert from "node:assert/strict"; import {add} from "./calculator.mjs"; test("add",()=>{assert.equal(add(2,3),5);assert.equal(add(-2,2),0);});\n');
    writeFileSync(join(root, 'notes.txt'), '用户已有内容，请保留。\n');
    const p = await app.call('projectAdd', { path: root, requestId: randomUUID() });
    const requirement = scenario === 'bugfix' ? '修复 calculator.mjs 中 add 的错误，使现有 node --test test.mjs 全部通过。只改必要文件，保留 notes.txt。不安装依赖、不提交代码、不联网。先读取项目生成计划，批准后执行修改和真实测试。' : '在 calculator.mjs 新增导出的 multiply(a,b)，支持正数、负数和零。在 test.mjs 添加这些情况的测试，保留现有 add 测试及 notes.txt。只修改 calculator.mjs 和 test.mjs，不安装依赖、不提交代码、不联网。先读取项目生成计划，批准后执行修改和 node --test test.mjs。';
    const task = await app.call('codingCreate', { projectId: p.id, requirement, planModelId: model.id, executeModelId: model.id, requestId: randomUUID() }); report.taskId = task.id; report.conversationId = task.conversationId;
  }
  if (action === 'execute') {
    const task = app.coding.db.task(report.taskId); const plan = app.coding.db.plans(task.id).at(-1); if (!plan) throw new Error('无可执行计划');
    report.runId = (await app.call('codingApprove', { taskId: task.id, planId: plan.id, hash: plan.hash, requestId: randomUUID() }))?.id;
  }
  const timer = setTimeout(() => { if (app.coding.active) void app.call('runCancel', { id: app.coding.active.run.id }); }, 12 * 60 * 1000);
  while (app.coding.active) await new Promise(r => setTimeout(r, 500)); clearTimeout(timer);
  const detail = await app.call('codingGet', { conversationId: report.conversationId });
  report.updatedAt = new Date().toISOString(); report.state = detail.task.state; report.message = detail.task.message; report.verification = detail.verification;
  report.plans = detail.plans; report.tools = detail.tools.map(t => ({ name: t.name, state: t.state, exitCode: t.exitCode, verification: t.verification, input: t.input, output: t.output })); report.summary = detail.summary;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await app.shutdown(); store.close(); }
