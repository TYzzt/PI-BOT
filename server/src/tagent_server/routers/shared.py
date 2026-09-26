"""Device-owned conversations and model synchronization, with durable request receipts."""
import hashlib
import uuid
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, Request, Query
from pydantic import BaseModel, ConfigDict, Field, model_validator, AnyHttpUrl
from sqlalchemy import select
from sqlalchemy.orm import Session
from tagent_server.config import utcnow
from tagent_server.deps import get_session, require_device, require_user
from tagent_server.models import Device, User, Project, Task
from tagent_server.sync_models import SharedDocument as Doc, SharedRevision, SharedChange, SharedReceipt
from tagent_server.tasks_service import write_lock, append_event
from tagent_server.vault import Vault
from tagent_server.shared_schemas import ModelPublic, ConversationPublic, ChatRunPublic, MessagePage, ChangePage, CredentialPublic, Ok

router = APIRouter(tags=['shared'])
TERMINAL = {'completed', 'failed', 'cancelled', 'interrupted'}
CAPABILITY = 'shared_v1'
class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid')
class Write(Strict):
    expected_version: int = Field(ge=0)
    request_id: uuid.UUID
class ModelFields(Strict):
    name: str = Field(min_length=1, max_length=80)
    base_url: AnyHttpUrl
    model_id: str = Field(min_length=1, max_length=200)
    context_window: int = Field(ge=1024, le=4000000)
    max_tokens: int = Field(ge=16, le=1000000)
    is_default: bool = False
    @model_validator(mode='after')
    def valid(self):
        u = self.base_url
        if u.username or u.password or u.query or u.fragment or self.max_tokens >= self.context_window:
            raise ValueError('模型配置无效')
        return self
class ModelWrite(Write):
    device_id: uuid.UUID
    config: ModelFields
    api_key: str | None = Field(default=None, min_length=1, max_length=8192, json_schema_extra={'writeOnly': True})
class DeleteModel(Write):
    replacement_id: uuid.UUID | None = None
class Applied(Strict):
    version: int = Field(ge=1)
    state: Literal['applied', 'failed']
    error: Literal['keychain_failed', 'referenced', 'invalid_config'] | None = None
class ConversationWrite(Write):
    device_id: uuid.UUID
    title: str = Field(min_length=1, max_length=120)
    kind: Literal['ask', 'read_code']
    model_config_id: uuid.UUID
    project_id: uuid.UUID | None = None
    shared: bool = True
    deleted: bool = False
    task_id: uuid.UUID | None = None
class MessageWrite(Strict):
    id: uuid.UUID
    run_id: uuid.UUID
    role: Literal['user', 'assistant']
    content: str = Field(max_length=1000000)
    status: Literal['running', 'completed', 'failed', 'cancelled', 'interrupted']
    revision: int = Field(ge=1)
    sequence: int = Field(ge=1)
class Upload(Strict):
    share_version: int = Field(ge=1)
    messages: list[MessageWrite] = Field(max_length=50)
class Send(Strict):
    request_id: uuid.UUID
    text: str = Field(min_length=1, max_length=30000)
class Result(Strict):
    state: Literal['running', 'completed', 'failed', 'cancelled', 'interrupted']
    local_run_id: uuid.UUID | None = None
class Ack(Strict):
    pass

def public(d: Doc):
    return {'id': str(d.id), 'device_id': str(d.device_id), 'version': d.version, **{k: v for k,v in d.data.items() if k not in {'secret'}}}
def load(s, id, kind, device=None):
    d = s.get(Doc,id)
    if not d or d.kind != kind or (device and d.device_id != device.device_id): raise HTTPException(404,'记录不存在')
    return d

def target(s, id):
    d = s.get(Device,id)
    if not d or d.revoked_at or CAPABILITY not in d.capabilities: raise HTTPException(409,'目标设备不可用或需升级')
    return d

def change(s, d):
    s.add(SharedChange(device_id=d.device_id,kind=d.kind,entity_id=d.id,version=d.version))
    append_event(s,type=f'{d.kind}.changed',task_id=None,now=utcnow(),payload={'id':str(d.id),'version':d.version,'device_id':str(d.device_id)})

