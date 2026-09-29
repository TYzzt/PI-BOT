import hashlib
import json
import uuid
from datetime import datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import func, select, text, update
from sqlalchemy.orm import Session

from tagent_server.config import Settings
from tagent_server.models import Approval, Command, Device, DeviceEventSequence, Event, Plan, PlanFeedback, Project, Run, Task
from tagent_server.present import device_presence
from tagent_server.schemas import (
    ApproveRequest,
    DeviceEventBatch,
    DeviceEventBatchResult,
    PlanPublish,
    RejectRequest,
    ReviseRequest,
    SequenceGap,
    TaskCreate,
)

NOTIFY_CHANNEL = "tagent_changes"
# 所有写入任务、计划、审批、命令、事件的事务都先取这把事务级锁：
# 提交顺序因此与 server_cursor 顺序一致，按 cursor 补拉不会漏掉晚提交的小 cursor。
WRITE_LOCK_KEY = 7_420_250_925
EVENT_SCHEMA_VERSION = 1

TERMINAL_TASK = frozenset({"completed", "failed", "cancelled", "rejected"})
ACTIVE_RUN = frozenset({"queued", "running", "waiting_for_input", "waiting_for_local_action"})
PLAN_COMMANDS = frozenset({"plan_request", "plan_revise"})
OPEN_COMMAND = ("pending", "delivered")

RUN_EVENT_STATE = {
    "run.started": "running",
    "run.waiting_for_input": "waiting_for_input",
    "run.waiting_for_local_action": "waiting_for_local_action",
    "run.interrupted": "interrupted",
    "run.needs_replan": "needs_replan",
    "run.completed": "completed",
    "run.failed": "failed",
    "run.cancelled": "cancelled",
}


