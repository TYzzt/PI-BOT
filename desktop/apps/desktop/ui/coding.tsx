import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import React, { useEffect, useRef, useState } from 'react';
import type { CodingDetail, ModelConfig, Project, Changes, ToolCall, PlanQuestion, QuestionPick } from '../../../packages/protocol/src/index.js';
import { answersReady, formatQuestionAnswers, questionKey } from '../../../packages/protocol/src/index.js';
import { useCloudStatus, SharedPanel } from './cloud.js';
const label: Record<string, string> = { reading: '正在处理', planning: '正在规划', awaiting_review: '等待审阅', awaiting_input: '等待补充信息', executing: '正在执行', needs_replan: '需要重新规划', waiting_for_local_action: '需要本机操作', completed: '已完成', failed: '运行失败', cancelled: '已停止', rejected: '已拒绝', interrupted: '运行中断', pending: '待执行', running: '进行中', passed: '通过', not_run: '未验证' };
function message(error: unknown) { return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, ''); }
function QuestionChoices({ questions, picks, onChange }: { questions: PlanQuestion[]; picks: Record<string, QuestionPick>; onChange: (next: Record<string, QuestionPick>) => void }) {
  return <div className="questions"><h3>需要你确认的问题</h3>{questions.map((question, index) => {
    const key = questionKey(question, index);
    const pick = picks[key] ?? { options: [], other: '' };
    const set = (next: QuestionPick) => onChange({ ...picks, [key]: next });
    if (typeof question === 'string') return <label key={key}>{index + 1}. {question}<textarea aria-label={question} rows={2} value={pick.other} onChange={e => set({ ...pick, other: e.target.value })}/></label>;
    return <fieldset key={key} className="choice-card"><legend>{index + 1}. {question.prompt}</legend>{question.options.map(option => <label key={option.id} className="choice-option"><input type={question.allowMultiple ? 'checkbox' : 'radio'} name={key} checked={pick.options.includes(option.id)} onChange={() => { const options = question.allowMultiple ? pick.options.includes(option.id) ? pick.options.filter(id => id !== option.id) : [...pick.options, option.id] : [option.id]; set({ ...pick, options }); }}/>{option.label}</label>)}<label>其他<input aria-label={`${question.prompt} 的其他回答`} value={pick.other} onChange={e => set({ ...pick, other: e.target.value })}/></label></fieldset>;
  })}</div>;
}
function useAction(onError: (text: string) => void) {
  const [busy, setBusy] = useState(false); const pending = useRef<{ key: string; id: string } | null>(null);
  async function run(key: string, operation: (requestId: string) => Promise<void>) {
    if (busy) return;
    if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() };
    setBusy(true); onError('');
    try { await operation(pending.current.id); pending.current = null; } catch (e) { onError(message(e)); } finally { setBusy(false); }
  }
  return { busy, run };
}
function toolText(input: string, key: string) { try { const value = JSON.parse(input)?.[key]; return typeof value === 'string' ? value.trim() : ''; } catch { return ''; } }
function shortText(text: string, max = 72) { const one = text.replace(/\s+/g, ' '); return one.length > max ? one.slice(0, max) + '…' : one; }
function toolSummary(tool: ToolCall) {
  const path = toolText(tool.input, 'path'), query = toolText(tool.input, 'query'), command = shortText(toolText(tool.input, 'command'));
  const stopped = tool.state === 'cancelled' || tool.state === 'interrupted';
  let line: string;
  switch (tool.name) {
    case 'read_file': line = path ? `读取 ${path}` : '读取文件'; break;
    case 'list_files': line = `查看目录 ${path || '项目根目录'}`; break;
    case 'search_files': line = query ? `搜索「${shortText(query, 40)}」` : '搜索代码'; break;
    case 'find_files': line = query ? `查找文件「${shortText(query, 40)}」` : '查找文件'; break;
    case 'git_status': line = '查看项目状态'; break;
    case 'update_plan': line = '整理修改计划'; break;
    case 'write_file': line = path ? `写入 ${path}` : '写入文件'; break;
    case 'edit_file': line = path ? `修改 ${path}` : '修改文件'; break;
    case 'run_command': {
      const verdict = tool.state === 'running' ? '进行中' : tool.verification ? (tool.exitCode === 0 ? '通过' : '未通过') : tool.exitCode === 0 ? '完成' : tool.exitCode !== null ? '未成功' : stopped ? '已停止' : '进行中';
      line = `${tool.verification ? '验证' : '运行'} ${command || '命令'} · ${verdict}`; break;
    }
    case 'update_step': line = '记录步骤进度'; break;
    case 'request_replan': line = '请求重新规划'; break;
    case 'request_local_action': line = '需要你在本机处理'; break;
    case 'browser_open': line = '打开网页'; break;
    case 'browser_snapshot': line = '查看当前页面'; break;
    case 'browser_click': line = '点击页面上的元素'; break;
    case 'browser_type': line = '填写页面内容'; break;
    case 'browser_press': line = '按下键盘按键'; break;
    case 'browser_task': line = '按步骤操作页面'; break;
    default: line = '处理项目';
  }
  if (tool.name !== 'run_command' && tool.state === 'running') line += ' · 进行中';
  else if (tool.name !== 'run_command' && tool.state === 'failed') line += ' · 失败';
  else if (tool.name !== 'run_command' && stopped) line += ' · 已停止';
  return line;
}
function ToolStep({ tool }: { tool: ToolCall }) {
  return <details className="tool-step"><summary>{toolSummary(tool)}</summary><p className="muted">{tool.exitCode !== null ? `退出码 ${tool.exitCode}` : tool.state === 'completed' ? '已完成' : '进行中'}{tool.truncated ? ' · 输出已截断' : ''}</p><pre>{tool.output || (tool.state === 'running' ? '还在进行…' : '没有额外输出')}</pre></details>;
}
function AgentTrace({ steps, live }: { steps: ToolCall[]; live: boolean }) {
  const active = [...steps].reverse().find(t => t.state === 'running');
  const spinning = !!active || live;
  const current = active ?? steps.at(-1);
  const headline = spinning && current ? toolSummary(current) : `工具活动 · ${steps.length} 步`;
  return <details className={`agent-trace${spinning ? ' running' : ''}`} aria-label="工具活动"><summary title={headline}>{spinning && <i className="agent-spin" aria-hidden="true"/>}<span>{headline}</span></summary><div className="tool-steps">{steps.map(t => <ToolStep key={t.id} tool={t}/>)}</div></details>;
}
function ModelSelect({ label: name, value, models, onChange, disabled }: { label: string; value: string; models: ModelConfig[]; onChange: (s: string) => void; disabled: boolean }) {
  return <label>{name}<select aria-label={name} value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>{models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>;
}
export function ProjectChatStart({ project, models, connected, blocked, onError, onOpen }: { project?: Project; models: ModelConfig[]; connected: boolean; blocked: boolean; onError: (s: string) => void; onOpen: (id: string) => void }) {
  const [draft, setDraft] = useState(''), [mode, setMode] = useState<'agent' | 'plan'>('agent');
  const defaultId = models.find(m => m.isDefault)?.id ?? models[0]?.id ?? '';
  const [modelId, setModelId] = useState(defaultId);
  const { busy, run } = useAction(onError); const sending = useRef(false);
  const disabled = busy || blocked || !connected;
  useEffect(() => { if (!models.some(m => m.id === modelId)) setModelId(defaultId); }, [models]);
  const send = async () => {
    if (disabled || sending.current || !project?.available || !modelId || !draft.trim()) return;
    const requirement = draft.trim(); sending.current = true;
    try {
      await run(JSON.stringify([mode, project.id, requirement, modelId]), async requestId => {
        const task = await window.agent.call('codingCreate', { mode, projectId: project.id, requirement, planModelId: modelId, executeModelId: modelId, requestId });
        onOpen(task.conversationId);
      });
    } finally { sending.current = false; }
  };
  return <>
    <header className="chat-header"><div><h1>{project?.name ?? '项目对话'}</h1><span className="subtitle">{project?.branch ? `分支 ${project.branch}` : '选择侧栏项目，开始对话'}</span></div></header>
    <section className="messages" aria-label="项目对话记录"><div className="welcome"><div className="welcome-mark">T<span>✦</span></div><h2>想在这个项目里做些什么？</h2><p>描述需求，或直接提问。</p></div></section>
    <footer className="composer-area">
      {(!project?.available || !models.length || blocked) && <div className="run-note" role="status">{!project?.available ? project?.error ?? '正在加载项目…' : !models.length ? '请先在设置中配置模型' : '当前任务完成后可继续发送'}</div>}
      <form className="composer" onSubmit={e => { e.preventDefault(); void send(); }}>
        <textarea aria-label="项目消息" rows={3} maxLength={30000} value={draft} onChange={e => setDraft(e.target.value)} placeholder="提问、修复问题，或描述要实现的功能…" onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}/>
        <div className="composer-toolbar project-start-toolbar">
          <ModelSelect label="模型" models={models} value={modelId} onChange={setModelId} disabled={disabled || !models.length}/>
          <label>模式<select aria-label="对话模式" value={mode} disabled={disabled} onChange={e => setMode(e.target.value as 'agent' | 'plan')}><option value="agent">正常</option><option value="plan">计划</option></select></label>
          <button className="primary send" disabled={disabled || !project?.available || !modelId || !draft.trim()}>发送</button>
        </div>
      </form>
      <div className="composer-hint">{mode === 'plan' ? '先讨论方案，确认后执行' : 'Enter 发送 · Shift + Enter 换行'}</div>
    </footer>
  </>;
}
export function Programming({ conversationId, models, connected, blocked, activeRunId, cancelling, onError, refresh, branch }: { conversationId: string; models: ModelConfig[]; connected: boolean; blocked: boolean; activeRunId?: string; cancelling: boolean; onError: (s: string) => void; refresh: () => Promise<void>; branch?: string }) {
  const [detail, setDetail] = useState<CodingDetail | null>(null), [feedback, setFeedback] = useState(''), [version, setVersion] = useState(''), [planModelId, setPlanModel] = useState(''), [picks, setPicks] = useState<Record<string, QuestionPick>>({});
  const [view, setView] = useState<'baseline' | 'workspace'>('baseline'), [changes, setChanges] = useState<Changes | null>(null), [path, setPath] = useState(''), [panel, setPanel] = useState<'plan' | 'changes' | null>(null);
  const { busy, run } = useAction(onError); const seq = useRef(0), epoch = useRef(0); const disabled = busy || blocked || !connected;
  async function load() { const marker = ++epoch.current; const d = await window.agent.call('codingGet', { conversationId }); if (marker !== epoch.current) return; setDetail(d); seq.current = d.lastSeq; setPlanModel(v => v || d.task.planModelId); }
  useEffect(() => { let live = true; const reload = () => { if (live) void load().catch(e => onError(message(e))); }; reload(); const timer = setInterval(reload, 1800); const off = window.agent.subscribe(e => { if (e.type === 'message.delta' && e.conversation_id === conversationId) { ++epoch.current; setDetail(d => d ? { ...d, messages: d.messages.map(m => m.id === e.message_id ? { ...m, content: e.content ?? '', status: 'running' } : m) } : d); return; } if ((e.type === 'service.status' && e.connected) || e.type === 'cloud.changed' || (e.conversation_id === conversationId && e.type !== 'message.delta')) reload(); }); return () => { live = false; epoch.current++; clearInterval(timer); off(); }; }, [conversationId]);
  useEffect(() => { if (!detail || panel !== 'changes') return; let live = true; void window.agent.call('codingChanges', { taskId: detail.task.id, view, ...(path ? { path } : {}) }).then(c => { if (live) setChanges(c); }).catch(e => onError(message(e))); return () => { live = false; }; }, [detail?.task.id, view, path, panel, detail?.task.state]);
  if (!detail) return <div className="coding-page muted">正在加载项目对话…</div>;
  const task = detail.task, latest = detail.plans.at(-1), plan = detail.plans.find(p => p.id === version) ?? latest;
  const invoke = (key: string, fn: (id: string) => Promise<void>) => run(key, async id => { await fn(id); await load(); await refresh(); });
  const cloud = detail.cloud, offline = !!cloud && !cloud.connected, unpublished = !!cloud && !!plan && !cloud.publishedPlanIds.includes(plan.id);
  const revise = (text: string, requestId: string) => cloud ? window.agent.call('cloudRevise', { taskId: task.id, feedback: text, requestId }) : window.agent.call('codingSend', { conversationId, text, modelId: planModelId, mode: 'plan', requestId });
  const showPanel = panel !== null;
  const openPlan = () => setPanel('plan');
  return <div className="coding-page conversation-page"><header className="coding-heading"><div><div className="eyebrow">{detail.project.name}{branch && <span className="branch-name">分支 {branch}</span>}{cloud && <span className={`cloud-badge ${offline ? 'offline' : ''}`}>来自云端{offline && ' · 离线'}</span>}</div><h1>{task.requirement.slice(0, 70)}</h1><p><span className={`state-pill state-${task.state}`}>{label[task.state] ?? task.state}</span> {detail.verification !== 'not_run' && <span>验证：{label[detail.verification]}</span>}</p></div><div className="coding-heading-actions">{plan && <button onClick={openPlan}>查看计划</button>}<button aria-label="打开代码变更" onClick={() => setPanel('changes')}>代码变更</button>{activeRunId && <button className="stop" disabled={!connected || busy || cancelling} onClick={() => void invoke('stop:' + activeRunId, async () => { await window.agent.call('runCancel', { id: activeRunId }); })}>{cancelling ? '正在停止…' : '■ 停止任务'}</button>}</div></header>
    <SharedPanel conversationId={conversationId} onError={onError}/><div className="task-notice" role="status">{cancelling ? '正在停止命令并等待确认，已产生的文件修改会保留。' : task.message || '正在处理任务…'}{task.state === 'executing' && <strong> 执行期间请避免同时编辑项目。</strong>}</div>
    <div className="coding-split">
    <ProjectConversation detail={detail} disabled={disabled} blocked={blocked} models={models} modelId={planModelId} onModel={setPlanModel} onError={onError} onPlan={openPlan} onSend={(text, mode) => invoke(JSON.stringify([mode, task.id, text, planModelId]), async requestId => {
      if (cloud) {
        if (mode === 'plan') await revise(text, requestId);
        else await window.agent.call('codingRead', { taskId: task.id, text, modelId: planModelId, requestId });
      } else await window.agent.call('codingSend', { conversationId, text, modelId: planModelId, mode, requestId });
      setVersion('');
    })} planDisabled={offline}/>

    {showPanel && <aside className="review-drawer" aria-label="审阅面板"><div className="review-drawer-bar">{plan && <button className={panel === 'plan' ? 'selected' : ''} onClick={() => setPanel('plan')}>计划与审阅</button>}<button className={panel === 'changes' ? 'selected' : ''} onClick={() => setPanel('changes')}>代码变更</button><button className="close-panel" aria-label="关闭审阅面板" onClick={() => setPanel(null)}>×</button></div><div className="review-drawer-body">

    {panel === 'plan' && <div className="plan-grid"><section className="plan-document"><div className="section-heading"><h2>执行计划</h2>{detail.plans.length > 0 && <select aria-label="计划版本" value={plan?.id ?? ''} onChange={e => { setVersion(e.target.value); setPicks({}); }}>{detail.plans.map(p => <option key={p.id} value={p.id}>v{p.version}{p.id === latest?.id ? ' · 最新' : ' · 历史'}</option>)}</select>}</div>{!plan ? <p className="muted">Pi 正在只读分析项目。生成有效结构化计划后在这里审阅。</p> : <><h3>{plan.body.goal}</h3><h4>范围</h4><ul>{plan.body.scope.map((s, i) => <li key={i}>{s}</li>)}</ul>{plan.body.nonGoals.length > 0 && <><h4>不包含</h4><ul>{plan.body.nonGoals.map((s, i) => <li key={i}>{s}</li>)}</ul></>}<h4>影响模块</h4><p>{plan.body.modules.join('、') || '待具体确认'}</p><h4>步骤</h4><ol>{plan.body.steps.map(s => <li key={s.stepId}><strong>{s.title}</strong><span className="step-status">{plan.id === latest?.id ? ({ completed: '已完成', pending: '待执行', running: '进行中', failed: '失败' }[detail.steps.find(x => x.stepId === s.stepId)?.state ?? 'pending']) : s.stepId}</span><p>{s.description}</p></li>)}</ol><h4>预期命令</h4><pre>{plan.body.commands.join('\n') || '无'}</pre><h4>外部动作</h4><ul>{plan.body.externalActions.map((s, i) => <li key={i}>{s}</li>)}</ul><h4>验证与验收</h4><ul>{[...plan.body.verification, ...plan.body.acceptance].map((s, i) => <li key={i}>{s}</li>)}</ul>{plan.body.questions.length > 0 && <p className="muted">待确认问题在下方选择。选完后才会生成可执行的计划。</p>}<small className="muted">v{plan.version} · {plan.hash.slice(0, 12)} · 仅保存在此 Mac</small></>}</section>
    <aside className="review-panel"><h2>审阅与操作</h2><p>批准后允许 Pi 修改项目文件，并以当前 macOS 用户权限运行非交互命令。这不是项目级系统沙箱。</p><p>保留已有修改，不自动提交、推送或回滚；需要额外权限或扩大范围时重新规划。</p>{cloud && <p className={`cloud-note ${offline ? 'offline' : ''}`} role="status">{offline ? '审批需要连接云端。' : unpublished ? '计划正在同步到云端，同步完成后可审批。' : '此任务来自云端：在这里或云端审批都可以，以先到达云端的决定为准。'}</p>}{plan && plan.body.questions.length > 0 && <QuestionChoices questions={plan.body.questions} picks={picks} onChange={setPicks}/>}{plan && plan.body.questions.length > 0 && <button className="primary" disabled={disabled || offline || plan.id !== latest?.id || !answersReady(plan.body.questions, picks)} onClick={() => void invoke('choices:' + plan.id, async requestId => { await revise(formatQuestionAnswers(plan.body.questions, picks), requestId); setPicks({}); setVersion(''); })}>提交选择</button>}<button className="primary" disabled={disabled || offline || unpublished || task.state !== 'awaiting_review' || plan?.id !== latest?.id || planModelId !== task.planModelId || (!cloud && planModelId !== task.executeModelId)} onClick={() => plan && void invoke('approve:' + plan.id, async requestId => { await (cloud ? window.agent.call('cloudApprove', { taskId: task.id, planId: plan.id, requestId }) : window.agent.call('codingApprove', { taskId: task.id, planId: plan.id, hash: plan.hash, requestId })); })}>确认执行</button><button disabled={disabled || offline || !['awaiting_review', 'awaiting_input', 'needs_replan'].includes(task.state)} onClick={() => void invoke('reject:' + task.latestPlanId, async requestId => { await (cloud ? window.agent.call('cloudReject', { taskId: task.id, requestId }) : window.agent.call('codingReject', { taskId: task.id, requestId })); })}>取消</button>
      <hr/>{!cloud && <><p>切换模型后，请重新规划再批准。</p></>}<label>修改意见或补充信息<textarea aria-label="修改意见或补充信息" rows={5} value={feedback} onChange={e => setFeedback(e.target.value)} placeholder="说明要调整的计划、补充问题答案，或针对当前工作区重新规划。"/></label><button className="primary" disabled={disabled || offline || !feedback.trim()} onClick={() => void invoke(JSON.stringify([task.id, feedback, planModelId]), async requestId => { await revise(feedback, requestId); setFeedback(''); setVersion(''); })}>要求修改 / 重新规划</button>
    </aside></div>}
    {panel === 'changes' && <section className="changes-panel"><div className="change-actions"><button className={view === 'baseline' ? 'selected' : ''} onClick={() => { setView('baseline'); setPath(''); }}>相对执行前基线</button><button className={view === 'workspace' ? 'selected' : ''} onClick={() => { setView('workspace'); setPath(''); }}>整个工作区</button><button onClick={() => void window.agent.call('codingChanges', { taskId: task.id, view, ...(path ? { path } : {}) }).then(setChanges).catch(e => onError(message(e)))}>刷新变更</button></div><p className="muted">{changes?.warning}</p><div className="diff-layout"><nav>{changes?.files.map(f => <button key={f.path} className={path === f.path ? 'selected' : ''} onClick={() => setPath(f.path)}><span>{f.kind === 'added' ? '+' : f.kind === 'deleted' ? '−' : '~'}</span> {f.path}{!f.preview && ' · 仅元信息'}</button>)}{!changes?.files.length && <p className="muted">暂无文件变更</p>}</nav><pre aria-label="文件差异">{changes?.diff || '选择文件查看差异'}</pre></div></section>}
    </div></aside>}
    </div>
  </div>;
}