def receipt(s, key, value):
    digest = hashlib.sha256(value.model_dump_json().encode()).hexdigest()
    r=s.get(SharedReceipt,key)
    if r:
        if r.digest!=digest: raise HTTPException(409,'幂等 ID 内容不一致')
        return digest,r.result
    return digest,None

def save_receipt(s,key,digest,result):
    s.add(SharedReceipt(id=key,digest=digest,result=result)); return result

def check_version(d, version):
    if (d.version if d else 0)!=version: raise HTTPException(409, {'message':'版本冲突','current':public(d) if d else None})
    if d and d.data.get('deleted'): raise HTTPException(410,'记录已删除')

def put_model(s, req, id, p, device=None):
    write_lock(s); target(s,p.device_id)
    if device and p.device_id!=device.device_id: raise HTTPException(403,'无权修改其他设备配置')
    key=f'model:{p.device_id}:{p.request_id}'; digest,old=receipt(s,key,p)
    if old is not None:return old
    d=s.get(Doc,id)
    if d and (d.kind!='model' or d.device_id!=p.device_id):raise HTTPException(403,'配置归属不匹配')
    check_version(d,p.expected_version)
    vault=Vault(req.app.state.settings.sync_key_file)
    version=(d.version if d else 0)+1
    secret=vault.seal(p.api_key,str(id),version) if p.api_key else d.data.get('secret') if d else None
    if not secret:raise HTTPException(422,'新模型必须提供 API Key')
    data={'config':p.config.model_dump(mode='json'),'secret':secret,'has_key':True,'credential_version':secret['version'],'deleted':False,'applied_version':d.data.get('applied_version',0) if d else 0,'apply_state':'pending','apply_error':None}
    if data['config']['is_default']:
        for other in s.scalars(select(Doc).where(Doc.kind=='model',Doc.device_id==p.device_id)).all():
            if other.id!=id and not other.data.get('deleted') and other.data['config']['is_default']:
                other.version+=1;other.data={**other.data,'config':{**other.data['config'],'is_default':False},'apply_state':'pending'}
                s.add(SharedRevision(document_id=other.id,version=other.version,data=other.data));change(s,other)
    if d:d.version=version;d.data=data
    else:d=Doc(id=id,kind='model',device_id=p.device_id,version=version,data=data);s.add(d);s.flush()
    s.add(SharedRevision(document_id=id,version=version,data=data));change(s,d)
    return save_receipt(s,key,digest,public(d))

@router.get('/configs/models', response_model=list[ModelPublic])
def models(user:User=Depends(require_user),s:Session=Depends(get_session)):
    return [public(d) for d in s.scalars(select(Doc).where(Doc.kind=='model')).all()]
@router.put('/configs/models/{id}', response_model=ModelPublic)
def model_put(id:uuid.UUID,p:ModelWrite,request:Request,user:User=Depends(require_user),s:Session=Depends(get_session)):
    return put_model(s,request,id,p)
@router.put('/device/configs/models/{id}', response_model=ModelPublic)
def device_model_put(id:uuid.UUID,p:ModelWrite,request:Request,device:Device=Depends(require_device),s:Session=Depends(get_session)):
    return put_model(s,request,id,p,device)

def delete_model(s,id,p,device=None):
    write_lock(s);d=load(s,id,'model',device);key=f'delete-model:{d.device_id}:{p.request_id}';digest,old=receipt(s,key,p)
    if old is not None:return old
    check_version(d,p.expected_version)
    references=s.scalars(select(Doc).where(Doc.kind=='conversation',Doc.device_id==d.device_id)).all()
    if p.replacement_id:
        replacement=load(s,p.replacement_id,'model')
        if replacement.id==id or replacement.device_id!=d.device_id or replacement.data.get('deleted'):raise HTTPException(409,'替代模型无效')
    if any(c.data['model_config_id']==str(id) and not c.data.get('deleted') for c in references) and not p.replacement_id:raise HTTPException(409,'需选择替代模型')
    d.version+=1;d.data={**d.data,'deleted':True,'replacement_id':str(p.replacement_id) if p.replacement_id else None,'apply_state':'pending'}
    s.add(SharedRevision(document_id=id,version=d.version,data=d.data));change(s,d)
    for c in references:
        if c.data['model_config_id']==str(id) and p.replacement_id:c.data={**c.data,'model_config_id':str(p.replacement_id)};c.version+=1;change(s,c)
    return save_receipt(s,key,digest,public(d))
