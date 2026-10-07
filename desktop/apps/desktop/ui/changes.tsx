import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Changes, FileChange } from '../../../packages/protocol/src/index.js';
import { createRefreshScheduler } from './refresh.js';
import { parseUnifiedDiff } from './diff.js';

const kindLabel = { added: '新增', modified: '修改', deleted: '删除' };
function Counts({ file }: { file: Pick<FileChange, 'additions' | 'deletions'> }) {
  return <span className="change-counts">{file.additions !== undefined && <span className="added-count">+{file.additions}</span>}{file.deletions !== undefined && <span className="deleted-count">−{file.deletions}</span>}</span>;
}
export function ChangesPanel({ taskId, executing, connected, revision, onError }: { taskId: string; executing: boolean; connected: boolean; revision: string; onError: (error: string) => void }) {
  const [view, setView] = useState<'baseline' | 'workspace'>('baseline'), [path, setPath] = useState(''), [changes, setChanges] = useState<Changes | null>(null), [loading, setLoading] = useState(true), [wrap, setWrap] = useState(false), [refresh, setRefresh] = useState(0);
  const refresher = useRef<ReturnType<typeof createRefreshScheduler> | null>(null);
  useEffect(() => {
    let live = true;
    const scheduler = createRefreshScheduler(async () => {
      if (!connected) { setLoading(false); return; }
      setLoading(true);
      try {
        const next = await window.agent.call('codingChanges', { taskId, view, ...(path ? { path } : {}) });
        if (!live) return;
        setChanges(next);
        if (!next.files.some(f => f.path === path)) setPath(next.files[0]?.path ?? '');
      } finally { if (live) setLoading(false); }
    }, error => { if (live) onError(error instanceof Error ? error.message : String(error)); });
    refresher.current = scheduler;
    scheduler.request(true);
    // Refresh only the visible review, at a bounded rate while the agent is writing.
    const timer = executing ? setInterval(() => scheduler.request(), 3000) : undefined;
    return () => { live = false; scheduler.stop(); if (timer) clearInterval(timer); };
  }, [taskId, view, path, executing, connected]);
  useEffect(() => { refresher.current?.request(); }, [revision, refresh]);
  const rows = useMemo(() => parseUnifiedDiff(changes?.diff ?? ''), [changes?.diff]);
  const files = changes?.files ?? [], selected = files.find(f => f.path === path), index = files.findIndex(f => f.path === path);
  const total = { additions: files.reduce((n, f) => n + (f.additions ?? 0), 0), deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0) };
  const select = (next: string) => { if (next !== path) { setLoading(true); setChanges(c => c ? { ...c, diff: '' } : c); setPath(next); } };
  return <section className="code-review" aria-label="代码变更审阅">
    <div className="code-review-toolbar"><div><strong>变更</strong><span>{files.length} 个文件</span>{files.some(f => f.additions !== undefined) && <Counts file={total}/>}</div><select aria-label="变更范围" value={view} onChange={e => { setChanges(null); setLoading(true); setPath(''); setView(e.target.value as typeof view); }}><option value="baseline">本次执行</option><option value="workspace">工作区</option></select><button className={loading ? 'refreshing' : ''} aria-label="刷新变更" title="刷新变更" disabled={!connected || loading} onClick={() => setRefresh(n => n + 1)}>↻</button></div>
    {!connected && <p className="change-notice" role="status">连接已断开，恢复后更新变更</p>}
    {changes?.warning && <details className="change-scope-note"><summary>关于这些变更{files.some(f => !f.preview) && ' · 部分文件仅元信息'}</summary><p>{changes.warning}</p></details>}
    <div className="code-review-layout"><nav className="change-file-list" aria-label="变更文件列表">{files.map(file => {
      const parts = file.path.split('/'), name = parts.pop();
      return <button key={file.path} className={`change-file${file.path === path ? ' selected' : ''}`} aria-label={`查看 ${file.path} 的差异`} aria-current={file.path === path ? 'true' : undefined} title={file.path} onClick={() => select(file.path)}><span className={`file-kind kind-${file.kind}`} title={kindLabel[file.kind]}>{({ added: 'A', modified: 'M', deleted: 'D' })[file.kind]}</span><span className="change-file-name"><strong>{name}</strong>{parts.length > 0 && <small>{parts.join('/')}</small>}</span><Counts file={file}/>{!file.preview && <span className="file-no-preview" title="仅元信息">·</span>}</button>;
    })}{!files.length && <div className="changes-empty"><span aria-hidden="true">◇</span><strong>{loading ? '正在读取变更…' : '暂无文件变更'}</strong><p>{view === 'baseline' ? '执行产生的文件变更会显示在这里' : '工作区相对 HEAD 的变更会显示在这里'}</p></div>}</nav>
    <div className="change-diff-pane">{selected && <header className="change-diff-heading"><div title={path}><span className={`file-kind kind-${selected.kind}`}>{({ added: 'A', modified: 'M', deleted: 'D' })[selected.kind]}</span><strong>{path}</strong><Counts file={selected}/></div><div className="diff-controls"><button aria-label="上一个变更文件" disabled={index <= 0 || loading} onClick={() => select(files[index - 1].path)}>↑</button><span>{index + 1}/{files.length}</span><button aria-label="下一个变更文件" disabled={index >= files.length - 1 || loading} onClick={() => select(files[index + 1].path)}>↓</button><button aria-label="差异自动换行" aria-pressed={wrap} className={wrap ? 'selected' : ''} title="自动换行" onClick={() => setWrap(v => !v)}>↵</button></div></header>}
      <div className={`numbered-diff${wrap ? ' wrap' : ''}`} aria-label="文件差异" aria-busy={loading}>{loading && !changes?.diff ? <p className="diff-placeholder">正在读取差异…</p> : !selected ? <p className="diff-placeholder">选择文件查看差异</p> : rows.length ? <table><colgroup><col className="diff-number-col"/><col className="diff-number-col"/><col className="diff-sign-col"/><col/></colgroup><tbody>{rows.map((row, i) => row.kind === 'hunk' || row.kind === 'note' ? <tr key={i} className={`diff-${row.kind}`}><td colSpan={4}>{row.text}</td></tr> : <tr key={i} className={`diff-${row.kind}`}><td className="diff-line-number">{row.oldLine}</td><td className="diff-line-number">{row.newLine}</td><td className="diff-sign">{row.kind === 'addition' ? '+' : row.kind === 'deletion' ? '−' : ''}</td><td className="diff-source"><code>{row.text || ' '}</code></td></tr>)}</tbody></table> : <p className="diff-placeholder">{selected.preview ? selected.kind === 'added' ? '新增空文件' : selected.kind === 'deleted' ? '已删除空文件' : '文件内容未变更，文件属性发生变化' : changes?.diff || '此文件仅提供元信息预览'}</p>}</div>
      {!!changes?.diff && changes.diff.length >= 250000 && <p className="change-notice">差异过长，当前仅显示前 250000 个字符</p>}
    </div></div>
  </section>;
}
