import type { DatabaseSync } from 'node:sqlite';
import type { Credentials } from '../keychain.js';
import type { JevStatus } from '../../../protocol/src/index.js';

export const JEV_DEFAULT_URL = 'https://api.typesafe.ai';
export const JEV_DEFAULT_MODEL = 'jev-latest';
export const JEV_KEY = 'jev-key';
export interface JevSettings { baseUrl: string; model: string; }
export type JevQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> } | { type: 'noul'; instructions: string };
export type JevAnswer = { type: 'choice'; choice: string; confidence?: number; probabilities?: Record<string, number> } | { type: 'noul'; noul: number };
export interface JevResponse { model: string; answers: Record<string, JevAnswer>; }

// Request/response shape of TypeSafe's POST /v1/systemone. Keep every field name in this file.
export class JevClient {
  constructor(private settings: JevSettings, private key: string, private fetcher: typeof fetch = fetch) {}
  async ask(state: unknown, questions: Record<string, JevQuestion>, signal?: AbortSignal): Promise<JevResponse> {
    const timeout = AbortSignal.timeout(20000);
    let response: Response;
    try {
      response = await this.fetcher(`${this.settings.baseUrl.replace(/\/+$/, '')}/v1/systemone`, {
        method: 'POST', headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.settings.model, state, questions }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw new Error('运行已停止');
      throw new Error(timeout.aborted ? 'Jev 请求超时' : 'Jev 无法连接，请检查网络和 Base URL');
    }
    if (response.status === 401 || response.status === 403) throw new Error('Jev key 无效或无权限');
    if (response.status === 429) throw new Error('Jev 请求过于频繁或余额不足');
    if (!response.ok) throw new Error(`Jev 请求失败（HTTP ${response.status}）`);
    let body: any;
    try { body = await response.json(); } catch { throw new Error('Jev 返回无效 JSON'); }
    if (!body || typeof body.answers !== 'object' || body.answers === null) throw new Error('Jev 返回缺少 answers');
    for (const [name, question] of Object.entries(questions)) {
      const answer = body.answers[name];
      if (question.type === 'choice' && (answer?.type !== 'choice' || typeof answer.choice !== 'string')) throw new Error(`Jev 未返回问题 ${name} 的选择`);
      if (question.type === 'noul' && (answer?.type !== 'noul' || typeof answer.noul !== 'number')) throw new Error(`Jev 未返回问题 ${name} 的概率`);
    }
    return { model: typeof body.model === 'string' ? body.model : this.settings.model, answers: body.answers };
  }
}

export class JevConfig {
  constructor(private db: DatabaseSync, private keys: Credentials, private fetcher: typeof fetch = fetch) {}
  settings(): JevSettings | null {
    const row = this.db.prepare("SELECT data FROM shared_state WHERE kind='jev' AND id='settings'").get() as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }
  async status(): Promise<JevStatus> {
    const s = this.settings(), hasKey = !!s && !!await this.keys.get(JEV_KEY).catch(() => null);
    return { configured: !!s && hasKey, baseUrl: s?.baseUrl ?? JEV_DEFAULT_URL, model: s?.model ?? JEV_DEFAULT_MODEL, hasKey };
  }
  async save(input: { baseUrl: string; model: string; apiKey?: string }): Promise<JevStatus> {
    if (!input.apiKey && !await this.keys.get(JEV_KEY)) throw new Error('请填写 Jev API Key');
    if (input.apiKey) await this.keys.set(JEV_KEY, input.apiKey);
    this.db.prepare("INSERT INTO shared_state VALUES('jev','settings',?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data").run(JSON.stringify({ baseUrl: input.baseUrl, model: input.model }));
    return this.status();
  }
  async remove(): Promise<JevStatus> {
    this.db.prepare("DELETE FROM shared_state WHERE kind='jev' AND id='settings'").run();
    await this.keys.delete(JEV_KEY);
    return this.status();
  }
  async client(): Promise<JevClient | null> {
    const s = this.settings(); if (!s) return null;
    const key = await this.keys.get(JEV_KEY).catch(() => null);
    return key ? new JevClient(s, key, this.fetcher) : null;
  }
  async test(): Promise<{ ok: true; model: string }> {
    const client = await this.client(); if (!client) throw new Error('尚未配置 Jev');
    const result = await client.ask('The page shows a button labelled "Submit".', { check: { type: 'noul', instructions: 'Is there a submit button?' } });
    return { ok: true, model: result.model };
  }
}