@router.post('/configs/models/{id}/delete', response_model=ModelPublic)
def model_delete(id:uuid.UUID,p:DeleteModel,user:User=Depends(require_user),s:Session=Depends(get_session)):return delete_model(s,id,p)
@router.post('/device/configs/models/{id}/delete', response_model=ModelPublic)
def device_model_delete(id:uuid.UUID,p:DeleteModel,device:Device=Depends(require_device),s:Session=Depends(get_session)):return delete_model(s,id,p,device)
@router.get('/device/configs/models/{id}/credential', response_model=CredentialPublic)
def credential(id:uuid.UUID,request:Request,version:int,device:Device=Depends(require_device),s:Session=Depends(get_session)):
    d=load(s,id,'model',device)
    if d.version!=version or d.data.get('deleted'):raise HTTPException(409,'配置版本已变化')
    from fastapi.responses import JSONResponse
    return JSONResponse({'api_key':Vault(request.app.state.settings.sync_key_file).open(d.data['secret'],str(id))},headers={'Cache-Control':'no-store'})
@router.post('/device/configs/models/{id}/applied', response_model=ModelPublic)
def applied(id:uuid.UUID,p:Applied,device:Device=Depends(require_device),s:Session=Depends(get_session)):
    write_lock(s);d=load(s,id,'model',device)
    if p.version!=d.version:raise HTTPException(409,'配置版本已变化')
    d.data={**d.data,'apply_state':p.state,'apply_error':p.error,'applied_version':p.version if p.state=='applied' else d.data['applied_version']};change(s,d);return public(d)

def put_conversation(s,id,p,device=None):
    write_lock(s);target(s,p.device_id)
    if device and device.device_id!=p.device_id:raise HTTPException(403,'会话归属不匹配')
    key=f'conversation:{p.device_id}:{p.request_id}';digest,old=receipt(s,key,p)
    if old is not None:return old
    d=s.get(Doc,id)
    if d and (d.kind!='conversation' or d.device_id!=p.device_id):raise HTTPException(403,'会话归属不匹配')
    check_version(d,p.expected_version)
    model=load(s,p.model_config_id,'model')
    if model.device_id!=p.device_id or model.data.get('deleted'):raise HTTPException(409,'模型不可用')
    if p.kind=='read_code':
        project=s.get(Project,p.project_id)
        if not project or project.device_id!=p.device_id or project.availability!='available':raise HTTPException(409,'项目未共享或不可用')
    if d and (d.data['kind']!=p.kind or d.data['project_id']!=(str(p.project_id) if p.project_id else None)):raise HTTPException(409,'不能切换会话项目或类型')
    if p.task_id:
        task=s.get(Task,p.task_id)
        if not task or task.target_device_id!=p.device_id:raise HTTPException(403,'任务归属不匹配')
    pending=[r for r in s.scalars(select(Doc).where(Doc.kind=='chat_run',Doc.device_id==p.device_id)).all() if r.data['conversation_id']==str(id) and r.data['state'] not in TERMINAL]
    if p.deleted and pending:raise HTTPException(409,'请先停止运行')
    share_version=(d.data.get('share_version',1)+(d.data['shared']!=p.shared)) if d else 1
    data=p.model_dump(mode='json',exclude={'expected_version','request_id','device_id'});data['share_version']=share_version
    if d:d.version+=1;d.data=data
    else:d=Doc(id=id,kind='conversation',device_id=p.device_id,version=1,data=data);s.add(d);s.flush()
    if p.deleted:
        for m in s.scalars(select(Doc).where(Doc.kind=='message',Doc.device_id==p.device_id)).all():
            if m.data['conversation_id']==str(id):s.delete(m)
    change(s,d);return save_receipt(s,key,digest,public(d))
@router.put('/conversations/{id}', response_model=ConversationPublic)
def conversation_put(id:uuid.UUID,p:ConversationWrite,user:User=Depends(require_user),s:Session=Depends(get_session)):return put_conversation(s,id,p)
@router.put('/device/conversations/{id}', response_model=ConversationPublic)
def device_conversation_put(id:uuid.UUID,p:ConversationWrite,device:Device=Depends(require_device),s:Session=Depends(get_session)):return put_conversation(s,id,p,device)
@router.get('/conversations', response_model=list[ConversationPublic])
def conversations(user:User=Depends(require_user),s:Session=Depends(get_session)):
    return [public(d) for d in s.scalars(select(Doc).where(Doc.kind=='conversation')).all() if not d.data.get('deleted')]
