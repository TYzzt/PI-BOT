import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, connect, type Server, type Socket, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Store } from '../packages/service/src/store.js';
import { Application } from '../packages/service/src/application.js';
import { piFactory } from '../packages/service/src/pi-adapter.js';
import { planContentHash } from '../packages/service/src/cloud/plan.js';
import { temp, MemoryCredentials } from './helpers.js';
import { codingEndpoint, fixtureProject, fixturePlan } from './coding-helpers.js';

// Runs against a real server, e.g. `docker compose up` in ../server:
// T_AGNET_CLOUD_URL=http://127.0.0.1:8000 T_AGNET_CLOUD_PASSWORD=<admin password> npm test
const cloudUrl = process.env.T_AGNET_CLOUD_URL, password = process.env.T_AGNET_CLOUD_PASSWORD;
const MARKER = 'LOCAL_SOURCE_MARKER_MUST_STAY_ON_MAC';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, timeout = 20000, what = '条件') { const start = Date.now(); while (!(await fn())) { if (Date.now() - start > timeout) throw new Error(`等待${what}超时`); await sleep(100); } }

// A TCP relay between the desktop service and the server; closing it simulates losing the network.
function relay(target: URL) {
  const sockets = new Set<Socket>(); let server: Server | null = null, port = 0;
  return {
    get url() { return `http://127.0.0.1:${port}`; },
    up: () => new Promise<void>(resolve => {
      server = createServer(client => {
        const upstream = connect(Number(target.port || 80), target.hostname); sockets.add(client); sockets.add(upstream);
        const drop = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
        client.on('error', drop).on('close', drop); upstream.on('error', drop).on('close', drop); client.pipe(upstream); upstream.pipe(client);
      });
      server.listen(port, '127.0.0.1', () => { port = (server!.address() as AddressInfo).port; resolve(); });
    }),
    down: () => new Promise<void>(resolve => { for (const s of sockets) s.destroy(); sockets.clear(); if (server) server.close(() => resolve()); else resolve(); }),
  };
}

