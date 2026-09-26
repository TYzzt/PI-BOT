import {test,expect,_electron as electron,type ElectronApplication} from '@playwright/test';
import {spawn,type ChildProcess} from 'node:child_process';
import {resolve} from 'node:path';
import {temp,endpoint} from './helpers.js';
import {Keychain} from '../packages/service/src/keychain.js';
const url=process.env.T_AGNET_SHARED_URL;
test('Mac UI pairs, shares old history, shows model sync and opts new chats out',async()=>{
 test.skip(!url,'需要隔离云端服务');const dir=temp(),api=await endpoint();let app:ElectronApplication|undefined,service:ChildProcess|undefined,modelId='',deviceId='';
 const env={...process.env,T_AGNET_DATA_DIR:dir.path,T_AGNET_KEYCHAIN_HELPER:resolve('native/dist/keychain')};
 try{
  service=spawn(resolve('node_modules/node/bin/node'),['packages/service/dist/server.mjs'],{env,stdio:'ignore'});
  app=await electron.launch({executablePath:resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[resolve('apps/desktop')],env});const page=await app.firstWindow();
  await expect(page.getByText('本地服务已连接',{exact:true})).toBeVisible();
  const seeded=await page.evaluate(async baseUrl=>{const m=await window.agent.call('modelSave',{name:'同步 UI 模型',baseUrl,modelId:'fixture',apiKey:'ui-shared-secret',contextWindow:32000,maxTokens:4096});const c=await window.agent.call('conversationCreate',{modelConfigId:m.id});await window.agent.call('conversationRename',{id:c.id,title:'待共享的历史'});return {model:m.id,conversation:c.id};},api.url);modelId=seeded.model;
  await page.getByRole('button',{name:'模型设置'}).click();await page.getByLabel('服务器地址',{exact:true}).fill(url!);await page.getByLabel('设备名称',{exact:true}).fill('UI Mac');await page.getByLabel('管理员密码',{exact:true}).fill(process.env.T_AGNET_SHARED_PASSWORD!);await page.getByRole('button',{name:'配对设备',exact:true}).click();
  await expect(page.getByText('已连接云端',{exact:true})).toBeVisible({timeout:15000});await expect(page.getByText(/云端 v1 · 本机已应用 v1/)).toBeVisible({timeout:15000});
  const paired=await page.evaluate(()=>window.agent.call('cloudStatus',{}));deviceId=paired.deviceId!;
  await page.getByText('选择历史会话共享',{exact:true}).click();await page.getByLabel('待共享的历史',{exact:true}).check();await page.getByRole('button',{name:'共享所选历史'}).click();
  await page.getByRole('button',{name:'待共享的历史'}).click();await expect(page.getByLabel('共享会话',{exact:true})).toBeChecked();await expect(page.getByText(/已同步/).first()).toBeVisible({timeout:15000});
  await page.getByLabel('新会话仅本机').check();await page.getByRole('button',{name:'＋ 新建会话'}).click();await expect(page.getByLabel('共享会话',{exact:true})).not.toBeChecked();
  await page.screenshot({path:'work/shared-desktop.png',animations:'disabled'});
  await page.getByRole('button',{name:'模型设置'}).click();page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'解除配对',exact:true}).click();await expect(page.getByRole('button',{name:'配对设备',exact:true})).toBeVisible();
 }finally{await app?.close();if(service&&service.exitCode===null){const exit=new Promise(r=>service!.once('exit',r));service.kill('SIGTERM');await exit;}if(modelId)await new Keychain(resolve('native/dist/keychain')).delete(modelId);await api.close();dir.cleanup();}
});
