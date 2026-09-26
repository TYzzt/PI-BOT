import React, { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import type { CloudChatConversation, CloudChatDetail, CloudModel, ModelConfig } from '../../../packages/protocol/src/index.js';

const statusLabel: Record<string, string> = { queued: '排队中', running: '正在回答', completed: '已完成', cancelled: '已停止', interrupted: '运行中断', failed: '请求失败' };
const terminal = (s?: string) => !s || ['completed', 'cancelled', 'failed', 'interrupted'].includes(s);
function errorText(e: unknown) { return (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, ''); }

export function useCloudModels(enabled: boolean) {
  const [models, setModels] = useState<CloudModel[]>([]), [error, setError] = useState('');
  const load = async () => { try { setModels(await window.agent.call('cloudModelList', {})); setError(''); } catch (e) { setError(errorText(e)); } };
  useEffect(() => { if (enabled) void load(); }, [enabled]);
  return { models, error, reload: load };
}

export function CloudChatPage({ connected, initialId, localModels, onError }: { connected: boolean; initialId: string | null; localModels: ModelConfig[]; onError: (s: string) => void }) {
  const [list, setList] = useState<CloudChatConversation[]>([]), [selected, setSelected] = useState<string | null>(initialId), [detail, setDetail] = useState<CloudChatDetail | null>(null);
  const [draft, setDraft] = useState(''), [busy, setBusy] = useState(false), [offline, setOffline] = useState(''), [creating, setCreating] = useState(false);
  const { models, error: modelError, reload } = useCloudModels(connected);
  const selectedRef = useRef(selected), request = useRef<{ text: string; id: string } | null>(null), bottom = useRef<HTMLDivElement>(null);
  selectedRef.current = selected;
  useEffect(() => { if (initialId) setSelected(initialId); }, [initialId]);
  const loadList = async () => { try { setList(await window.agent.call('cloudChatList', {})); setOffline(''); } catch (e) { setOffline(errorText(e)); } };
  const loadDetail = async (id: string) => { try { const d = await window.agent.call('cloudChatGet', { id }); if (selectedRef.current === id) setDetail(d); setOffline(''); } catch (e) { setOffline(errorText(e)); } };
  useEffect(() => { if (!connected) return; void loadList(); const t = setInterval(() => void loadList(), 5000); return () => clearInterval(t); }, [connected]);
  // The server is authoritative; poll once a second while a conversation is open.
  useEffect(() => { setDetail(null); setDraft(''); request.current = null; if (!connected || !selected) return; void loadDetail(selected); const t = setInterval(() => void loadDetail(selected), 1000); return () => clearInterval(t); }, [connected, selected]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [detail?.messages.map(m => m.content.length).join()]);
  async function perform(fn: () => Promise<void>) { setBusy(true); onError(''); try { await fn(); } catch (e) { onError(errorText(e)); } finally { setBusy(false); } }
  async function create(modelId: string) {
    await perform(async () => { const c = await window.agent.call('cloudChatCreate', { id: crypto.randomUUID(), modelId, title: '云端问答' }); setCreating(false); await loadList(); setSelected(c.id); });
  }
  async function send() {
    if (!selected || !draft.trim()) return;
    const text = draft.trim(), id = request.current?.text === text ? request.current.id : crypto.randomUUID(); request.current = { text, id };
    await perform(async () => { await window.agent.call('cloudChatSend', { conversationId: selected, text, requestId: id }); setDraft(''); request.current = null; await loadDetail(selected); });
  }
  const run = detail?.run, active = run && !terminal(run.state), model = models.find(m => m.id === detail?.conversation.modelId);
  return <div className="cloud-chat">
    <aside className="cloud-chat-list" aria-label="云端会话">
      <button className="new-chat" disabled={!connected || busy} onClick={() => { void reload(); setCreating(true); }}><span>＋</span> 新建云端会话</button>
      {list.map(c => <button key={c.id} className={selected === c.id ? 'conversation selected' : 'conversation'} onClick={() => setSelected(c.id)}><span className="chat-symbol">☁</span><span>{c.title}</span></button>)}
      {!list.length && !offline && <p className="sidebar-hint">云端问答由服务器上的 DeepAgents 执行，Mac 关机时手机也能继续提问。</p>}
    </aside>
    <section className="cloud-chat-main">
      <header className="chat-header"><div><h1>{detail?.conversation.title ?? '云端问答'}</h1><span className="subtitle">{model ? `${model.name} · ${model.modelId}` : '服务器执行 · 不访问这台 Mac'}</span></div><div className="header-actions"><span className="mode-badge">CLOUD · 云端</span></div></header>
      {offline && <div className="sync-note" role="alert">{offline}</div>}
      {detail?.conversation.handoff && <div className="sync-note">从 Mac 会话转来，带入 {detail.conversation.handoff.messageCount} 条共享消息；原会话不受影响。</div>}
      <section className="messages" aria-label="云端聊天记录">
        {!detail?.messages.length ? <div className="welcome"><div className="welcome-mark">☁</div><h2>{selected ? '向云端助手提问' : '选择或新建一个云端会话'}</h2><p>可联网搜索（服务器配置 Tavily 后），不能读取 Mac 上的项目和文件。</p></div>
          : detail.messages.map(m => <article key={m.id} className={`message ${m.role}`}><div className="message-label">{m.role === 'user' ? '你' : '云端助手'}{<span>{m.role === 'assistant' ? statusLabel[m.status] ?? m.status : m.sequence === 0 ? statusLabel[run?.state ?? 'queued'] : ''}</span>}</div>
            <div className="message-body">{m.content ? <Markdown skipHtml components={{ a: ({ href, children }) => <a href={href} onClick={e => { e.preventDefault(); if (href) void window.agent.openExternal(href).catch(err => onError(errorText(err))); }}>{children}</a>, img: () => <span>[图片未加载]</span> }}>{m.content}</Markdown> : <span className="muted">{m.status === 'running' ? '正在思考…' : '没有生成内容'}</span>}</div>
            {m.role === 'assistant' && run?.id === m.runId && run.error && <div className="message-error">{run.error}</div>}</article>)}
        <div ref={bottom}/>
      </section>
      <footer className="composer-area">{active && <div className="run-note">{run!.cancelRequested ? '正在停止，请稍候…' : run!.state === 'queued' ? '已提交，等待云端 Worker 领取' : '云端正在生成回复'}</div>}
        <div className="composer"><textarea aria-label="输入云端问题" placeholder={selected ? '输入你的问题…' : '新建云端会话后开始提问'} value={draft} disabled={!selected || !connected} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!active && !busy) void send(); } }}/>
          <div className="composer-toolbar"><span>云端执行 · 无本机权限</span>{active ? <button className="stop" disabled={busy || run!.cancelRequested} onClick={() => void perform(async () => { await window.agent.call('cloudChatCancel', { runId: run!.id }); await loadDetail(selected!); })}>■ 停止生成</button> : <button className="primary send" disabled={!selected || !draft.trim() || busy || !connected} onClick={send}>发送 ↑</button>}</div></div></footer>
    </section>
    {creating && <div className="modal-backdrop"><section className="modal" role="dialog" aria-label="新建云端会话"><h2>新建云端会话</h2>
      {modelError ? <p role="alert">{modelError}</p> : !models.length ? <p>还没有云端模型。在「模型设置」的模型卡片上点击“复制到云端”{localModels.length ? '' : '（需要先添加本机模型）'}。</p> : <><p>选择云端使用的模型：</p>{models.map(m => <button key={m.id} className="model-choice" disabled={busy} onClick={() => void create(m.id)}>{m.name}<small>{m.modelId}{m.isDefault ? ' · 默认' : ''}</small></button>)}</>}
      <div className="modal-actions"><button onClick={() => setCreating(false)}>取消</button></div></section></div>}
  </div>;
}

