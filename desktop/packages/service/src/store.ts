import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import type { ModelConfig, Conversation, Message, Run, RunState } from '../../protocol/src/index.js';

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 5) throw new Error('数据库版本较新，不能使用旧版本应用打开');
    if (version < 1) this.transaction(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS models(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL, modelConfigId TEXT NOT NULL REFERENCES models(id), createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, sessionPath TEXT);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, taskId TEXT NOT NULL, conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, requestId TEXT NOT NULL UNIQUE, requestHash TEXT NOT NULL, state TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, runId TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'local_only');
      PRAGMA user_version=1;`));
    if (version < 2) this.transaction(() => this.db.exec(`
      ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'ask';
      ALTER TABLE conversations ADD COLUMN projectId TEXT;
      CREATE TABLE projects(id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE coding_tasks(id TEXT PRIMARY KEY, conversationId TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE plans(id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES coding_tasks(id) ON DELETE CASCADE, data TEXT NOT NULL, baseline TEXT NOT NULL);
      CREATE TABLE coding_runs(runId TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE, taskId TEXT NOT NULL REFERENCES coding_tasks(id) ON DELETE CASCADE, data TEXT NOT NULL, baseline TEXT);
      CREATE TABLE approvals(planId TEXT PRIMARY KEY REFERENCES plans(id) ON DELETE CASCADE, runId TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE tool_calls(id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES coding_tasks(id) ON DELETE CASCADE, runId TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE task_steps(taskId TEXT PRIMARY KEY REFERENCES coding_tasks(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE coding_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL REFERENCES coding_tasks(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE request_receipts(id TEXT PRIMARY KEY, hash TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE app_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version=2;
    `));
    // Cloud tables only hold identifiers, versions, hashes and redacted event payloads; never source, diffs or model text.
    if (version < 3) this.transaction(() => this.db.exec(`
      CREATE TABLE cloud_link(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE cloud_projects(projectId TEXT PRIMARY KEY, cloudProjectId TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE cloud_tasks(taskId TEXT PRIMARY KEY REFERENCES coding_tasks(id) ON DELETE CASCADE, cloudTaskId TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE cloud_commands(seq INTEGER PRIMARY KEY AUTOINCREMENT, commandId TEXT NOT NULL UNIQUE, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE cloud_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, error TEXT, createdAt INTEGER NOT NULL);
      PRAGMA user_version=3;
    `));
    if (version < 4) this.transaction(() => this.db.exec(`
      ALTER TABLE conversations ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE shared_state(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE shared_dirty(id TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 1);
      CREATE TRIGGER shared_message_insert AFTER INSERT ON messages BEGIN
        INSERT INTO shared_dirty VALUES(NEW.id,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1;
      END;
      CREATE TRIGGER shared_message_update AFTER UPDATE OF content,status ON messages BEGIN
        INSERT INTO shared_dirty VALUES(NEW.id,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1;
      END;
      PRAGMA user_version=4;
    `));
    if (version < 5) this.transaction(() => this.db.exec(`UPDATE conversations SET shared=1;
      UPDATE shared_state SET data=json_remove(data,'$.pending','$.fingerprint') WHERE kind='conversation';
      PRAGMA user_version=5;`));
    this.db.exec(`UPDATE messages SET status='interrupted' WHERE role='assistant' AND runId IN (SELECT id FROM runs WHERE state IN ('running','cancelling'));
      UPDATE runs SET state='interrupted', error='本地服务已重启，上次运行未完成；不会自动重发请求' WHERE state IN ('running','cancelling');`);
  }
  transaction<T>(fn: () => T): T { const savepoint = 'sp_' + randomUUID().replaceAll('-', ''); this.db.exec(`SAVEPOINT ${savepoint}`); try { const r = fn(); this.db.exec(`RELEASE ${savepoint}`); return r; } catch (e) { this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw e; } }
  models(): ModelConfig[] { return (this.db.prepare('SELECT data FROM models ORDER BY rowid').all() as { data: string }[]).map(r => JSON.parse(r.data)); }
  assertModelReady(id: string) { const state = this.db.prepare("SELECT data FROM shared_state WHERE kind='model' AND id=?").get(id) as { data: string } | undefined; if (state && JSON.parse(state.data).applying) throw new Error('此模型配置尚未完整应用，请等待同步或重新保存密钥'); }
  model(id: string): ModelConfig { const m = this.models().find(m => m.id === id); if (!m) throw new Error('模型配置不存在'); return m; }
  putModel(model: ModelConfig) { this.db.prepare('INSERT INTO models(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(model.id, JSON.stringify(model)); }
  defaultModel(id: string) { this.model(id); this.transaction(() => { for (const m of this.models()) this.putModel({ ...m, isDefault: m.id === id }); }); }
  deleteModel(id: string, replacement?: string) {
    const m = this.model(id); const count = (this.db.prepare('SELECT count(*) AS n FROM conversations WHERE modelConfigId=?').get(id) as { n: number }).n;
    if (count && !replacement) throw new Error('此模型被会话引用，请先选择替代模型');
    if (replacement) { this.model(replacement); if (replacement === id) throw new Error('替代模型不能是当前模型'); }
    this.transaction(() => {
      if (replacement) this.db.prepare('UPDATE conversations SET modelConfigId=? WHERE modelConfigId=?').run(replacement, id);
      this.db.prepare('DELETE FROM models WHERE id=?').run(id);
      if (m.isDefault) { const next = this.models().find(v => v.id === replacement) ?? this.models()[0]; if (next) this.putModel({ ...next, isDefault: true }); }
    });
  }
  conversations(): Conversation[] { return this.db.prepare('SELECT id,title,modelConfigId,createdAt,updatedAt,kind,projectId,shared FROM conversations ORDER BY updatedAt DESC').all() as unknown as Conversation[]; }
  conversation(id: string): Conversation { const c = this.conversations().find(c => c.id === id); if (!c) throw new Error('会话不存在'); return c; }
  // The legacy shared argument remains wire-compatible; every Mac conversation syncs.
  createConversation(modelConfigId: string, _shared?: boolean, suppliedId?: string): Conversation { this.model(modelConfigId); const id = suppliedId ?? randomUUID(), now = Date.now(); this.db.prepare('INSERT INTO conversations(id,title,modelConfigId,createdAt,updatedAt,shared) VALUES(?,?,?,?,?,?)').run(id, '新会话', modelConfigId, now, now, 1); return this.conversation(id); }
  rename(id: string, title: string) { this.conversation(id); this.db.prepare('UPDATE conversations SET title=?,updatedAt=? WHERE id=?').run(title, Date.now(), id); }
  deleteConversation(id: string) { this.db.prepare('DELETE FROM conversations WHERE id=?').run(id); }
  sessionPath(id: string): string | null { return (this.db.prepare('SELECT sessionPath FROM conversations WHERE id=?').get(id) as { sessionPath: string | null }).sessionPath; }
  setSessionPath(id: string, path: string) { this.db.prepare('UPDATE conversations SET sessionPath=? WHERE id=?').run(path, id); }
  messages(id: string): Message[] { return this.db.prepare('SELECT * FROM messages WHERE conversationId=? ORDER BY rowid').all(id) as unknown as Message[]; }
  runs(id: string): Run[] { return this.db.prepare('SELECT id,taskId,conversationId,state,error FROM runs WHERE conversationId=? ORDER BY rowid').all(id) as unknown as Run[]; }
  run(id: string): Run { const r = this.db.prepare('SELECT id,taskId,conversationId,state,error FROM runs WHERE id=?').get(id) as unknown as Run; if (!r) throw new Error('运行不存在'); return r; }
  existing(requestId: string, conversationId: string, text: string): Run | undefined {
    const row = this.db.prepare('SELECT id,requestHash FROM runs WHERE requestId=?').get(requestId) as { id: string; requestHash: string } | undefined;
    if (!row) return undefined;
    if (row.requestHash !== this.hash(conversationId, text)) throw new Error('重复请求 ID 的内容不一致');
    return this.run(row.id);
  }
  private hash(c: string, text: string) { return createHash('sha256').update(JSON.stringify([c, text])).digest('hex'); }
  start(conversationId: string, text: string, requestId: string, codingTaskId?: string): { run: Run; assistantId: string } {
    this.conversation(conversationId);
    const id = randomUUID(), taskId = codingTaskId ?? randomUUID(), assistantId = randomUUID();
    this.transaction(() => {
      this.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?)').run(id, taskId, conversationId, requestId, this.hash(conversationId, text), 'running', null);
      const stmt = this.db.prepare('INSERT INTO messages(id,conversationId,runId,role,content,status) VALUES(?,?,?,?,?,?)');
      const sharedRun = this.db.prepare("SELECT data FROM shared_state WHERE kind='run' AND id=?").get(requestId) as { data: string } | undefined;
      const mapping = sharedRun ? JSON.parse(sharedRun.data) : null;
      stmt.run(mapping?.messageId ?? randomUUID(), conversationId, id, 'user', text, 'completed');
      if (mapping) this.db.prepare("UPDATE shared_state SET data=? WHERE kind='run' AND id=?").run(JSON.stringify({ ...mapping, starting: false, localRunId: id }), requestId);
      stmt.run(assistantId, conversationId, id, 'assistant', '', 'running');
      const c = this.conversation(conversationId);
      this.db.prepare('UPDATE conversations SET title=?,updatedAt=? WHERE id=?').run(c.title === '新会话' ? text.slice(0, 30) : c.title, Date.now(), conversationId);
    });
    return { run: this.run(id), assistantId };
  }
  updateMessage(id: string, content: string, status: string) { this.db.prepare('UPDATE messages SET content=?,status=? WHERE id=?').run(content, status, id); }
  finish(id: string, state: RunState, error: string | null = null) { this.db.prepare('UPDATE runs SET state=?,error=? WHERE id=?').run(state, error, id); }
  close() { this.db.close(); }
}
