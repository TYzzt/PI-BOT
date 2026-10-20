import { accessSync, constants } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { execFileSync } from 'node:child_process';

export function defaultDataDir(platform = process.platform, env = process.env, home = homedir()) {
  if (env.PI_BOT_DATA_DIR) return env.PI_BOT_DATA_DIR;
  return platform === 'darwin' ? join(home,'Library','Application Support','Pi Bot')
    : join(env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home,'.local','share'),'pi-bot');
}
export function commandShell(platform = process.platform, env = process.env) {
  const shell = env.PI_BOT_SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  if (!isAbsolute(shell)) throw new Error('PI_BOT_SHELL 必须是可执行文件的绝对路径');
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
