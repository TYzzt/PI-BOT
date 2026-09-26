import React, { useEffect, useState } from 'react';
import type { ConfigItem, ConfigListing, ConfigReason, ConfigState, McpConfig, SkillConfig } from '../../../packages/protocol/src/index.js';

function errorText(e: unknown) { return (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, ''); }
const stateLabel: Record<ConfigState, string> = { pending: '待检查', available: '可用', unavailable: '不可用', not_applicable: '不在本机运行', failed: '应用失败' };
const runtimeLabel = { mac: '仅 Mac', cloud: '仅云端（云端暂未加载）', both: 'Mac 与云端' };
export function reasonText(r: ConfigReason) {
  switch (r.code) {
    case 'command_missing': return `缺少命令 ${r.detail}（未在 PATH、/opt/homebrew/bin、/usr/local/bin 中找到可执行文件）`;
    case 'platform_unsupported': return `平台不支持：${r.detail}`;
    case 'script_missing': return `技能包缺少脚本 ${r.detail}`;
    case 'mcp_missing': return `依赖的 MCP「${r.detail}」不存在`;
    case 'mcp_unavailable': return `依赖的 MCP 不可用：${r.detail}`;
    case 'secret_missing': return `本机 Keychain 缺少 secret「${r.detail}」`;
    case 'write_failed': return `写入本地技能目录失败`;
    default: return `配置无效：${r.detail}`;
  }
}
const list = (s: string) => s.split(/[,，\s]+/).map(x => x.trim()).filter(Boolean);
const emptySkill = (): SkillConfig => ({ name: '', description: '', content: '', files: [], runtime: 'mac', enabled: true, requires: { commands: [], platforms: [], scripts: [], mcp: [] }, installHint: null });
const emptyMcp = (): McpConfig => ({ name: '', transport: 'stdio', command: '', args: [], url: null, timeoutMs: 30000, env: [], runtime: 'mac', enabled: true, disabledTools: [] });

function Status({ item }: { item: ConfigItem<unknown> }) {
  const l = item.local;
  return <div className="config-status">
    <div><span className={`state-pill state-${l.state}`}>{stateLabel[l.state]}</span><span className="config-version">最新 v{item.version} · 本机生效 {l.activeVersion ? `v${l.activeVersion}` : '无'}</span></div>
    {l.state === 'unavailable' && l.activeVersion > 0 && l.activeVersion < item.version && <p className="muted">新版本不可用，本机继续使用 v{l.activeVersion}。</p>}
    {!!l.reasons.length && <ul className="config-reasons" aria-label="不可用原因">{l.reasons.map((r, i) => <li key={i}>{reasonText(r)}</li>)}</ul>}
    {item.devices.length > 0 && <details><summary>各设备状态</summary><ul className="config-devices">{item.devices.map(d => <li key={d.deviceId}>{d.label || '设备'}：{stateLabel[d.state]} · 生效 v{d.appliedVersion || 0}{d.reasons.length ? ` · ${d.reasons.map(reasonText).join('；')}` : ''}</li>)}</ul></details>}
  </div>;
}

