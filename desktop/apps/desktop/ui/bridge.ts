import type { DesktopBridge, Method } from '../../../packages/protocol/src/index.js';

declare global { interface Window { agent: DesktopBridge } }
export const bridge = window.agent;
export function call<T>(method: Method, input?: unknown) { return bridge.call(method, input) as Promise<T>; }
export const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : '操作失败');
