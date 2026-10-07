import { executionProgress, activityDuration, executionDuration, runDuration } from './progress.js';
import { ChangesPanel } from './changes.js';
import { createRefreshScheduler } from './refresh.js';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import React, { useEffect, useRef, useState } from 'react';
import type { CodingDetail, ModelConfig, Project, CodingRun, ToolCall, PlanQuestion, QuestionPick, PlanVersion } from '../../../packages/protocol/src/index.js';
import { answersReady, formatQuestionAnswers, questionKey } from '../../../packages/protocol/src/index.js';
import { useCloudStatus, SharedPanel } from './cloud.js';
const label: Record<string, string> = { reading: '正在处理', planning: '正在规划', awaiting_review: '等待审阅', awaiting_input: '等待补充信息', executing: '正在执行', needs_replan: '需要重新规划', waiting_for_local_action: '需要本机操作', completed: '已完成', failed: '运行失败', cancelled: '已停止', rejected: '已拒绝', interrupted: '运行中断', pending: '待执行', running: '进行中', passed: '通过', not_run: '未验证' };
function message(error: unknown) { return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, ''); }
function QuestionChoices({ questions, picks, onChange, disabled, onSubmit }: { questions: PlanQuestion[]; picks: Record<string, QuestionPick>; onChange: (next: Record<string, QuestionPick>) => void; disabled: boolean; onSubmit: () => void }) {
  const [index, setIndex] = useState(0);
  const question = questions[index], key = questionKey(question, index);
  const pick = picks[key] ?? { options: [], other: '' };
  const set = (next: QuestionPick) => onChange({ ...picks, [key]: next });
  const ready = answersReady([question], { [questionKey(question, 0)]: pick });
  const prompt = typeof question === 'string' ? question : question.prompt;
  return <section className="question-prompt" aria-label="待确认问题">
    <div className="question-heading"><span className="plan-symbol">?</span><span>需要你的意见</span><span className="question-count">{index + 1} / {questions.length}</span></div>
    <h3>{prompt}</h3><p className="question-hint">{typeof question !== 'string' && question.allowMultiple ? '可以选择多项，也可以补充自己的想法。' : '选择一个选项，或填写自己的答案。'}回答后继续{typeof question === 'string' ? '。' : '；推荐项也需要你确认。'}</p>
    <fieldset className="question-options" disabled={disabled}><legend className="sr-only">{prompt}</legend>
      {typeof question !== 'string' && question.options.map((option, optionIndex) => <label key={option.id} className={`question-option${pick.options.includes(option.id) ? ' picked' : ''}`}><input type={question.allowMultiple ? 'checkbox' : 'radio'} name={key} checked={pick.options.includes(option.id)} onChange={() => {
        const options = question.allowMultiple ? pick.options.includes(option.id) ? pick.options.filter(id => id !== option.id) : [...pick.options, option.id] : [option.id];
        set({ ...pick, options });
      }}/><span>{option.label}</span><span className="option-index">{optionIndex + 1}</span></label>)}
      <textarea aria-label={typeof question === 'string' ? prompt : `${prompt} 的其他回答`} rows={2} maxLength={5000} value={pick.other} onChange={e => set({ ...pick, other: e.target.value })} placeholder="也可以输入你的想法…"/>
    </fieldset>
    <div className="question-footer"><span>任务已暂停，等待你的回答</span><div>{index > 0 && <button disabled={disabled} onClick={() => setIndex(index - 1)}>上一题</button>}{index < questions.length - 1 ? <button className="primary" disabled={disabled || !ready} onClick={() => setIndex(index + 1)}>下一题 →</button> : <button className="primary" disabled={disabled || !answersReady(questions, picks)} onClick={onSubmit}>提交回答并继续 →</button>}</div></div>
  </section>;
}
function PlanDocument({ plan, detail, expanded = false }: { plan: PlanVersion; detail: CodingDetail; expanded?: boolean }) {
  const latest = detail.plans.at(-1)?.id === plan.id;
  const execution = detail.runs.findLast(r => r.mode === 'execute');
  const showProgress = latest && execution?.planId === plan.id;
  return <section className="plan-document plan-card" aria-label="执行计划">
    <div className="plan-card-heading"><span className="plan-symbol">≡</span><span>执行计划</span><span className="plan-version">v{plan.version}{!latest && ' · 历史'}</span></div>
    <h3>{plan.body.goal}</h3><div className="plan-meta"><span>{plan.body.steps.length} 个步骤</span><span>{plan.body.modules.length} 个相关模块</span><span>{plan.body.verification.length} 项验证</span></div>
    <ol className="plan-timeline">{plan.body.steps.map((s, i) => {
      const state = showProgress ? detail.steps.find(x => x.stepId === s.stepId)?.state ?? 'pending' : 'pending';
      return <li key={s.stepId} className={`plan-step step-${state}`}><span className="plan-step-number">{state === 'completed' ? '✓' : i + 1}</span><div><div className="plan-step-heading"><strong>{s.title}</strong>{showProgress && <span className="step-status">{({ completed: '已完成', pending: '待执行', running: '进行中', failed: '失败' })[state]}</span>}</div><p>{s.description}</p></div></li>;
    })}</ol>
    <details className="plan-details" open={expanded || undefined}><summary>范围、验证与执行细节<span>展开</span></summary><div>
      <h4>修改范围</h4><ul>{plan.body.scope.map((s, i) => <li key={i}>{s}</li>)}</ul>
      {plan.body.modules.length > 0 && <><h4>相关模块</h4><div className="module-tags">{plan.body.modules.map((s, i) => <code key={i}>{s}</code>)}</div></>}
      {plan.body.nonGoals.length > 0 && <><h4>不包含</h4><ul>{plan.body.nonGoals.map((s, i) => <li key={i}>{s}</li>)}</ul></>}
      <h4>验证与验收</h4><ul>{[...plan.body.verification, ...plan.body.acceptance].map((s, i) => <li key={i}>{s}</li>)}</ul>
      {plan.body.commands.length > 0 && <><h4>预期命令</h4><pre>{plan.body.commands.join('\n')}</pre></>}
      {plan.body.externalActions.length > 0 && <><h4>外部动作</h4><ul>{plan.body.externalActions.map((s, i) => <li key={i}>{s}</li>)}</ul></>}
    </div></details>
  </section>;
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
    case 'request_user_input': line = '等待你补充信息'; break;
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
  return <details className="tool-step"><summary>{toolSummary(tool)}</summary><p className="muted">{tool.exitCode !== null ? `退出码 ${tool.exitCode}` : tool.state === 'completed' ? '已完成' : label[tool.state] ?? tool.state}{tool.truncated ? ' · 输出已截断' : ''}</p><pre>{tool.output || (tool.state === 'running' ? '还在进行…' : '没有额外输出')}</pre></details>;
}
function AgentTrace({ steps, live }: { steps: ToolCall[]; live: boolean }) {
  const active = [...steps].reverse().find(t => t.state === 'running');
  const spinning = !!active || live;
  const current = active ?? steps.at(-1);
  const headline = spinning && current ? toolSummary(current) : `工具活动 · ${steps.length} 步`;
  return <details className={`agent-trace${spinning ? ' running' : ''}`} aria-label="工具活动"><summary title={headline}>{spinning && <i className="agent-spin" aria-hidden="true"/>}<span>{headline}</span></summary><div className="tool-steps">{steps.map(t => <ToolStep key={t.id} tool={t}/>)}</div></details>;
}
function ExecutionElapsed({ runs }: { runs: CodingRun[] }) {
  const [now, setNow] = useState(Date.now());
  const ticking = runs.some(r => ['execute', 'agent'].includes(r.mode) && ['running', 'cancelling'].includes(r.run.state));
  useEffect(() => { setNow(Date.now()); if (!ticking) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [ticking]);
  const duration = executionDuration(runs, now);
  return duration === undefined ? null : <span className="execution-elapsed" aria-label="执行耗时">执行耗时 <time>{activityDuration(duration)}</time></span>;
}
function ExecutionProgress({ detail, connected, onActivity, compact = false, showActivityLink = true }: { detail: CodingDetail; connected: boolean; onActivity: () => void; compact?: boolean; showActivityLink?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const progress = executionProgress(detail);
  const current = progress.current;
  const duration = progress.run ? runDuration(progress.run, now) : undefined;
  const assistant = detail.messages.findLast(m => m.role === 'assistant' && m.runId === progress.run?.run.id);
  const headline = !connected ? '连接已断开，正在恢复进度同步' : current ? toolSummary(current) : assistant?.content.trim() ? '正在分析并整理回复…' : '正在思考下一步…';
  const output = current?.name === 'run_command' ? current.output.trim().split('\n').filter(Boolean).at(-1) : undefined;
  return <section className={`execution-progress${compact ? ' compact' : ''}${!connected ? ' disconnected' : ''}`} aria-label={compact ? '计划执行状态' : '执行进度'}>
    <div className="execution-progress-heading"><span>{connected && <i className="agent-spin" aria-hidden="true"/>}执行进度</span><span>{progress.steps.length ? `已报告 ${progress.completed} / ${progress.steps.length} 步完成` : `最近 ${progress.activities.filter(t => t.state === 'completed').length} 项操作已完成`}</span>{!compact && <button onClick={onActivity}>查看活动 ↗</button>}</div>
    {duration !== undefined && <div className="execution-time-row" aria-label="本轮执行耗时"><span>本轮已执行</span><time>{activityDuration(duration)}</time></div>}
    {progress.steps.length > 0 && <div className="execution-step-meter" role="progressbar" aria-label="已报告的步骤进度" aria-valuemin={0} aria-valuemax={progress.steps.length} aria-valuenow={progress.completed}>{progress.steps.map(step => <span key={step.stepId} className={`meter-${step.state}`} title={`${step.title} · ${label[step.state] ?? step.state}`}/>)}</div>}
    {progress.runningStep && <div className="execution-current-step">当前步骤：{progress.runningStep.title}</div>}
    <div className="execution-current" title={headline}><span>{headline}</span>{current && connected && <time>{activityDuration(now - current.startedAt)}</time>}{progress.active.length > 1 && <small>{progress.active.length} 项并行</small>}</div>
    {output && <pre className="execution-output" aria-label="命令最新输出">{shortText(output, 220)}</pre>}
    {!current && progress.latest && <div className="execution-last" title={toolSummary(progress.latest)}>最近活动：{toolSummary(progress.latest)}{progress.latest.endedAt && <span> · {activityDuration(now - progress.latest.endedAt)}前</span>}</div>}
    {compact && showActivityLink && <button className="execution-open-activity" onClick={onActivity}>查看实时活动 →</button>}
  </section>;
}
function ExecutionActivity({ detail }: { detail: CodingDetail }) {
  const progress = executionProgress(detail);
  return <section className="execution-activity" aria-label="执行活动详情"><div className="section-heading"><div><div className="eyebrow">ACTIVITY</div><h2>执行活动</h2></div><span>{progress.tools.length} 条最近记录</span></div>
    {progress.steps.length > 0 && <div className="execution-steps"><h3>计划步骤 <span>{progress.completed} / {progress.steps.length} 完成</span></h3>{progress.steps.map((step, i) => <div key={step.stepId} className={`execution-step step-${step.state}`}><span className="plan-step-number">{step.state === 'completed' ? '✓' : i + 1}</span><div><strong>{step.title}</strong><small>{label[step.state] ?? step.state}</small>{step.note && <p>{step.note}</p>}</div></div>)}</div>}
    <h3>最近工具活动</h3><p className="muted">新活动显示在最上方，展开可以查看具体输出。</p>
    <div className="execution-tool-list">{[...progress.tools].reverse().map(tool => <ToolStep key={tool.id} tool={tool}/>)}{!progress.tools.length && <p className="muted">正在准备执行，工具开始运行后会显示在这里。</p>}</div>
  </section>;
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
  const [panel, setPanel] = useState<'plan' | 'changes' | 'progress' | null>(null);
  const inputKey = detail?.task.pendingInput?.id ?? detail?.task.latestPlanId;
  useEffect(() => { setPicks({}); }, [inputKey]);
  const { busy, run } = useAction(onError); const seq = useRef(0), epoch = useRef(0), deltas = useRef(new Map<string, string>()); const disabled = busy || blocked || !connected;
  async function load() { const marker = ++epoch.current; const d = await window.agent.call('codingGet', { conversationId }); if (marker !== epoch.current) return; setDetail({ ...d, messages: d.messages.map(m => m.status === 'running' && deltas.current.has(m.id) ? { ...m, content: deltas.current.get(m.id)!, status: 'running' } : m) }); seq.current = d.lastSeq; setPlanModel(v => v || d.task.planModelId); }
  useEffect(() => { let live = true; const scheduler = createRefreshScheduler(load, e => { if (live) onError(message(e)); }); const reload = () => { if (live) scheduler.request(); }; scheduler.request(true); const timer = setInterval(() => scheduler.request(true), 1800); const off = window.agent.subscribe(e => { if (e.type === 'message.delta' && e.conversation_id === conversationId) { deltas.current.set(e.message_id!, e.content ?? ''); setDetail(d => d ? { ...d, messages: d.messages.map(m => m.id === e.message_id ? { ...m, content: e.content ?? '', status: 'running' } : m) } : d); return; } if (e.type === 'message.finalized' && e.message_id) deltas.current.delete(e.message_id); if ((e.type === 'service.status' && e.connected) || e.type === 'cloud.changed' || (e.conversation_id === conversationId && e.type !== 'message.delta')) reload(); }); return () => { live = false; scheduler.stop(); epoch.current++; clearInterval(timer); off(); }; }, [conversationId]);
  if (!detail) return <div className="coding-page muted">正在加载项目对话…</div>;
  const task = detail.task, latest = detail.plans.at(-1), plan = detail.plans.find(p => p.id === version) ?? latest;
  const invoke = (key: string, fn: (id: string) => Promise<void>) => run(key, async id => { await fn(id); await load(); await refresh(); });
  const cloud = detail.cloud, offline = !!cloud && !cloud.connected, unpublished = !!cloud && !!plan && !cloud.publishedPlanIds.includes(plan.id);
  const revise = (text: string, requestId: string) => cloud ? window.agent.call('cloudRevise', { taskId: task.id, feedback: text, requestId }) : window.agent.call('codingSend', { conversationId, text, modelId: planModelId, mode: 'plan', requestId });
  const showPanel = panel !== null;
  const openPlan = () => { setVersion(''); setPanel('plan'); };
  const executing = task.state === 'executing';
  const verificationLabel = detail.tools.some(t => t.runId === task.activeRunId && t.verification && t.state === 'running') ? '验证中' : detail.verification !== 'not_run' ? label[detail.verification] : '';
  const openActivity = () => setPanel('progress');
  const pending = task.pendingInput;
  const questions = ['awaiting_input', 'needs_replan'].includes(task.state) ? pending?.questions ?? latest?.body.questions ?? [] : [];
  const approveBlocked = disabled || offline || (!!cloud && !!latest && !cloud.publishedPlanIds.includes(latest.id)) || task.state !== 'awaiting_review' || planModelId !== task.planModelId || (!cloud && planModelId !== task.executeModelId);
  const approveDisabled = approveBlocked || plan?.id !== latest?.id || unpublished;
  const approve = (target: PlanVersion | undefined) => target && void invoke('approve:' + target.id, async requestId => { await (cloud ? window.agent.call('cloudApprove', { taskId: task.id, planId: target.id, requestId }) : window.agent.call('codingApprove', { taskId: task.id, planId: target.id, hash: target.hash, requestId })); });
  const submitAnswers = () => void invoke('choices:' + inputKey + JSON.stringify(picks), async requestId => {
    const text = formatQuestionAnswers(questions, picks);
    if (pending?.mode === 'agent') await window.agent.call('codingSend', { conversationId, text, modelId: planModelId, mode: 'agent', requestId });
    else await revise(text, requestId);
    setPicks({}); setVersion('');
  });
  const decisions = <>
    {questions.length > 0 && <QuestionChoices key={inputKey} questions={questions} picks={picks} onChange={setPicks} disabled={disabled || offline} onSubmit={submitAnswers}/>}
    {latest && !pending && !questions.length && !['planning', 'awaiting_input', 'executing'].includes(task.state) && <div className="conversation-plan"><PlanDocument plan={latest} detail={detail}/><div className="plan-card-footer"><span>{task.state === 'awaiting_review' ? '计划已准备好，确认后开始执行' : label[task.state] ?? task.state}</span><div><button onClick={openPlan}>查看并审阅计划</button>{task.state === 'awaiting_review' && panel !== 'plan' && <button className="primary" disabled={approveBlocked} onClick={() => approve(latest)}>确认执行 →</button>}</div></div></div>}
  </>;

  return <div className="coding-page conversation-page"><header className="coding-heading"><div><div className="eyebrow">{detail.project.name}{branch && <span className="branch-name">分支 {branch}</span>}{cloud && <span className={`cloud-badge ${offline ? 'offline' : ''}`}>来自云端{offline && ' · 离线'}</span>}</div><h1>{task.requirement.slice(0, 70)}</h1><p><span className={`state-pill state-${task.state}`}>{label[task.state] ?? task.state}</span> {verificationLabel && <span>验证：{verificationLabel}</span>} <ExecutionElapsed runs={detail.runs}/></p></div><div className="coding-heading-actions">{plan && <button onClick={openPlan}>查看计划</button>}<button aria-label="打开代码变更" onClick={() => setPanel('changes')}>代码变更</button>{activeRunId && <button className="stop" disabled={!connected || busy || cancelling} onClick={() => void invoke('stop:' + activeRunId, async () => { await window.agent.call('runCancel', { id: activeRunId }); })}>{cancelling ? '正在停止…' : '■ 停止任务'}</button>}</div></header>
    {(latest || task.state === 'planning' || task.pendingInput?.mode === 'plan') && <nav className="plan-workflow" aria-label="计划进度">{['制定计划', '确认执行', '修改与验证'].map((name, i) => {
      const stage = ['planning', 'awaiting_input', 'needs_replan'].includes(task.state) ? 0 : ['awaiting_review', 'rejected'].includes(task.state) ? 1 : 2;
      return <React.Fragment key={name}>{i > 0 && <span className="workflow-line"/>}<span className={`workflow-stage${i === stage ? ' current' : i < stage ? ' done' : ''}`}><i>{i < stage ? '✓' : i + 1}</i>{name}</span></React.Fragment>;
    })}</nav>}<SharedPanel conversationId={conversationId} onError={onError}/><div className="task-notice compact-notice" role="status">{cancelling ? '正在停止命令并等待确认，已产生的文件修改会保留。' : task.message || '正在处理任务…'}{task.state === 'executing' && <strong> 执行期间请避免同时编辑项目。</strong>}</div>
    <div className="coding-split">
    <ProjectConversation detail={detail} disabled={disabled} blocked={blocked} models={models} modelId={planModelId} onModel={setPlanModel} onError={onError} onSend={(text, mode) => invoke(JSON.stringify([mode, task.id, text, planModelId]), async requestId => {
      if (cloud) {
        if (mode === 'plan') await revise(text, requestId);
        else await window.agent.call('codingRead', { taskId: task.id, text, modelId: planModelId, requestId });
      } else await window.agent.call('codingSend', { conversationId, text, modelId: planModelId, mode, requestId });
      setVersion('');
    })} planDisabled={offline} decisions={decisions} needsInput={questions.length > 0} progress={executing ? <ExecutionProgress detail={detail} connected={connected} onActivity={openActivity}/> : null}/>

    {showPanel && <aside className={`review-drawer${panel === 'changes' ? ' changes-review' : ''}`} aria-label="审阅面板"><div className="review-drawer-bar">{plan && <button className={panel === 'plan' ? 'selected' : ''} onClick={() => setPanel('plan')}>计划与审阅</button>}<button className={panel === 'changes' ? 'selected' : ''} onClick={() => setPanel('changes')}>代码变更</button><button className={panel === 'progress' ? 'selected' : ''} onClick={openActivity}>执行活动</button><button className="close-panel" aria-label="关闭审阅面板" onClick={() => setPanel(null)}>×</button></div><div className="review-drawer-body">

    {panel === 'plan' && <div className="plan-review">
      <div className="section-heading"><div><div className="eyebrow">PLAN REVIEW</div><h2>计划审阅</h2></div>{plan && <select aria-label="计划版本" value={plan.id} onChange={e => setVersion(e.target.value)}>{detail.plans.map(p => <option key={p.id} value={p.id}>v{p.version}{p.id === latest?.id ? ' · 最新' : ' · 历史'}</option>)}</select>}</div>
      {plan ? <PlanDocument key={plan.id} plan={plan} detail={detail} expanded/> : <p className="muted">正在阅读项目、整理方案。遇到需要确认的问题，会直接在对话中提问。</p>}
      {questions.length > 0 && <div className="review-question-note"><span>有 {questions.length} 个问题等待你的回答</span><button onClick={() => setPanel(null)}>在对话中回答 →</button></div>}
      {cloud && <p className={`cloud-note ${offline ? 'offline' : ''}`} role="status">{offline ? '审批需要连接云端。' : unpublished ? '计划正在同步到云端，同步完成后可审批。' : '此任务来自云端，在这里或云端审批均可。'}</p>}
      <section className="plan-revision"><label>修改意见或补充信息<textarea aria-label="修改意见或补充信息" rows={3} maxLength={30000} value={feedback} onChange={e => setFeedback(e.target.value)} placeholder="想调整哪些步骤？在这里补充…"/></label><button disabled={disabled || offline || !feedback.trim()} onClick={() => void invoke(JSON.stringify([task.id, feedback, planModelId]), async requestId => { await revise(feedback, requestId); setFeedback(''); setVersion(''); })}>要求修改 / 重新规划</button></section>
      <details className="execution-notes"><summary>执行说明</summary><p>确认后按计划修改项目并运行命令，保留已有修改。不会自动提交、推送或回滚；扩大范围时重新审阅。</p></details>
    </div>}
    {panel === 'progress' && <ExecutionActivity detail={detail}/>}
    {panel === 'changes' && <ChangesPanel taskId={task.id} executing={executing} connected={connected} revision={detail.tools.filter(t => ['write_file', 'edit_file', 'run_command'].includes(t.name)).map(t => t.id + t.state).join(',')} onError={onError}/>}
    </div>{executing ? <ExecutionProgress detail={detail} connected={connected} onActivity={openActivity} compact showActivityLink={panel !== 'progress'}/> : panel === 'plan' && <div className="review-decision-bar"><p>{planModelId !== task.planModelId || (!cloud && planModelId !== task.executeModelId) ? '模型已切换，请重新规划' : plan?.id !== latest?.id ? '历史版本仅供查看' : questions.length ? '回答问题后继续完善计划' : task.state === 'awaiting_review' ? '确认后开始修改和验证' : label[task.state] ?? task.state}</p><div><button disabled={disabled || offline || !['awaiting_review', 'awaiting_input', 'needs_replan'].includes(task.state)} onClick={() => void invoke('reject:' + task.latestPlanId, async requestId => { await (cloud ? window.agent.call('cloudReject', { taskId: task.id, requestId }) : window.agent.call('codingReject', { taskId: task.id, requestId })); })}>暂不执行</button><button className="primary" disabled={approveDisabled} onClick={() => approve(plan)}>确认执行</button></div></div>}</aside>}
    </div>
  </div>;
}

function ProjectConversation({ detail, disabled, blocked, models, modelId, onModel, onError, onSend, planDisabled, decisions, needsInput, progress }: { detail: CodingDetail; disabled: boolean; blocked: boolean; models: ModelConfig[]; modelId: string; onModel: (id: string) => void; onError: (s: string) => void; onSend: (text: string, mode: 'agent' | 'plan') => Promise<void>; planDisabled: boolean; decisions: React.ReactNode; needsInput: boolean; progress: React.ReactNode }) {
  const [mode, setMode] = useState<'agent' | 'plan'>(['planning', 'awaiting_review', 'awaiting_input', 'needs_replan'].includes(detail.task.state) ? 'plan' : 'agent');
  useEffect(() => { if (detail.runs.at(-1)?.mode === 'execute') setMode('agent'); }, [detail.runs.at(-1)?.run.id]);
  const [draft, setDraft] = useState(''); const sent = useRef<{ text: string; previousRunId?: string } | null>(null); const transcript = useRef<HTMLDivElement>(null), following = useRef(true);
  useEffect(() => { if (following.current && transcript.current) { const question = transcript.current.querySelector<HTMLElement>('.question-prompt'); if (question) transcript.current.scrollTop = question.offsetTop - transcript.current.offsetTop; else transcript.current.scrollTop = transcript.current.scrollHeight; } }, [detail.messages.map(m => m.content + m.status).join(''), detail.tools.map(t => t.id + t.state + t.output.length).join(''), detail.task.pendingInput?.id, detail.task.state, detail.task.latestPlanId]);
  const send = async () => { if (disabled || (mode === 'plan' && planDisabled) || !draft.trim()) return; const text = draft.trim(); sent.current = { text, previousRunId: detail.runs.at(-1)?.run.id }; await onSend(text, mode); /* Preserve draft when the RPC failed; the caller reports the error. */ };
  // Once persisted, clear the matching draft, including a send whose response was lost on reconnect.
  useEffect(() => { const pending = sent.current; if (pending && detail.messages.some(m => m.role === 'user' && m.content === pending.text && m.runId !== pending.previousRunId && m.runId === detail.runs.at(-1)?.run.id)) { setDraft(current => current.trim() === pending.text ? '' : current); sent.current = null; } }, [detail.messages]);
  return <section className="project-conversation">
    <div className="project-transcript" aria-label="项目对话记录" ref={transcript} onScroll={() => { const el = transcript.current!; following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 70; }}>
      {detail.messages.map(m => { const run = detail.runs.find(r => r.run.id === m.runId); const status = m.status === 'completed' ? '已完成' : label[m.status] ?? m.status; const steps = m.role === 'assistant' ? detail.tools.filter(t => t.runId === m.runId) : []; return <article key={m.id} className={`message ${m.role}`}><div className="message-label">{m.role === 'user' ? '你' : 'T-AGNET'}{m.role === 'assistant' && <><span>{status}</span>{run && run.endedAt != null && runDuration(run, run.endedAt) !== undefined && <span className="message-duration">耗时 {activityDuration(runDuration(run, run.endedAt)!)}</span>}</>}</div>{steps.length > 0 && <AgentTrace steps={steps} live={m.status === 'running' && !m.content.trim()}/>}<div className="message-body">{m.content ? <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ href, children }) => <a href={href} onClick={e => { e.preventDefault(); if (href && /^https?:\/\//i.test(href)) void window.agent.openExternal(href).catch(e => onError(message(e))); }}>{children}</a>, img: () => <span>[图片未加载]</span> }}>{m.content}</Markdown> : m.status === 'running' && steps.length === 0 ? <span className="muted">正在思考…</span> : m.status !== 'running' ? <span className="muted">{detail.task.pendingInput?.runId === m.runId ? '需要你的意见，回答后继续。' : '未生成回答'}</span> : null}</div>{m.role === 'assistant' && run?.run.error && <p className="message-error">{run.run.error}</p>}</article>; })}
      {decisions}
    </div>
    {progress}
    {!needsInput && <form className="project-composer" onSubmit={e => { e.preventDefault(); following.current = true; void send(); }}>
      <ModelSelect label="模型" models={models} value={modelId} onChange={onModel} disabled={disabled}/>
      <textarea aria-label="项目消息" rows={3} maxLength={30000} value={draft} disabled={!models.length} onChange={e => setDraft(e.target.value)} placeholder="提问、修复问题，或描述要实现的功能…" onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); following.current = true; void send(); } }}/>
      <div className="project-compose-actions"><label>模式<select aria-label="对话模式" value={mode} disabled={disabled} onChange={e => setMode(e.target.value as 'agent' | 'plan')}><option value="agent">正常</option><option value="plan" disabled={planDisabled}>计划</option></select></label><span>{blocked ? '当前任务完成后可继续发送' : mode === 'plan' ? '先讨论方案，确认后执行' : detail.cloud ? '云端任务：修改需通过计划审批' : 'Enter 发送 · Shift + Enter 换行'}</span><button className="primary" disabled={disabled || (mode === 'plan' && planDisabled) || !draft.trim()}>发送</button></div>
    </form>}
  </section>;
}
