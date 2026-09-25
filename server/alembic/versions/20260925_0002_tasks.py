"""阶段 2 持久任务、计划版本、审批、设备命令与事件。不保存源码、diff 或原始工具输出。"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260925_0002"
down_revision: str | None = "20260925_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

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


def _in(column: str, values: Sequence[str]) -> str:
    return f"{column} IN ({', '.join(repr(value) for value in values)})"


def upgrade() -> None:
    op.create_table(
        "tasks",
        sa.Column("task_id", sa.Uuid(), primary_key=True),
        sa.Column("project_id", sa.Uuid(), sa.ForeignKey("projects.project_id"), nullable=False),
        sa.Column("target_device_id", sa.Uuid(), sa.ForeignKey("devices.device_id"), nullable=False),
        sa.Column("requirement", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("cancel_requested_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("latest_plan_id", sa.Uuid(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(_in("status", TASK_STATUSES), name="tasks_status_check"),
        sa.UniqueConstraint("idempotency_key", name="tasks_idempotency_key_key"),
    )
    op.create_index("ix_tasks_project_id", "tasks", ["project_id"])
    op.create_index("ix_tasks_target_device_id", "tasks", ["target_device_id"])

    op.create_table(
        "plans",
        sa.Column("plan_id", sa.Uuid(), primary_key=True),
        sa.Column("task_id", sa.Uuid(), sa.ForeignKey("tasks.task_id"), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("content_hash", sa.Text(), nullable=False),
        sa.Column("body", postgresql.JSONB(), nullable=False),
        sa.Column("workspace_fingerprint", sa.Text(), nullable=False),
        sa.Column("config_snapshot_id", sa.Text(), nullable=False),
        sa.Column("device_id", sa.Uuid(), sa.ForeignKey("devices.device_id"), nullable=False),
        sa.Column("project_id", sa.Uuid(), sa.ForeignKey("projects.project_id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("superseded_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("task_id", "version", name="plans_task_version_key"),
    )
    op.create_index("ix_plans_task_id", "plans", ["task_id"])

    op.create_table(
        "approvals",
        sa.Column("approval_id", sa.Uuid(), primary_key=True),
        sa.Column("plan_id", sa.Uuid(), sa.ForeignKey("plans.plan_id"), nullable=False),
        sa.Column("task_id", sa.Uuid(), sa.ForeignKey("tasks.task_id"), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("content_hash", sa.Text(), nullable=False),
        sa.Column("device_id", sa.Uuid(), sa.ForeignKey("devices.device_id"), nullable=False),
        sa.Column("project_id", sa.Uuid(), sa.ForeignKey("projects.project_id"), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("status IN ('recorded', 'rejected', 'expired')", name="approvals_status_check"),
        sa.UniqueConstraint("idempotency_key", name="approvals_idempotency_key_key"),
    )
    op.create_index("ix_approvals_task_id", "approvals", ["task_id"])
    op.create_index(
        "approvals_active_plan",
        "approvals",
        ["plan_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('recorded', 'rejected')"),
    )

    op.create_table(
        "runs",
        sa.Column("run_id", sa.Uuid(), primary_key=True),
        sa.Column("task_id", sa.Uuid(), sa.ForeignKey("tasks.task_id"), nullable=False),
        sa.Column("phase", sa.Text(), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("approval_id", sa.Uuid(), sa.ForeignKey("approvals.approval_id"), nullable=True),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(_in("state", RUN_STATES), name="runs_state_check"),
        sa.CheckConstraint("phase IN ('plan', 'execute')", name="runs_phase_check"),
    )
    op.create_index("ix_runs_task_id", "runs", ["task_id"])

    op.create_table(
        "plan_feedback",
        sa.Column("feedback_id", sa.Uuid(), primary_key=True),
        sa.Column("task_id", sa.Uuid(), sa.ForeignKey("tasks.task_id"), nullable=False),
        sa.Column("plan_id", sa.Uuid(), sa.ForeignKey("plans.plan_id"), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("feedback", sa.Text(), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("idempotency_key", name="plan_feedback_idempotency_key_key"),
    )
    op.create_index("ix_plan_feedback_task_id", "plan_feedback", ["task_id"])

    op.create_table(
        "commands",
        sa.Column("command_id", sa.Uuid(), primary_key=True),
        sa.Column("device_id", sa.Uuid(), sa.ForeignKey("devices.device_id"), nullable=False),
        sa.Column("task_id", sa.Uuid(), sa.ForeignKey("tasks.task_id"), nullable=False),
        sa.Column("run_id", sa.Uuid(), sa.ForeignKey("runs.run_id"), nullable=True),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("acked_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("type IN ('plan_request', 'plan_revise', 'execute', 'cancel')", name="commands_type_check"),
        sa.CheckConstraint(
            "status IN ('pending', 'delivered', 'acked', 'expired', 'superseded')", name="commands_status_check"
        ),
    )
    op.create_index("ix_commands_task_id", "commands", ["task_id"])
    op.create_index("commands_device_status", "commands", ["device_id", "status"])

    op.create_table(
        "events",
        sa.Column("event_id", sa.Uuid(), primary_key=True),
        sa.Column("server_cursor", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("task_id", sa.Uuid(), sa.ForeignKey("tasks.task_id"), nullable=True),
        sa.Column("run_id", sa.Uuid(), nullable=True),
        sa.Column("producer_id", sa.Text(), nullable=False),
        sa.Column("producer_seq", sa.BigInteger(), nullable=True),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.UniqueConstraint("server_cursor", name="events_server_cursor_key"),
    )
    op.create_index("ix_events_task_id", "events", ["task_id"])

    op.create_table(
        "device_event_sequences",
        sa.Column("device_id", sa.Uuid(), sa.ForeignKey("devices.device_id"), primary_key=True),
        sa.Column("last_seq", sa.BigInteger(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("device_event_sequences")
    op.drop_index("ix_events_task_id", table_name="events")
    op.drop_table("events")
    op.drop_index("commands_device_status", table_name="commands")
    op.drop_index("ix_commands_task_id", table_name="commands")
    op.drop_table("commands")
    op.drop_index("ix_plan_feedback_task_id", table_name="plan_feedback")
    op.drop_table("plan_feedback")
    op.drop_index("ix_runs_task_id", table_name="runs")
    op.drop_table("runs")
    op.drop_index("approvals_active_plan", table_name="approvals")
    op.drop_index("ix_approvals_task_id", table_name="approvals")
    op.drop_table("approvals")
    op.drop_index("ix_plans_task_id", table_name="plans")
    op.drop_table("plans")
    op.drop_index("ix_tasks_target_device_id", table_name="tasks")
    op.drop_index("ix_tasks_project_id", table_name="tasks")
    op.drop_table("tasks")
