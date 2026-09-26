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
class CredentialPublic(BaseModel):
    api_key: str
class Ok(BaseModel):
    ok: bool