function ProjectConversation({ detail, disabled, blocked, models, modelId, onModel, onError, onPlan, onSend, planDisabled }: { detail: CodingDetail; disabled: boolean; blocked: boolean; models: ModelConfig[]; modelId: string; onModel: (id: string) => void; onError: (s: string) => void; onPlan: () => void; onSend: (text: string, mode: 'agent' | 'plan') => Promise<void>; planDisabled: boolean }) {
  const [mode, setMode] = useState<'agent' | 'plan'>(['planning', 'awaiting_review', 'awaiting_input', 'needs_replan'].includes(detail.task.state) ? 'plan' : 'agent');
  useEffect(() => { if (detail.runs.at(-1)?.mode === 'execute') setMode('agent'); }, [detail.runs.at(-1)?.run.id]);
  const [draft, setDraft] = useState(''); const sent = useRef<{ text: string; previousRunId?: string } | null>(null); const transcript = useRef<HTMLDivElement>(null), following = useRef(true);
  useEffect(() => { if (following.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight; }, [detail.messages.map(m => m.content + m.status).join(''), detail.tools.map(t => t.id + t.state + t.output.length).join('')]);
  const send = async () => { if (disabled || (mode === 'plan' && planDisabled) || !draft.trim()) return; const text = draft.trim(); sent.current = { text, previousRunId: detail.runs.at(-1)?.run.id }; await onSend(text, mode); /* Preserve draft when the RPC failed; the caller reports the error. */ };
  // Once persisted, clear the matching draft, including a send whose response was lost on reconnect.
  useEffect(() => { const pending = sent.current; if (pending && detail.messages.some(m => m.role === 'user' && m.content === pending.text && m.runId !== pending.previousRunId && m.runId === detail.runs.at(-1)?.run.id)) { setDraft(current => current.trim() === pending.text ? '' : current); sent.current = null; } }, [detail.messages]);
  return <section className="project-conversation">
    <div className="project-transcript" aria-label="项目对话记录" ref={transcript} onScroll={() => { const el = transcript.current!; following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 70; }}>
      {detail.messages.map(m => { const run = detail.runs.find(r => r.run.id === m.runId); const status = m.status === 'completed' ? '已完成' : label[m.status] ?? m.status; const steps = m.role === 'assistant' ? detail.tools.filter(t => t.runId === m.runId) : []; return <article key={m.id} className={`message ${m.role}`}><div className="message-label">{m.role === 'user' ? '你' : 'T-AGNET'}{m.role === 'assistant' && <span>{status}</span>}</div>{steps.length > 0 && <AgentTrace steps={steps} live={m.status === 'running' && !m.content.trim()}/>}<div className="message-body">{m.content ? <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ href, children }) => <a href={href} onClick={e => { e.preventDefault(); if (href && /^https?:\/\//i.test(href)) void window.agent.openExternal(href).catch(e => onError(message(e))); }}>{children}</a>, img: () => <span>[图片未加载]</span> }}>{m.content}</Markdown> : m.status === 'running' && steps.length === 0 ? <span className="muted">正在思考…</span> : m.status !== 'running' ? <span className="muted">未生成回答</span> : null}</div>{m.role === 'assistant' && run?.run.error && <p className="message-error">{run.run.error}</p>}</article>; })}
    </div>
    {detail.task.state === 'awaiting_review' && <div className="inline-plan"><span>修改计划已准备好，确认后才会执行。</span><button onClick={onPlan}>查看并审阅计划 →</button></div>}
    {detail.task.state === 'awaiting_input' && <div className="inline-plan"><span>计划里有需要确认的问题。</span><button onClick={onPlan}>去选择 →</button></div>}
    <form className="project-composer" onSubmit={e => { e.preventDefault(); following.current = true; void send(); }}>
      <ModelSelect label="模型" models={models} value={modelId} onChange={onModel} disabled={disabled}/>
      <textarea aria-label="项目消息" rows={3} maxLength={30000} value={draft} disabled={!models.length} onChange={e => setDraft(e.target.value)} placeholder="提问、修复问题，或描述要实现的功能…" onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); following.current = true; void send(); } }}/>
      <div className="project-compose-actions"><label>模式<select aria-label="对话模式" value={mode} disabled={disabled} onChange={e => setMode(e.target.value as 'agent' | 'plan')}><option value="agent">正常</option><option value="plan" disabled={planDisabled}>计划</option></select></label><span>{blocked ? '当前任务完成后可继续发送' : mode === 'plan' ? '先讨论方案，确认后执行' : detail.cloud ? '云端任务：修改需通过计划审批' : 'Enter 发送 · Shift + Enter 换行'}</span><button className="primary" disabled={disabled || (mode === 'plan' && planDisabled) || !draft.trim()}>发送</button></div>
    </form>
  </section>;
}