@router.get('/conversations/{id}', response_model=ConversationPublic)
def conversation_get(id:uuid.UUID,user:User=Depends(require_user),s:Session=Depends(get_session)):return public(load(s,id,'conversation'))
@router.get('/conversations/{id}/messages', response_model=MessagePage)
def messages(id:uuid.UUID,after:int=0,limit:int=Query(default=100,ge=1,le=500),user:User=Depends(require_user),s:Session=Depends(get_session)):
    c=load(s,id,'conversation')
    if c.data.get('deleted'):raise HTTPException(410,'会话已删除')
    rows=sorted([public(d) for d in s.scalars(select(Doc).where(Doc.kind=='message',Doc.device_id==c.device_id)).all() if d.data['conversation_id']==str(id) and d.data['sequence']>after],key=lambda d:d['sequence'])
    pending=[public(d) for d in s.scalars(select(Doc).where(Doc.kind=='message',Doc.device_id==c.device_id)).all() if d.data['conversation_id']==str(id) and d.data['sequence']==0]
    return {'pending_messages':pending,'messages':rows[:limit],'next_cursor':rows[:limit][-1]['sequence'] if rows[:limit] else after,'has_more':len(rows)>limit}
@router.post('/device/conversations/{id}/messages', response_model=Ok)
def upload(id:uuid.UUID,p:Upload,device:Device=Depends(require_device),s:Session=Depends(get_session)):
    write_lock(s);c=load(s,id,'conversation',device)
    if c.data.get('deleted') or not c.data['shared'] or c.data['share_version']!=p.share_version:raise HTTPException(409,'会话共享状态已变化')
    for m in p.messages:
        d=s.get(Doc,m.id)
        if d and (d.kind!='message' or d.device_id!=device.device_id or d.data['conversation_id']!=str(id)):raise HTTPException(409,'消息归属不匹配')
        if d and (d.version>=m.revision or d.data['status'] in TERMINAL):continue
        data={**m.model_dump(mode='json',exclude={'id','revision'}),'conversation_id':str(id)}
        if d:d.version=m.revision;d.data=data
        else:d=Doc(id=m.id,kind='message',device_id=device.device_id,version=m.revision,data=data);s.add(d);s.flush()
        change(s,d)
    return {'ok':True}
@router.post('/conversations/{id}/messages', response_model=ChatRunPublic)
def send(id:uuid.UUID,p:Send,user:User=Depends(require_user),s:Session=Depends(get_session)):
    write_lock(s);c=load(s,id,'conversation');target(s,c.device_id)
    key=f'send:{id}:{p.request_id}';digest,old=receipt(s,key,p)
    if old is not None:return old
    if not c.data['shared'] or c.data.get('deleted'):raise HTTPException(409,'会话已停止共享')
    if c.data['kind']=='read_code':
        project=s.get(Project,uuid.UUID(c.data['project_id']))
        if not project or project.device_id!=c.device_id or project.availability!='available':raise HTTPException(409,'项目不可用')
    for r in s.scalars(select(Doc).where(Doc.kind=='chat_run',Doc.device_id==c.device_id)).all():
        if r.data['conversation_id']==str(id) and r.data['state'] not in TERMINAL:raise HTTPException(409,'该会话已有未结束请求')
    rid=uuid.uuid4();mid=uuid.uuid4()
    data={'conversation_id':str(id),'message_id':str(mid),'text':p.text,'state':'queued','share_version':c.data['share_version'],'acked':False,'cancel_requested':False,'local_run_id':None}
    message=Doc(id=mid,kind='message',device_id=c.device_id,version=0,data={'conversation_id':str(id),'run_id':str(rid),'role':'user','content':p.text,'status':'queued','sequence':0});s.add(message)
    d=Doc(id=rid,kind='chat_run',device_id=c.device_id,version=1,data=data);s.add(d);s.flush();change(s,d)
    return save_receipt(s,key,digest,public(d))
