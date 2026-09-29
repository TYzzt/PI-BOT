import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {Store} from '../packages/service/src/store.js';
import {temp} from './helpers.js';
test('remote receipt and stable user ID commit atomically; restart interrupts without losing sync revisions',()=>{
 const dir=temp(),path=join(dir.path,'app.sqlite');let s=new Store(path);
 try{
  const model=randomUUID();s.putModel({id:model,name:'test',baseUrl:'http://localhost/v1',modelId:'test',contextWindow:32000,maxTokens:4096,isDefault:true,hasKey:true});
  const c=s.createConversation(model),request=randomUUID(),messageId=randomUUID();
  s.db.prepare('INSERT INTO shared_state VALUES(?,?,?)').run('run',request,JSON.stringify({starting:true,messageId}));
  const run=s.start(c.id,'remote question',request);assert.equal(s.messages(c.id)[0].id,messageId);
  const mapped=JSON.parse((s.db.prepare("SELECT data FROM shared_state WHERE kind='run'").get() as any).data);assert.equal(mapped.localRunId,run.run.id);assert.equal(mapped.starting,false);
  s.updateMessage(run.assistantId,'partial reply','running');const before=(s.db.prepare('SELECT revision FROM shared_dirty WHERE id=?').get(run.assistantId) as any).revision;
  s.close();s=new Store(path);assert.equal(s.run(run.run.id).state,'interrupted');assert.equal(s.messages(c.id)[1].content,'partial reply');assert.ok((s.db.prepare('SELECT revision FROM shared_dirty WHERE id=?').get(run.assistantId) as any).revision>before);
  assert.equal(s.existing(request,c.id,'remote question')?.id,run.run.id);
  s.db.prepare('INSERT INTO shared_state VALUES(?,?,?)').run('model',model,JSON.stringify({applying:2}));assert.throws(()=>s.assertModelReady(model),/尚未完整应用/);assert.doesNotThrow(()=>s.assertModelReady(randomUUID()));
 }finally{s.close();dir.cleanup();}
});

test('v4 opt-outs migrate once, including pending uploads; new offline conversations always sync',()=>{
 const dir=temp(),path=join(dir.path,'app.sqlite');let s=new Store(path);
 try{
  const model=randomUUID();s.putModel({id:model,name:'test',baseUrl:'http://localhost/v1',modelId:'test',contextWindow:32000,maxTokens:4096,isDefault:true,hasKey:true});
  const c=s.createConversation(model,false);assert.equal(c.shared,1);
  s.db.prepare('UPDATE conversations SET shared=0 WHERE id=?').run(c.id);
  s.db.prepare('INSERT INTO shared_state VALUES(?,?,?)').run('conversation',c.id,JSON.stringify({version:7,pending:{body:{shared:false}},fingerprint:'old'}));
  s.db.exec('PRAGMA user_version=4');s.close();s=new Store(path);
  assert.equal(s.conversation(c.id).shared,1);
  const state=JSON.parse((s.db.prepare("SELECT data FROM shared_state WHERE kind='conversation' AND id=?").get(c.id) as any).data);
  assert.equal(state.version,7);assert.equal(state.pending,undefined);assert.equal(state.fingerprint,undefined);
  s.close();s=new Store(path);assert.equal(s.conversations().length,1);assert.equal(s.conversation(c.id).shared,1);
 }finally{s.close();dir.cleanup();}
});

test('sync waits for project and model dependencies while healthy conversations continue',async()=>{
 const {SharedSync}=await import('../packages/service/src/cloud/shared.js');
 const {MemoryCredentials}=await import('./helpers.js');
 const dir=temp(),s=new Store(join(dir.path,'app.sqlite')),keys=new MemoryCredentials();
 const good=randomUUID(),bad=randomUUID(),project=randomUUID();
 for(const id of [bad,good])s.putModel({id,name:'test',baseUrl:'http://localhost/v1',modelId:'test',contextWindow:32000,maxTokens:4096,isDefault:id===good,hasKey:true});
 await keys.set(good,'fixture');
 const broken=s.createConversation(bad),ordinary=s.createConversation(good),code=s.createConversation(good);
 s.db.prepare("UPDATE conversations SET kind='coding',projectId=? WHERE id=?").run(project,code.id);
 const sent:any[]=[];let registered=false;
 const cloud:any={connected:true,db:{link:()=>({deviceId:'device'}),project:()=>registered?{enabled:true,cloudProjectId:'cloud-project'}:null,task:()=>null},request:async(method:string,path:string,body:any)=>{
  if(path==='/device/shared/snapshot')return {documents:[],tasks:[]};
  if(path.includes('/changes?'))return {changes:[],next_cursor:0,has_more:false};
  if(method==='PUT'&&path.includes('/conversations/'))sent.push(body);
  return {version:1,share_version:1};
 }};
 const sync=new SharedSync({store:s,keys,cloud,coding:{db:{byConversation:()=>null}} as any,busy:()=>false,serial:async fn=>fn(),call:async()=>{},emit:()=>{}});
 await sync.stop();
 try{
  await (sync as any).sync();
  assert.equal(sent.length,1);assert.equal(sent[0].project_id,null);
  assert.ok(sync.status().conversations.find(c=>c.id===broken.id)?.error);
  assert.ok(sync.status().conversations.find(c=>c.id===code.id)?.error);
  assert.ok(sync.status().conversations.find(c=>c.id===ordinary.id)?.syncedAt);
  registered=true;await keys.set(bad,'fixture');await (sync as any).sync();
  assert.equal(sent.length,3);assert.ok(sent.some(body=>body.project_id==='cloud-project'));
  assert.ok(sync.status().conversations.every(c=>c.syncedAt&&!c.error));
 }finally{s.close();dir.cleanup();}
});
