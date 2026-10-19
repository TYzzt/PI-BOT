import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import electron from 'electron';
const node = resolve('node_modules/node/bin/node');
if (!existsSync(node)) throw new Error('请先运行 npm install 安装项目 Node.js 24');
const env = { ...process.env, PI_BOT_SERVER_URL: process.env.PI_BOT_SERVER_URL || 'http://127.0.0.1:8000' };
const children = new Set(); let closing = false;
function run(binary, args, options = {}) { const child = spawn(binary, args, { stdio: 'inherit', env, detached: true, ...options }); children.add(child); child.on('exit', () => children.delete(child)); return child; }
const build = run(node, ['scripts/build.mjs']);
await new Promise((resolve, reject) => { build.on('exit', code => code === 0 ? resolve() : reject(new Error('构建失败'))); build.on('error', reject); });
const dataDir = env.PI_BOT_DATA_DIR || (process.platform === 'darwin' ? join(homedir(),'Library','Application Support','Pi Bot') : join(env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(homedir(),'.local','share'),'pi-bot'));
const socket = join('/tmp',`pi-bot-${process.getuid?.() ?? 0}-${createHash('sha256').update(dataDir).digest('hex').slice(0,12)}`,'service.sock');
const running = await new Promise(resolve => {
  let token; try { token=readFileSync(join(dataDir,'ipc-token'),'utf8'); } catch { resolve(false); return; }
  const s=connect(socket); let buffer='';
  const finish=value=>{clearTimeout(timer);s.destroy();resolve(value);};
  const timer=setTimeout(()=>finish(false),800);
  s.on('connect',()=>s.write(JSON.stringify({token})+'\n'));
  s.on('data',data=>{buffer+=data;const i=buffer.indexOf('\n');if(i>=0){try{finish(JSON.parse(buffer.slice(0,i)).ready===true);}catch{finish(false);}}});
  s.on('error',()=>finish(false));
});
const service = running ? null : run(node, ['packages/service/dist/server.mjs']);
// The app is already built. Resolve Electron through Node so nested workspace
// installs work even when Forge cannot find their node_modules directory.
const electronEnv = { ...env };
delete electronEnv.ELECTRON_RUN_AS_NODE;
const ui = run(electron, [resolve('apps/desktop')], { cwd: resolve('apps/desktop'), env: electronEnv });
function signalGroup(child, signal) { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
function stop() { if (closing) return; closing = true; const stopping = [...children]; for (const child of stopping) signalGroup(child, 'SIGTERM'); setTimeout(() => { for (const child of stopping) signalGroup(child, 'SIGKILL'); }, 8500).unref(); }
for (const child of [service, ui].filter(Boolean)) { child.on('error', stop); child.on('exit', stop); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