export function ConfigsPage({ connected, onError }: { connected: boolean; onError: (s: string) => void }) {
  const [data, setData] = useState<ConfigListing | null>(null), [tab, setTab] = useState<'skill' | 'mcp'>('skill'), [selected, setSelected] = useState<string | null>(null);
  const [skill, setSkill] = useState<SkillConfig>(emptySkill()), [mcp, setMcp] = useState<McpConfig>(emptyMcp()), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [secretName, setSecretName] = useState(''), [secretValue, setSecretValue] = useState('');
  const load = async () => { try { setData(await window.agent.call('configList', {})); } catch (e) { onError(errorText(e)); } };
  useEffect(() => { if (!connected) return; void load(); const t = setInterval(() => void load(), 3000); return () => clearInterval(t); }, [connected]);
  const items: ConfigItem<SkillConfig | McpConfig>[] = tab === 'skill' ? data?.skills ?? [] : data?.mcpServers ?? [];
  const current = items.find(i => i.id === selected);
  function open(id: string | null) {
    setSelected(id); setNotice('');
    const s = data?.skills.find(i => i.id === id), m = data?.mcpServers.find(i => i.id === id);
    if (tab === 'skill') setSkill(s ? structuredClone(s.config) : emptySkill()); else setMcp(m ? structuredClone(m.config) : emptyMcp());
  }
  async function perform(fn: () => Promise<ConfigListing>, done: string) { setBusy(true); onError(''); setNotice(''); try { setData(await fn()); setNotice(done); } catch (e) { onError(errorText(e)); await load(); } finally { setBusy(false); } }
  function save() {
    const id = current?.id ?? crypto.randomUUID(), expectedVersion = current?.version ?? 0, requestId = crypto.randomUUID();
    void perform(async () => { const r = tab === 'skill' ? await window.agent.call('configSkillPut', { id, expectedVersion, requestId, config: { ...skill, installHint: skill.installHint || null } }) : await window.agent.call('configMcpPut', { id, expectedVersion, requestId, config: mcp.transport === 'stdio' ? { ...mcp, url: null } : { ...mcp, command: null, args: [] } }); setSelected(id); return r; }, '已保存并同步到云端，其他端会显示新版本。');
  }
  const disabled = !connected || busy || !data?.paired;
  return <div className="coding-page configs-page">
    <div className="coding-heading"><div><div className="eyebrow">SHARED CONFIG</div><h1>Skills 与 MCP</h1><p>配置保存在云端，手机和 Mac 都能编辑。Mac 只检查依赖是否就绪，<strong>不会自动运行任何安装命令或脚本</strong>；缺少依赖时显示原因，由你手动安装后点击“重新检查”。</p></div>
      <button disabled={disabled} onClick={() => void perform(() => window.agent.call('configRecheck', {}), '已重新检查本机依赖。')}>重新检查</button></div>
    {data && !data.paired && <div className="task-notice">需要先在「模型设置」中配对云端。</div>}
    {data?.error && <div className="task-notice" role="alert">{data.error}</div>}
    {notice && <p className="success" role="status">✓ {notice}</p>}
    <div className="coding-tabs"><button className={tab === 'skill' ? 'selected' : ''} onClick={() => { setTab('skill'); setSelected(null); setSkill(emptySkill()); }}>Skills {data?.skills.length ?? 0}</button><button className={tab === 'mcp' ? 'selected' : ''} onClick={() => { setTab('mcp'); setSelected(null); setMcp(emptyMcp()); }}>MCP {data?.mcpServers.length ?? 0}</button></div>
    <div className="project-grid">
      <section aria-label={tab === 'skill' ? 'Skills 列表' : 'MCP 列表'}>
        <button className="new-chat" disabled={disabled} onClick={() => open(null)}>＋ 新建{tab === 'skill' ? ' Skill' : ' MCP'}</button>
        {items.map(i => <div key={i.id} className={`project-card ${selected === i.id ? 'active' : ''}`}><button className="project-title" onClick={() => open(i.id)}><strong>{i.config.name}</strong>{!i.config.enabled && <span className="tag">已停用</span>}<small>{runtimeLabel[i.config.runtime]}</small></button><Status item={i}/></div>)}
        {!items.length && <p className="muted">还没有{tab === 'skill' ? ' Skill' : ' MCP'} 配置。</p>}
        {tab === 'mcp' && data && <div className="project-card"><h4>本机 secret（只存 macOS Keychain，不上传）</h4>
          {data.secrets.map(s => <div key={s.name} className="secret-row"><span>{s.name}</span><span className={s.present ? 'state-pill state-available' : 'state-pill state-unavailable'}>{s.present ? '已设置' : '缺失'}</span>{s.present && <button disabled={busy} onClick={() => void perform(() => window.agent.call('configSecretDelete', { name: s.name }), `已删除 ${s.name}`)}>删除</button>}</div>)}
          <form className="secret-form" onSubmit={e => { e.preventDefault(); void perform(() => window.agent.call('configSecretSet', { name: secretName, value: secretValue }), `已保存 ${secretName}`).then(() => setSecretValue('')); }}>
            <input aria-label="secret 名称" placeholder="secret 名称" value={secretName} onChange={e => setSecretName(e.target.value)} required/><input aria-label="secret 值" type="password" autoComplete="off" placeholder="值" value={secretValue} onChange={e => setSecretValue(e.target.value)} required/><button disabled={busy}>保存</button></form></div>}
      </section>
      <form className="task-form" onSubmit={e => { e.preventDefault(); save(); }} aria-label="编辑配置">
        <h2>{current ? `编辑 ${current.config.name}（v${current.version}）` : `新建${tab === 'skill' ? ' Skill' : ' MCP'}`}</h2>
        {current && <Status item={current}/>}
        {tab === 'skill' && current && (current.config as SkillConfig).installHint && <div className="install-hint"><h4>安装提示（不会自动执行）</h4><pre>{(current.config as SkillConfig).installHint}</pre></div>}
        {tab === 'skill' ? <SkillForm value={skill} onChange={setSkill}/> : <McpForm value={mcp} onChange={setMcp}/>}
        <div className="change-actions"><button className="primary" disabled={disabled}>{busy ? '处理中…' : '保存'}</button>
          {current && <button type="button" className="danger" disabled={disabled} onClick={() => { if (confirm(`删除 ${current.config.name}？所有设备都会移除它。`)) void perform(() => window.agent.call('configDelete', { kind: tab, id: current.id, expectedVersion: current.version, requestId: crypto.randomUUID() }), '已删除。').then(() => open(null)); }}>删除</button>}</div>
      </form>
    </div>
  </div>;
}

