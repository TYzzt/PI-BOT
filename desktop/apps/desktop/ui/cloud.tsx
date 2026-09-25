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
      <p className="muted">云端只收到计划和脱敏后的执行进度；代码、文件内容、命令输出和聊天记录保留在本机。</p>
      <div className="card-actions"><button disabled={disabled} onClick={() => void perform(() => window.agent.call('cloudRetry', {}))}>立即重试</button><button className="danger" disabled={disabled} onClick={() => { if (confirm('解除配对后，这台 Mac 不再接收云端任务，本机私钥会被删除。继续？')) void perform(() => window.agent.call('cloudUnpair', {})); }}>解除配对</button></div>
    </div>}
  </section>;
}
