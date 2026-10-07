import { createRefreshScheduler } from './refresh.js';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { DesktopBridge, Snapshot, ConversationDetail, ModelConfig, ModelInput, Project, CloudChatConversation } from '../../../packages/protocol/src/index.js';
import './style.css';
import { ProjectChatStart, Programming } from './coding.js';
import { CloudLogin, CloudPanel, SharedPanel, useCloudStatus } from './cloud.js';
import { CloudChatPage } from './cloud-chat.js';
import { ConfigsPage } from './configs.js';
import { BrowserPanel } from './browser.js';
import { Sidebar } from './navigation.js';
declare global { interface Window { agent: DesktopBridge } }
const empty: Snapshot = { models: [], conversations: [], activeRun: null, testing: false };
const statusLabel: Record<string, string> = { running: '正在回答', cancelling: '正在停止', completed: '已完成', cancelled: '已停止', interrupted: '运行中断', failed: '请求失败' };
function errorText(e: unknown) { return (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, ''); }

function App() {
  const [projects, setProjects] = useState<Project[]>([]), [projectTarget, setProjectTarget] = useState('');
  const [cloudConversations, setCloudConversations] = useState<CloudChatConversation[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot>(empty), [selected, setSelected] = useState<string | null>(null), [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [connected, setConnected] = useState(false), [page, setPage] = useState<'chat' | 'settings' | 'projects' | 'cloud' | 'configs'>('chat'), [error, setError] = useState(''), [draft, setDraft] = useState(''), [busy, setBusy] = useState(false), [rename, setRename] = useState<string | null>(null);
  const cloud = useCloudStatus(connected);
  useEffect(() => {
    if (!cloud.status?.paired) { setCloudConversations([]); return; }
    let live = true;
    const load = () => void window.agent.call('cloudChatList', {}).then(rows => { if (live) setCloudConversations(rows); }).catch(() => {});
    load(); const timer = setInterval(load, 3000);
    return () => { live = false; clearInterval(timer); };
  }, [cloud.status?.paired]);
  const [cloudTarget, setCloudTarget] = useState<string | null>(null);
  const selectedRef = useRef(selected), requestRef = useRef<{ text: string; conversationId: string; id: string } | null>(null), detailEpoch = useRef(0), bottom = useRef<HTMLDivElement>(null), creatingChat = useRef(false), sending = useRef(false), preserveDraftFor = useRef<string | null>(null);
  const deltas = useRef(new Map<string, string>());
  selectedRef.current = selected;
  const fetchDetail = async (id: string) => { const epoch = ++detailEpoch.current; const d = await window.agent.call('conversationGet', { id }); if (selectedRef.current === id && epoch === detailEpoch.current) {
    d.messages = d.messages.map(m => deltas.current.has(m.id) ? { ...m, content: deltas.current.get(m.id)! } : m); setDetail(d);
  } };
  const refresh = async () => { const [s, p] = await Promise.all([window.agent.call('snapshot', {}), window.agent.call('projectList', {})]); setSnapshot(s); setProjects(p); setConnected(true); if (selectedRef.current) { if (s.conversations.some(c => c.id === selectedRef.current)) await fetchDetail(selectedRef.current); else { selectedRef.current = null; setSelected(null); setDetail(null); } } };
  useEffect(() => {
    let alive = true;
    const scheduler = createRefreshScheduler(refresh, () => { if (alive) setConnected(false); });
    const load = () => scheduler.request();
    scheduler.request(true); const poll = setInterval(() => scheduler.request(true), 2000);
    const off = window.agent.subscribe(event => {
      if (event.type === 'service.status') { setConnected(!!event.connected); if (event.connected) load(); return; }
      if (event.type === 'message.delta' && event.message_id) { deltas.current.set(event.message_id, event.content ?? ''); if (event.conversation_id === selectedRef.current) setDetail(d => d ? { ...d, messages: d.messages.map(m => m.id === event.message_id ? { ...m, content: event.content ?? '' } : m) } : d); }
      else { if (event.type === 'message.finalized' && event.message_id) deltas.current.delete(event.message_id); load(); }
    }); return () => { alive = false; scheduler.stop(); clearInterval(poll); off(); };
  }, []);
  useEffect(() => { if (!selected || preserveDraftFor.current !== selected) { setDraft(''); requestRef.current = null; } preserveDraftFor.current = null; setDetail(null); if (selected) void fetchDetail(selected).catch(e => setError(errorText(e))); }, [selected]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [detail?.messages.map(m => m.content).join('')]);
  async function action(fn: () => Promise<void>) { setError(''); setBusy(true); try { await fn(); await refresh(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }
  function emptyAsk() {
    const asks = snapshot.conversations.filter(c => !c.projectId && c.kind !== 'coding');
    const open = asks.find(c => c.id === selected);
    if (open && detail?.conversation.id === open.id && !detail.messages.length) return open;
    return asks.find(c => c.title === '新会话');
  }
  async function createChat() {
    if (creatingChat.current || sending.current || !connected || busy) return;
    const existing = emptyAsk(); if (existing) { if (!selected) preserveDraftFor.current = existing.id; setSelected(existing.id); setPage('chat'); return; }
    const model = snapshot.models.find(m => m.isDefault) ?? snapshot.models[0]; if (!model) { setPage('settings'); return; }
    creatingChat.current = true;
    try { await action(async () => { const c = await window.agent.call('conversationCreate', { modelConfigId: model.id }); if (!selected) preserveDraftFor.current = c.id; setSelected(c.id); setPage('chat'); }); }
    finally { creatingChat.current = false; }
  }
  async function send() {
    if (!draft.trim() || !connected || blocked || busy || sending.current || creatingChat.current) return;
    const text = draft.trim();
    const model = snapshot.models.find(m => m.isDefault) ?? snapshot.models[0];
    if (!selected && !model) { setError('请先配置模型，输入的内容会保留。'); setPage('settings'); return; }
    sending.current = true;
    try {
      await action(async () => {
        let conversationId = selected;
        if (!conversationId) {
          const existing = emptyAsk();
          const reusable = existing && !(await window.agent.call('conversationGet', { id: existing.id })).messages.length;
          const conversation = reusable ? existing : await window.agent.call('conversationCreate', { modelConfigId: model!.id });
          conversationId = conversation.id;
          // Selecting the newly created conversation must not discard the draft on a failed send.
          preserveDraftFor.current = conversationId; selectedRef.current = conversationId; setSelected(conversationId);
        }
        const old = requestRef.current;
        const id = old?.text === text && old.conversationId === conversationId ? old.id : crypto.randomUUID();
        requestRef.current = { text, conversationId, id };
        await window.agent.call('messageSend', { conversationId, text, requestId: id });
        if (selectedRef.current === conversationId) setDraft(current => current.trim() === text ? '' : current);
        if (requestRef.current?.id === id) requestRef.current = null;
      });
    } finally { sending.current = false; }
  }
  const blocked = !!snapshot.activeRun || snapshot.testing;
  const currentModel = snapshot.models.find(m => m.id === detail?.conversation.modelConfigId);
  if (connected && !cloud.status?.paired) {
    if (!cloud.status) return <div className="login-screen"><p className="muted">正在确认云端状态…</p></div>;
    return <CloudLogin connected={connected} error={error} onError={setError}/>;
  }
  return <div className="layout">
    <Sidebar projects={projects} conversations={snapshot.conversations} cloudConversations={cloudConversations}
      page={page} selected={page === 'chat' && selected ? { source: 'local', id: selected } : page === 'cloud' && cloudTarget ? { source: 'cloud', id: cloudTarget } : null}
      activeConversationId={snapshot.activeRun?.conversationId} disabled={!connected || busy} connected={connected}
      syncLabel={!connected ? '正在连接本地服务…' : !cloud.status?.paired ? '待连接云端' : !cloud.status.connected ? '离线 · 等待自动同步' : cloud.status.failed || cloud.status.failures.length ? '同步遇到问题 · 前往设置' : cloud.status.pending ? '正在同步…' : '已连接云端 · 自动同步'}
      onNew={() => void createChat()}
      onOpen={ref => { if (ref.source === 'local') { setSelected(ref.id); setPage('chat'); } else { setCloudTarget(ref.id); setPage('cloud'); } }}
      onPage={setPage} onProject={id => { setProjectTarget(id); setPage('projects'); }}
      onAddProject={() => void action(async () => { const path = await window.agent.chooseProjectDirectory(); if (!path) return; const p = await window.agent.call('projectAdd', { path, requestId: crypto.randomUUID() }); setProjectTarget(p.id); setPage('projects'); })}/>
    <main>{error && <div className="error-banner" role="alert">{error}<button onClick={() => setError('')} aria-label="关闭错误">×</button></div>}
      {page === 'configs' ? <ConfigsPage connected={connected} onError={setError}/> : page === 'cloud' ? <CloudChatPage connected={connected} initialId={cloudTarget} onSelect={setCloudTarget} onCreated={c => { setCloudConversations(rows => [c, ...rows.filter(r => r.id !== c.id)]); setCloudTarget(c.id); }} localModels={snapshot.models} onError={setError}/> : page === 'settings' ? <Settings models={snapshot.models} connected={connected} blocked={blocked || busy} refresh={refresh} onError={setError}/> : page === 'projects' ? <ProjectChatStart key={projectTarget} project={projects.find(p => p.id === projectTarget)} models={snapshot.models} connected={connected} blocked={blocked} onError={setError} onOpen={id => { setSelected(id); setPage('chat'); void refresh(); }}/> : snapshot.conversations.find(c => c.id === selected)?.kind === 'coding' && selected ? <Programming key={selected} conversationId={selected} models={snapshot.models} connected={connected} blocked={blocked} activeRunId={snapshot.activeRun?.id} cancelling={snapshot.activeRun?.state === 'cancelling'} onError={setError} refresh={refresh} branch={projects.find(p => p.id === snapshot.conversations.find(c => c.id === selected)?.projectId)?.branch}/> : <>
        <header className="chat-header"><div><h1>{detail?.conversation.title ?? '工作从一个问题开始'}</h1><span className="subtitle">{currentModel ? `${currentModel.name} · ${currentModel.modelId}` : '本机运行 · 自动同步'}</span></div><div className="header-actions"><span className="mode-badge">ASK · 问答</span>{selected && <><button title="重命名" onClick={() => { setRename(detail?.conversation.title ?? ''); }}>重命名</button><button disabled={snapshot.activeRun?.conversationId === selected} onClick={() => { if (confirm('删除此会话及聊天记录？')) void action(async () => { await window.agent.call('conversationDelete', { id: selected }); selectedRef.current = null; setSelected(null); setDetail(null); }); }}>删除</button></>}</div></header>
        {selected && <SharedPanel conversationId={selected} onError={setError}/>}
        <section className="messages" aria-label="聊天记录">{!detail?.messages.length ? <div className="welcome"><div className="welcome-mark">T<span>✦</span></div><h2>{snapshot.models.length ? '今天，想聊些什么？' : '先连接你的模型'}</h2><p>{snapshot.models.length ? '整理思路，探索问题，继续上一次的对话。' : '填入模型接口和密钥，开始你的第一段对话。'}</p>{!snapshot.models.length ? <button className="primary" onClick={() => setPage('settings')}>配置模型 →</button> : !selected ? <button className="primary" onClick={createChat}>开始新对话 →</button> : <div className="suggestions">{['帮我把一个复杂问题拆解成清晰的步骤', '解释一下 AI agent 和大语言模型的区别'].map(t => <button key={t} onClick={() => setDraft(t)}>{t} ↗</button>)}</div>}<div className="privacy-note">{cloud.status?.paired ? '对话自动同步 · 模型请求发送到你配置的服务商' : '连接云端后自动同步 · 当前记录保存在本机'}</div></div> : detail.messages.map(m => <article key={m.id} className={`message ${m.role}`}><div className="message-label">{m.role === 'user' ? '你' : 'T-AGNET'}{m.role === 'assistant' && <span>{statusLabel[m.status] ?? m.status}</span>}</div><div className="message-body">{m.content ? <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ href, children }) => <a href={href} onClick={e => { e.preventDefault(); if (href) void window.agent.openExternal(href).catch(e => setError(errorText(e))); }}>{children}</a>, img: () => <span>[图片未加载]</span> }}>{m.content}</Markdown> : <span className="muted">{m.status === 'running' ? '正在思考…' : '没有生成内容'}</span>}</div>{m.role === 'assistant' && detail.runs.find(r => r.id === m.runId)?.error && <div className="message-error">{detail.runs.find(r => r.id === m.runId)?.error}</div>}</article>)}<div ref={bottom}/></section>
        <footer className="composer-area">{blocked && <div className="run-note">{snapshot.testing ? '正在测试模型连接' : snapshot.activeRun?.state === 'cancelling' ? '正在停止，请稍候…' : snapshot.activeRun?.conversationId === selected ? '正在生成回复' : '另一个会话正在生成，请等待或停止当前请求'}</div>}<div className="composer"><textarea aria-label="输入问题" placeholder="输入你的问题…" value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!blocked && !busy) void send(); } }}/><div className="composer-toolbar"><span>纯问答 · 无本机工具权限</span>{snapshot.activeRun ? <button className="stop" disabled={!connected || snapshot.activeRun.state === 'cancelling'} onClick={() => void action(async () => { await window.agent.call('runCancel', { id: snapshot.activeRun!.id }); })}>■ 停止生成</button> : <button className="primary send" disabled={!draft.trim() || blocked || busy || !connected} onClick={send}>发送 ↑</button>}</div></div><div className="composer-hint">Enter 发送 · Shift + Enter 换行</div></footer>
      </>}
    {rename !== null && selected && <div className="modal-backdrop"><form className="modal" role="dialog" aria-label="重命名会话" onSubmit={e => { e.preventDefault(); void action(async () => { await window.agent.call('conversationRename', { id: selected, title: rename }); setRename(null); }); }}><h2>重命名会话</h2><input aria-label="会话名称" autoFocus required maxLength={120} value={rename} onChange={e => setRename(e.target.value)}/><div className="modal-actions"><button type="button" onClick={() => setRename(null)}>取消</button><button className="primary" disabled={busy}>保存名称</button></div></form></div>}
    </main>
  </div>;
}
type ModelDraft = Omit<ModelInput, 'contextWindow'> & { contextWindow: number | '' };
const defaults: ModelDraft = { name: '', baseUrl: '', modelId: '', apiKey: '', contextWindow: '', maxTokens: 4096 };
function Settings({ models, connected, blocked, refresh, onError }: { models: ModelConfig[]; connected: boolean; blocked: boolean; refresh: () => Promise<void>; onError: (s: string) => void }) {
  const [form, setForm] = useState<ModelDraft>({ ...defaults }), [working, setWorking] = useState(false), [notice, setNotice] = useState(''), [deleting, setDeleting] = useState<string | null>(null), [replacement, setReplacement] = useState('');
  const disabled = !connected || blocked || working;
  async function perform(fn: () => Promise<void>) { setWorking(true); onError(''); setNotice(''); try { await fn(); await refresh(); } catch (e) { onError(errorText(e)); } finally { setWorking(false); } }
  const field = (key: keyof ModelDraft, value: string | number) => setForm(f => ({ ...f, [key]: value }));
  return <div className="settings-page"><header><div className="eyebrow">PREFERENCES</div><h1>设置</h1><p>连接你自己的模型。API Key 保存在 macOS Keychain。</p></header>
    <h2 className="settings-section-title">模型</h2><div className="settings-grid"><section className="model-list"><div className="section-heading">已配置模型<button onClick={() => { setForm({ ...defaults }); setNotice(''); }}>＋ 添加</button></div>{!models.length && <div className="empty-models">还没有模型配置<br/><span>在右侧添加你的第一个模型。</span></div>}{models.map(m => <div key={m.id} className={`model-card ${form.id === m.id ? 'active' : ''}`}><button className="model-title" onClick={() => { setForm({ id: m.id, name: m.name, baseUrl: m.baseUrl, modelId: m.modelId, apiKey: '', contextWindow: m.contextWindow || '', maxTokens: m.maxTokens }); setNotice(''); }}><strong>{m.name}</strong>{m.isDefault && <span className="tag">默认</span>}<small>{m.modelId}</small></button><SharedPanel modelId={m.id} onError={onError}/><div className="key-status">{m.hasKey ? '● 密钥已配置' : '○ 缺少密钥'}</div><div className="card-actions"><button disabled={disabled} onClick={() => perform(async () => { await window.agent.call('modelTest', { id: m.id }); setNotice(`${m.name}：连接成功`); })}>测试连接</button>{!m.isDefault && <button disabled={disabled} onClick={() => perform(async () => { await window.agent.call('modelDefault', { id: m.id }); })}>设为默认</button>}<button disabled={disabled} onClick={() => { setDeleting(m.id); setReplacement(''); }}>删除</button></div></div>)}</section>
    <form className="model-form" onSubmit={e => { e.preventDefault(); const contextWindow = form.contextWindow; if (contextWindow === '') return; void perform(async () => { const m = await window.agent.call('modelSave', { ...form, contextWindow }); setForm({ ...form, id: m.id, apiKey: '', contextWindow }); setNotice('配置已保存。可点击“测试连接”验证模型。'); }); }}><h2>{form.id ? '编辑模型' : '添加模型'}</h2><div className="protocol-badge">OpenAI 兼容 · Chat Completions</div>
      <label>显示名称<input required maxLength={80} value={form.name} placeholder="我的模型" onChange={e => field('name', e.target.value)}/></label>
      <label>Base URL<input aria-label="Base URL" required type="url" value={form.baseUrl} placeholder="https://your-provider.example/v1" onChange={e => field('baseUrl', e.target.value)}/><small>填写完整 API 根地址，不包含 /chat/completions。</small></label>
      <label>模型 ID<input required value={form.modelId} placeholder="服务商提供的模型名称" onChange={e => field('modelId', e.target.value)}/></label>
      <label>API Key<input type="password" autoComplete="off" required={!form.id} value={form.apiKey ?? ''} placeholder={form.id ? '已保存，留空则保持原密钥' : '仅保存在本机 Keychain'} onChange={e => field('apiKey', e.target.value)}/></label>
      <details><summary>高级设置</summary><div className="advanced"><label>上下文长度<input type="number" required min={1024} max={4000000} placeholder="按服务商公布填写" value={form.contextWindow} onInvalid={e => { const details = e.currentTarget.closest('details'); if (details) details.open = true; }} onChange={e => field('contextWindow', e.target.value === '' ? '' : Number(e.target.value))}/></label><label>输出上限<input type="number" required min={16} max={1000000} value={form.maxTokens} onChange={e => field('maxTokens', Number(e.target.value))}/></label></div><small>请按服务商公布的模型能力填写。</small></details>
      <button className="primary save" disabled={disabled}>{working ? '处理中…' : '保存配置'}</button>{notice && <p className="success" role="status">✓ {notice}</p>}
    </form></div>
    <CloudPanel connected={connected} onError={onError}/><SharedPanel onError={onError}/><BrowserPanel connected={connected} onError={onError}/>
    {deleting && <div className="modal-backdrop"><section className="modal" role="dialog" aria-label="删除模型"><h2>删除模型配置</h2><p>已有会话使用此模型时，需要选择替代模型。</p><select aria-label="替代模型" value={replacement} onChange={e => setReplacement(e.target.value)}><option value="">不替换（仅限未被引用的模型）</option>{models.filter(m => m.id !== deleting).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select><div className="modal-actions"><button onClick={() => setDeleting(null)}>返回</button><button className="danger" disabled={disabled} onClick={() => perform(async () => { await window.agent.call('modelDelete', { id: deleting, ...(replacement ? { replacementId: replacement } : {}) }); if (form.id === deleting) setForm({ ...defaults }); setDeleting(null); })}>确认删除</button></div></section></div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
