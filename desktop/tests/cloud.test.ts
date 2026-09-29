import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { createPublicKey, verify, createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { canonicalJson, cloudPlanBody, planContentHash } from '../packages/service/src/cloud/plan.js';
import { newIdentity, signer } from '../packages/service/src/cloud/identity.js';
import { planBodySchema } from '../packages/protocol/src/index.js';
import { Store } from '../packages/service/src/store.js';
import { Application } from '../packages/service/src/application.js';
import { piFactory } from '../packages/service/src/pi-adapter.js';
import { temp, MemoryCredentials, eventually } from './helpers.js';
import { codingEndpoint, fixtureProject } from './coding-helpers.js';

const vector = JSON.parse(readFileSync(new URL('../../server/tests/fixtures/plan_hash_vector.json', import.meta.url), 'utf8'));

test('plan content hash matches the shared server vector', () => {
  const input = vector.input;
  const local = planBodySchema.parse({ goal: input.body.goal, scope: input.body.scope, nonGoals: input.body.non_goals, modules: input.body.modules, steps: input.body.steps.map((s: any) => ({ stepId: s.step_id, title: s.title, description: s.description })), commands: input.body.commands, externalActions: input.body.external_actions, verification: input.body.verification, acceptance: input.body.acceptance, questions: input.body.questions });
  const body = cloudPlanBody(local);
  assert.deepEqual(body, input.body);
  assert.equal(planContentHash({ taskId: input.task_id, version: input.version, projectId: input.project_id, deviceId: input.device_id, body, workspaceFingerprint: input.workspace_fingerprint, configSnapshotId: input.config_snapshot_id }), vector.content_hash);
  assert.equal(planContentHash({ taskId: input.task_id.toUpperCase(), version: input.version, projectId: input.project_id, deviceId: input.device_id, body, workspaceFingerprint: input.workspace_fingerprint, configSnapshotId: input.config_snapshot_id }), vector.content_hash);
  assert.equal(canonicalJson({ b: [1, { d: 'x\n', c: null }], a: '中文\u0001' }), '{"a":"中文\\u0001","b":[1,{"c":null,"d":"x\\n"}]}');
});

test('device signature follows the server canonical message', () => {
  const identity = newIdentity(), deviceId = randomUUID(), body = Buffer.from('{"a":1}');
  const headers = signer(deviceId, identity.privateKey)('post', '/device/events', body);
  assert.equal(headers['X-TAgnet-Device-Id'], deviceId); assert.ok(headers['X-TAgnet-Nonce'].length >= 16);
  const message = `${headers['X-TAgnet-Timestamp']}.${headers['X-TAgnet-Nonce']}.POST./device/events.${createHash('sha256').update(body).digest('hex')}`;
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(identity.publicKey, 'base64')]), format: 'der', type: 'spki' });
  assert.ok(verify(null, Buffer.from(message), key, Buffer.from(headers['X-TAgnet-Signature'], 'base64')));
  assert.equal(Buffer.from(identity.publicKey, 'base64').length, 32);
});

test('v2 database migrates to v5 without touching existing data', () => {
  const dir = temp(), path = join(dir.path, 'v2.sqlite');
  try {
    let store = new Store(path);
    store.putModel({ id: randomUUID(), name: 'kept', baseUrl: 'https://example.com/v1', modelId: 'm', contextWindow: 32000, maxTokens: 4096, isDefault: true, hasKey: true });
    const conversation = store.createConversation(store.models()[0].id); store.start(conversation.id, '旧问题', randomUUID());
    store.db.exec('DROP TRIGGER shared_message_insert; DROP TRIGGER shared_message_update; DROP TABLE shared_state; DROP TABLE shared_dirty; ALTER TABLE conversations DROP COLUMN shared; DROP TABLE cloud_link; DROP TABLE cloud_projects; DROP TABLE cloud_tasks; DROP TABLE cloud_commands; DROP TABLE cloud_outbox; PRAGMA user_version=2;'); store.close();
    store = new Store(path);
    assert.equal((store.db.prepare('PRAGMA user_version').get() as any).user_version, 5);
    assert.equal(store.models()[0].name, 'kept'); assert.equal(store.messages(conversation.id)[0].content, '旧问题');
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM cloud_outbox').get() as any).n, 0);
    store.db.exec('PRAGMA user_version=6'); store.close();
    assert.throws(() => new Store(path), /数据库版本较新/);
  } finally { dir.cleanup(); }
});

