import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, AppEvent } from '../../../packages/protocol/src/index.js';
const bridge: DesktopBridge = {
  chooseProjectDirectory: () => ipcRenderer.invoke('agent:chooseProjectDirectory'),
  computerName: () => ipcRenderer.invoke('agent:computerName'),
  cloudServerUrl: () => ipcRenderer.invoke('agent:cloudServerUrl'),
  call: (method, input) => ipcRenderer.invoke('agent:call', method, input),
  subscribe: listener => { const handler = (_event: Electron.IpcRendererEvent, event: AppEvent) => listener(event); ipcRenderer.on('agent:event', handler); return () => ipcRenderer.removeListener('agent:event', handler); },
  openExternal: url => ipcRenderer.invoke('agent:openExternal', url),
};
contextBridge.exposeInMainWorld('agent', bridge);
