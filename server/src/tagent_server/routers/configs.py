"""Shared skill packages and MCP server templates.

Documents are global (device_id NULL). Each device reports its own static dependency check; the server never
executes anything from a package and never stores MCP secret values, only reference names.
"""
import hashlib
import json
import re
import uuid
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field, AnyHttpUrl, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session
from tagent_server.config import utcnow
from tagent_server.deps import get_session, require_device, require_user
from tagent_server.models import Device, User
from tagent_server.sync_models import SharedDocument as Doc, SharedRevision
from tagent_server.tasks_service import write_lock
from tagent_server.routers.shared import Strict, Write, change, receipt, save_receipt, check_version
from tagent_server.shared_schemas import SkillPublic, McpServerPublic, ConfigBundle, ConfigRevision

router = APIRouter(tags=['configs'])
NAME = r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
COMMAND = r'^[A-Za-z0-9._+-]{1,64}$'
ENV_NAME = r'^[A-Za-z_][A-Za-z0-9_]{0,63}$'
SECRET_LIKE = re.compile(r'KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL', re.I)
MAX_PACKAGE = 1024 * 1024
Runtime = Literal['mac', 'cloud', 'both']
ReasonCode = Literal['command_missing', 'platform_unsupported', 'script_missing', 'mcp_missing', 'mcp_unavailable', 'secret_missing', 'invalid_config', 'write_failed']

def valid_path(v: str) -> str:
    parts = v.split('/')
    if v.startswith('/') or '\\' in v or '\x00' in v or any(p in ('', '.', '..') for p in parts) or v == 'SKILL.md':
        raise ValueError('文件路径必须是包内相对路径，且不能是 SKILL.md')
    return v

class SkillFile(Strict):
    path: str = Field(min_length=1, max_length=200)
    content: str = Field(max_length=200_000)
    _path = field_validator('path')(valid_path)
class Requires(Strict):
    commands: list[str] = Field(default_factory=list, max_length=20)
    platforms: list[Literal['darwin', 'linux', 'win32']] = Field(default_factory=list, max_length=3)
    scripts: list[str] = Field(default_factory=list, max_length=20)
    mcp: list[str] = Field(default_factory=list, max_length=20)
    @field_validator('commands')
    @classmethod
    def commands_ok(cls, v):
        if any(not re.match(COMMAND, c) for c in v): raise ValueError('命令名只能是单个可执行文件名，不能包含路径或参数')
        return v
    @field_validator('mcp')
    @classmethod
    def mcp_ok(cls, v):
        if any(not re.match(NAME, c) for c in v): raise ValueError('MCP 名称无效')
        return v
    _scripts = field_validator('scripts')(lambda v: [valid_path(x) for x in v])
class SkillFields(Strict):
    name: str = Field(pattern=NAME)
    description: str = Field(default='', max_length=500)
    content: str = Field(min_length=1, max_length=200_000)
    files: list[SkillFile] = Field(default_factory=list, max_length=20)
    runtime: Runtime = 'mac'
    enabled: bool = True
    requires: Requires = Field(default_factory=Requires)
    install_hint: str | None = Field(default=None, max_length=4000)
    @model_validator(mode='after')
    def package(self):
        paths = [f.path for f in self.files]
        if len(set(paths)) != len(paths): raise ValueError('文件路径重复')
        if len(self.content.encode()) + sum(len(f.content.encode()) for f in self.files) > MAX_PACKAGE: raise ValueError('技能包超过 1MB')
        if any(s not in paths for s in self.requires.scripts): raise ValueError('声明的脚本必须包含在技能包文件中')
        return self
class EnvVar(Strict):
    name: str = Field(pattern=ENV_NAME)
    value: str | None = Field(default=None, max_length=4000)
    secret_ref: str | None = Field(default=None, pattern=NAME)
    @model_validator(mode='after')
    def one(self):
        if (self.value is None) == (self.secret_ref is None): raise ValueError('环境变量需在明文值与 secret 引用中二选一')
        if self.value is not None and SECRET_LIKE.search(self.name): raise ValueError(f'{self.name} 疑似密钥，请改用 secret 引用')
        return self
