"""Cloud-executed models and conversations. Runs are picked up by the DeepAgents worker."""
import uuid
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import Field
from sqlalchemy import select, text
from sqlalchemy.orm import Session
from tagent_server.deps import get_session, require_device, require_user
from tagent_server.models import Device, User
from tagent_server.routers import shared
from tagent_server.routers.shared import Strict, Write, ModelFields, Send, TERMINAL, public, load, change, receipt, save_receipt, check_version
from tagent_server.shared_schemas import CloudModelPublic, ConversationPublic, ChatRunPublic, MessagePage
from tagent_server.sync_models import SharedDocument as Doc, SharedRevision
from tagent_server.tasks_service import write_lock
from tagent_server.vault import Vault

router = APIRouter(tags=['cloud'])
HANDOFF_MESSAGES = 40
HANDOFF_CHARS = 60000


class CloudModelWrite(Write):
    config: ModelFields
    api_key: str | None = Field(default=None, min_length=1, max_length=8192, json_schema_extra={'writeOnly': True})
class CloudModelDelete(Write):
    replacement_id: uuid.UUID | None = None
class FromMac(Strict):
    request_id: uuid.UUID
    model_id: uuid.UUID
class CloudConversationWrite(Write):
    title: str = Field(min_length=1, max_length=120)
    model_config_id: uuid.UUID
    deleted: bool = False
class Handoff(Strict):
    request_id: uuid.UUID
    model_config_id: uuid.UUID
    title: str | None = Field(default=None, min_length=1, max_length=120)


def cloud_model(s: Session, id: uuid.UUID) -> Doc:
    d = s.get(Doc, id)
    if not d or d.kind != 'cloud_model' or d.data.get('deleted'): raise HTTPException(409, '云端模型不可用')
    return d

def cloud_conversation(s: Session, id: uuid.UUID) -> Doc:
    d = s.get(Doc, id)
    if not d or d.kind != 'conversation' or d.device_id is not None: raise HTTPException(404, '云端会话不存在')
    return d

def revise(s: Session, d: Doc, data: dict):
    d.version += 1; d.data = data
    s.add(SharedRevision(document_id=d.id, version=d.version, data=data)); change(s, d)

def put_cloud_model(s: Session, request: Request, id: uuid.UUID, p: CloudModelWrite):
    write_lock(s); key = f'cloud-model:{p.request_id}'; digest, old = receipt(s, key, p)
    if old is not None: return old
    d = s.get(Doc, id)
    if d and d.kind != 'cloud_model': raise HTTPException(409, '配置 ID 已被占用')
    check_version(d, p.expected_version)
    version = (d.version if d else 0) + 1
    secret = Vault(request.app.state.settings.sync_key_file).seal(p.api_key, str(id), version) if p.api_key else d.data.get('secret') if d else None
    if not secret: raise HTTPException(422, '新模型必须提供 API Key')
    data = {'config': p.config.model_dump(mode='json'), 'secret': secret, 'has_key': True, 'deleted': False, 'source_model_id': d.data.get('source_model_id') if d else None}
    if data['config']['is_default']: clear_default(s, id)
    if d: revise(s, d, data)
    else:
        d = Doc(id=id, kind='cloud_model', device_id=None, version=1, data=data); s.add(d); s.flush()
        s.add(SharedRevision(document_id=id, version=1, data=data)); change(s, d)
    return save_receipt(s, key, digest, public(d))

def clear_default(s: Session, keep: uuid.UUID):
    for other in s.scalars(select(Doc).where(Doc.kind == 'cloud_model')).all():
        if other.id != keep and not other.data.get('deleted') and other.data['config']['is_default']:
            revise(s, other, {**other.data, 'config': {**other.data['config'], 'is_default': False}})

def copy_from_mac(s: Session, request: Request, p: FromMac, device: Device | None):
    write_lock(s); key = f'cloud-model-copy:{p.request_id}'; digest, old = receipt(s, key, p)
    if old is not None: return old
    source = s.get(Doc, p.model_id)
    if not source or source.kind != 'model' or source.data.get('deleted') or (device and source.device_id != device.device_id): raise HTTPException(404, '模型不存在')
    vault = Vault(request.app.state.settings.sync_key_file)
    id = uuid.uuid4()
    # The key is re-sealed server-side; it never travels to or through a client.
    secret = vault.seal(vault.open(source.data['secret'], str(source.id)), str(id), 1)
    data = {'config': {**source.data['config'], 'is_default': False}, 'secret': secret, 'has_key': True, 'deleted': False, 'source_model_id': str(source.id)}
    if not any(not m.data.get('deleted') for m in s.scalars(select(Doc).where(Doc.kind == 'cloud_model')).all()): data['config']['is_default'] = True
    d = Doc(id=id, kind='cloud_model', device_id=None, version=1, data=data); s.add(d); s.flush()
    s.add(SharedRevision(document_id=id, version=1, data=data)); change(s, d)
    return save_receipt(s, key, digest, public(d))

