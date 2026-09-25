import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from tagent_server.config import utcnow
from tagent_server.db import Base


class User(Base):
    __tablename__ = "users"

    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    singleton: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


class PairingCode(Base):
    __tablename__ = "pairing_codes"

    pairing_code_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    code_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


class Device(Base):
    __tablename__ = "devices"

    device_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    public_key: Mapped[str] = mapped_column(Text, nullable=False)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    capabilities: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


class DeviceNonce(Base):
    __tablename__ = "device_nonces"

    device_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("devices.device_id"), primary_key=True)
    nonce: Mapped[str] = mapped_column(Text, primary_key=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Project(Base):
    __tablename__ = "projects"
    __table_args__ = (CheckConstraint("availability IN ('available', 'unavailable')", name="projects_availability_check"),)

    project_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    device_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("devices.device_id"), nullable=False, index=True)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    availability: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


TASK_STATUSES = (
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
)
RUN_STATES = (
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
)
COMMAND_TYPES = ("plan_request", "plan_revise", "execute", "cancel")
COMMAND_STATUSES = ("pending", "delivered", "acked", "expired", "superseded")
APPROVAL_STATUSES = ("recorded", "rejected", "expired")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(value) for value in values)})"


class Task(Base):
    __tablename__ = "tasks"
    __table_args__ = (CheckConstraint(_in("status", TASK_STATUSES), name="tasks_status_check"),)

    task_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("projects.project_id"), nullable=False, index=True)
    target_device_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("devices.device_id"), nullable=False, index=True)
    requirement: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    cancel_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    latest_plan_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


class Plan(Base):
    __tablename__ = "plans"
    __table_args__ = (UniqueConstraint("task_id", "version", name="plans_task_version_key"),)

    plan_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    task_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("tasks.task_id"), nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    content_hash: Mapped[str] = mapped_column(Text, nullable=False)
    body: Mapped[dict] = mapped_column(JSONB, nullable=False)
    workspace_fingerprint: Mapped[str] = mapped_column(Text, nullable=False)
    config_snapshot_id: Mapped[str] = mapped_column(Text, nullable=False)
    device_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("devices.device_id"), nullable=False)
    project_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("projects.project_id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PlanFeedback(Base):
    __tablename__ = "plan_feedback"

    feedback_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    task_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("tasks.task_id"), nullable=False, index=True)
    plan_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("plans.plan_id"), nullable=False)
    run_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    feedback: Mapped[str] = mapped_column(Text, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


class Approval(Base):
    __tablename__ = "approvals"
    __table_args__ = (
        CheckConstraint(_in("status", APPROVAL_STATUSES), name="approvals_status_check"),
        Index("approvals_active_plan", "plan_id", unique=True, postgresql_where=text("status IN ('recorded', 'rejected')")),
    )

    approval_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    plan_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("plans.plan_id"), nullable=False)
    task_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("tasks.task_id"), nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    content_hash: Mapped[str] = mapped_column(Text, nullable=False)
    device_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("devices.device_id"), nullable=False)
    project_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("projects.project_id"), nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


class Run(Base):
    __tablename__ = "runs"
    __table_args__ = (
        CheckConstraint(_in("state", RUN_STATES), name="runs_state_check"),
        CheckConstraint("phase IN ('plan', 'execute')", name="runs_phase_check"),
    )

    run_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    task_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("tasks.task_id"), nullable=False, index=True)
    phase: Mapped[str] = mapped_column(Text, nullable=False)
    attempt: Mapped[int] = mapped_column(Integer, nullable=False)
    approval_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("approvals.approval_id"), nullable=True)
    state: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


class Command(Base):
    __tablename__ = "commands"
    __table_args__ = (
        CheckConstraint(_in("type", COMMAND_TYPES), name="commands_type_check"),
        CheckConstraint(_in("status", COMMAND_STATUSES), name="commands_status_check"),
        Index("commands_device_status", "device_id", "status"),
    )

    command_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    device_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("devices.device_id"), nullable=False)
    task_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("tasks.task_id"), nullable=False, index=True)
    run_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("runs.run_id"), nullable=True)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    acked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Event(Base):
    __tablename__ = "events"

    event_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    server_cursor: Mapped[int] = mapped_column(BigInteger, Identity(always=True), nullable=False, unique=True)
    task_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("tasks.task_id"), nullable=True, index=True)
    run_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    producer_id: Mapped[str] = mapped_column(Text, nullable=False)
    producer_seq: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)


class DeviceEventSequence(Base):
    __tablename__ = "device_event_sequences"

    device_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("devices.device_id"), primary_key=True)
    last_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
