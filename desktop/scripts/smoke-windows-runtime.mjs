import { mkdtempSync, rmSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, fork } from 'node:child_process';
import { createServer } from 'node:net';
if (process.platform !== 'win32') throw new Error('Windows-only smoke test');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Stage outside the repository so ancestor node_modules cannot hide missing runtime dependencies.
const stage = mkdtempSync(join(tmpdir(), 'Pi Bot runtime 中文 '));
let service;
try {
  const runtime = join(stage, 'runtime');
  // Node's native cpSync can misencode non-ASCII Windows destinations; the
  // asynchronous implementation preserves the actual staged path.
  await cp(resolve(root, 'apps/desktop/runtime'), runtime, { recursive: true });
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve); });
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const env = { ...process.env, PI_BOT_DATA_DIR: join(stage, 'private'), PI_BOT_LIBRARY_ROOT: join(stage, 'libraries'), PI_BOT_WINDOWS_HELPER: join(runtime, 'pi-bot-windows.exe'), PI_BOT_PARENT_LEASE: '1', PI_BOT_IPC_PORT: String(port) };
  const node = join(runtime, 'bin/node.exe');
  const documentJob = (job,bytes) => new Promise((resolve,reject) => {
    const child=fork(join(runtime,'document-worker.mjs'),[],{execPath:node,execArgv:[],serialization:'advanced',windowsHide:true,stdio:['ignore','ignore','pipe','ipc'],cwd:stage});
    let diagnostic='';child.stderr.on('data',b=>{diagnostic=(diagnostic+b).slice(-2000);});
    const timer=setTimeout(()=>{child.kill();reject(new Error('Packaged document worker timed out'));},30000);
    child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);if(code)reject(new Error(`Packaged document worker failed: ${diagnostic}`));});
    child.once('message',message=>{clearTimeout(timer);child.kill();message.ok?resolve(message.result):reject(new Error(message.error));});child.send({job,bytes});
  });
  for(const [name,content] of [['测试.docx',{paragraphs:[{text:'随包文档验证'}]}],['测试.xlsx',{sheets:[{name:'验证',rows:[['随包文档验证']]}]}]]){
    const generated=await documentJob({action:'write',name,content});
    const read=await documentJob({action:'read',name},generated.bytes);
    if(!JSON.stringify(read).includes('随包文档验证'))throw new Error('Packaged document roundtrip lost Chinese content');
  }
  service = spawn(node, [join(runtime, 'server.mjs')], { cwd: stage, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  service.stdin.on('error', () => {});
  let stderr = ''; service.stderr.on('data', b => { stderr = (stderr + b).slice(-4000); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Standalone runtime startup timeout: ${stderr}`)), 45000);
    service.once('error', reject);
    service.once('exit', code => { clearTimeout(timer); reject(new Error(`Standalone service exited ${code}: ${stderr}`)); });
    service.stdout.on('data', b => { if (b.toString().includes('service ready')) { clearTimeout(timer); resolve(); } });
  });
  const cli = spawn(node, [join(runtime, 'cli.mjs'), 'status'], { cwd: stage, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = ''; cli.stdout.on('data', b => { output += b; }); cli.stderr.on('data', b => { stderr += b; });
  await new Promise((resolve, reject) => { cli.once('error', reject); cli.once('exit', code => code === 0 ? resolve() : reject(new Error(`Standalone CLI failed: ${stderr}`))); });
  JSON.parse(output);
  const exit = new Promise(resolve => service.once('exit', resolve));
  service.stdin.end();
  const code = await exit;
  if (code !== 0) throw new Error(`Standalone shutdown failed (${code})`);
  console.log('Standalone Windows runtime and authenticated IPC smoke passed.');
} finally {
  if (service && service.exitCode === null) {
    service.kill();
    await new Promise(resolve => service.once('exit', resolve));
  }
  rmSync(stage, { recursive: true, force: true });
}
