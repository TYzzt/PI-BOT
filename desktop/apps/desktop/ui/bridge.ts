import type { DesktopBridge, Method } from '../../../packages/protocol/src/index.js';

declare global { interface Window { agent: DesktopBridge } }
function agent(): DesktopBridge {
  if (!window.agent) throw new Error('桌面桥尚未就绪');
  return window.agent;
}
/** Resolved on use so renderer modules can be imported without a preload bridge. */
export const bridge: DesktopBridge = {
  call: (method, input) => agent().call(method, input),
  subscribe: listener => agent().subscribe(listener),
  computerName: () => agent().computerName(),
  defaultServerUrl: () => agent().defaultServerUrl(),
  openLibrary: botId => agent().openLibrary(botId),
  openExternal: url => agent().openExternal(url),
};
export function call<T>(method: Method, input?: unknown) { return bridge.call(method, input) as Promise<T>; }
export const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : '操作失败');