function Common<T extends SkillConfig | McpConfig>({ value, onChange }: { value: T; onChange: (v: T) => void }) {
  return <><label>名称<input aria-label="名称" required value={value.name} onChange={e => onChange({ ...value, name: e.target.value })}/></label>
    <div className="model-pair"><label>运行环境<select aria-label="运行环境" value={value.runtime} onChange={e => onChange({ ...value, runtime: e.target.value as T['runtime'] })}><option value="mac">仅 Mac</option><option value="cloud">仅云端</option><option value="both">Mac 与云端</option></select></label>
      <label className="choice-option"><input type="checkbox" checked={value.enabled} onChange={e => onChange({ ...value, enabled: e.target.checked })}/>启用</label></div></>;
}

function SkillForm({ value, onChange }: { value: SkillConfig; onChange: (v: SkillConfig) => void }) {
  const req = (patch: Partial<SkillConfig['requires']>) => onChange({ ...value, requires: { ...value.requires, ...patch } });
  return <>
    <Common value={value} onChange={onChange}/>
    <label>说明<input aria-label="说明" value={value.description} onChange={e => onChange({ ...value, description: e.target.value })}/></label>
    <label>SKILL.md<textarea aria-label="SKILL.md" rows={10} required value={value.content} onChange={e => onChange({ ...value, content: e.target.value })}/></label>
    <h4>包内文件（以文本保存，Mac 上不设可执行权限）</h4>
    {value.files.map((f, i) => <div key={i} className="config-file"><input aria-label="文件路径" placeholder="scripts/run.sh" value={f.path} onChange={e => onChange({ ...value, files: value.files.map((x, j) => j === i ? { ...x, path: e.target.value } : x) })}/><textarea aria-label="文件内容" rows={4} value={f.content} onChange={e => onChange({ ...value, files: value.files.map((x, j) => j === i ? { ...x, content: e.target.value } : x) })}/><button type="button" onClick={() => onChange({ ...value, files: value.files.filter((_, j) => j !== i) })}>移除文件</button></div>)}
    <button type="button" onClick={() => onChange({ ...value, files: [...value.files, { path: '', content: '' }] })}>＋ 添加文件</button>
    <h4>依赖声明（Mac 只检查，不安装）</h4>
    <label>系统命令<input aria-label="系统命令" placeholder="ffmpeg, pdftotext" value={value.requires.commands.join(', ')} onChange={e => req({ commands: list(e.target.value) })}/></label>
    <label>平台<span className="choice-row">{(['darwin', 'linux', 'win32'] as const).map(p => <label key={p} className="choice-option"><input type="checkbox" checked={value.requires.platforms.includes(p)} onChange={e => req({ platforms: e.target.checked ? [...value.requires.platforms, p] : value.requires.platforms.filter(x => x !== p) })}/>{p}</label>)}</span><small>都不选表示不限平台。</small></label>
    <label>脚本（须在包内文件中）<input aria-label="脚本" value={value.requires.scripts.join(', ')} onChange={e => req({ scripts: list(e.target.value) })}/></label>
    <label>依赖的 MCP<input aria-label="依赖的 MCP" value={value.requires.mcp.join(', ')} onChange={e => req({ mcp: list(e.target.value) })}/></label>
    <label>安装提示（仅展示，不会执行）<textarea aria-label="安装提示" rows={3} value={value.installHint ?? ''} onChange={e => onChange({ ...value, installHint: e.target.value || null })}/></label>
  </>;
}