test('cloud link: pairing, sharing, plans, approvals, events, cancel, offline replay, restart and unpair', { skip: !cloudUrl || !password ? '设置 T_AGNET_CLOUD_URL 与 T_AGNET_CLOUD_PASSWORD 后运行' : false, timeout: 300000 }, async () => {
  const net = relay(new URL(cloudUrl!)); await net.up();
  const dir = temp(), root = join(dir.path, 'project'), dbPath = join(dir.path, 'app.sqlite'); mkdirSync(root); fixtureProject(root);
  writeFileSync(join(root, 'main.mjs'), `// ${MARKER}\nexport function add(a, b) { return a - b; }\n`);
  const models = await codingEndpoint(), modelKeys = new MemoryCredentials(), deviceKeys = new MemoryCredentials();
  const open = () => { const store = new Store(dbPath); return { store, app: new Application(store, modelKeys, piFactory(dir.path), () => {}, { credentials: deviceKeys, options: { retryBaseMs: 100, retryMaxMs: 500, busyPollMs: 100 } }) }; };
  let { store, app } = open();
  const login = await (await fetch(cloudUrl + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) })).json() as { access_token: string };
  const user = async (method: string, path: string, body?: unknown) => { const r = await fetch(cloudUrl + path, { method, headers: { authorization: `Bearer ${login.access_token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() as any }; };
  const task = async (id: string) => (await user('GET', `/tasks/${id}`)).json;
  const status = (id: string, wanted: string, timeout = 30000) => until(async () => (await task(id)).status === wanted, timeout, `云端任务 ${wanted}`);
  const plan = async (id: string) => (await user('GET', `/plans/${(await task(id)).latest_plan_id}`)).json;
  const allEvents = async (taskId?: string) => { const out: any[] = []; let after = 0; for (;;) { const page = (await user('GET', `/events?after=${after}&limit=500${taskId ? `&task_id=${taskId}` : ''}`)).json; out.push(...page.events); after = page.next_cursor; if (!page.has_more) return out; } };
  const approve = (p: any, key = randomUUID()) => user('POST', `/plans/${p.plan_id}/approve`, { version: p.version, content_hash: p.content_hash, idempotency_key: key });
  const published = (cloudTaskId: string, count: number) => until(() => Object.keys(app.cloud.db.taskByCloud(cloudTaskId)?.plans ?? {}).length >= count, 10000, '计划映射');
  const runningCommand = () => until(() => !!app.coding.active && app.coding.db.tools(app.coding.active.task.id).some(t => t.runId === app.coding.active!.run.id && t.name === 'run_command' && t.state === 'running'), 30000, '本机慢命令');
  try {
    const model = await app.call('modelSave', { name: 'fixture', modelId: 'fixture', baseUrl: models.url, apiKey: 'coding-fixture-secret', contextWindow: 32000, maxTokens: 4096 });
    const project = await app.call('projectAdd', { path: root, requestId: randomUUID() });
    assert.equal(model.isDefault, true);

    // D3-01 pairing; the password is used once and never persisted.
    await assert.rejects(app.call('cloudPair', { serverUrl: net.url, label: 'E2E Mac', password: 'wrong-password' }), /管理员密码错误/);
    const paired = await app.call('cloudPair', { serverUrl: net.url, label: 'E2E Mac', password: password! });
    assert.ok(paired.paired && paired.deviceId); await until(() => app.cloud.connected, 10000, '设备连接');
    assert.deepEqual([...deviceKeys.values.keys()], [app.cloud.db.link()!.account]);

    // D3-02 sharing sends only the project name.
    await app.call('cloudProjectShare', { projectId: project.id, enabled: true });
    const projects = (await user('GET', '/projects')).json, cloudProject = projects.find((p: any) => p.device_id === paired.deviceId);
    assert.equal(cloudProject.display_name, 'project'); assert.equal(cloudProject.availability, 'available'); assert.ok(!JSON.stringify(projects).includes(root));
    const create = async (requirement: string) => { const r = await user('POST', '/tasks', { project_id: cloudProject.project_id, requirement, idempotency_key: randomUUID() }); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.task_id as string; };

    // D3-03 plans are generated locally, published and hash-verified.
    const taskA = await create('修复 add（A）'); await status(taskA, 'awaiting_review');
    const taskB = await create('修复 add（B）'); await status(taskB, 'awaiting_review');
    await published(taskA, 1); await published(taskB, 1);
    const planA = await plan(taskA), linkA = app.cloud.db.taskByCloud(taskA)!, [localPlanA, mappedA] = Object.entries(linkA.plans)[0];
    const localA = app.coding.db.plan(localPlanA);
    assert.equal(planA.version, 1); assert.equal(planA.content_hash, mappedA.hash); assert.equal(planA.body.goal, fixturePlan.goal); assert.deepEqual(planA.body.steps, [{ step_id: 'fix-add', title: fixturePlan.steps[0].title, description: fixturePlan.steps[0].description }]);
    assert.equal(planContentHash({ taskId: taskA, version: 1, projectId: cloudProject.project_id, deviceId: paired.deviceId!, body: planA.body, workspaceFingerprint: localA.fingerprint, configSnapshotId: localA.configHash }), planA.content_hash);
    assert.equal((await app.call('codingGet', { conversationId: app.coding.db.task(linkA.taskId).conversationId })).cloud?.cloudTaskId, taskA);
    await assert.rejects(app.call('codingApprove', { taskId: linkA.taskId, planId: localPlanA, hash: localA.hash, requestId: randomUUID() }), /云端/);

    // D3-04 approval from the Mac goes through the device endpoint and executes locally.
    await app.call('cloudApprove', { taskId: linkA.taskId, planId: localPlanA, requestId: randomUUID() });
    await status(taskA, 'completed');
    assert.match(readFileSync(join(root, 'main.mjs'), 'utf8'), /a \+ b/);
    const eventsA = await allEvents(taskA);
    assert.equal(eventsA.find(e => e.type === 'approval.recorded').payload.actor, 'device');
    assert.ok(eventsA.some(e => e.type === 'step.completed' && e.payload.step_id === 'fix-add'));
    assert.ok(eventsA.some(e => e.type === 'tool.finished' && e.payload.tool_name === 'run_command' && e.payload.verification === 'passed' && e.payload.exit_code === 0), JSON.stringify(eventsA.filter(e => e.type === 'tool.finished').map(e => e.payload)));
    assert.equal(eventsA.find(e => e.type === 'run.completed').payload.verification, 'passed');

    // D3-05 duplicate user approvals yield one run; the changed workspace forces a replan.
    const planB = await plan(taskB), key = randomUUID();
    const approvals = await Promise.all([approve(planB, key), approve(planB, key), approve(planB)]);
    assert.deepEqual(approvals.map(a => a.status), [200, 200, 200]); assert.equal(new Set(approvals.map(a => a.json.approval_id)).size, 1); assert.equal(approvals[0].json.actor, 'user');
    await status(taskB, 'needs_replan');
    assert.equal((await task(taskB)).runs.filter((r: any) => r.phase === 'execute').length, 1);
    const linkB = app.cloud.db.taskByCloud(taskB)!; assert.equal(app.coding.db.task(linkB.taskId).state, 'needs_replan');

    // D3-06 revisions from the cloud and from the Mac keep versions contiguous.
    await user('POST', `/plans/${planB.plan_id}/revise`, { feedback: '基于当前工作区重新规划', idempotency_key: randomUUID() });
    await until(async () => (await task(taskB)).plans.length === 2 && (await task(taskB)).status === 'awaiting_review', 30000, '修订 v2');
    await app.call('cloudRevise', { taskId: linkB.taskId, feedback: '保持改动最小', requestId: randomUUID() });
    await until(async () => (await task(taskB)).plans.length === 3 && (await task(taskB)).status === 'awaiting_review', 30000, '修订 v3');
    assert.deepEqual((await task(taskB)).plans.map((p: any) => p.version), [1, 2, 3]);
    assert.equal((await allEvents(taskB)).filter(e => e.type === 'plan.revision_requested').map(e => e.payload.actor).join(), 'user,device');
    assert.equal((await approve(await plan(taskB))).status, 200); await status(taskB, 'completed');

    // D3-08 + D3-11 cancel waits for the device; a plan request arriving while busy is queued.
    const taskE = await create('slow-command 修复 add（E）'); await status(taskE, 'awaiting_review');
    assert.equal((await approve(await plan(taskE))).status, 200); await runningCommand(); await status(taskE, 'running');
    const taskF = await create('修复 add（F）');
    await until(() => app.cloud.db.commands('acked').some(c => c.task_id === taskF), 20000, '排队命令');
    assert.equal(app.cloud.db.taskByCloud(taskF), null); assert.ok(app.cloud.status().queued >= 1);
    const cancelling = await user('POST', `/tasks/${taskE}/cancel`, {});
    assert.equal(cancelling.json.status, 'running'); assert.equal(cancelling.json.cancel_requested, true);
    await status(taskE, 'cancelled');
    await status(taskF, 'awaiting_review'); await published(taskF, 1);

    // D3-09 offline: events queue locally; device approval is refused; an expired approval never runs.
    const taskG = await create('slow-command 修复 add（G）'); await status(taskG, 'awaiting_review');
    assert.equal((await approve(await plan(taskG))).status, 200); await runningCommand();
    await net.down(); await until(() => !app.cloud.connected, 10000, '断开');
    await app.call('runCancel', { id: app.coding.active!.run.id }); await until(() => !app.coding.active, 20000, '本机停止');
    await until(() => app.cloud.status().pending >= 2, 5000, '离线积压');
    const linkF = app.cloud.db.taskByCloud(taskF)!, [localPlanF] = Object.entries(linkF.plans)[0];
    await assert.rejects(app.call('cloudApprove', { taskId: linkF.taskId, planId: localPlanF, requestId: randomUUID() }), /审批需要连接云端/);
    assert.equal((await approve(await plan(taskF))).status, 200);
    await sleep(61000);
    await status(taskF, 'awaiting_review', 10000);
    await net.up(); await until(() => app.cloud.connected && app.cloud.status().pending === 0, 20000, '补发');
    await status(taskG, 'cancelled');
    await sleep(1000);
    assert.equal(app.coding.db.task(linkF.taskId).state, 'awaiting_review'); assert.ok(!app.coding.db.runs(linkF.taskId).some(r => r.mode === 'execute'));

    // D3-10 restart: an in-flight run is reported interrupted; acked commands still run; redelivery is ignored.
    const taskJ = await create('slow-command 修复 add（J）'); await status(taskJ, 'awaiting_review');
    assert.equal((await approve(await plan(taskJ))).status, 200); await runningCommand();
    const taskH = await create('修复 add（H）');
    await until(() => app.cloud.db.commands('acked').some(c => c.task_id === taskH), 20000, '排队命令 H');
    const linkJ = app.cloud.db.taskByCloud(taskJ)!, jRun = linkJ.active!.localRunId, jTask = linkJ.taskId, commandH = app.cloud.db.commands('acked').find(c => c.task_id === taskH)!;
    app.coding.observer = null; await app.shutdown(); // Simulates the service dying: no cloud events for this stop.
    store.db.prepare("UPDATE runs SET state='running' WHERE id=?").run(jRun);
    store.db.prepare('UPDATE coding_tasks SET data=json_set(data, \'$.state\', \'executing\', \'$.activeRunId\', ?) WHERE id=?').run(jRun, jTask);
    store.close(); ({ store, app } = open());
    assert.equal(store.run(jRun).state, 'interrupted');
    await until(() => app.cloud.connected, 10000, '重启后连接');
    await status(taskJ, 'interrupted'); await status(taskH, 'awaiting_review');
    const tasksBefore = app.coding.db.tasks().length;
    (app.cloud as any).receive({ type: 'command', ...commandH }); await sleep(500);
    assert.equal(app.coding.db.tasks().length, tasksBefore);

    // D3-09 producer_seq is gap-free with no duplicates; D3-07 nothing local leaked.
    const events = await allEvents(), mine = events.filter(e => e.producer_id === paired.deviceId);
    assert.deepEqual(mine.map(e => e.producer_seq), mine.map((_, i) => i + 1)); assert.equal(new Set(mine.map(e => e.event_id)).size, mine.length);
    const plans = await Promise.all((await user('GET', '/tasks')).json.map(async (t: any) => (await Promise.all((await task(t.task_id)).plans.map((p: any) => user('GET', `/plans/${p.plan_id}`)))).map(r => r.json)));
    const shared = JSON.stringify({ events, plans, projects: (await user('GET', '/projects')).json, devices: (await user('GET', '/devices')).json });
    for (const secret of [MARKER, root, dir.path, 'PASS add', 'coding-fixture-secret', '计划已生成，请审阅。', '执行结束，请查看真实验证和差异。', 'user uncommitted notes']) assert.ok(!shared.includes(secret), secret);
    assert.ok(!JSON.stringify(mine).includes('test.mjs'));

    // D3-01 again: no password or JWT anywhere in local storage.
    const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(t => JSON.stringify(store.db.prepare(`SELECT * FROM "${t.name}"`).all())).join('\n');
    const files = [dbPath, dbPath + '-wal'].filter(existsSync).map(p => readFileSync(p).toString('latin1')).join('');
    for (const text of [tables, files, JSON.stringify([...deviceKeys.values.values(), ...modelKeys.values.values()])]) { assert.ok(!text.includes(password!)); assert.doesNotMatch(text, /eyJ[\w-]+\.eyJ[\w-]+\./); }

    // Unpair removes credentials, retaining mappings for a later authenticated re-pair.
    const unpaired = await app.call('cloudUnpair', {});
    assert.equal(unpaired.paired, false); assert.equal(deviceKeys.values.size, 0); assert.ok(app.cloud.db.tasks().length > 0);
    assert.ok(app.coding.db.task(linkA.taskId));
  } finally { await app.shutdown(); store.close(); await models.close(); await net.down(); dir.cleanup(); }
});
