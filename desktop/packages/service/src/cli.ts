import { parseArgs } from 'node:util';
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ServiceClient } from '../../../apps/desktop/src/service-client.js';
import { computerName } from './platform.js';

async function password(): Promise<string> {
  if (!stdin.isTTY) throw new Error('登录需要交互终端，以隐藏输入密码');
  stdout.write('密码：'); emitKeypressEvents(stdin); stdin.setRawMode(true); stdin.resume();
  return new Promise((resolve,reject) => {
    let value = '';
    const finish = (error?: Error) => {
      stdin.off('keypress',key); stdin.setRawMode(false); stdin.pause(); stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const key = (text: string | undefined, event: {name?:string;ctrl?:boolean;meta?:boolean}) => {
      if (event.ctrl && event.name === 'c') return finish(new Error('已取消登录'));
      if (event.name === 'return' || event.name === 'enter') return finish();
      if (event.name === 'backspace') value = Array.from(value).slice(0,-1).join('');
      else if (text && !event.ctrl && !event.meta && !text.includes('\u001b')) value += text;
    };
    stdin.on('keypress',key);
  });
}

async function main() {
  const {positionals,values} = parseArgs({allowPositionals:true,options:{server:{type:'string'},username:{type:'string'},label:{type:'string'},help:{type:'boolean'}}});
  const command = positionals[0];
  if (values.help || !command) {
    console.log('Pi Bot\n  pi-bot serve\n  pi-bot login --server https://bot.example.com --username USER [--label NAME]\n  pi-bot status\n  pi-bot logout\n\n先运行 serve 或启动 pi-bot 用户级 systemd 服务，再登录。');
    return;
  }
  if (positionals.length !== 1 || !['serve','login','status','logout'].includes(command)) throw new Error('未知命令，请运行 pi-bot --help');
  if (command === 'serve') { await import('./server.js'); return; }
  let ready!: () => void;
  const connected = new Promise<void>(resolve => { ready = resolve; });
  const client = new ServiceClient(event => { if (event.type === 'service.status' && event.connected) ready(); });
  client.start();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([connected,new Promise<never>((_,reject) => { timer=setTimeout(()=>reject(new Error('本地服务未启动，请先运行 pi-bot serve 或 systemctl --user start pi-bot')),5000); })]);
    clearTimeout(timer);
    if (command === 'login') {
      const prompt = createInterface({input:stdin,output:stdout});
      let serverUrl: string, username: string;
      try { serverUrl=values.server || await prompt.question('服务器地址：'); username=values.username || await prompt.question('用户名：'); }
      finally { prompt.close(); }
      await client.call('login',{serverUrl,username,password:await password(),label:values.label || computerName()});
      console.log('已登录并绑定这台执行电脑。');
    } else if (command === 'logout') {
      await client.call('logout',{}); console.log('已退出登录并解绑这台执行电脑，资料库文件保留。');
    } else console.log(JSON.stringify(await client.call('status',{}),null,2));
  } finally { clearTimeout(timer); client.stop(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : '操作失败'); process.exitCode=1; });