def canonical_json(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def plan_content_hash(
    *,
    task_id: uuid.UUID,
    version: int,
    project_id: uuid.UUID,
    device_id: uuid.UUID,
    body: dict,
    workspace_fingerprint: str,
    config_snapshot_id: str,
) -> str:
    material = {
        "task_id": str(task_id),
        "version": version,
        "project_id": str(project_id),
        "device_id": str(device_id),
        "body": body,
        "workspace_fingerprint": workspace_fingerprint,
        "config_snapshot_id": config_snapshot_id,
    }
    return hashlib.sha256(canonical_json(material)).hexdigest()


def write_lock(session: Session) -> None:
    session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": WRITE_LOCK_KEY})


def notify_changes(session: Session) -> None:
    session.execute(text("SELECT pg_notify(:channel, '')"), {"channel": NOTIFY_CHANNEL})


def append_event(
    session: Session,
    *,
    type: str,
    task_id: uuid.UUID | None,
    now: datetime,
    run_id: uuid.UUID | None = None,
    payload: dict | None = None,
    producer_id: str = "server",
    producer_seq: int | None = None,
    event_id: uuid.UUID | None = None,
    occurred_at: datetime | None = None,
) -> Event:
    event = Event(
        event_id=event_id or uuid.uuid4(),
        task_id=task_id,
        run_id=run_id,
        producer_id=producer_id,
        producer_seq=producer_seq,
        type=type,
        schema_version=EVENT_SCHEMA_VERSION,
        occurred_at=occurred_at or now,
        recorded_at=now,
        payload=payload or {},
    )
    session.add(event)
    session.flush()
    notify_changes(session)
    return event


def set_task_status(session: Session, task: Task, status: str, now: datetime) -> None:
    if task.status == status:
        return
    previous = task.status
    task.status = status
    task.updated_at = now
    append_event(session, type="task.status_changed", task_id=task.task_id, now=now, payload={"status": status, "previous": previous})


def touch_device(session: Session, device_id: uuid.UUID, now: datetime) -> None:
    session.execute(update(Device).where(Device.device_id == device_id).values(last_seen_at=now))


def load_task(session: Session, task_id: uuid.UUID) -> Task:
    task = session.get(Task, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    return task


def _get_plan(session: Session, plan_id: uuid.UUID) -> tuple[Plan, Task]:
    plan = session.get(Plan, plan_id)
    if plan is None:
        raise HTTPException(status_code=404, detail="计划不存在")
    return plan, load_task(session, plan.task_id)


def _require_target_usable(session: Session, task: Task) -> Device:
    device = session.get(Device, task.target_device_id)
    project = session.get(Project, task.project_id)
    if device is None or device.revoked_at is not None:
        raise HTTPException(status_code=409, detail="执行设备已撤销")
    if project is None or project.device_id != task.target_device_id:
        raise HTTPException(status_code=409, detail="项目已改绑到其他设备")
    return device


def _require_actor_device(task: Task, device_id: uuid.UUID | None) -> str:
    if device_id is None:
        return "user"
    if task.target_device_id != device_id:
        raise HTTPException(status_code=403, detail="只有任务的执行设备可以审批")
    return "device"


def _require_latest(task: Task, plan: Plan) -> None:
    if plan.superseded_at is not None or task.latest_plan_id != plan.plan_id:
        raise HTTPException(status_code=409, detail="计划已被新版本取代")


def _queue_status(device: Device, settings: Settings, now: datetime) -> str:
    return "queued" if device_presence(device, settings, now) == "online" else "waiting_for_device"


def _next_attempt(session: Session, task_id: uuid.UUID, phase: str) -> int:
    count = session.scalar(select(func.count()).select_from(Run).where(Run.task_id == task_id, Run.phase == phase))
    return int(count or 0) + 1


def _new_run(session: Session, task: Task, phase: str, now: datetime, approval_id: uuid.UUID | None = None) -> Run:
    run = Run(
        task_id=task.task_id,
        phase=phase,
        attempt=_next_attempt(session, task.task_id, phase),
        approval_id=approval_id,
        state="queued",
        created_at=now,
        updated_at=now,
    )
    session.add(run)
    session.flush()
    return run


def _new_command(
    session: Session,
    task: Task,
    run: Run | None,
    type: str,
    payload: dict,
    expires_at: datetime,
    now: datetime,
) -> Command:
    command = Command(
        device_id=task.target_device_id,
        task_id=task.task_id,
        run_id=run.run_id if run else None,
        type=type,
        payload=payload,
        status="pending",
        expires_at=expires_at,
        created_at=now,
    )
    session.add(command)
    session.flush()
    notify_changes(session)
    return command


def _set_run_state(run: Run, state: str, now: datetime) -> None:
    if run.state != state:
        run.state = state
        run.updated_at = now


def create_task(
    session: Session,
    settings: Settings,
    payload: TaskCreate,
    now: datetime,
    conversation_id: uuid.UUID | None = None,
    message_id: uuid.UUID | None = None,
) -> Task:
    write_lock(session)
    existing = session.scalars(select(Task).where(Task.idempotency_key == payload.idempotency_key)).first()
    if existing is not None:
        if existing.project_id != payload.project_id or existing.requirement != payload.requirement:
            raise HTTPException(status_code=409, detail="幂等键已用于其他请求")
        return existing
    project = session.get(Project, payload.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="项目不存在")
    device = session.get(Device, project.device_id)
    if device is None or device.revoked_at is not None or project.availability != "available":
        raise HTTPException(status_code=409, detail="项目不可用")
    task = Task(
        project_id=project.project_id,
        target_device_id=device.device_id,
        requirement=payload.requirement,
        status=_queue_status(device, settings, now),
        idempotency_key=payload.idempotency_key,
        created_at=now,
        updated_at=now,
    )
    session.add(task)
    session.flush()
    run = _new_run(session, task, "plan", now)
    command_payload: dict = {
        "task_id": str(task.task_id),
        "run_id": str(run.run_id),
        "project_id": str(project.project_id),
        "requirement": task.requirement,
    }
    if conversation_id is not None:
        command_payload["conversation_id"] = str(conversation_id)
    if message_id is not None:
        command_payload["message_id"] = str(message_id)
    _new_command(
        session,
        task,
        run,
        "plan_request",
        command_payload,
        now + timedelta(seconds=settings.command_ttl_seconds),
        now,
    )
    append_event(
        session,
        type="task.created",
        task_id=task.task_id,
        run_id=run.run_id,
        now=now,
        payload={"status": task.status, "project_id": str(project.project_id), "target_device_id": str(device.device_id)},
    )
    return task


def publish_plan(session: Session, device: Device, task_id: uuid.UUID, payload: PlanPublish, now: datetime) -> Plan:
    write_lock(session)
    task = load_task(session, task_id)
    if task.target_device_id != device.device_id:
        raise HTTPException(status_code=404, detail="任务不存在")
    project = session.get(Project, task.project_id)
    if project is None or project.device_id != device.device_id:
        raise HTTPException(status_code=409, detail="项目已改绑到其他设备")
    existing = session.scalars(select(Plan).where(Plan.task_id == task.task_id, Plan.version == payload.version)).first()
    if existing is not None:
        if existing.content_hash == payload.content_hash:
            return existing
        raise HTTPException(status_code=409, detail="该版本已发布，不能改写")
    run = session.get(Run, payload.run_id)
    if run is None or run.task_id != task.task_id or run.phase != "plan":
        raise HTTPException(status_code=400, detail="规划运行无效")
    if run.state not in ACTIVE_RUN:
        raise HTTPException(status_code=409, detail="规划运行已结束")
    if task.status in TERMINAL_TASK or task.cancel_requested_at is not None:
        raise HTTPException(status_code=409, detail="任务已结束或正在取消")
    latest_version = session.scalar(select(func.max(Plan.version)).where(Plan.task_id == task.task_id)) or 0
    if payload.version != latest_version + 1:
        raise HTTPException(status_code=409, detail="版本号不连续")
    body = payload.body.model_dump(mode="json")
    expected = plan_content_hash(
        task_id=task.task_id,
        version=payload.version,
        project_id=task.project_id,
        device_id=device.device_id,
        body=body,
        workspace_fingerprint=payload.workspace_fingerprint,
        config_snapshot_id=payload.config_snapshot_id,
    )
    if expected != payload.content_hash:
        raise HTTPException(status_code=400, detail="content_hash 与计划内容不符")
    plan = Plan(
        task_id=task.task_id,
        version=payload.version,
        content_hash=payload.content_hash,
        body=body,
        workspace_fingerprint=payload.workspace_fingerprint,
        config_snapshot_id=payload.config_snapshot_id,
        device_id=device.device_id,
        project_id=task.project_id,
        created_at=now,
    )
    session.add(plan)
    session.flush()
    for old in session.scalars(
        select(Plan).where(Plan.task_id == task.task_id, Plan.superseded_at.is_(None), Plan.plan_id != plan.plan_id)
    ).all():
        old.superseded_at = now
        append_event(
            session,
            type="plan.superseded",
            task_id=task.task_id,
            now=now,
            payload={"plan_id": str(old.plan_id), "version": old.version, "superseded_by": str(plan.plan_id)},
        )
    for command in session.scalars(
        select(Command).where(Command.run_id == run.run_id, Command.status.in_(OPEN_COMMAND))
    ).all():
        command.status = "acked"
        command.delivered_at = command.delivered_at or now
        command.acked_at = now
    task.latest_plan_id = plan.plan_id
    _set_run_state(run, "completed", now)
    append_event(
        session,
        type="plan.published",
        task_id=task.task_id,
        run_id=run.run_id,
        now=now,
        payload={"plan_id": str(plan.plan_id), "version": plan.version, "content_hash": plan.content_hash},
    )
    set_task_status(session, task, "waiting_for_input" if body.get("questions") else "awaiting_review", now)
    return plan


def approve_plan(
    session: Session,
    settings: Settings,
    plan_id: uuid.UUID,
    payload: ApproveRequest,
    now: datetime,
    device_id: uuid.UUID | None = None,
) -> tuple[Approval, Run]:
    write_lock(session)
    plan, task = _get_plan(session, plan_id)
    actor = _require_actor_device(task, device_id)
    if payload.version != plan.version or payload.content_hash != plan.content_hash:
        raise HTTPException(status_code=409, detail="计划版本或 hash 不匹配")
    by_key = session.scalars(select(Approval).where(Approval.idempotency_key == payload.idempotency_key)).first()
    if by_key is not None:
        if by_key.plan_id != plan.plan_id or by_key.status == "rejected":
            raise HTTPException(status_code=409, detail="幂等键已用于其他请求")
        return by_key, _run_for_approval(session, by_key)
    recorded = session.scalars(select(Approval).where(Approval.plan_id == plan.plan_id, Approval.status == "recorded")).first()
    if recorded is not None:
        return recorded, _run_for_approval(session, recorded)
    _require_latest(task, plan)
    if task.status != "awaiting_review" or task.cancel_requested_at is not None:
        raise HTTPException(status_code=409, detail="任务当前不能批准")
    if plan.body.get("questions"):
        raise HTTPException(status_code=409, detail="请先回答计划中的待确认问题")
    _require_target_usable(session, task)
    approval = Approval(
        plan_id=plan.plan_id,
        task_id=task.task_id,
        version=plan.version,
        content_hash=plan.content_hash,
        device_id=task.target_device_id,
        project_id=task.project_id,
        status="recorded",
        actor=actor,
        expires_at=now + timedelta(seconds=settings.approval_ttl_seconds),
        idempotency_key=payload.idempotency_key,
        created_at=now,
    )
    session.add(approval)
    session.flush()
    run = _new_run(session, task, "execute", now, approval_id=approval.approval_id)
    assert approval.expires_at is not None
    _new_command(
        session,
        task,
        run,
        "execute",
        {
            "task_id": str(task.task_id),
            "run_id": str(run.run_id),
            "project_id": str(task.project_id),
            "approval_id": str(approval.approval_id),
            "plan_id": str(plan.plan_id),
            "version": plan.version,
            "content_hash": plan.content_hash,
            "expires_at": approval.expires_at.isoformat(),
        },
        approval.expires_at,
        now,
    )
    append_event(
        session,
        type="approval.recorded",
        task_id=task.task_id,
        run_id=run.run_id,
        now=now,
        payload={
            "approval_id": str(approval.approval_id),
            "plan_id": str(plan.plan_id),
            "version": plan.version,
            "expires_at": approval.expires_at.isoformat(),
            "actor": actor,
        },
    )
    set_task_status(session, task, "approved", now)
    return approval, run


def _run_for_approval(session: Session, approval: Approval) -> Run:
    run = session.scalars(select(Run).where(Run.approval_id == approval.approval_id)).first()
    assert run is not None
    return run


def reject_plan(
    session: Session,
    plan_id: uuid.UUID,
    payload: RejectRequest,
    now: datetime,
    device_id: uuid.UUID | None = None,
) -> Task:
    write_lock(session)
    plan, task = _get_plan(session, plan_id)
    actor = _require_actor_device(task, device_id)
    by_key = session.scalars(select(Approval).where(Approval.idempotency_key == payload.idempotency_key)).first()
    if by_key is not None:
        if by_key.plan_id != plan.plan_id or by_key.status != "rejected":
            raise HTTPException(status_code=409, detail="幂等键已用于其他请求")
        return task
    _require_latest(task, plan)
    if task.status not in ("awaiting_review", "waiting_for_input"):
        raise HTTPException(status_code=409, detail="任务当前不能拒绝")
    approval = Approval(
        plan_id=plan.plan_id,
        task_id=task.task_id,
        version=plan.version,
        content_hash=plan.content_hash,
        device_id=task.target_device_id,
        project_id=task.project_id,
        status="rejected",
        actor=actor,
        expires_at=None,
        idempotency_key=payload.idempotency_key,
        created_at=now,
    )
    session.add(approval)
    session.flush()
    append_event(
        session,
        type="approval.rejected",
        task_id=task.task_id,
        now=now,
        payload={"approval_id": str(approval.approval_id), "plan_id": str(plan.plan_id), "version": plan.version, "actor": actor},
    )
    set_task_status(session, task, "rejected", now)
    return task


def revise_plan(
    session: Session,
    settings: Settings,
    plan_id: uuid.UUID,
    payload: ReviseRequest,
    now: datetime,
    device_id: uuid.UUID | None = None,
    conversation_id: uuid.UUID | None = None,
    message_id: uuid.UUID | None = None,
) -> Task:
    write_lock(session)
    plan, task = _get_plan(session, plan_id)
    actor = _require_actor_device(task, device_id)
    by_key = session.scalars(select(PlanFeedback).where(PlanFeedback.idempotency_key == payload.idempotency_key)).first()
    if by_key is not None:
        if by_key.plan_id != plan.plan_id:
            raise HTTPException(status_code=409, detail="幂等键已用于其他请求")
        return task
    _require_latest(task, plan)
    if task.status not in ("awaiting_review", "waiting_for_input", "needs_replan", "interrupted") or task.cancel_requested_at is not None:
        raise HTTPException(status_code=409, detail="任务当前不能修改计划")
    device = _require_target_usable(session, task)
    run = _new_run(session, task, "plan", now)
    session.add(
        PlanFeedback(
            task_id=task.task_id,
            plan_id=plan.plan_id,
            run_id=run.run_id,
            feedback=payload.feedback,
            actor=actor,
            idempotency_key=payload.idempotency_key,
            created_at=now,
        )
    )
    revise_payload: dict = {
        "task_id": str(task.task_id),
        "run_id": str(run.run_id),
        "project_id": str(task.project_id),
        "base_plan_id": str(plan.plan_id),
        "base_version": plan.version,
        "feedback": payload.feedback,
    }
    if conversation_id is not None:
        revise_payload["conversation_id"] = str(conversation_id)
    if message_id is not None:
        revise_payload["message_id"] = str(message_id)
    _new_command(
        session,
        task,
        run,
        "plan_revise",
        revise_payload,
        now + timedelta(seconds=settings.command_ttl_seconds),
        now,
    )
    append_event(
        session,
        type="plan.revision_requested",
        task_id=task.task_id,
        run_id=run.run_id,
        now=now,
        payload={"plan_id": str(plan.plan_id), "version": plan.version, "actor": actor},
    )
    set_task_status(session, task, _queue_status(device, settings, now), now)
    return task


def cancel_task(session: Session, settings: Settings, task_id: uuid.UUID, now: datetime) -> Task:
    write_lock(session)
    task = load_task(session, task_id)
    if task.status == "cancelled" or task.cancel_requested_at is not None:
        return task
    if task.status in TERMINAL_TASK:
        raise HTTPException(status_code=409, detail="任务已结束")
    for command in session.scalars(
        select(Command).where(Command.task_id == task.task_id, Command.status.in_(OPEN_COMMAND), Command.type != "cancel")
    ).all():
        command.status = "superseded"
    runs = session.scalars(select(Run).where(Run.task_id == task.task_id, Run.state.in_(ACTIVE_RUN))).all()
    # 设备必须先 ack 才会开始执行，所以只有已 ack 的运行需要设备确认取消。
    acked_runs = {
        run_id
        for run_id in session.scalars(
            select(Command.run_id).where(Command.task_id == task.task_id, Command.acked_at.is_not(None), Command.type != "cancel")
        ).all()
    }
    running = [run for run in runs if run.run_id in acked_runs]
    if not running:
        for run in runs:
            _set_run_state(run, "cancelled", now)
        set_task_status(session, task, "cancelled", now)
        return task
    target = max(running, key=lambda item: item.created_at)
    task.cancel_requested_at = now
    task.updated_at = now
    _new_command(
        session,
        task,
        target,
        "cancel",
        {"task_id": str(task.task_id), "run_id": str(target.run_id)},
        now + timedelta(seconds=settings.command_ttl_seconds),
        now,
    )
    append_event(session, type="task.cancel_requested", task_id=task.task_id, run_id=target.run_id, now=now, payload={})
    return task


def _due_filter(now: datetime, device_id: uuid.UUID | None):
    conditions = [Command.status.in_(OPEN_COMMAND), Command.expires_at <= now]
    if device_id is not None:
        conditions.append(Command.device_id == device_id)
    return conditions


def expire_due(session: Session, now: datetime, device_id: uuid.UUID | None = None) -> None:
    if session.scalars(select(Command.command_id).where(*_due_filter(now, device_id)).limit(1)).first() is None:
        return
    write_lock(session)
    for command in session.scalars(select(Command).where(*_due_filter(now, device_id)).order_by(Command.created_at)).all():
        command.status = "expired"
        task = session.get(Task, command.task_id)
        run = session.get(Run, command.run_id) if command.run_id else None
        assert task is not None
        if command.type == "execute" and run is not None:
            _set_run_state(run, "expired", now)
            approval = session.get(Approval, run.approval_id) if run.approval_id else None
            if approval is not None and approval.status == "recorded":
                approval.status = "expired"
                append_event(
                    session,
                    type="approval.expired",
                    task_id=task.task_id,
                    run_id=run.run_id,
                    now=now,
                    payload={"approval_id": str(approval.approval_id), "plan_id": str(approval.plan_id)},
                )
            if task.status == "approved":
                set_task_status(session, task, "awaiting_review", now)
        elif command.type in PLAN_COMMANDS:
            if run is not None and run.state in ACTIVE_RUN:
                _set_run_state(run, "expired", now)
            append_event(
                session,
                type="command.expired",
                task_id=task.task_id,
                run_id=command.run_id,
                now=now,
                payload={"command_id": str(command.command_id), "command_type": command.type},
            )
            if task.status in ("queued", "waiting_for_device", "planning"):
                set_task_status(session, task, "interrupted", now)
        elif command.type == "cancel":
            task.cancel_requested_at = None
            task.updated_at = now
            append_event(
                session,
                type="task.cancel_expired",
                task_id=task.task_id,
                run_id=command.run_id,
                now=now,
                payload={"command_id": str(command.command_id)},
            )


def open_commands(session: Session, device_id: uuid.UUID, now: datetime) -> list[Command]:
    return list(
        session.scalars(
            select(Command)
            .where(Command.device_id == device_id, Command.status.in_(OPEN_COMMAND), Command.expires_at > now)
            .order_by(Command.created_at, Command.command_id)
        ).all()
    )


def mark_delivered(session: Session, commands: list[Command], now: datetime) -> None:
    pending = [command for command in commands if command.status == "pending"]
    if not pending:
        return
    write_lock(session)
    session.flush()
    for command in pending:
        session.refresh(command)
        if command.status != "pending":
            continue
        command.status = "delivered"
        command.delivered_at = now
        if command.type in PLAN_COMMANDS:
            task = session.get(Task, command.task_id)
            if task is not None and task.status == "waiting_for_device":
                set_task_status(session, task, "queued", now)


def ack_command(session: Session, device: Device, command_id: uuid.UUID, now: datetime) -> Command:
    expire_due(session, now, device.device_id)
    write_lock(session)
    command = session.get(Command, command_id)
    if command is None or command.device_id != device.device_id:
        raise HTTPException(status_code=404, detail="命令不存在")
    if command.status == "acked":
        return command
    if command.status == "expired":
        raise HTTPException(status_code=409, detail="命令已过期")
    if command.status == "superseded":
        raise HTTPException(status_code=409, detail="命令已失效")
    command.status = "acked"
    command.delivered_at = command.delivered_at or now
    command.acked_at = now
    if command.type in PLAN_COMMANDS and command.run_id is not None:
        run = session.get(Run, command.run_id)
        task = session.get(Task, command.task_id)
        if run is not None and run.state == "queued":
            _set_run_state(run, "running", now)
        if task is not None and task.status in ("queued", "waiting_for_device"):
            set_task_status(session, task, "planning", now)
    notify_changes(session)
    return command


def ingest_device_events(session: Session, device: Device, batch: DeviceEventBatch, now: datetime) -> DeviceEventBatchResult:
    write_lock(session)
    sequence = session.get(DeviceEventSequence, device.device_id)
    last_seq = sequence.last_seq if sequence is not None else 0
    accepted = 0
    duplicates = 0
    gaps: list[SequenceGap] = []
    for item in sorted(batch.events, key=lambda event: event.producer_seq):
        if session.get(Event, item.event_id) is not None:
            duplicates += 1
            continue
        task = session.get(Task, item.task_id)
        if task is None or task.target_device_id != device.device_id:
            raise HTTPException(status_code=404, detail="任务不存在")
        run: Run | None = None
        if item.run_id is not None:
            run = session.get(Run, item.run_id)
            if run is None or run.task_id != task.task_id:
                raise HTTPException(status_code=400, detail="运行无效")
        elif item.type.startswith("run."):
            raise HTTPException(status_code=400, detail="运行事件必须带 run_id")
        if item.producer_seq > last_seq + 1:
            gaps.append(SequenceGap(expected=last_seq + 1, received=item.producer_seq))
        last_seq = max(last_seq, item.producer_seq)
        append_event(
            session,
            type=item.type,
            task_id=task.task_id,
            run_id=item.run_id,
            now=now,
            payload=item.payload.model_dump(mode="json", exclude_none=True),
            producer_id=str(device.device_id),
            producer_seq=item.producer_seq,
            event_id=item.event_id,
            occurred_at=item.occurred_at,
        )
        accepted += 1
        if run is not None and item.type in RUN_EVENT_STATE:
            _project_run_event(session, task, run, item.type, now)
    if sequence is None:
        session.add(DeviceEventSequence(device_id=device.device_id, last_seq=last_seq))
    else:
        sequence.last_seq = last_seq
    return DeviceEventBatchResult(accepted=accepted, duplicates=duplicates, gaps=gaps, last_seq=last_seq)


def _project_run_event(session: Session, task: Task, run: Run, event_type: str, now: datetime) -> None:
    state = RUN_EVENT_STATE[event_type]
    _set_run_state(run, state, now)
    if task.status == "rejected":
        return
    if state == "running":
        status = "running" if run.phase == "execute" else "planning"
    elif state == "completed":
        if run.phase != "execute":
            return
        status = "completed"
    else:
        status = state
    set_task_status(session, task, status, now)
