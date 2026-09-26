"""Public sync responses deliberately contain no credential ciphertext or plaintext."""
import uuid
from typing import Any,Literal
from pydantic import BaseModel

class Identity(BaseModel):
    id: uuid.UUID
    # null for cloud-executed documents
    device_id: uuid.UUID | None
    version: int
class PublicModelFields(BaseModel):
    name: str
    base_url: str
    model_id: str
    context_window: int
    max_tokens: int
    is_default: bool
class ModelPublic(Identity):
    config: PublicModelFields
    has_key: bool
    credential_version: int
    deleted: bool
    applied_version: int
    apply_state: Literal['pending','applied','failed']
    apply_error: str | None = None
    replacement_id: uuid.UUID | None = None
class Handoff(BaseModel):
    from_conversation_id: uuid.UUID
    message_count: int
class ConversationPublic(Identity):
    title: str
    kind: Literal['ask','read_code']
    target: Literal['mac','cloud'] = 'mac'
    model_config_id: uuid.UUID
    project_id: uuid.UUID | None
    task_id: uuid.UUID | None
    shared: bool
    share_version: int
    deleted: bool
    handoff: Handoff | None = None
class MessagePublic(Identity):
    conversation_id: uuid.UUID
    run_id: uuid.UUID
    role: Literal['user','assistant']
    content: str
    status: Literal['queued','running','completed','failed','cancelled','interrupted']
    sequence: int
class ChatRunPublic(Identity):
    conversation_id: uuid.UUID
    message_id: uuid.UUID
    text: str
    state: Literal['queued','running','completed','failed','cancelled','interrupted']
    share_version: int
    acked: bool
    cancel_requested: bool
    local_run_id: uuid.UUID | None
    error: str | None = None
class MessagePage(BaseModel):
    pending_messages: list[MessagePublic]
    messages: list[MessagePublic]
    next_cursor: int
    has_more: bool
class ChangePublic(BaseModel):
    cursor: int
    kind: Literal['model','conversation','message','chat_run']
    id: uuid.UUID
    document: ModelPublic | ConversationPublic | MessagePublic | ChatRunPublic | None
class ChangePage(BaseModel):
    changes: list[ChangePublic]
    next_cursor: int
    has_more: bool
class CloudModelPublic(Identity):
    config: PublicModelFields
    has_key: bool
    deleted: bool
    source_model_id: uuid.UUID | None = None
class ConfigReason(BaseModel):
    code: Literal['command_missing','platform_unsupported','script_missing','mcp_missing','mcp_unavailable','secret_missing','invalid_config','write_failed']
    detail: str
class DeviceConfigState(BaseModel):
    device_id: uuid.UUID
    label: str
    # pending: the device has not checked the current version yet
    state: Literal['pending','available','unavailable','not_applicable','failed']
    checked_version: int
    reasons: list[ConfigReason]
    applied_version: int
    applied_hash: str | None
    checked_at: str
class SkillFilePublic(BaseModel):
    path: str
    content: str
class RequiresPublic(BaseModel):
    commands: list[str]
    platforms: list[Literal['darwin','linux','win32']]
    scripts: list[str]
    mcp: list[str]
class SkillFieldsPublic(BaseModel):
    name: str
    description: str
    content: str
    files: list[SkillFilePublic]
    runtime: Literal['mac','cloud','both']
    enabled: bool
    requires: RequiresPublic
    install_hint: str | None
class EnvVarPublic(BaseModel):
    name: str
    value: str | None
    secret_ref: str | None
class McpFieldsPublic(BaseModel):
    name: str
    transport: Literal['stdio','http']
    command: str | None
    args: list[str]
    url: str | None
    timeout_ms: int
    env: list[EnvVarPublic]
    runtime: Literal['mac','cloud','both']
    enabled: bool
    disabled_tools: list[str]
class ConfigDocPublic(BaseModel):
    id: uuid.UUID
    version: int
    content_hash: str
    deleted: bool
    devices: list[DeviceConfigState]
class SkillPublic(ConfigDocPublic):
    config: SkillFieldsPublic
class McpServerPublic(ConfigDocPublic):
    config: McpFieldsPublic
class ConfigBundle(BaseModel):
    skills: list[SkillPublic]
    mcp_servers: list[McpServerPublic]
class ConfigRevision(BaseModel):
    version: int
    content_hash: str
    deleted: bool
class CredentialPublic(BaseModel):
    api_key: str
class Ok(BaseModel):
    ok: bool
