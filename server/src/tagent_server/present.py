from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from tagent_server.config import Settings
from tagent_server.models import Approval, Command, Device, Event, Plan, Project, Run, Task
from tagent_server.schemas import (
    ApprovalPublic,
    CommandPublic,
    DevicePublic,
    EventPublic,
    PlanPublic,
    PlanSummary,
    ProjectPublic,
    RunPublic,
    TaskDetail,
    TaskSummary,
)


def device_presence(device: Device, settings: Settings, now: datetime) -> str:
    if device.revoked_at is not None or device.last_seen_at is None:
        return "offline"
    if now - device.last_seen_at <= timedelta(seconds=settings.presence_ttl_seconds):
        return "online"
    return "offline"


def device_out(device: Device, settings: Settings, now: datetime) -> DevicePublic:
    return DevicePublic(
        device_id=device.device_id,
        label=device.label,
        public_key=device.public_key,
        capabilities=list(device.capabilities),
        last_seen_at=device.last_seen_at,
        revoked_at=device.revoked_at,
        presence=device_presence(device, settings, now),
    )


def project_out(project: Project, device: Device) -> ProjectPublic:
    availability = "unavailable" if device.revoked_at is not None else project.availability
    return ProjectPublic(
        project_id=project.project_id,
        device_id=project.device_id,
        display_name=project.display_name,
        availability=availability,
        created_at=project.created_at,
        updated_at=project.updated_at,
    )


def task_summary(task: Task, device: Device, settings: Settings, now: datetime) -> TaskSummary:
    return TaskSummary(
        task_id=task.task_id,
        project_id=task.project_id,
        target_device_id=task.target_device_id,
        requirement=task.requirement,
        status=task.status,  # type: ignore[arg-type]
        cancel_requested=task.cancel_requested_at is not None,
        cancel_requested_at=task.cancel_requested_at,
        latest_plan_id=task.latest_plan_id,
        device_presence=device_presence(device, settings, now),  # type: ignore[arg-type]
        created_at=task.created_at,
        updated_at=task.updated_at,
    )


def plan_summary(plan: Plan) -> PlanSummary:
    return PlanSummary(
        plan_id=plan.plan_id,
        version=plan.version,
        content_hash=plan.content_hash,
        created_at=plan.created_at,
        superseded_at=plan.superseded_at,
    )


def plan_public(plan: Plan) -> PlanPublic:
    return PlanPublic(
        **plan_summary(plan).model_dump(),
        task_id=plan.task_id,
        device_id=plan.device_id,
        project_id=plan.project_id,
        body=plan.body,
        workspace_fingerprint=plan.workspace_fingerprint,
        config_snapshot_id=plan.config_snapshot_id,
    )


def run_public(run: Run) -> RunPublic:
    return RunPublic(
        run_id=run.run_id,
        phase=run.phase,  # type: ignore[arg-type]
        attempt=run.attempt,
        state=run.state,  # type: ignore[arg-type]
        approval_id=run.approval_id,
        created_at=run.created_at,
        updated_at=run.updated_at,
    )


def task_detail(session: Session, task: Task, settings: Settings, now: datetime) -> TaskDetail:
    device = session.get(Device, task.target_device_id)
    assert device is not None
    plans = session.scalars(select(Plan).where(Plan.task_id == task.task_id).order_by(Plan.version)).all()
    runs = session.scalars(select(Run).where(Run.task_id == task.task_id).order_by(Run.created_at, Run.run_id)).all()
    return TaskDetail(
        **task_summary(task, device, settings, now).model_dump(),
        plans=[plan_summary(plan) for plan in plans],
        runs=[run_public(run) for run in runs],
    )


def approval_public(approval: Approval, run: Run) -> ApprovalPublic:
    return ApprovalPublic(
        approval_id=approval.approval_id,
        plan_id=approval.plan_id,
        task_id=approval.task_id,
        run_id=run.run_id,
        version=approval.version,
        content_hash=approval.content_hash,
        device_id=approval.device_id,
        project_id=approval.project_id,
        status=approval.status,  # type: ignore[arg-type]
        expires_at=approval.expires_at,
        created_at=approval.created_at,
    )


def command_public(command: Command) -> CommandPublic:
    return CommandPublic(
        command_id=command.command_id,
        command_type=command.type,  # type: ignore[arg-type]
        task_id=command.task_id,
        run_id=command.run_id,
        payload=command.payload,
        expires_at=command.expires_at,
        created_at=command.created_at,
    )


def event_public(event: Event) -> EventPublic:
    return EventPublic(
        event_id=event.event_id,
        server_cursor=event.server_cursor,
        type=event.type,
        task_id=event.task_id,
        run_id=event.run_id,
        producer_id=event.producer_id,
        producer_seq=event.producer_seq,
        schema_version=event.schema_version,
        occurred_at=event.occurred_at,
        payload=event.payload,
    )
