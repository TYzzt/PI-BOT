import { accessSync, constants } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { isAbsolute, join, win32 } from 'node:path';
import { execFileSync } from 'node:child_process';

export function defaultDataDir(platform = process.platform, env = process.env, home = homedir()) {
  if (env.PI_BOT_DATA_DIR) {
    if (!(platform === 'win32' ? win32 : { isAbsolute }).isAbsolute(env.PI_BOT_DATA_DIR)) throw new Error('PI_BOT_DATA_DIR 必须是绝对路径');
    return env.PI_BOT_DATA_DIR;
  }
  if (platform === 'win32') return win32.join(env.LOCALAPPDATA && win32.isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : win32.join(home, 'AppData', 'Local'), 'Pi Bot');
  return platform === 'darwin' ? join(home,'Library','Application Support','Pi Bot')
    : join(env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home,'.local','share'),'pi-bot');
}
export function commandShell(platform = process.platform, env = process.env) {
  const shell = env.PI_BOT_SHELL || (platform === 'win32' ? win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  if (platform === 'win32' && env.PI_BOT_SHELL && !/\\(?:powershell|pwsh)\.exe$/i.test(shell)) throw new Error('Windows 仅支持 PowerShell 解释器');
  if (!(platform === 'win32' ? win32.isAbsolute(shell) : isAbsolute(shell))) throw new Error('PI_BOT_SHELL 必须是可执行文件的绝对路径');
  try { accessSync(shell,constants.X_OK); } catch { throw new Error(`命令解释器不可执行：${shell}`); }
  return shell;
}
export function computerName() {
  if (process.platform === 'darwin') try {
    const name = execFileSync('scutil',['--get','ComputerName'],{encoding:'utf8',timeout:2000}).trim();
    if (name) return name.slice(0,80);
  } catch { /* Use hostname when macOS has no configured computer name. */ }
  return (hostname().replace(/\.local$/,'') || 'Pi Bot computer').slice(0,80);
}
