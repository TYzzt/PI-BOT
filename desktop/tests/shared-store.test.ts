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
