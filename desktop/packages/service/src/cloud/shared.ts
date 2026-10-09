import { randomUUID, createHash } from 'node:crypto';
import type { Store } from '../store.js';
import type { Credentials } from '../keychain.js';
import type { CodingController } from '../coding/controller.js';
import type { CloudSync } from './sync.js';
import type { ModelConfig, Run, SharedStatus, AppEvent } from '../../../protocol/src/index.js';
import { CloudHttpError } from './client.js';
interface Host { store: Store; keys: Credentials; cloud: CloudSync; coding: CodingController; busy(): boolean; serial<T>(fn:()=>Promise<T>):Promise<T>; call(method:string,input:any):Promise<any>; emit(e:AppEvent):void; }
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fields=(m:ModelConfig)=>({name:m.name,base_url:m.baseUrl,model_id:m.modelId,context_window:m.contextWindow,max_tokens:m.maxTokens,is_default:m.isDefault});
const terminal=(s:string)=>['completed','cancelled','failed','interrupted'].includes(s);
export class SharedSync {
  private timer?:NodeJS.Timeout; private stopped=false; private running=false; private pendingTick?: Promise<void>; private error?:string;
  constructor(private h:Host){this.timer=setTimeout(()=>void this.tick(),1000);}
  async stop(){this.stopped=true;clearTimeout(this.timer);await this.pendingTick?.catch(()=>{});}
  private get db(){return this.h.store.db;}
  private get(kind:string,id:string):any{return JSON.parse((this.db.prepare('SELECT data FROM shared_state WHERE kind=? AND id=?').get(kind,id) as any)?.data??'null');}
  private put(kind:string,id:string,data:any){this.db.prepare('INSERT INTO shared_state VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind,id,JSON.stringify(data));}
  private all(kind:string):any[]{return (this.db.prepare('SELECT id,data FROM shared_state WHERE kind=?').all(kind) as any[]).map(r=>({id:r.id,...JSON.parse(r.data)}));}
  status():SharedStatus{return {deviceLabel:this.h.cloud.db.link()?.label,connected:this.h.cloud.connected,runs:this.all('remote').filter(r=>r.kind==='chat_run'&&r.document).map(r=>({id:r.id,conversationId:r.document.conversation_id,state:r.document.state,cancelRequested:r.document.cancel_requested})),models:this.all('model').map(m=>({id:m.id,version:m.conflict?.version??this.get('remote',m.id)?.document?.version??m.version??0,applied:m.applied??0,error:m.error,conflict:!!m.conflict})),conversations:this.h.store.conversations().map(c=>({id:c.id,shared:!!c.shared,version:this.get('conversation',c.id)?.version??0,error:this.get('conversation',c.id)?.error,syncedAt:this.get('conversation',c.id)?.syncedAt})),error:this.error};}
  applying(){return this.all('model').some(m=>!!m.applying);}
  async reset(){for(const m of this.all('model'))if(m.pending?.keyRef)await this.h.keys.delete(m.pending.keyRef);this.db.exec('DELETE FROM shared_state; UPDATE conversations SET shared=1;');}
  async share(ids:string[],_shared:boolean){for(const id of ids){this.h.store.conversation(id);this.db.prepare('UPDATE conversations SET shared=? WHERE id=?').run(1,id);}this.h.emit({type:'state.changed'});}
  async resolve(id:string,choice:'remote'|'local'){
    const m=this.get('model',id);if(!m?.conflict)throw new Error('没有待解决的配置冲突');
    if(choice==='remote'){if(this.h.busy())throw new Error('请等待当前运行结束');await this.applyModel(m.conflict);}
    else{if(m.pending?.keyRef)await this.h.keys.delete(m.pending.keyRef);this.put('model',id,{...m,version:m.conflict.version,pending:null,conflict:null,error:undefined,fingerprint:null});}
  }
  async beforeDeleteConversation(id:string){
    const m=this.get('conversation',id);if(!m?.version)return;
    if(!this.h.cloud.connected)throw new Error('共享会话全端删除需要连接云端');
    const c=this.h.store.conversation(id);const body=this.conversationBody(c,m);body.deleted=true;
    await this.h.cloud.request('PUT',`/device/conversations/${id}`,body);
    this.put('conversation',id,{...m,deleted:true});
  }
  async beforeDeleteModel(id:string,replacementId?:string){
    const m=this.get('model',id);if(m?.pending||m?.conflict)throw new Error('请先完成模型同步或解决版本冲突，再删除配置');
    if(m?.remoteDeleted||!m?.version)return;
    if(!this.h.cloud.connected)throw new Error('已同步模型删除需要连接云端');
    const pending=m.deletePending??{expected_version:m.version,request_id:randomUUID(),replacement_id:replacementId??null};
    this.put('model',id,{...m,deletePending:pending});
    try{const r=await this.h.cloud.request<any>('POST',`/device/configs/models/${id}/delete`,pending);this.put('model',id,{version:r.version,remoteDeleted:true});}
    catch(e){if(e instanceof CloudHttpError&&e.status<500)this.put('model',id,{...m,deletePending:null});throw e;}
  }
  private async tick(){
    if(this.stopped||this.running)return;this.running=true;
    try{if(this.h.cloud.db.link()&&this.h.cloud.connected){this.pendingTick=this.h.serial(()=>this.sync());await this.pendingTick;}}catch(e){this.error=e instanceof CloudHttpError?`同步被拒绝（${e.status}）`:e instanceof Error&&e.message.includes('凭据')?'本机凭据不可用':'共享同步暂时失败，将自动重试';}
    finally{this.running=false;this.h.emit({type:'cloud.changed'});if(!this.stopped)this.timer=setTimeout(()=>void this.tick(),1000);}
  }
  private async sync(){
    // Local records are flushed before executing remotely queued work.
    this.error=undefined;
    await this.h.cloud.request('POST','/device/shared/enable');
    const snapshot=await this.h.cloud.request<any>('GET','/device/shared/snapshot');
    const remoteModels=snapshot.documents.filter((d:any)=>d.entity_kind==='model');
    for(const m of this.all('model'))if(m.deletePending){
      try{const r=await this.h.cloud.request<any>('POST',`/device/configs/models/${m.id}/delete`,m.deletePending);this.put('model',m.id,{...m,deletePending:null,remoteDeleted:true});if(!this.h.busy())await this.applyModel(r);}
      catch(e){if(e instanceof CloudHttpError&&e.status<500)this.put('model',m.id,{...m,deletePending:null,error:'删除未生效，请刷新配置后重试'});else throw e;}
    }
    for(const m of this.h.store.models()){
      try{await this.syncModel(m,remoteModels.find((r:any)=>r.id===m.id));}
      catch{const state=this.get('model',m.id)??{};this.put('model',m.id,{...state,error:'模型配置待同步，请检查连接和本机凭据'});}
    }
    for(const r of remoteModels)if(!this.h.store.models().some(m=>m.id===r.id)&&!this.h.busy()&&(!r.deleted||r.apply_state!=='applied'))await this.applyModel(r);
    for(const t of snapshot.tasks){const link=this.h.cloud.db.taskByCloud(t.id);if(link&&['rejected','cancelled'].includes(t.state)&&this.h.coding.active?.task.id!==link.taskId){const task=this.h.coding.db.task(link.taskId);if(task.state!==t.state){this.h.coding.db.putTask({...task,state:t.state,message:t.state==='rejected'?'计划已在云端拒绝':'任务已在云端取消'});this.h.emit({type:'state.changed'});}}}
    for(const r of snapshot.documents.filter((d:any)=>d.entity_kind==='conversation'&&!d.deleted&&d.shared)){
      if(this.h.store.conversations().some(c=>c.id===r.id)||!this.h.store.models().some(m=>m.id===r.model_config_id))continue;
      const project=r.kind==='read_code'?this.h.cloud.db.projectByCloud(r.project_id):null;if(r.kind==='read_code'&&!project?.enabled)continue;
      this.h.store.transaction(()=>{
        this.h.store.createConversation(r.model_config_id,true,r.id);this.h.store.rename(r.id,r.title);
        if(project){this.db.prepare("UPDATE conversations SET kind='coding',projectId=? WHERE id=?").run(project.projectId,r.id);this.h.coding.db.putTask({id:randomUUID(),conversationId:r.id,projectId:project.projectId,requirement:r.title,planModelId:r.model_config_id,executeModelId:r.model_config_id,intent:'read',state:'completed',latestPlanId:null,activeRunId:null,message:'可以直接提问代码问题',createdAt:Date.now()});}
        this.put('conversation',r.id,{version:r.version,shareVersion:r.share_version});
      });this.h.emit({type:'state.changed'});
    }
    for(const c of this.h.store.conversations()){
      try{await this.syncConversation(c,snapshot.documents.find((r:any)=>r.entity_kind==='conversation'&&r.id===c.id));}catch{const m=this.get('conversation',c.id)??{};this.put('conversation',c.id,{...m,error:'会话待同步，连接恢复后自动重试'});}
    }
    const pending=snapshot.documents.filter((r:any)=>r.entity_kind==='chat_run'&&!terminal(r.state));
    // Process cancellation even when another request owns the global model slot.
    for(const r of pending)if(r.cancel_requested)await this.remote(r,snapshot.documents);
    if(!this.h.busy())for(const r of pending.filter((r:any)=>!r.cancel_requested)){await this.remote(r,snapshot.documents);if(this.h.busy())break;}
    for(const r of this.all('run'))if(r.localRunId){const run=this.h.store.run(r.localRunId);if(terminal(run.state)&&!r.reported&&(!this.h.store.conversation(run.conversationId).shared||this.h.store.messages(run.conversationId).filter(m=>m.runId===run.id).every(m=>(this.get('message',m.id)?.revision??0)>=((this.db.prepare('SELECT revision FROM shared_dirty WHERE id=?').get(m.id) as any)?.revision??1)))){await this.h.cloud.request('POST',`/device/chat-runs/${r.id}/result`,{state:run.state,local_run_id:run.id});this.put('run',r.id,{...r,reported:true});}}
    await this.pull();
  }
  private async syncModel(m:ModelConfig,remote:any){
    let state=this.get('model',m.id)??{version:0};if(state.deleted)return;
    const fingerprint=hash({...fields(m),revision:m.revision??0});
    if(state.conflict)return;
    if(state.pending){await this.sendModel(m.id,state);return;}
    if(remote&&remote.version>(state.version??0)){
      if(state.fingerprint&&state.fingerprint!==fingerprint){this.put('model',m.id,{...state,conflict:remote,error:'配置版本冲突：请选择云端版本或重新提交本地版本'});return;}
      if(!this.h.busy())await this.applyModel(remote);return;
    }
    if(state.fingerprint===fingerprint){if(state.error)this.put('model',m.id,{...state,error:undefined});if(remote&&remote.apply_state!=='applied'&&state.applied===remote.version)await this.h.cloud.request('POST',`/device/configs/models/${m.id}/applied`,{version:remote.version,state:'applied'});return;}
    const key=await this.h.keys.get(m.id);if(!key)throw new Error('本机缺少模型密钥');
    const keyRef=randomUUID();await this.h.keys.set(keyRef,key);
    state={...state,pending:{keyRef,fingerprint,body:{device_id:this.h.cloud.db.link()!.deviceId,config:fields(m),expected_version:state.version??0,request_id:randomUUID()}}};this.put('model',m.id,state);
    await this.sendModel(m.id,state);
  }
  private async sendModel(id:string,state:any){
    const p=state.pending,key=await this.h.keys.get(p.keyRef);if(!key)throw new Error('待上传的模型密钥已丢失，请重新保存');
    try{const r=await this.h.cloud.request<any>('PUT',`/device/configs/models/${id}`,{...p.body,api_key:key});
      this.put('model',id,{version:r.version,applied:r.version,fingerprint:p.fingerprint});await this.h.keys.delete(p.keyRef);
      await this.h.cloud.request('POST',`/device/configs/models/${id}/applied`,{version:r.version,state:'applied'});
    }catch(e){if(e instanceof CloudHttpError&&e.status===409){const snap=await this.h.cloud.request<any>('GET','/device/shared/snapshot');this.put('model',id,{...state,pending:null,conflict:snap.documents.find((r:any)=>r.id===id),error:'配置版本冲突'});await this.h.keys.delete(p.keyRef);return;}throw e;}
  }
  private async applyModel(r:any){
    try{
      if(r.deleted){if(this.h.store.models().some(m=>m.id===r.id)){await this.h.call('modelDelete',{id:r.id,replacementId:r.replacement_id??undefined});}this.put('model',r.id,{version:r.version,applied:r.version,deleted:true});}
      else{
        this.put('model',r.id,{...(this.get('model',r.id)??{}),applying:r.version});
        const k=await this.h.cloud.request<any>('GET',`/device/configs/models/${r.id}/credential?version=${r.version}`);
        // The local secret file is written before SQLite: a failed write cannot acknowledge an applied revision.
        await this.h.keys.set(r.id,k.api_key);
        const c=r.config,old=this.h.store.models().find(m=>m.id===r.id);
        const m:ModelConfig={id:r.id,name:c.name,baseUrl:c.base_url,modelId:c.model_id,contextWindow:c.context_window,maxTokens:c.max_tokens,isDefault:c.is_default,hasKey:true,revision:(old?.revision??0)+1};
        this.h.store.putModel(m);this.put('model',r.id,{version:r.version,applied:r.version,fingerprint:hash({...fields(m),revision:m.revision})});
      }
      await this.h.cloud.request('POST',`/device/configs/models/${r.id}/applied`,{version:r.version,state:'applied'});this.h.emit({type:'state.changed'});
    }catch{this.put('model',r.id,{...(this.get('model',r.id)??{}),remoteDeleted:!!r.deleted,error:'模型应用失败，请检查本机凭据或配置引用'});await this.h.cloud.request('POST',`/device/configs/models/${r.id}/applied`,{version:r.version,state:'failed',error:r.deleted?'referenced':'credential_failed'});}
  }
  private conversationBody(c:any,state:any,remote?:any){
    const task=c.kind==='coding'?this.h.coding.db.byConversation(c.id):null;
    const linked=task?this.h.cloud.db.task(task.id)?.cloudTaskId??null:null;
    // Keep a phone-created plan link until this Mac has bound the local task.
    return {device_id:this.h.cloud.db.link()!.deviceId,title:c.title,kind:c.kind==='coding'?'read_code':'ask',project_id:c.projectId?this.h.cloud.db.project(c.projectId)?.cloudProjectId??null:null,model_config_id:c.modelConfigId,shared:!!c.shared,deleted:false,task_id:linked??remote?.task_id??null,expected_version:state.version??0,request_id:randomUUID()};
  }
  private async syncConversation(c:any,remote:any){
    let state=this.get('conversation',c.id)??{version:0};if(state.deleted)return;
    if(remote?.deleted){if(this.h.busy())return;await this.h.call('conversationDelete',{id:c.id});this.put('conversation',c.id,{...state,deleted:true});return;}
    if(remote&&remote.version>state.version&&!state.pending){this.db.prepare('UPDATE conversations SET title=?,shared=?,modelConfigId=? WHERE id=?').run(remote.title,1,remote.model_config_id,c.id);c=this.h.store.conversation(c.id);state={...state,version:remote.version,shareVersion:remote.share_version};this.put('conversation',c.id,state);}
    if(!c.shared&&!state.version)return;
    if(c.projectId&&!this.h.cloud.db.project(c.projectId)?.enabled)throw new Error('等待项目同步');
    const modelState=this.get('model',c.modelConfigId);
    if(!modelState?.version||modelState.pending||modelState.applying||modelState.conflict||modelState.error)throw new Error('等待模型同步');
    const messages=this.h.store.messages(c.id);if(!state.version&&messages.some(m=>m.status==='running'))return;
    const body=this.conversationBody(c,state,remote),fingerprint=hash({...body,expected_version:0,request_id:''});
    if(state.fingerprint!==fingerprint){
      if(!state.pending){state={...state,pending:{body,fingerprint}};this.put('conversation',c.id,state);}
      let r:any;
      try{r=await this.h.cloud.request<any>('PUT',`/device/conversations/${c.id}`,state.pending.body);}
      catch(e){if(e instanceof CloudHttpError&&e.status===409)this.put('conversation',c.id,{...state,pending:null,fingerprint:null});throw e;}
      state={version:r.version,shareVersion:r.share_version,fingerprint:state.pending.fingerprint,syncedAt:Date.now()};this.put('conversation',c.id,state);
    }
    if(!c.shared)return;
    for(let i=0;i<messages.length;i++){
      const m=messages[i],dirty=this.db.prepare('SELECT revision FROM shared_dirty WHERE id=?').get(m.id) as any;
      const rev=dirty?.revision??1;if(this.get('message',m.id)?.revision>=rev)continue;
      const runMap=this.all('run').find(r=>r.localRunId===m.runId);
      await this.h.cloud.request('POST',`/device/conversations/${c.id}/messages`,{share_version:state.shareVersion,messages:[{id:m.role==='user'&&runMap?runMap.messageId:m.id,run_id:runMap?.id??m.runId,role:m.role,content:m.content,status:m.status,revision:rev,sequence:i+1}]});
      this.put('message',m.id,{revision:rev});
    }
    this.put('conversation',c.id,{...state,syncedAt:Date.now(),error:undefined});
  }
  private async remote(r:any,documents:any[]){
    let mapping=this.get('run',r.id);
    if(mapping?.localRunId){const local=this.h.store.run(mapping.localRunId);if(r.cancel_requested&&!terminal(local.state))await this.h.call('runCancel',{id:local.id});return;}
    const c=documents.find(d=>d.entity_kind==='conversation'&&d.id===r.conversation_id);
    if(!c)return;
    try{const ack=await this.h.cloud.request<any>('POST',`/device/chat-runs/${r.id}/ack`);if(terminal(ack.state))return;if(ack.cancel_requested)r={...r,cancel_requested:true};}catch(e){if(e instanceof CloudHttpError&&e.status===409)return;throw e;}
    if(r.cancel_requested){await this.h.cloud.request('POST',`/device/chat-runs/${r.id}/result`,{state:'cancelled'});return;}
    if(this.h.busy())return;
    const modelState=this.get('model',c.model_config_id);const desired=documents.find(d=>d.entity_kind==='model'&&d.id===c.model_config_id);
    if(!modelState||modelState.conflict||modelState.pending||modelState.deleted||modelState.applied<(desired?.version??0))return;
    const local=this.h.store.conversations().find(x=>x.id===c.id);
    if(local&&!local.shared){await this.h.cloud.request('POST',`/device/chat-runs/${r.id}/result`,{state:'cancelled'});return;}
    if(c.kind==='read_code'&&!this.h.cloud.db.projectByCloud(c.project_id)?.enabled){await this.h.cloud.request('POST',`/device/chat-runs/${r.id}/result`,{state:'failed'});return;}
    if(r.state==='running'){await this.h.cloud.request('POST',`/device/chat-runs/${r.id}/result`,{state:'interrupted'});return;}
    this.put('run',r.id,{starting:true,messageId:r.message_id});
    try{
      let run:Run;
      if(c.kind==='ask'){
        if(!local)this.h.store.createConversation(c.model_config_id,true,c.id);
        run=await this.h.call('messageSend',{conversationId:c.id,text:r.text,requestId:r.id});
      }else if(!local){
        const p=this.h.cloud.db.projectByCloud(c.project_id);if(!p?.enabled)throw new Error('项目未共享');
        const task=await this.h.coding.dispatch('codingCreate',{conversationId:c.id,intent:'read',shared:true,projectId:p.projectId,requirement:r.text,planModelId:c.model_config_id,executeModelId:c.model_config_id,requestId:r.id},true) as any;
        run=this.h.store.run(task.activeRunId);
      }else{const task=this.h.coding.db.byConversation(c.id);run=await this.h.call('codingRead',{taskId:task.id,text:r.text,modelId:c.model_config_id,requestId:r.id});}
      this.put('run',r.id,{localRunId:run.id,messageId:r.message_id});await this.h.cloud.request('POST',`/device/chat-runs/${r.id}/result`,{state:'running',local_run_id:run.id});
    }catch(e){if(this.get('run',r.id)?.localRunId)throw e;await this.h.cloud.request('POST',`/device/chat-runs/${r.id}/result`,{state:'failed'});}
  }
  private async pull(){
    let after=this.get('cursor','device')?.after??0;
    for(;;){const page=await this.h.cloud.request<any>('GET',`/device/shared/changes?after=${after}&limit=100`);
      this.h.store.transaction(()=>{for(const e of page.changes)this.put('remote',e.id,{kind:e.kind,document:e.document});this.put('cursor','device',{after:page.next_cursor});});after=page.next_cursor;if(!page.has_more)break;}
  }
}
