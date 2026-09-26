import React, { useEffect, useState } from 'react';
import type { CloudStatus } from '../../../packages/protocol/src/index.js';
function message(error: unknown) { return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, ''); }
function time(at: number | null) { return at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '尚未同步'; }
export function useCloudStatus(connected: boolean) {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const refresh = async () => { setStatus(await window.agent.call('cloudStatus', {})); };
  useEffect(() => { if (!connected) return; let live = true; const load = () => void window.agent.call('cloudStatus', {}).then(s => { if (live) setStatus(s); }).catch(() => {}); load(); const timer = setInterval(load, 5000); const off = window.agent.subscribe(e => { if (e.type === 'cloud.changed' || (e.type === 'service.status' && e.connected)) load(); }); return () => { live = false; clearInterval(timer); off(); }; }, [connected]);
  return { status, setStatus, refresh };
}
export function CloudPanel({ connected, onError }: { connected: boolean; onError: (s: string) => void }) {
  const { status, setStatus } = useCloudStatus(connected);
  const [form, setForm] = useState({ serverUrl: '', label: '', password: '' }), [working, setWorking] = useState(false);
  const disabled = !connected || working;
  async function perform(fn: () => Promise<CloudStatus>) { setWorking(true); onError(''); try { setStatus(await fn()); } catch (e) { onError(message(e)); } finally { setWorking(false); } }
  return <section className="cloud-panel" aria-label="云端同步"><div className="section-heading"><h2>云端同步</h2>{status?.paired && <span className={`cloud-state ${status.connected ? 'online' : ''}`}><i/>{status.connected ? '已连接云端' : '云端离线，正在重连'}</span>}</div>
    {!status ? <p className="muted">正在读取云端状态…</p> : !status.paired ? <form className="cloud-form" onSubmit={e => { e.preventDefault(); void perform(async () => { const s = await window.agent.call('cloudPair', form); setForm(f => ({ ...f, password: '' })); return s; }); }}>
      <p>把这台 Mac 登记为云端执行设备。管理员密码只用于本次配对，不会保存；设备私钥保存在 macOS Keychain。</p>
      <label>服务器地址<input aria-label="服务器地址" required type="url" value={form.serverUrl} placeholder="https://agent.example.com" onChange={e => setForm(f => ({ ...f, serverUrl: e.target.value }))}/><small>只填写协议、主机和端口。</small></label>
      <label>设备名称<input aria-label="设备名称" required maxLength={80} value={form.label} placeholder="我的 MacBook" onChange={e => setForm(f => ({ ...f, label: e.target.value }))}/></label>
      <label>管理员密码<input aria-label="管理员密码" required type="password" autoComplete="off" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}/></label>
      <button className="primary" disabled={disabled}>{working ? '正在配对…' : '配对设备'}</button>
    </form> : <div className="cloud-info">
      <dl><dt>服务器</dt><dd>{status.serverUrl}</dd><dt>设备</dt><dd>{status.label} <small>{status.deviceId}</small></dd><dt>最近同步</dt><dd>{time(status.lastSyncAt)}</dd><dt>待上传</dt><dd>{status.pending} 条</dd><dt>排队命令</dt><dd>{status.queued} 条</dd><dt>发送失败</dt><dd>{status.failed} 条</dd><dt>共享项目</dt><dd>{status.projects.filter(p => p.enabled).length} 个 · 在「项目与编程」中开启</dd></dl>
      {status.failures.length > 0 && <ul className="cloud-failures" aria-label="同步问题">{status.failures.map((f, i) => <li key={i}><time>{time(f.at)}</time>{f.message}</li>)}</ul>}
      <p className="muted">云端保存共享聊天、计划、执行摘要及加密模型密钥；项目文件、diff 和原始工具输出留在本机。</p>
      <div className="card-actions"><button disabled={disabled} onClick={() => void perform(() => window.agent.call('cloudRetry', {}))}>立即重试</button><button className="danger" disabled={disabled} onClick={() => { if (confirm('解除配对后，这台 Mac 不再接收云端任务，本机私钥会被删除。继续？')) void perform(() => window.agent.call('cloudUnpair', {})); }}>解除配对</button></div>
    </div>}
  </section>;
}

export function SharedPanel({ conversationId, modelId, onError }: { conversationId?: string; modelId?: string; onError: (s:string)=>void }) {
  const [status,setStatus]=useState<import('../../../packages/protocol/src/index.js').SharedStatus|null>(null);
  const [history,setHistory]=useState<{id:string;title:string}[]>([]),[selected,setSelected]=useState<string[]>([]);
  useEffect(()=>{let live=true;const load=()=>void window.agent.call('sharedStatus',{}).then(s=>{if(live)setStatus(s);}).catch(()=>{});load();const t=setInterval(load,2000);if(!conversationId&&!modelId)void window.agent.call('snapshot',{}).then(s=>{if(live)setHistory(s.conversations.filter(c=>!c.shared));});return()=>{live=false;clearInterval(t);};},[conversationId,modelId]);
  const perform=async(fn:()=>Promise<unknown>)=>{try{await fn();setStatus(await window.agent.call('sharedStatus',{}));}catch(e){onError(message(e));}};
  if(modelId){const m=status?.models.find(x=>x.id===modelId);return <div className="sync-note">{m?`云端 v${m.version} · 本机已应用 v${m.applied}`:'配对后自动同步配置和密钥'}{m?.error&&<span>{m.error}</span>}{m?.conflict&&<><button onClick={()=>void perform(()=>window.agent.call('sharedResolve',{id:modelId,choice:'remote'}))}>使用云端版本</button><button onClick={()=>void perform(()=>window.agent.call('sharedResolve',{id:modelId,choice:'local'}))}>重新提交本地版本</button></>}</div>;}
  if(conversationId){const c=status?.conversations.find(x=>x.id===conversationId);const active=status?.runs?.find(r=>r.conversationId===conversationId&&!['completed','failed','cancelled','interrupted'].includes(r.state));return <div className="sync-note"><label><input type="checkbox" checked={!!c?.shared} onChange={e=>void perform(()=>window.agent.call('sharedConversation',{ids:[conversationId],shared:e.target.checked}))}/>共享会话</label><span>{c?.shared?c.error??(c.syncedAt?`已同步 ${time(c.syncedAt)}`:'等待同步'):'仅本机'}</span><span>{status?.deviceLabel??'此 Mac'}{status?.deviceLabel&&!status.connected?' · 云端离线，状态待对账':''}{active?` · ${active.cancelRequested?'取消中':active.state==='queued'?'远程请求排队':'远程请求生成中'}`:''}</span><small>完整回答可能含代码片段。关闭只停止后续上传，云端已有记录仍保留。</small></div>;}
  return <section className="cloud-panel"><h2>聊天与模型同步</h2><p className="muted">新会话默认共享；旧会话由你选择。所有模型配置和 API Key 自动同步，云端加密存储，仅下发给授权 Mac。</p>{status?.error&&<p role="alert">{status.error}</p>}<details><summary>选择历史会话共享</summary>{history.map(c=><label key={c.id}><input type="checkbox" checked={selected.includes(c.id)} onChange={e=>setSelected(v=>e.target.checked?[...v,c.id]:v.filter(id=>id!==c.id))}/>{c.title}</label>)}<button disabled={!selected.length} onClick={()=>void perform(async()=>{await window.agent.call('sharedConversation',{ids:selected,shared:true});setSelected([]);})}>共享所选历史</button></details></section>;
}
