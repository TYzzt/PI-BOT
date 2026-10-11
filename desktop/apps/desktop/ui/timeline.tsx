import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { PiBot } from '@pi-bot/bot-face/react';
import type { Mood } from '@pi-bot/bot-face';
import type { Approval, Bot, Message, ToolEntry } from '../../../packages/protocol/src/index.js';
import { bridge, call, errorText } from './bridge.js';

const TOOL_LABELS: Record<string, string> = {
  list_files: '查看目录', read_file: '读取文件', search_files: '搜索文件', write_file: '写入文件', edit_file: '修改文件',
  run_command: '执行命令', request_outside_access: '申请访问', web_search: '联网搜索',
};
const time = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
      a: ({ href, children }) => <a href={href} onClick={e => { e.preventDefault(); if (href && /^https?:/.test(href)) void bridge.openExternal(href); }}>{children}</a>,
    }}>{text}</ReactMarkdown>
  );
});

function Tools({ tools }: { tools: ToolEntry[] }) {
  if (!tools.length) return null;
  return (
    <div className="tools">
      {tools.map(t => (
        <span key={t.id} className={`tool ${t.state}`} title={t.summary}>
          <i />{TOOL_LABELS[t.name] ?? t.name}{t.summary ? <em>{t.summary}</em> : null}
        </span>
      ))}
    </div>
  );
}

function ApprovalCard({ approval }: { approval: Approval }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(true);
    try { await call('decide', { approvalId: approval.id, decision }); } catch (e) { setError(errorText(e)); setBusy(false); }
  };
  return (
    <div className="approval">
      <strong>想访问资料库以外的位置</strong>
      <code>{approval.path}</code>
      <p>{approval.reason}</p>
      {error && <p className="error small">{error}</p>}
      <div className="row-end">
        <button className="ghost" disabled={busy} onClick={() => decide('reject')}>拒绝</button>
        <button className="primary" disabled={busy} onClick={() => decide('approve')}>允许本次任务访问</button>
      </div>
    </div>
  );
}

export function Timeline({ bot, messages, hasMore, mood, online, onLoadMore }: { bot: Bot; messages: Message[]; hasMore: boolean; mood: Mood; online: boolean; onLoadMore(): void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const run = bot.latest_run;
  const busy = !!run && ['queued', 'running', 'waiting_approval'].includes(run.status);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, bot.pending_approvals.length]);
  useEffect(() => { stick.current = true; setError(''); }, [bot.id]);
  const send = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setError('');
    stick.current = true;
    try { await call('send', { botId: bot.id, text: value }); setText(''); } catch (e) { setError(errorText(e)); }
  };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
  };
  let lastDay = '';
  return (
    <>
      <div className="timeline" ref={scroller} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        {hasMore && <button className="ghost load-more" onClick={onLoadMore}>加载更早的消息</button>}
        {!messages.length && (
          <div className="intro">
            <PiBot avatar={bot.avatar} mood={mood === 'idle' ? 'happy' : mood} size={150} followPointer />
            <h2>我是 {bot.name}</h2>
            <p className="muted">{bot.persona ? bot.persona.slice(0, 140) : '告诉我你想做什么。我的资料都放在自己的资料库里，随时可以在 Finder 中查看。'}</p>
          </div>
        )}
        {messages.map(m => {
          const d = day(m.created_at);
          const separator = d !== lastDay ? <div className="day" key={`d-${m.id}`}><span>{d}</span></div> : null;
          lastDay = d;
          return [separator, m.role === 'user' ? (
            <div className="msg user" key={m.id}><div className="bubble">{m.content}</div><span className="meta">{time(m.created_at)}</span></div>
          ) : (
            <div className="msg bot" key={m.id}>
              <div className="body">
                <Tools tools={m.tools} />
                {m.content ? <div className="bubble markdown"><Markdown text={m.content} /></div> : m.status === 'running' ? <div className="typing"><i /><i /><i /></div> : null}
                <span className="meta">
                  {time(m.created_at)}
                  {m.executor === 'cloud' && <span className="tag" title="Mac 离线时在云端运行，只能对话和联网搜索">云端</span>}
                  {m.status === 'failed' && <span className="tag bad">{run?.assistant_message_id === m.id && run.error ? run.error : '运行失败'}</span>}
                  {m.status === 'cancelled' && <span className="tag">已停止</span>}
                </span>
              </div>
            </div>
          )];
        })}
        {bot.pending_approvals.map(a => <ApprovalCard key={a.id} approval={a} />)}
      </div>
      <div className="composer">
        {error && <p className="error small">{error}</p>}
        {!online && <p className="muted small">Mac 未连接服务器，暂时无法发送。</p>}
        <div className="input">
          <textarea value={text} onChange={e => setText(e.target.value)} onKeyDown={key} rows={Math.min(8, Math.max(1, text.split('\n').length))} placeholder={busy ? `${bot.name} 正在忙…` : `给 ${bot.name} 发消息`} disabled={!online} />
          {busy
            ? <button className="stop" onClick={() => run && call('cancel', { runId: run.id }).catch(e => setError(errorText(e)))} title="停止">■</button>
            : <button className="send" disabled={!text.trim() || !online} onClick={send} title="发送（Enter）">↑</button>}
        </div>
      </div>
    </>
  );
}
