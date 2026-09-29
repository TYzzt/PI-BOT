import type { Api, CloudChatConversation, CloudChatDetail, CloudChatMessage, CloudChatRun, CloudModel } from '../../../protocol/src/index.js';
import { CloudHttpError, CloudNetworkError } from './client.js';

// Cloud conversations live on the server only; nothing here touches local SQLite.
export type CloudChatMethod = 'cloudChatList' | 'cloudChatGet' | 'cloudChatCreate' | 'cloudChatSend' | 'cloudChatCancel' | 'cloudChatHandoff' | 'cloudModelList' | 'cloudModelFromLocal';
export const cloudChatMethods: ReadonlySet<string> = new Set<CloudChatMethod>(['cloudChatList', 'cloudChatGet', 'cloudChatCreate', 'cloudChatSend', 'cloudChatCancel', 'cloudChatHandoff', 'cloudModelList', 'cloudModelFromLocal']);
export interface CloudChatHost { paired(): boolean; request<T>(method: string, path: string, body?: unknown): Promise<T>; }

export const toConversation = (d: any): CloudChatConversation => ({ id: d.id, updatedAt: d.updated_at ?? 0, version: d.version, title: d.title, modelId: d.model_config_id, handoff: d.handoff ? { fromConversationId: d.handoff.from_conversation_id, messageCount: d.handoff.message_count } : null });
export const toMessage = (d: any): CloudChatMessage => ({ id: d.id, runId: d.run_id, role: d.role, content: d.content, status: d.status, sequence: d.sequence });
export const toRun = (d: any): CloudChatRun => ({ id: d.id, conversationId: d.conversation_id, state: d.state, cancelRequested: !!d.cancel_requested, error: d.error ?? null });
export const toModel = (d: any): CloudModel => ({ id: d.id, version: d.version, name: d.config.name, modelId: d.config.model_id, isDefault: !!d.config.is_default, sourceModelId: d.source_model_id ?? null });

export class CloudChat {
  constructor(private host: CloudChatHost) {}

  async dispatch<M extends CloudChatMethod>(method: M, input: Api[M]['input']): Promise<Api[M]['output']> {
    if (!this.host.paired()) throw new Error('云端问答需要先在「设置」中配对云端');
    try { return await this.handle(method, input as any) as Api[M]['output']; }
    catch (e) {
      if (e instanceof CloudNetworkError) throw new Error('云端离线：无法连接服务器，请检查网络后重试');
      if (e instanceof CloudHttpError && e.status === 404 && method === 'cloudModelFromLocal') throw new Error('该模型还没有同步到云端，请等待同步完成后再试');
      if (e instanceof CloudHttpError && e.status === 404 && method === 'cloudChatHandoff') throw new Error('原会话还没有同步到云端，请等待自动同步完成');
      throw e;
    }
  }

  private async handle(method: CloudChatMethod, input: any): Promise<unknown> {
    const r = this.host.request.bind(this.host);
    switch (method) {
      case 'cloudChatList': return (await r<any[]>('GET', '/device/cloud/conversations')).map(toConversation);
      case 'cloudModelList': return (await r<any[]>('GET', '/device/cloud/models')).filter(m => !m.deleted).map(toModel);
      case 'cloudModelFromLocal': return toModel(await r('POST', '/device/cloud/models/from-mac', { request_id: input.requestId, model_id: input.modelId }));
      case 'cloudChatCreate': return toConversation(await r('PUT', `/device/cloud/conversations/${input.id}`, { expected_version: 0, request_id: input.id, title: input.title, model_config_id: input.modelId }));
      case 'cloudChatHandoff': return toConversation(await r('POST', `/device/cloud/conversations/${input.id}/handoff-from/${input.conversationId}`, { request_id: input.requestId, model_config_id: input.modelId }));
      case 'cloudChatSend': return toRun(await r('POST', `/device/cloud/conversations/${input.conversationId}/messages`, { text: input.text, request_id: input.requestId }));
      case 'cloudChatCancel': return toRun(await r('POST', `/device/cloud/chat-runs/${input.runId}/cancel`));
      case 'cloudChatGet': return this.detail(input.id);
    }
  }

  private async detail(id: string): Promise<CloudChatDetail> {
    const conversation = (await this.host.request<any[]>('GET', '/device/cloud/conversations')).find(c => c.id === id);
    if (!conversation) throw new Error('云端会话不存在或已删除');
    const messages: CloudChatMessage[] = [];
    let after = 0, pending: any[] = [];
    for (;;) {
      const page = await this.host.request<any>('GET', `/device/cloud/conversations/${id}/messages?after=${after}&limit=500`);
      messages.push(...page.messages.map(toMessage)); pending = page.pending_messages; after = page.next_cursor;
      if (!page.has_more) break;
    }
    messages.push(...pending.map(toMessage));
    const last = messages.at(-1);
    // Handed-off history carries a synthetic run id with no run record behind it.
    const run = last ? await this.host.request<any>('GET', `/device/cloud/chat-runs/${last.runId}`).then(toRun, e => { if (e instanceof CloudHttpError && e.status === 404) return null; throw e; }) : null;
    return { conversation: toConversation(conversation), messages, run };
  }
}
