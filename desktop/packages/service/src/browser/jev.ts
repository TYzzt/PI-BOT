import type { DatabaseSync } from 'node:sqlite';
import type { Credentials } from '../keychain.js';
import type { JevStatus } from '../../../protocol/src/index.js';

export const JEV_DEFAULT_URL = 'https://api.typesafe.ai';
export const JEV_DEFAULT_MODEL = 'jev-latest';
// Keychain helper only accepts a UUID account under dev.t-agnet.*.
export const JEV_KEY = '6f0e2b1a-9c34-4d5e-8f70-1a2b3c4d5e6f';
export interface JevSettings { baseUrl: string; model: string; }
export type JevQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> } | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } };
export type JevAnswer = { type: 'choice'; choice: string; confidence?: number; probabilities?: Record<string, number> } | { type: 'noul'; noul: number };
export interface JevResponse { model: string; answers: Record<string, JevAnswer>; }

const clip = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 180);
function detailFrom(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const record = body as Record<string, unknown>;
  const text = (value: unknown) => typeof value === 'string' ? clip(value) : '';
  const direct = text(record.message) || text(record.detail) || text(record.error);
  if (direct) return direct;
  const nested = record.error;
  return nested && typeof nested === 'object' ? text((nested as Record<string, unknown>).message) : '';
}
async function errorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text) return '';
  try { return detailFrom(JSON.parse(text)) || clip(text); } catch { return clip(text); }
}
function pause(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('运行已停止')); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('运行已停止')); }, { once: true });
  });
}

// Request/response shape of TypeSafe's POST /v1/systemone. Keep every field name in this file.
export class JevClient {
  constructor(private settings: JevSettings, private key: string, private fetcher: typeof fetch = fetch) {}
  async ask(state: unknown, questions: Record<string, JevQuestion>, signal?: AbortSignal): Promise<JevResponse> {
    const timeout = AbortSignal.timeout(20000);
    const url = `${this.settings.baseUrl.replace(/\/+$/, '')}/v1/systemone`;
    const init = { method: 'POST', headers: { authorization: `Bearer ${this.key}`, accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ state, model: this.settings.model, questions }) };
    let response!: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await this.fetcher(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.message === '运行已停止')) throw new Error('运行已停止');
        throw new Error(timeout.aborted ? 'Jev 请求超时' : 'Jev 无法连接，请检查网络和 Base URL');
      }
      if ((response.status === 429 || response.status === 529) && attempt < 2) {
        const retryHeader = response.headers.get('retry-after');
        const retryAfter = retryHeader === null ? Number.NaN : Number(retryHeader);
        const delay = Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(retryAfter * 1000, 2000) : 400 * 2 ** attempt;
        await response.body?.cancel().catch(() => {});
        await pause(delay, signal);
        continue;
      }
      break;
    }
    if (response.status === 401 || response.status === 403) throw new Error('Jev key 无效或无权限');
    if (!response.ok) {
      const detail = await errorDetail(response);
      if (response.status === 429) throw new Error(detail ? `Jev 请求过于频繁：${detail}` : 'Jev 请求过于频繁，请稍后再试');
      if (response.status === 529) throw new Error(detail ? `Jev 服务繁忙：${detail}` : 'Jev 服务繁忙，请稍后再试');
      throw new Error(detail ? `Jev 请求失败（HTTP ${response.status}）：${detail}` : `Jev 请求失败（HTTP ${response.status}）`);
    }
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
