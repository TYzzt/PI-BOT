import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from tagent_server.security import decode_public_key

Availability = Literal["available", "unavailable"]
Presence = Literal["online", "offline"]


def _strip_required(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("不能为空")
    return value


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: str = Field(min_length=1, max_length=1024)


class TokenResponse(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int


class PairingCodeResponse(BaseModel):
    pairing_code: str
    expires_at: datetime


class PairRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pairing_code: str = Field(min_length=1, max_length=256)
    public_key: str = Field(min_length=1, max_length=128)
    label: str = Field(min_length=1, max_length=80)
    capabilities: list[str] = Field(default_factory=list, max_length=32)

    @field_validator("label")
    @classmethod
    def strip_label(cls, value: str) -> str:
        return _strip_required(value)

    @field_validator("public_key")
    @classmethod
    def check_public_key(cls, value: str) -> str:
        decode_public_key(value)
        return value

    @field_validator("capabilities")
    @classmethod
    def check_capabilities(cls, value: list[str]) -> list[str]:
        cleaned: list[str] = []
        for item in value:
            text = item.strip()
            if not text or len(text) > 64:
                raise ValueError("能力名称长度必须在 1 到 64 之间")
            cleaned.append(text)
        return cleaned


class DevicePublic(BaseModel):
    device_id: uuid.UUID
    label: str
    public_key: str
    capabilities: list[str]
    last_seen_at: datetime | None
    revoked_at: datetime | None
    presence: Presence


class ProjectCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    display_name: str = Field(min_length=1, max_length=120)
    availability: Availability = "available"

    @field_validator("display_name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        return _strip_required(value)


class ProjectPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    display_name: str | None = Field(default=None, min_length=1, max_length=120)
    availability: Availability | None = None
    device_id: uuid.UUID | None = None

    @field_validator("display_name")
    @classmethod
    def strip_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return _strip_required(value)

    @model_validator(mode="after")
    def at_least_one(self) -> "ProjectPatch":
        if self.display_name is None and self.availability is None and self.device_id is None:
            raise ValueError("至少提供一个字段")
        return self


class ProjectPublic(BaseModel):
    project_id: uuid.UUID
    device_id: uuid.UUID
    display_name: str
    availability: Availability
    created_at: datetime
    updated_at: datetime


class HealthResponse(BaseModel):
    ok: bool


TaskStatus = Literal[
    "queued",
    "waiting_for_device",
    "planning",
    "awaiting_review",
    "approved",
    "running",
    "waiting_for_input",
    "waiting_for_local_action",
    "needs_replan",
    "interrupted",
    "completed",
    "failed",
    "cancelled",
    "rejected",
]
RunState = Literal[
    "queued",
    "running",
    "waiting_for_input",
    "waiting_for_local_action",
    "needs_replan",
    "interrupted",
    "completed",
    "failed",
    "cancelled",
    "expired",
]
CommandType = Literal["plan_request", "plan_revise", "execute", "cancel"]
IdempotencyKey = Annotated[str, Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9_.:-]+$")]
Sha256Hex = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
ShortText = Annotated[str, Field(max_length=1000)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TaskCreate(StrictModel):
    project_id: uuid.UUID
    requirement: str = Field(min_length=1, max_length=30000)
    idempotency_key: IdempotencyKey

    @field_validator("requirement")
    @classmethod
    def strip_requirement(cls, value: str) -> str:
        return _strip_required(value)


class PlanStep(StrictModel):
    step_id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    title: str = Field(min_length=1, max_length=500)
    description: str = Field(max_length=3000)


class PlanBody(StrictModel):
    goal: str = Field(min_length=1, max_length=4000)
    scope: list[ShortText] = Field(min_length=1, max_length=30)
    non_goals: list[ShortText] = Field(max_length=30)
    modules: list[Annotated[str, Field(max_length=500)]] = Field(max_length=100)
    steps: list[PlanStep] = Field(min_length=1, max_length=30)
    commands: list[Annotated[str, Field(max_length=2000)]] = Field(max_length=30)
    external_actions: list[ShortText] = Field(max_length=30)
    verification: list[Annotated[str, Field(min_length=1, max_length=1000)]] = Field(min_length=1, max_length=30)
    acceptance: list[Annotated[str, Field(min_length=1, max_length=1000)]] = Field(min_length=1, max_length=30)
    questions: list[Annotated[str, Field(max_length=2000)]] = Field(max_length=20)

    @model_validator(mode="after")
    def unique_steps(self) -> "PlanBody":
        if len({step.step_id for step in self.steps}) != len(self.steps):
            raise ValueError("step_id 必须唯一")
        return self


class PlanPublish(StrictModel):
    run_id: uuid.UUID
    version: int = Field(ge=1, le=10000)
    content_hash: Sha256Hex
    body: PlanBody
    workspace_fingerprint: Sha256Hex
    config_snapshot_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.:-]+$")


class ApproveRequest(StrictModel):
    version: int = Field(ge=1, le=10000)
    content_hash: Sha256Hex
    idempotency_key: IdempotencyKey


class RejectRequest(StrictModel):
    idempotency_key: IdempotencyKey


class ReviseRequest(StrictModel):
    feedback: str = Field(min_length=1, max_length=30000)
    idempotency_key: IdempotencyKey

    @field_validator("feedback")
    @classmethod
    def strip_feedback(cls, value: str) -> str:
        return _strip_required(value)


class CancelRequest(StrictModel):
    pass


class PlanSummary(BaseModel):
    plan_id: uuid.UUID
    version: int
    content_hash: str
    created_at: datetime
    superseded_at: datetime | None


class PlanPublic(PlanSummary):
    task_id: uuid.UUID
    device_id: uuid.UUID
    project_id: uuid.UUID
    body: PlanBody
    workspace_fingerprint: str
    config_snapshot_id: str


class RunPublic(BaseModel):
    run_id: uuid.UUID
    phase: Literal["plan", "execute"]
    attempt: int
    state: RunState
    approval_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime


class TaskSummary(BaseModel):
    task_id: uuid.UUID
    project_id: uuid.UUID
    target_device_id: uuid.UUID
    requirement: str
    status: TaskStatus
    cancel_requested: bool
    cancel_requested_at: datetime | None
    latest_plan_id: uuid.UUID | None
    device_presence: Presence
    created_at: datetime
    updated_at: datetime


class TaskDetail(TaskSummary):
    plans: list[PlanSummary]
    runs: list[RunPublic]


class ApprovalPublic(BaseModel):
    approval_id: uuid.UUID
    plan_id: uuid.UUID
    task_id: uuid.UUID
    run_id: uuid.UUID
    version: int
    content_hash: str
    device_id: uuid.UUID
    project_id: uuid.UUID
    status: Literal["recorded", "rejected", "expired"]
    actor: Literal["user", "device"]
    expires_at: datetime | None
    created_at: datetime


class CommandPublic(BaseModel):
    command_id: uuid.UUID
    command_type: CommandType
    task_id: uuid.UUID
    run_id: uuid.UUID | None
    payload: dict
    expires_at: datetime
    created_at: datetime


class CommandAckResponse(BaseModel):
    command_id: uuid.UUID
    status: Literal["acked"]
    acked_at: datetime


DeviceEventType = Literal[
    "run.started",
    "run.waiting_for_input",
    "run.waiting_for_local_action",
    "run.interrupted",
    "run.needs_replan",
    "run.completed",
    "run.failed",
    "run.cancelled",
    "step.started",
    "step.updated",
    "step.completed",
    "step.failed",
    "tool.started",
    "tool.finished",
    "artifact.available",
]


class DeviceEventPayload(StrictModel):
    step_id: str | None = Field(default=None, pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    title: str | None = Field(default=None, max_length=500)
    summary: str | None = Field(default=None, max_length=2000)
    tool_name: str | None = Field(default=None, max_length=100, pattern=r"^[A-Za-z0-9_.:-]+$")
    status: Literal["ok", "error", "cancelled", "timeout"] | None = None
    exit_code: int | None = Field(default=None, ge=-1024, le=1024)
    verification: Literal["passed", "failed", "not_run", "cancelled"] | None = None
    duration_ms: int | None = Field(default=None, ge=0, le=86_400_000)
    artifact_id: uuid.UUID | None = None
    visibility: Literal["local_only", "shared"] | None = None


class DeviceEventIn(StrictModel):
    event_id: uuid.UUID
    producer_seq: int = Field(ge=1)
    type: DeviceEventType
    task_id: uuid.UUID
    run_id: uuid.UUID | None = None
    occurred_at: datetime
    payload: DeviceEventPayload = Field(default_factory=DeviceEventPayload)


class DeviceEventBatch(StrictModel):
    events: list[DeviceEventIn] = Field(min_length=1, max_length=100)


class SequenceGap(BaseModel):
    expected: int
    received: int


class DeviceEventBatchResult(BaseModel):
    accepted: int
    duplicates: int
    gaps: list[SequenceGap]
    last_seq: int


class EventPublic(BaseModel):
    event_id: uuid.UUID
    server_cursor: int
    type: str
    task_id: uuid.UUID | None
    run_id: uuid.UUID | None
    producer_id: str
    producer_seq: int | None
    schema_version: int
    occurred_at: datetime
    payload: dict


class EventPage(BaseModel):
    events: list[EventPublic]
    next_cursor: int
    has_more: bool


class WsCommandMessage(CommandPublic):
    type: Literal["command"]


class WsAckMessage(StrictModel):
    type: Literal["ack"]
    command_id: uuid.UUID


class WsAckResultMessage(BaseModel):
    type: Literal["ack_result"]
    command_id: uuid.UUID
    ok: bool
    detail: str | None = None


class WsPingMessage(StrictModel):
    type: Literal["ping"]


class WsPongMessage(BaseModel):
    type: Literal["pong"]


class WsSubscribeMessage(StrictModel):
    type: Literal["subscribe"]
    after: int = Field(ge=0)


class WsEventMessage(BaseModel):
    type: Literal["event"]
    event: EventPublic


class WsErrorMessage(BaseModel):
    type: Literal["error"]
    detail: str


WS_MODELS: tuple[type[BaseModel], ...] = (
    WsCommandMessage,
    WsAckMessage,
    WsAckResultMessage,
    WsPingMessage,
    WsPongMessage,
    WsSubscribeMessage,
    WsEventMessage,
    WsErrorMessage,
)
