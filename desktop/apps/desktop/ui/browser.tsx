import React, { useEffect, useState } from 'react';
import type { BrowserStatus } from '../../../packages/protocol/src/index.js';
function message(error: unknown) { return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, ''); }
function since(at: number) { return new Date(at).toLocaleTimeString('zh-CN', { hour12: false }); }

export function BrowserPanel({ connected, onError }: { connected: boolean; onError: (s: string) => void }) {
  const [status, setStatus] = useState<BrowserStatus | null>(null), [working, setWorking] = useState(false), [notice, setNotice] = useState('');
  const [form, setForm] = useState({ baseUrl: '', model: '', apiKey: '' }), [editing, setEditing] = useState(false);
  const load = async () => { const s = await window.agent.call('browserStatus', {}); setStatus(s); return s; };
  useEffect(() => { if (!connected) return; let live = true; const tick = () => void window.agent.call('browserStatus', {}).then(s => { if (live) setStatus(s); }).catch(() => {}); tick(); const timer = setInterval(tick, 5000); return () => { live = false; clearInterval(timer); }; }, [connected]);
  const disabled = !connected || working;
  async function perform(fn: () => Promise<string>) { setWorking(true); onError(''); setNotice(''); try { const text = await fn(); await load(); setNotice(text); } catch (e) { onError(message(e)); } finally { setWorking(false); } }
  const edit = () => { if (!status) return; setForm({ baseUrl: status.jev.baseUrl, model: status.jev.model, apiKey: '' }); setEditing(true); setNotice(''); };
  const jev = status?.jev;
  return <>
    <section className="cloud-panel" aria-label="Jev 浏览器决策"><div className="section-heading"><h2>Jev 浏览器决策</h2>{jev && <span className={`cloud-state ${jev.configured ? 'online' : ''}`}><i/>{jev.configured ? '已配置' : '未配置'}</span>}</div>
      {!status ? <p className="muted">正在读取…</p> : editing ? <form className="cloud-form" onSubmit={e => { e.preventDefault(); void perform(async () => { await window.agent.call('jevSave', { baseUrl: form.baseUrl, model: form.model, ...(form.apiKey ? { apiKey: form.apiKey } : {}) }); setEditing(false); return 'Jev 配置已保存，执行阶段会提供 browser_task'; }); }}>
        <p>配置后，执行阶段可以用 browser_task 让 Jev 逐步决定点击和输入。每一步会把页面标题、网址、元素列表和页面文字节选发送给 TypeSafe。</p>
        <label>Base URL<input aria-label="Jev Base URL" required type="url" value={form.baseUrl} onChange={e => setForm(f => ({ ...f, baseUrl: e.target.value }))}/><small>请求地址为 Base URL + /v1/systemone。</small></label>
        <label>模型<input aria-label="Jev 模型" required value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))}/></label>
        <label>API Key<input aria-label="Jev API Key" type="password" autoComplete="off" required={!jev?.hasKey} value={form.apiKey} placeholder={jev?.hasKey ? '已保存，留空则保持原密钥' : '仅保存在本机 Keychain'} onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))}/></label>
        <div className="card-actions"><button className="primary" disabled={disabled}>{working ? '处理中…' : '保存'}</button><button type="button" onClick={() => setEditing(false)}>取消</button></div>
      </form> : <div className="cloud-info">
        <dl><dt>Base URL</dt><dd>{jev!.baseUrl}</dd><dt>模型</dt><dd>{jev!.model}</dd><dt>密钥</dt><dd>{jev!.hasKey ? '已保存在 Keychain' : '未配置'}</dd></dl>
        <div className="card-actions"><button disabled={disabled} onClick={edit}>{jev!.configured ? '修改' : '配置 Jev'}</button>{jev!.configured && <button disabled={disabled} onClick={() => perform(async () => { const r = await window.agent.call('jevTest', {}); return `Jev 连接成功（${r.model}）`; })}>测试连接</button>}{jev!.configured && <button disabled={disabled} onClick={() => perform(async () => { await window.agent.call('jevDelete', {}); return 'Jev 配置已删除'; })}>删除</button>}</div>
      </div>}
      {notice && <p className="success" role="status">✓ {notice}</p>}
    </section>
    <section className="cloud-panel" aria-label="自动化浏览器"><div className="section-heading"><h2>自动化浏览器</h2>{status && <span className={`cloud-state ${status.running ? 'online' : ''}`}><i/>{status.running ? '运行中' : '未启动'}</span>}</div>
      {!status ? <p className="muted">正在读取…</p> : <div className="cloud-info"><dl>
        <dt>Chrome</dt><dd>{status.executable ?? '未找到 Google Chrome，请安装或设置 TAGNET_CHROME'}</dd>
        <dt>占用</dt><dd>{status.holder ? <>任务 {status.holder.taskId.slice(0, 8)}<small>自 {since(status.holder.since)}</small></> : '空闲'}</dd>
      </dl><p className="muted">执行阶段的任务使用独立的自动化 profile，与日常 Chrome 分开。同一时间只有一个任务能操作浏览器，其他任务排队等待。</p></div>}
    </section>
  </>;
}