test('an unpaired service never touches the network for cloud features and keeps local flows unchanged', { timeout: 60000 }, async () => {
  const dir = temp(), root = join(dir.path, 'project'); mkdirSync(root); fixtureProject(root);
  const models = await codingEndpoint(), store = new Store(join(dir.path, 'app.sqlite')), deviceKeys = new MemoryCredentials();
  const original = globalThis.fetch, calls: string[] = [];
  globalThis.fetch = (async (input: any, init?: any) => { calls.push(String(input)); return original(input, init); }) as typeof fetch;
  const app = new Application(store, new MemoryCredentials(), piFactory(dir.path), () => {}, { dataDir: dir.path, credentials: deviceKeys });
  try {
    const model = await app.call('modelSave', { name: 'fixture', modelId: 'fixture', baseUrl: models.url, apiKey: 'k', contextWindow: 32000, maxTokens: 4096 });
    const project = await app.call('projectAdd', { path: root, requestId: randomUUID() });
    const task = await app.call('codingCreate', { projectId: project.id, requirement: '修复 add', planModelId: model.id, executeModelId: model.id, requestId: randomUUID() });
    await eventually(() => !app.coding.active, 20000);
    const detail = await app.call('codingGet', { conversationId: task.conversationId });
    assert.equal(detail.task.state, 'awaiting_review'); assert.equal(detail.cloud, undefined);
    const run = await app.call('codingApprove', { taskId: task.id, planId: detail.plans[0].id, hash: detail.plans[0].hash, requestId: randomUUID() }); assert.ok(run);
    await eventually(() => !app.coding.active, 20000); assert.equal(app.coding.db.task(task.id).state, 'completed');
    assert.deepEqual(await app.call('cloudStatus', {}), { paired: false, serverUrl: null, deviceId: null, label: null, connected: false, lastSyncAt: null, pending: 0, queued: 0, failed: 0, failures: [], projects: [] });
    await assert.rejects(app.call('cloudProjectShare', { projectId: project.id, enabled: true }), /尚未配对/);
    await assert.rejects(app.call('cloudApprove', { taskId: task.id, planId: detail.plans[0].id, requestId: randomUUID() }), /不是云端任务/);
    await assert.rejects(async () => app.call('cloudPair', { serverUrl: 'https://example.com/prefix', label: 'Mac', password: 'x' }), /只填写协议、主机和端口/);
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM cloud_outbox').get() as any).n, 0);
    assert.deepEqual(calls.filter(url => !url.startsWith(models.url)), []); assert.equal(deviceKeys.values.size, 0);
  } finally { globalThis.fetch = original; await app.shutdown(); store.close(); await models.close(); dir.cleanup(); }
});

test('outbox keeps order, retries network failures and isolates rejected events', { timeout: 30000 }, async () => {
  const received: any[] = []; let online = false;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    if (!online) { req.socket.destroy(); return; }
    if (req.url !== '/device/events') { res.writeHead(404, { 'content-type': 'application/json' }).end('{"detail":"不存在"}'); return; }
    const events = JSON.parse(body).events;
    if (events.some((e: any) => e.payload.summary === 'reject-me')) { res.writeHead(400, { 'content-type': 'application/json' }).end('{"detail":"事件无效"}'); return; }
    received.push(...events); res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ accepted: events.length, duplicates: 0, gaps: [], last_seq: 0 }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const dir = temp(), store = new Store(join(dir.path, 'app.sqlite')), deviceKeys = new MemoryCredentials(), identity = newIdentity(), account = randomUUID();
  await deviceKeys.set(account, identity.privateKey);
  store.db.prepare('INSERT INTO cloud_link VALUES(1,?)').run(JSON.stringify({ account, serverUrl: `http://127.0.0.1:${(server.address() as any).port}`, deviceId: randomUUID(), label: 'Mac', publicKey: identity.publicKey, pairedAt: 1, producerSeq: 0, lastSyncAt: null }));
  const app = new Application(store, new MemoryCredentials(), piFactory(dir.path), () => {}, { credentials: deviceKeys, options: { retryBaseMs: 50, retryMaxMs: 200 } });
  try {
    const task = randomUUID(), run = randomUUID();
    for (const summary of ['one', 'reject-me', 'three']) (app.cloud as any).report(task, run, 'run.failed', { summary });
    await new Promise(r => setTimeout(r, 400));
    assert.equal(app.cloud.status().pending, 3); assert.equal(received.length, 0); assert.match(app.cloud.status().failures[0].message, /无法连接云端/);
    online = true;
    await eventually(() => app.cloud.status().pending === 0, 10000);
    assert.deepEqual(received.map(e => [e.producer_seq, e.payload.summary]), [[1, 'one'], [3, 'three']]);
    const status = app.cloud.status(); assert.equal(status.failed, 1); assert.equal(status.failures.at(-1)!.message, '事件无效');
    await app.call('cloudRetry', {}); await eventually(() => app.cloud.status().failed === 1 && app.cloud.status().pending === 0, 10000);
  } finally { await app.shutdown(); store.close(); server.closeAllConnections(); server.close(); dir.cleanup(); }
});

test('automatic project registration isolates failures and retries with the same identity', async () => {
  const dir = temp(), store = new Store(join(dir.path, 'app.sqlite'));
  const app = new Application(store, new MemoryCredentials(), piFactory(dir.path), () => {}, { credentials: new MemoryCredentials() });
  const first = { id: randomUUID(), name: 'first', path: '/first', removed: false, createdAt: 1 }, second = { ...first, id: randomUUID(), name: 'second', path: '/second' };
  app.coding.db.putProject(first); app.coding.db.putProject(second);
  app.cloud.db.putLink({ account: 'fixture', serverUrl: 'http://localhost', deviceId: randomUUID(), publicKey: '', label: 'fixture', pairedAt: 1, producerSeq: 0, lastSyncAt: null });
  const requests: string[] = [], remote = new Map<string, string>(); let dropped = false;
  app.cloud.request = (async (_method: string, _path: string, body: any) => {
    requests.push(body.request_id);
    if (!remote.has(body.request_id)) remote.set(body.request_id, randomUUID());
    if (body.request_id === first.id && !dropped) { dropped = true; throw new Error('response lost after commit'); }
    return { project_id: remote.get(body.request_id) };
  }) as typeof app.cloud.request;
  try {
    await assert.rejects((app.cloud as any).reconcileProjects(), /response lost/);
    assert.equal(app.cloud.db.project(first.id), null); assert.ok(app.cloud.db.project(second.id));
    await (app.cloud as any).reconcileProjects();
    assert.deepEqual(requests, [first.id, second.id, first.id]);
    assert.equal(app.cloud.db.project(first.id)?.cloudProjectId, remote.get(first.id)); assert.equal(remote.size, 2);
  } finally { await app.shutdown(); store.close(); dir.cleanup(); }
});