class McpFields(Strict):
    name: str = Field(pattern=NAME)
    transport: Literal['stdio', 'http']
    command: str | None = Field(default=None, min_length=1, max_length=500)
    args: list[str] = Field(default_factory=list, max_length=50)
    url: AnyHttpUrl | None = None
    timeout_ms: int = Field(default=30000, ge=1000, le=600000)
    env: list[EnvVar] = Field(default_factory=list, max_length=50)
    runtime: Runtime = 'mac'
    enabled: bool = True
    disabled_tools: list[str] = Field(default_factory=list, max_length=200)
    @field_validator('args')
    @classmethod
    def args_ok(cls, v):
        if any(len(a) > 2000 for a in v): raise ValueError('参数过长')
        return v
    @model_validator(mode='after')
    def transport_ok(self):
        if self.transport == 'stdio' and (not self.command or self.url): raise ValueError('stdio 需要 command，且不能填写 URL')
        if self.transport == 'http' and (not self.url or self.command or self.args): raise ValueError('HTTP 需要 URL，且不能填写命令')
        if self.url and (self.url.username or self.url.password): raise ValueError('URL 不能包含账号密码')
        names = [e.name for e in self.env]
        if len(set(names)) != len(names): raise ValueError('环境变量重复')
        return self
class SkillWrite(Write):
    config: SkillFields
class McpWrite(Write):
    config: McpFields
class ConfigDelete(Write):
    pass
class Reason(Strict):
    code: ReasonCode
    detail: str = Field(default='', max_length=300)
class ConfigApplied(Strict):
    version: int = Field(ge=1)
    hash: str = Field(pattern=r'^[0-9a-f]{64}$')
    state: Literal['available', 'unavailable', 'not_applicable', 'failed']
    reasons: list[Reason] = Field(default_factory=list, max_length=50)

KINDS = {'skills': 'skill', 'mcp-servers': 'mcp_server'}