def delete_cloud_model(s: Session, id: uuid.UUID, p: CloudModelDelete):
    write_lock(s); key = f'cloud-model-delete:{p.request_id}'; digest, old = receipt(s, key, p)
    if old is not None: return old
    d = load(s, id, 'cloud_model'); check_version(d, p.expected_version)
    users = [c for c in s.scalars(select(Doc).where(Doc.kind == 'conversation', Doc.device_id.is_(None))).all() if c.data['model_config_id'] == str(id) and not c.data.get('deleted')]
    if users and not p.replacement_id: raise HTTPException(409, '需选择替代模型')
    if p.replacement_id and (p.replacement_id == id or cloud_model(s, p.replacement_id) is None): raise HTTPException(409, '替代模型无效')
    revise(s, d, {**d.data, 'deleted': True, 'secret': None, 'replacement_id': str(p.replacement_id) if p.replacement_id else None})
    for c in users: revise(s, c, {**c.data, 'model_config_id': str(p.replacement_id)})
    return save_receipt(s, key, digest, public(d))

def put_cloud_conversation(s: Session, id: uuid.UUID, p: CloudConversationWrite):
    write_lock(s); key = f'cloud-conversation:{p.request_id}'; digest, old = receipt(s, key, p)
    if old is not None: return old
    d = s.get(Doc, id)
    if d and (d.kind != 'conversation' or d.device_id is not None): raise HTTPException(409, '会话 ID 已被占用')
    check_version(d, p.expected_version)
    if not p.deleted: cloud_model(s, p.model_config_id)
    if p.deleted and d and active_run(s, id): raise HTTPException(409, '请先停止运行')
    base = d.data if d else {'kind': 'ask', 'target': 'cloud', 'project_id': None, 'task_id': None, 'shared': True, 'share_version': 1, 'handoff': None, 'generation': 0}
    data = {**base, 'title': p.title, 'model_config_id': str(p.model_config_id), 'deleted': p.deleted}
    if d: revise(s, d, data)
    else:
        d = Doc(id=id, kind='conversation', device_id=None, version=1, data=data); s.add(d); s.flush(); change(s, d)
    if p.deleted: forget(s, id)
    return save_receipt(s, key, digest, public(d))

def forget(s: Session, id: uuid.UUID):
    for m in s.scalars(select(Doc).where(Doc.kind == 'message', Doc.device_id.is_(None), Doc.data['conversation_id'].astext == str(id))).all(): s.delete(m)
    # Checkpoint tables exist once a worker has started; threads are named "<conversation>:<generation>".
    if s.execute(text("SELECT to_regclass('checkpoints')")).scalar():
        for table in ('checkpoint_writes', 'checkpoint_blobs', 'checkpoints'):
            s.execute(text(f'DELETE FROM {table} WHERE thread_id LIKE :prefix'), {'prefix': f'{id}:%'})

def active_run(s: Session, conversation_id: uuid.UUID):
    return any(r.data['conversation_id'] == str(conversation_id) and r.data['state'] not in TERMINAL for r in s.scalars(select(Doc).where(Doc.kind == 'chat_run', Doc.device_id.is_(None))).all())

def handoff(s: Session, id: uuid.UUID, source_id: uuid.UUID, p: Handoff, device: Device | None):
    write_lock(s); key = f'cloud-handoff:{p.request_id}'; digest, old = receipt(s, key, p)
    if old is not None: return old
    if s.get(Doc, id): raise HTTPException(409, '会话 ID 已被占用')
    source = s.get(Doc, source_id)
    if not source or source.kind != 'conversation' or source.device_id is None or (device and source.device_id != device.device_id): raise HTTPException(404, '会话不存在')
    if source.data.get('deleted') or not source.data['shared']: raise HTTPException(409, '只有已共享的会话可以转到云端')
    cloud_model(s, p.model_config_id)
    history = sorted((m for m in s.scalars(select(Doc).where(Doc.kind == 'message', Doc.device_id == source.device_id, Doc.data['conversation_id'].astext == str(source_id))).all() if m.data['sequence'] > 0 and m.data['status'] == 'completed' and m.data['content']), key=lambda m: m.data['sequence'])[-HANDOFF_MESSAGES:]
    budget, kept = HANDOFF_CHARS, []
    for m in reversed(history):
        if len(m.data['content']) > budget: break
        budget -= len(m.data['content']); kept.insert(0, m)
    data = {'kind': 'ask', 'target': 'cloud', 'project_id': None, 'task_id': None, 'shared': True, 'share_version': 1, 'generation': 0, 'deleted': False,
            'title': p.title or f"{source.data['title']}（云端）"[:120], 'model_config_id': str(p.model_config_id), 'handoff': {'from_conversation_id': str(source_id), 'message_count': len(kept)}}
    d = Doc(id=id, kind='conversation', device_id=None, version=1, data=data); s.add(d); s.flush()
    run_id = str(uuid.uuid4())
    for index, m in enumerate(kept, start=1):
        s.add(Doc(id=uuid.uuid4(), kind='message', device_id=None, version=1, data={'conversation_id': str(id), 'run_id': run_id, 'role': m.data['role'], 'content': m.data['content'], 'status': 'completed', 'sequence': index}))
    s.flush(); change(s, d)
    return save_receipt(s, key, digest, public(d))