@router.get('/chat-runs/{id}', response_model=ChatRunPublic)
def chat_run(id:uuid.UUID,user:User=Depends(require_user),s:Session=Depends(get_session)):return public(load(s,id,'chat_run'))
def finish_pending_message(s, run):
    # A question cancelled before the Mac started remains visible, but is no longer queued.
    message=s.get(Doc,uuid.UUID(run.data['message_id']))
    if message and message.data['sequence']==0 and message.data['status']=='queued':
        message.version+=1;message.data={**message.data,'status':run.data['state']};change(s,message)

@router.post('/chat-runs/{id}/cancel', response_model=ChatRunPublic)
def cancel(id:uuid.UUID,user:User=Depends(require_user),s:Session=Depends(get_session)):
    write_lock(s);d=load(s,id,'chat_run')
    if d.data['state'] not in TERMINAL:d.data={**d.data,'cancel_requested':True,'state':d.data['state'] if d.data['acked'] else 'cancelled'};d.version+=1;change(s,d)
    if d.data['state'] in TERMINAL:finish_pending_message(s,d)
    return public(d)
@router.post('/device/chat-runs/{id}/ack', response_model=ChatRunPublic)
def ack(id:uuid.UUID,device:Device=Depends(require_device),s:Session=Depends(get_session)):
    write_lock(s);d=load(s,id,'chat_run',device);c=load(s,uuid.UUID(d.data['conversation_id']),'conversation',device)
    if d.data['state'] in TERMINAL:return public(d)
    if c.data.get('deleted') or not c.data['shared'] or c.data['share_version']!=d.data['share_version']:
        d.data={**d.data,'state':'cancelled'};d.version+=1;change(s,d);finish_pending_message(s,d);return public(d)
    d.data={**d.data,'acked':True};return public(d)
@router.post('/device/chat-runs/{id}/result', response_model=ChatRunPublic)
def result(id:uuid.UUID,p:Result,device:Device=Depends(require_device),s:Session=Depends(get_session)):
    write_lock(s);d=load(s,id,'chat_run',device)
    if d.data['state'] in TERMINAL:return public(d)
    if not d.data['acked']:raise HTTPException(409,'请先确认接收')
    d.data={**d.data,'state':p.state,'local_run_id':str(p.local_run_id) if p.local_run_id else d.data['local_run_id']};d.version+=1;change(s,d)
    if p.state in TERMINAL:finish_pending_message(s,d)
    return public(d)
@router.get('/device/shared/changes', response_model=ChangePage)
def changes(after:int=0,limit:int=Query(default=100,ge=1,le=500),device:Device=Depends(require_device),s:Session=Depends(get_session)):
    rows=s.scalars(select(SharedChange).where(SharedChange.device_id==device.device_id,SharedChange.cursor>after).order_by(SharedChange.cursor).limit(limit+1)).all()
    return {'changes':[{'cursor':r.cursor,'kind':r.kind,'id':str(r.entity_id),'document':public(s.get(Doc,r.entity_id)) if s.get(Doc,r.entity_id) else None} for r in rows[:limit]],'next_cursor':rows[:limit][-1].cursor if rows[:limit] else after,'has_more':len(rows)>limit}
@router.get('/device/shared/snapshot')
def snapshot(device:Device=Depends(require_device),s:Session=Depends(get_session)):
    docs=s.scalars(select(Doc).where(Doc.device_id==device.device_id,Doc.kind.in_(['model','conversation','chat_run'])).order_by(Doc.position)).all()
    tasks=s.scalars(select(Task).where(Task.target_device_id==device.device_id)).all()
    return {'documents':[{**public(d),'entity_kind':d.kind} for d in docs],'tasks':[{'id':str(t.task_id),'state':t.status} for t in tasks]}

@router.post('/device/shared/enable', response_model=Ok)
def enable(device:Device=Depends(require_device),s:Session=Depends(get_session)):
    write_lock(s)
    if CAPABILITY not in device.capabilities:device.capabilities=[*device.capabilities,CAPABILITY]
    return {'ok':True}

# Declare authentication requirements in the exported contract as well as dependencies.
from tagent_server.openapi_extra import DEVICE_SECURITY, USER_SECURITY
for route in router.routes:
    route.openapi_extra = DEVICE_SECURITY if route.path.startswith('/device/') else USER_SECURITY