def content_hash(config: dict) -> str:
    return hashlib.sha256(json.dumps(config, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()

def present(s: Session, d: Doc) -> dict:
    labels = {str(x.device_id): x.label for x in s.scalars(select(Device)).all()}
    devices = []
    for device_id, st in (d.data.get('devices') or {}).items():
        state = st['state'] if st['checked_version'] == d.version else 'pending'
        devices.append({'device_id': device_id, 'label': labels.get(device_id, ''), 'state': state, 'checked_version': st['checked_version'],
                        'reasons': st['reasons'] if state != 'pending' else [], 'applied_version': st['applied_version'], 'applied_hash': st['applied_hash'], 'checked_at': st['checked_at']})
    return {'id': str(d.id), 'version': d.version, 'config': d.data['config'], 'content_hash': d.data['content_hash'], 'deleted': d.data.get('deleted', False), 'devices': devices}

def load(s: Session, id: uuid.UUID, kind: str) -> Doc:
    d = s.get(Doc, id)
    if not d or d.kind != kind or d.device_id is not None: raise HTTPException(404, '配置不存在')
    return d

def put_config(s: Session, kind: str, id: uuid.UUID, p: SkillWrite | McpWrite):
    write_lock(s)
    key = f'{kind}:{p.request_id}'; digest, old = receipt(s, key, p)
    if old is not None: return old
    d = s.get(Doc, id)
    if d and (d.kind != kind or d.device_id is not None): raise HTTPException(403, '配置类型不匹配')
    if d is None and p.expected_version != 0: raise HTTPException(409, {'message': '版本冲突', 'current': None})
    if d and d.version != p.expected_version: raise HTTPException(409, {'message': '版本冲突', 'current': present(s, d)})
    if d and d.data.get('deleted'): raise HTTPException(410, '配置已删除')
    config = p.config.model_dump(mode='json')
    for other in s.scalars(select(Doc).where(Doc.kind == kind, Doc.device_id.is_(None))).all():
        if other.id != id and not other.data.get('deleted') and other.data['config']['name'] == config['name']: raise HTTPException(409, '名称已存在')
    data = {'config': config, 'content_hash': content_hash(config), 'deleted': False, 'devices': d.data.get('devices', {}) if d else {}}
    if d: d.version += 1; d.data = data
    else: d = Doc(id=id, kind=kind, device_id=None, version=1, data=data); s.add(d); s.flush()
    s.add(SharedRevision(document_id=id, version=d.version, data=data)); change(s, d)
    return save_receipt(s, key, digest, present(s, d))

def delete_config(s: Session, kind: str, id: uuid.UUID, p: ConfigDelete):
    write_lock(s); d = load(s, id, kind)
    key = f'delete-{kind}:{p.request_id}'; digest, old = receipt(s, key, p)
    if old is not None: return old
    check_version(d, p.expected_version)
    d.version += 1; d.data = {**d.data, 'deleted': True}
    s.add(SharedRevision(document_id=id, version=d.version, data=d.data)); change(s, d)
    return save_receipt(s, key, digest, present(s, d))

def listing(s: Session, kind: str, include_deleted=False):
    docs = s.scalars(select(Doc).where(Doc.kind == kind, Doc.device_id.is_(None)).order_by(Doc.position)).all()
    return [present(s, d) for d in docs if include_deleted or not d.data.get('deleted')]

@router.get('/configs/skills', response_model=list[SkillPublic])
def skills(user: User = Depends(require_user), s: Session = Depends(get_session)): return listing(s, 'skill')
@router.get('/configs/mcp-servers', response_model=list[McpServerPublic])
def mcp_servers(user: User = Depends(require_user), s: Session = Depends(get_session)): return listing(s, 'mcp_server')
@router.put('/configs/skills/{id}', response_model=SkillPublic)
def skill_put(id: uuid.UUID, p: SkillWrite, user: User = Depends(require_user), s: Session = Depends(get_session)): return put_config(s, 'skill', id, p)
@router.put('/configs/mcp-servers/{id}', response_model=McpServerPublic)
def mcp_put(id: uuid.UUID, p: McpWrite, user: User = Depends(require_user), s: Session = Depends(get_session)): return put_config(s, 'mcp_server', id, p)
@router.post('/configs/skills/{id}/delete', response_model=SkillPublic)
def skill_delete(id: uuid.UUID, p: ConfigDelete, user: User = Depends(require_user), s: Session = Depends(get_session)): return delete_config(s, 'skill', id, p)
@router.post('/configs/mcp-servers/{id}/delete', response_model=McpServerPublic)
def mcp_delete(id: uuid.UUID, p: ConfigDelete, user: User = Depends(require_user), s: Session = Depends(get_session)): return delete_config(s, 'mcp_server', id, p)
@router.get('/configs/{kind}/{id}/revisions', response_model=list[ConfigRevision])
def revisions(kind: Literal['skills', 'mcp-servers'], id: uuid.UUID, user: User = Depends(require_user), s: Session = Depends(get_session)):
    load(s, id, KINDS[kind])
    rows = s.scalars(select(SharedRevision).where(SharedRevision.document_id == id).order_by(SharedRevision.version.desc())).all()
    return [{'version': r.version, 'content_hash': r.data['content_hash'], 'deleted': r.data.get('deleted', False)} for r in rows]

@router.get('/device/configs/bundle', response_model=ConfigBundle)
def bundle(device: Device = Depends(require_device), s: Session = Depends(get_session)):
    return {'skills': listing(s, 'skill'), 'mcp_servers': listing(s, 'mcp_server')}
@router.put('/device/configs/skills/{id}', response_model=SkillPublic)
def device_skill_put(id: uuid.UUID, p: SkillWrite, device: Device = Depends(require_device), s: Session = Depends(get_session)): return put_config(s, 'skill', id, p)
@router.put('/device/configs/mcp-servers/{id}', response_model=McpServerPublic)
def device_mcp_put(id: uuid.UUID, p: McpWrite, device: Device = Depends(require_device), s: Session = Depends(get_session)): return put_config(s, 'mcp_server', id, p)
@router.post('/device/configs/skills/{id}/delete', response_model=SkillPublic)
def device_skill_delete(id: uuid.UUID, p: ConfigDelete, device: Device = Depends(require_device), s: Session = Depends(get_session)): return delete_config(s, 'skill', id, p)
@router.post('/device/configs/mcp-servers/{id}/delete', response_model=McpServerPublic)
def device_mcp_delete(id: uuid.UUID, p: ConfigDelete, device: Device = Depends(require_device), s: Session = Depends(get_session)): return delete_config(s, 'mcp_server', id, p)
@router.post('/device/configs/{kind}/{id}/applied', response_model=SkillPublic | McpServerPublic)
def applied(kind: Literal['skills', 'mcp-servers'], id: uuid.UUID, p: ConfigApplied, device: Device = Depends(require_device), s: Session = Depends(get_session)):
    write_lock(s); d = load(s, id, KINDS[kind])
    if d.data.get('deleted') or p.version != d.version or p.hash != d.data['content_hash']: raise HTTPException(409, '配置版本已变化')
    devices = dict(d.data.get('devices') or {}); key = str(device.device_id)
    prev = devices.get(key) or {'applied_version': 0, 'applied_hash': None}
    usable = p.state in ('available', 'not_applicable')
    devices[key] = {'checked_version': p.version, 'state': p.state, 'reasons': [r.model_dump() for r in p.reasons], 'checked_at': utcnow().isoformat(),
                    'applied_version': p.version if usable else prev['applied_version'], 'applied_hash': p.hash if usable else prev['applied_hash']}
    same = {k: v for k, v in devices[key].items() if k != 'checked_at'} == {k: v for k, v in (d.data.get('devices') or {}).get(key, {}).items() if k != 'checked_at'}
    d.data = {**d.data, 'devices': devices}
    if not same: change(s, d)
    return present(s, d)

from tagent_server.openapi_extra import DEVICE_SECURITY, USER_SECURITY
for route in router.routes:
    route.openapi_extra = DEVICE_SECURITY if route.path.startswith('/device/') else USER_SECURITY