def cloud_only(s: Session, id: uuid.UUID):
    cloud_conversation(s, id)
def cloud_run(s: Session, id: uuid.UUID):
    d = load(s, id, 'chat_run')
    if d.device_id is not None: raise HTTPException(404, '记录不存在')


# User (JWT) endpoints
@router.get('/cloud/models', response_model=list[CloudModelPublic])
def models(user: User = Depends(require_user), s: Session = Depends(get_session)):
    return [public(d) for d in s.scalars(select(Doc).where(Doc.kind == 'cloud_model').order_by(Doc.position)).all()]
@router.put('/cloud/models/{id}', response_model=CloudModelPublic)
def model_put(id: uuid.UUID, p: CloudModelWrite, request: Request, user: User = Depends(require_user), s: Session = Depends(get_session)):
    return put_cloud_model(s, request, id, p)
@router.post('/cloud/models/{id}/delete', response_model=CloudModelPublic)
def model_delete(id: uuid.UUID, p: CloudModelDelete, user: User = Depends(require_user), s: Session = Depends(get_session)):
    return delete_cloud_model(s, id, p)
@router.post('/cloud/models/from-mac', response_model=CloudModelPublic)
def model_copy(p: FromMac, request: Request, user: User = Depends(require_user), s: Session = Depends(get_session)):
    return copy_from_mac(s, request, p, None)
@router.put('/cloud/conversations/{id}', response_model=ConversationPublic)
def conversation_put(id: uuid.UUID, p: CloudConversationWrite, user: User = Depends(require_user), s: Session = Depends(get_session)):
    return put_cloud_conversation(s, id, p)
@router.post('/cloud/conversations/{id}/handoff-from/{source_id}', response_model=ConversationPublic)
def conversation_handoff(id: uuid.UUID, source_id: uuid.UUID, p: Handoff, user: User = Depends(require_user), s: Session = Depends(get_session)):
    return handoff(s, id, source_id, p, None)


# Device (signed) endpoints for the Mac client; limited to cloud conversations and the device's own Mac data.
@router.get('/device/cloud/models', response_model=list[CloudModelPublic])
def device_models(device: Device = Depends(require_device), s: Session = Depends(get_session)):
    return [public(d) for d in s.scalars(select(Doc).where(Doc.kind == 'cloud_model').order_by(Doc.position)).all()]
@router.post('/device/cloud/models/from-mac', response_model=CloudModelPublic)
def device_model_copy(p: FromMac, request: Request, device: Device = Depends(require_device), s: Session = Depends(get_session)):
    return copy_from_mac(s, request, p, device)
@router.get('/device/cloud/conversations', response_model=list[ConversationPublic])
def device_conversations(device: Device = Depends(require_device), s: Session = Depends(get_session)):
    return [public(d) for d in s.scalars(select(Doc).where(Doc.kind == 'conversation', Doc.device_id.is_(None)).order_by(Doc.position.desc())).all() if not d.data.get('deleted')]
@router.put('/device/cloud/conversations/{id}', response_model=ConversationPublic)
def device_conversation_put(id: uuid.UUID, p: CloudConversationWrite, device: Device = Depends(require_device), s: Session = Depends(get_session)):
    return put_cloud_conversation(s, id, p)
@router.post('/device/cloud/conversations/{id}/handoff-from/{source_id}', response_model=ConversationPublic)
def device_conversation_handoff(id: uuid.UUID, source_id: uuid.UUID, p: Handoff, device: Device = Depends(require_device), s: Session = Depends(get_session)):
    return handoff(s, id, source_id, p, device)
@router.get('/device/cloud/conversations/{id}/messages', response_model=MessagePage)
def device_messages(id: uuid.UUID, after: int = 0, limit: int = Query(default=100, ge=1, le=500), device: Device = Depends(require_device), s: Session = Depends(get_session)):
    cloud_only(s, id); return shared.messages(id, after, limit, None, s)
@router.post('/device/cloud/conversations/{id}/messages', response_model=ChatRunPublic)
def device_send(id: uuid.UUID, p: Send, device: Device = Depends(require_device), s: Session = Depends(get_session)):
    cloud_only(s, id); return shared.send(id, p, None, s)
@router.get('/device/cloud/chat-runs/{id}', response_model=ChatRunPublic)
def device_chat_run(id: uuid.UUID, device: Device = Depends(require_device), s: Session = Depends(get_session)):
    cloud_run(s, id); return shared.chat_run(id, None, s)
@router.post('/device/cloud/chat-runs/{id}/cancel', response_model=ChatRunPublic)
def device_cancel(id: uuid.UUID, device: Device = Depends(require_device), s: Session = Depends(get_session)):
    cloud_run(s, id); return shared.cancel(id, None, s)


from tagent_server.openapi_extra import DEVICE_SECURITY, USER_SECURITY
for route in router.routes:
    route.openapi_extra = DEVICE_SECURITY if route.path.startswith('/device/') else USER_SECURITY