function McpForm({ value, onChange }: { value: McpConfig; onChange: (v: McpConfig) => void }) {
  return <>
    <Common value={value} onChange={onChange}/>
    <label>连接方式<select aria-label="连接方式" value={value.transport} onChange={e => onChange({ ...value, transport: e.target.value as McpConfig['transport'] })}><option value="stdio">stdio（本机命令）</option><option value="http">Streamable HTTP</option></select></label>
    {value.transport === 'stdio' ? <>
      <label>命令<input aria-label="命令" required placeholder="npx 或 /opt/homebrew/bin/xxx" value={value.command ?? ''} onChange={e => onChange({ ...value, command: e.target.value })}/><small>Mac 只检查命令是否存在，保存或同步都不会启动它。</small></label>
      <label>参数（每行一个）<textarea aria-label="参数" rows={3} value={value.args.join('\n')} onChange={e => onChange({ ...value, args: e.target.value.split('\n').filter(Boolean) })}/></label>
    </> : <label>URL<input aria-label="URL" required type="url" value={value.url ?? ''} onChange={e => onChange({ ...value, url: e.target.value })}/></label>}
    <label>超时（毫秒）<input aria-label="超时" type="number" min={1000} max={600000} value={value.timeoutMs} onChange={e => onChange({ ...value, timeoutMs: Number(e.target.value) })}/></label>
    <h4>环境变量（密钥请用 secret 引用，值只保存在各设备本机）</h4>
    {value.env.map((v, i) => { const set = (patch: Partial<McpConfig['env'][number]>) => onChange({ ...value, env: value.env.map((x, j) => j === i ? { ...x, ...patch } : x) }); return <div key={i} className="config-env">
      <input aria-label="变量名" placeholder="NAME" value={v.name} onChange={e => set({ name: e.target.value })}/>
      <select aria-label="变量类型" value={v.secretRef !== null ? 'secret' : 'value'} onChange={e => set(e.target.value === 'secret' ? { value: null, secretRef: '' } : { value: '', secretRef: null })}><option value="value">明文值</option><option value="secret">secret 引用</option></select>
      <input aria-label="变量值" placeholder={v.secretRef !== null ? 'secret 名称' : '值'} value={v.secretRef ?? v.value ?? ''} onChange={e => set(v.secretRef !== null ? { secretRef: e.target.value } : { value: e.target.value })}/>
      <button type="button" onClick={() => onChange({ ...value, env: value.env.filter((_, j) => j !== i) })}>移除</button></div>; })}
    <button type="button" onClick={() => onChange({ ...value, env: [...value.env, { name: '', value: null, secretRef: '' }] })}>＋ 添加环境变量</button>
    <label>停用的工具<input aria-label="停用的工具" value={value.disabledTools.join(', ')} onChange={e => onChange({ ...value, disabledTools: list(e.target.value) })}/><small>首版只管理配置；工具清单需在 MCP 接入运行后显示。</small></label>
  </>;
}
