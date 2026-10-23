import { StrictMode, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { PiBot } from '@pi-bot/bot-face/react';
import { DEFAULT_AVATAR, moodFor, sleepLabel, type Mood } from '@pi-bot/bot-face';
import type { AccountState, AppEvent, Bot, Device, LocalActivity, Message, MessagePage, ModelOption } from '../../../packages/protocol/src/index.js';
import { bridge, call, errorText } from './bridge.js';
import { BotEditor } from './editor.js';
import { Timeline } from './timeline.js';
import { BotListItem } from './bot-list-item.js';
import { DevicePhoneButton, PhoneDock } from './phone-control.js';
import './style.css';

const ORANGE = DEFAULT_AVATAR;

function Login({ state }: { state: AccountState }) {
  const [serverUrl, setServerUrl] = useState(state.serverUrl ?? '');
  const serverUrlEdited = useRef(false);
  const [username, setUsername] = useState(state.user?.username ?? '');
  const [password, setPassword] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [mood, setMood] = useState<Mood>(state.connection === 'revoked' ? 'error' : 'idle');
  const [error, setError] = useState(state.connection === 'revoked' ? '这台电脑已被解绑或账号不可用，请重新登录。' : '');
  useEffect(() => {
    if (state.serverUrl || serverUrlEdited.current) return;
    let active = true;
    void bridge.defaultServerUrl().then(url => {
      if (active && !serverUrlEdited.current) setServerUrl(url);
    });
    return () => { active = false; };
  }, [state.serverUrl]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMood('thinking'); setError('');
    try {
      await call('login', { serverUrl, username, password, label: await bridge.computerName() });
      setMood('celebrate');
    } catch (err) { setMood('error'); setError(errorText(err)); }
  };
  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <PiBot avatar={ORANGE} mood={mood} size={150} followPointer />
        <h1>Pi Bot</h1>
        <p className="muted">登录后，这台电脑就是你的 Bot 们工作的电脑。<br />它们的资料库放在 ~/pi-bot。</p>
        <label>用户名<input value={username} onChange={e => setUsername(e.target.value)} autoFocus autoComplete="username" /></label>
        <label>密码<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" /></label>
        {advanced
          ? <label>服务器地址<input value={serverUrl} onChange={e => { serverUrlEdited.current = true; setServerUrl(e.target.value); }} /></label>
          : <button type="button" className="link" onClick={() => setAdvanced(true)}>服务器：{serverUrl.replace(/^https?:\/\//, '')}</button>}
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={!serverUrl.trim() || !username || !password || mood === 'thinking'}>登录并绑定这台电脑</button>
        <p className="muted small">账号由管理员创建。一个账号可以绑定多台 Mac 或 Linux电脑；每个 Bot 选择一台执行。</p>
      </form>
    </div>
  );
}

function botMood(bot: Bot, activity: LocalActivity | undefined, now: number): Mood {
  if (bot.activity?.status && ['running', 'waiting_approval', 'queued'].includes(bot.activity.status)) return moodFor({ status: bot.activity.status, tool: bot.activity.tool });
  if (activity) return activity.mood;
  const run = bot.latest_run;
  return moodFor({ status: run?.status ?? null, finishedAt: run?.finished_at ? Date.parse(run.finished_at) : null, lastActiveAt: Date.parse(bot.last_active_at), now });
}
function statusLine(bot: Bot, mood: Mood, now: number) {
  if (bot.activity?.summary) return bot.activity.summary;
  if (bot.pending_approvals.length) return '等你批准…';
  if (mood === 'thinking') return '思考中…';
  if (mood === 'working') return '工作中…';
  if (mood === 'searching') return '查找中…';
  if (mood === 'sleeping') return `睡着了 · ${sleepLabel(Date.parse(bot.last_active_at), now)}`;
  return bot.last_message?.preview || '还没有对话';
}

function Settings({ state, onClose, onOpenPhone }: { state: AccountState; onClose(): void; onOpenPhone(device: Device): void }) {
  const [devices,setDevices] = useState<Device[]>([]);
  const [error,setError] = useState('');
  const refresh = () => call<Device[]>('devices').then(setDevices).catch(e => setError(errorText(e)));
  useEffect(() => {
    void refresh();
    return bridge.subscribe(event => { if (event.type === 'bots' || event.type === 'account') void refresh(); });
  },[]);
  const revoke = async (device: Device) => {
    if (!confirm(`解绑「${device.label}」？该电脑上的文件保留，绑定它的 Bot 将等待重新选择执行电脑。`)) return;
    try { if (device.id === state.deviceId) { await call('logout'); onClose(); } else { await call('deviceRevoke',{id:device.id}); await refresh(); } }
    catch(e) { setError(errorText(e)); }
  };
  return (
      <div className="backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
        <div className="modal settings">
          <h2>设置</h2>
          <dl>
            <dt>账号</dt><dd>{state.user?.display_name}（{state.user?.username}）</dd>
            <dt>这台电脑</dt><dd>{state.deviceLabel}</dd>
            <dt>服务器</dt><dd className="mono">{state.serverUrl}</dd>
            <dt>资料库</dt><dd className="mono">{state.libraryRoot}</dd>
          </dl>
          <p className="muted small">Bot 在各自绑定的电脑上读写资料库、执行命令，访问资料库以外的文件前会先征得你同意。绑定电脑离线时，Bot 在云端聊天和搜索，本地任务等待原电脑上线。</p>
          <h3>执行电脑</h3>
          {devices.filter(d=>!d.revoked_at).map(d=>(
            <div key={d.id} className="device-row">
              <span>{d.label} · {d.platform === 'linux' ? 'Linux' : d.platform === 'darwin' ? 'macOS' : d.platform === 'win32' ? 'Windows' : '未知平台'} · {d.online ? '在线' : '离线'}{d.id === state.deviceId ? ' · 本机' : ''}</span>
              <span className="device-actions">
                <DevicePhoneButton device={d} onOpen={() => onOpenPhone(d)} />
                <button type="button" className="ghost danger small" onClick={()=>void revoke(d)}>解绑</button>
              </span>
            </div>
          ))}
          {error && <p className="error">{error}</p>}
          <footer>
            <button className="ghost danger" onClick={() => { if (confirm('退出登录并解绑这台电脑？资料库文件会保留。')) void call('logout').then(onClose).catch(e => setError(errorText(e))); }}>退出登录</button>
            <button className="primary" onClick={onClose}>完成</button>
          </footer>
        </div>
      </div>
  );
}

function App() {
  const [service, setService] = useState(false);
  const [account, setAccount] = useState<AccountState | null>(null);
  const [bots, setBots] = useState<Bot[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [devices,setDevices] = useState<Device[]>([]);
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem('pi-bot.selected'));
  const [pages, setPages] = useState<Record<string, { messages: Message[]; hasMore: boolean }>>({});
  const [activities, setActivities] = useState<Record<string, LocalActivity>>({});
  const [editor, setEditor] = useState<Bot | 'new' | null>(null);
  const [settings, setSettings] = useState(false);
  const [phoneTarget, setPhoneTarget] = useState<{ botId: string | null; deviceId: string | null } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [loadError, setLoadError] = useState('');
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const online = account?.connection === 'online';

  const loadBots = useCallback(async () => {
    try {
      const r = await call<{ bots: Bot[]; devices: Device[] }>('bots');
      setDevices(r.devices ?? []);
      setBots(r.bots); setLoadError('');
      setSelected(s => (s && r.bots.some(b => b.id === s) ? s : r.bots[0]?.id ?? null));
    } catch (e) { setLoadError(errorText(e)); }
  }, []);
  const loadTail = useCallback(async (botId: string) => {
    const page = await call<MessagePage>('messages', { botId }).catch(() => null);
    if (!page) return;
    setPages(p => {
      const old = p[botId];
      const byId = new Map((old?.messages ?? []).map(m => [m.id, m]));
      for (const m of page.messages) byId.set(m.id, m);
      return { ...p, [botId]: { messages: [...byId.values()].sort((a, b) => a.seq - b.seq), hasMore: old ? old.hasMore : page.has_more } };
    });
  }, []);
  const loadMore = async (botId: string) => {
    const current = pages[botId];
    if (!current?.messages.length) return;
    const page = await call<MessagePage>('messages', { botId, before: current.messages[0].seq });
    setPages(p => ({ ...p, [botId]: { messages: [...page.messages, ...p[botId].messages], hasMore: page.has_more } }));
  };

  useEffect(() => {
    let disposed = false;
    const loadStatus = () => {
      void call<AccountState & { activities: LocalActivity[] }>('status').then(s => {
        if (disposed) return;
        setService(true); setAccount(s);
        setActivities(Object.fromEntries(s.activities.map(a => [a.botId, a])));
      }).catch(() => { /* A later connection event retries if the service is not ready. */ });
    };
    const unsubscribe = bridge.subscribe((event: AppEvent) => {
      if (event.type === 'service.status') { setService(event.connected); if (event.connected) loadStatus(); }
      else if (event.type === 'account') setAccount(event.state);
      else if (event.type === 'bots') void loadBots();
      else if (event.type === 'bot') { void loadBots(); if (event.bot_id === selectedRef.current) void loadTail(event.bot_id); }
      else if (event.type === 'delta') setPages(p => {
        const page = p[event.bot_id];
        if (!page) return p;
        return { ...p, [event.bot_id]: { ...page, messages: page.messages.map(m => (m.id === event.message_id && m.status === 'running' ? { ...m, content: event.content } : m)) } };
      });
      else if (event.type === 'activity') setActivities(a => { const next = { ...a }; if (event.activity) next[event.botId] = event.activity; else delete next[event.botId]; return next; });
    });
    // The service may connect before the renderer subscribes to its events.
    loadStatus();
    return () => { disposed = true; unsubscribe(); };
  }, [loadBots, loadTail]);
  useEffect(() => {
    if (!online) return;
    void loadBots();
    void call<ModelOption[]>('models').then(setModels).catch(() => {});
  }, [online, loadBots]);
  useEffect(() => { if (selected) { localStorage.setItem('pi-bot.selected', selected); if (online) void loadTail(selected); } }, [selected, online, loadTail]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 3000); return () => clearInterval(t); }, []);

  if (!service || !account) return <div className="splash"><PiBot avatar={ORANGE} mood="sleeping" size={110} /><p className="muted">正在连接本地服务…</p></div>;
  if (account.connection === 'signed_out' || account.connection === 'revoked') return <Login state={account} />;
  const bot = bots.find(b => b.id === selected) ?? null;
  const page = bot ? pages[bot.id] : undefined;
  return (
    <div className={phoneTarget ? 'shell with-phone' : 'shell'}>
      <aside>
        <div className="titlebar">
          <span className="brand">Pi Bot</span>
          <span className={`pill ${account.connection}`}>{online ? '电脑在线' : account.connection === 'connecting' ? '连接中…' : '离线 · 重连中'}</span>
        </div>
        <div className="bot-list">
          {bots.map(b => {
            const mood = botMood(b, activities[b.id], now);
            return (
              <BotListItem
                key={b.id}
                bot={b}
                mood={mood}
                summary={b.is_main && !b.latest_run && !b.last_message ? '主智能体 · 有什么想做的，告诉我' : statusLine(b, mood, now)}
                selected={b.id === selected}
                onSelect={() => setSelected(b.id)}
              />
            );
          })}
          {!bots.length && online && !loadError && <p className="muted small empty-list">还没有 Bot</p>}
          {loadError && <p className="error small empty-list">{loadError}</p>}
        </div>
        <button className="new-bot" disabled={!online} onClick={() => setEditor('new')}>＋ 新建 Bot</button>
        <button className="me" onClick={() => setSettings(true)}>
          <span className="avatar-letter">{(account.user?.display_name ?? '?').slice(0, 1).toUpperCase()}</span>
          <span>{account.user?.display_name}</span>
          <span className="muted">⚙︎</span>
        </button>
      </aside>
      <main>
        {!online && <div className="banner">{account.connection === 'connecting' ? '正在连接服务器…' : '与服务器的连接已断开，正在自动重连。断开期间 Bot 无法在这台电脑上工作。'}</div>}
        {bot ? (
          <>
            <header className="bot-head">
              <PiBot avatar={bot.avatar} mood={botMood(bot, activities[bot.id], now)} size={52} followPointer />
              <div className="bot-title">
                <h1>{bot.name}</h1>
                <span className="muted small">{devices.find(d=>d.id===bot.execution_device_id)?.label ?? '未绑定电脑'} · {devices.find(d=>d.id===bot.execution_device_id)?.online ? '在线' : '离线，云端聊天'} · {bot.is_main ? '主智能体 · ' : ''}{models.find(m => m.id === bot.model_id)?.name ?? '默认模型'} · ~/pi-bot/{bot.slug}</span>
              </div>
              <button className="ghost" disabled={bot.execution_device_id !== account.deviceId} onClick={() => bridge.openLibrary(bot.id).catch(e => alert(errorText(e)))}>在文件管理器中打开资料库</button>
              <button className="ghost" disabled={!online} onClick={() => setEditor(bot)}>编辑</button>
              <button type="button" className="ghost" aria-label="打开手机预览" onClick={() => setPhoneTarget({ botId: bot.id, deviceId: null })}>手机</button>
            </header>
            <Timeline bot={bot} messages={page?.messages ?? []} hasMore={page?.hasMore ?? false} mood={botMood(bot, activities[bot.id], now)} online={online} onLoadMore={() => loadMore(bot.id)} onOpenBot={id => { if (bots.some(b => b.id === id)) setSelected(id); }} onSent={sent => {
              setPages(p => {
                const old = p[bot.id];
                const byId = new Map((old?.messages ?? []).map(m => [m.id, m]));
                for (const m of sent.messages) byId.set(m.id, m);
                return { ...p, [bot.id]: { messages: [...byId.values()].sort((a, b) => a.seq - b.seq), hasMore: old?.hasMore ?? sent.has_more } };
              });
            }} />
          </>
        ) : (
          <div className="empty">
            <PiBot avatar={ORANGE} mood={online ? 'celebrate' : 'sleeping'} size={180} followPointer />
            {online ? (
              <>
                <h2>创建你的第一个 Bot</h2>
                <p className="muted">每个 Bot 有自己的性格、长期记忆和资料库。它们会在这台电脑上帮你整理资料、写文件、跑命令。</p>
                <button className="primary" onClick={() => setEditor('new')}>新建 Bot</button>
              </>
            ) : (
              <>
                <h2>正在连接服务器</h2>
                <p className="muted">连上之后这里会出现你的 Bot。资料库里的文件一直在文件管理器里：{account.libraryRoot ?? '~/pi-bot'}</p>
              </>
            )}
          </div>
        )}
      </main>
      {phoneTarget && <PhoneDock botId={phoneTarget.botId ? bot?.id ?? phoneTarget.botId : null} pinnedDeviceId={phoneTarget.deviceId} devices={devices} executionDeviceId={phoneTarget.botId ? bot?.execution_device_id ?? null : null} onClose={() => setPhoneTarget(null)} />}
      {editor && <BotEditor bot={editor === 'new' ? undefined : editor} models={models} devices={devices} currentDeviceId={account.deviceId ?? null} onClose={() => setEditor(null)} onSaved={b => { setEditor(null); setSelected(b.id); void loadBots(); }} />}
      {settings && <Settings state={account} onClose={() => setSettings(false)} onOpenPhone={device => { setSettings(false); setPhoneTarget({ botId: null, deviceId: device.id }); }} />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
