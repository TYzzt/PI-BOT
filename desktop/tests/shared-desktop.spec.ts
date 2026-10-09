import {test,expect,_electron as electron,type ElectronApplication} from '@playwright/test';
import {spawn,type ChildProcess} from 'node:child_process';
import {resolve} from 'node:path';
import {temp,endpoint} from './helpers.js';
const url=process.env.T_AGNET_SHARED_URL;
test('Mac UI pairs and automatically syncs existing and new conversations',async()=>{
 test.skip(!url,'需要隔离云端服务');const dir=temp(),api=await endpoint();let app:ElectronApplication|undefined,service:ChildProcess|undefined,modelId='',deviceId='';
 const env={...process.env,T_AGNET_DATA_DIR:dir.path};
 try{
  service=spawn(resolve('node_modules/node/bin/node'),['packages/service/dist/server.mjs'],{env,stdio:'ignore'});
  app=await electron.launch({executablePath:resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[resolve('apps/desktop')],env});const page=await app.firstWindow();
  await expect(page.getByRole('button',{name:'连接',exact:true})).toBeVisible();
  const seeded=await page.evaluate(async baseUrl=>{const m=await window.agent.call('modelSave',{name:'同步 UI 模型',baseUrl,modelId:'fixture',apiKey:'ui-shared-secret',contextWindow:32000,maxTokens:4096});const c=await window.agent.call('conversationCreate',{modelConfigId:m.id});await window.agent.call('conversationRename',{id:c.id,title:'待共享的历史'});await window.agent.call('messageSend',{conversationId:c.id,text:'记住蓝鲸',requestId:crypto.randomUUID()});return {model:m.id,conversation:c.id};},api.url);modelId=seeded.model;
  await expect.poll(async()=>!(await page.evaluate(()=>window.agent.call('snapshot',{}))).activeRun).toBe(true);
  await page.getByLabel('管理员密码',{exact:true}).fill(process.env.T_AGNET_SHARED_PASSWORD!);await page.getByRole('button',{name:'连接',exact:true}).click();
  await expect(page.getByText('已连接云端 · 自动同步')).toBeVisible({timeout:15000});
  await page.getByRole('button',{name:'设置'}).click();await expect(page.getByText(/云端 v1 · 本机已应用 v1/)).toBeVisible({timeout:15000});
  const paired=await page.evaluate(()=>window.agent.call('cloudStatus',{}));deviceId=paired.deviceId!;
  await page.getByRole('button',{name:'待共享的历史'}).click();await expect(page.getByLabel('共享会话',{exact:true})).toHaveCount(0);await expect(page.getByText(/已同步/).first()).toBeVisible({timeout:15000});
  await page.getByRole('button',{name:'新对话',exact:true}).click();await expect(page.getByLabel('新会话仅本机')).toHaveCount(0);await expect(page.getByText(/已同步/).first()).toBeVisible({timeout:15000});
  await page.evaluate(async id=>{const model=await window.agent.call('cloudModelFromLocal',{modelId:id,requestId:crypto.randomUUID()});await window.agent.call('cloudChatCreate',{id:crypto.randomUUID(),modelId:model.id,title:'云端问答'});},modelId);
  await expect(page.getByRole('navigation',{name:'问答',exact:true}).getByRole('button',{name:'云端问答',exact:true})).toBeVisible();
  await expect(page.locator('.cloud-chat-list')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'转到云端继续'})).toHaveCount(0);
  await page.getByRole('button',{name:'云端问答',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({path:'work/shared-desktop.png',animations:'disabled'});
  await page.getByRole('button',{name:'设置'}).click();page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'解除配对',exact:true}).click();await expect(page.getByRole('button',{name:'连接',exact:true})).toBeVisible();
 }finally{await app?.close();if(service&&service.exitCode===null){const exit=new Promise(r=>service!.once('exit',r));service.kill('SIGTERM');await exit;}await api.close();dir.cleanup();}
});
