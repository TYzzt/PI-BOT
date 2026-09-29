import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Store } from '../packages/service/src/store.js';
import { CodingStore } from '../packages/service/src/coding/store.js';
import { temp } from './helpers.js';

test('v1 database migration preserves Ask history and v2 interruption never resumes writes', () => {
  const dir = temp(), path = join(dir.path, 'old.sqlite'); let db = new DatabaseSync(path);
  const modelId = randomUUID(), conversationId = randomUUID(), runId = randomUUID(), taskId = randomUUID();
  try {
    db.exec(`CREATE TABLE models(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,modelConfigId TEXT NOT NULL REFERENCES models(id),createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,sessionPath TEXT);
      CREATE TABLE runs(id TEXT PRIMARY KEY,taskId TEXT NOT NULL,conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,requestId TEXT NOT NULL UNIQUE,requestHash TEXT NOT NULL,state TEXT NOT NULL,error TEXT);
      CREATE TABLE messages(id TEXT PRIMARY KEY,conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,runId TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,role TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL,visibility TEXT NOT NULL DEFAULT 'local_only'); PRAGMA user_version=1;`);
    const model = { id: modelId, name: 'legacy', baseUrl: 'https://example.com/v1', modelId: 'legacy', contextWindow: 32000, maxTokens: 4096, hasKey: true, isDefault: true };
    db.prepare('INSERT INTO models VALUES(?,?)').run(modelId, JSON.stringify(model)); db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?)').run(conversationId, '旧会话', modelId, 1, 1, '/legacy/session');
    db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?)').run(runId, taskId, conversationId, randomUUID(), 'hash', 'completed', null); db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run(randomUUID(), conversationId, runId, 'assistant', '原有回答', 'completed', 'local_only'); db.close();
    let store = new Store(path); let coding = new CodingStore(store);
    assert.equal(store.conversation(conversationId).kind, 'ask'); assert.equal(store.messages(conversationId)[0].content, '原有回答'); assert.equal(store.sessionPath(conversationId), '/legacy/session'); assert.deepEqual(store.model(modelId), model);
    const project = { id: randomUUID(), name: 'fixture', path: '/unavailable-fixture', removed: false, createdAt: 1 }; coding.putProject(project);
    coding.putTask({ id: taskId, conversationId, projectId: project.id, requirement: 'interrupted', planModelId: modelId, executeModelId: modelId, state: 'executing', latestPlanId: null, activeRunId: runId, message: '', createdAt: 1 });
    store.finish(runId, 'running'); coding.putTool({ id: randomUUID(), taskId, runId, name: 'run_command', input: '{}', output: 'partial', state: 'running', startedAt: 1, endedAt: null, exitCode: null, verification: true, truncated: false, cwd: '/unavailable-fixture', path: '' }); store.close();
    store = new Store(path); coding = new CodingStore(store); assert.equal(coding.task(taskId).state, 'interrupted'); assert.equal(store.run(runId).state, 'interrupted'); assert.equal(coding.tools(taskId)[0].state, 'interrupted'); assert.equal(coding.tools(taskId)[0].output, 'partial'); assert.equal((store.db.prepare('PRAGMA user_version').get() as any).user_version, 5); store.close();
  } finally { dir.cleanup(); }
});