export function HandoffDialog({ conversationId, localModelId, onClose, onDone, onError }: { conversationId: string; localModelId: string; onClose: () => void; onDone: (id: string) => void; onError: (s: string) => void }) {
  const { models, error, reload } = useCloudModels(true);
  const [busy, setBusy] = useState(false), requestId = useRef(crypto.randomUUID()), targetId = useRef(crypto.randomUUID());
  const copied = models.find(m => m.sourceModelId === localModelId);
  const [choice, setChoice] = useState('');
  useEffect(() => { if (!choice && models.length) setChoice((copied ?? models.find(m => m.isDefault) ?? models[0]).id); }, [models]);
  async function perform(fn: () => Promise<void>) { setBusy(true); onError(''); try { await fn(); } catch (e) { onError(errorText(e)); } finally { setBusy(false); } }
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-label="转到云端继续"><h2>转到云端继续</h2>
    <p>新建一个云端会话，只带上这段会话已共享的聊天记录（最近 40 条、最多 6 万字）。原会话保持不变；云端不能读取项目文件或执行命令。</p>
    {error ? <p role="alert">{error}</p> : !models.length ? <><p>还没有云端模型。</p><button disabled={busy} onClick={() => void perform(async () => { await window.agent.call('cloudModelFromLocal', { modelId: localModelId, requestId: crypto.randomUUID() }); await reload(); })}>把当前模型复制到云端</button></>
      : <label>云端模型<select aria-label="云端模型" value={choice} onChange={e => setChoice(e.target.value)}>{models.map(m => <option key={m.id} value={m.id}>{m.name} · {m.modelId}</option>)}</select></label>}
    <div className="modal-actions"><button onClick={onClose}>取消</button><button className="primary" disabled={busy || !choice} onClick={() => void perform(async () => { const c = await window.agent.call('cloudChatHandoff', { id: targetId.current, conversationId, modelId: choice, requestId: requestId.current }); onDone(c.id); })}>转到云端</button></div>
  </section></div>;
}

export function CopyToCloud({ modelId, disabled, onError }: { modelId: string; disabled: boolean; onError: (s: string) => void }) {
  const [state, setState] = useState<'idle' | 'working' | 'done'>('idle');
  return <button disabled={disabled || state === 'working'} title="在服务器上复制一份云端模型，密钥不经过本机传输" onClick={() => { setState('working'); onError(''); void window.agent.call('cloudModelFromLocal', { modelId, requestId: crypto.randomUUID() }).then(() => setState('done'), e => { setState('idle'); onError(errorText(e)); }); }}>{state === 'done' ? '已复制到云端' : state === 'working' ? '复制中…' : '复制到云端'}</button>;
}
