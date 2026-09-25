import uuid

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from tagent_server.config import Settings, utcnow
from tagent_server.deps import get_session, require_device
from tagent_server.models import Device
from tagent_server.openapi_extra import DEVICE_SECURITY
from tagent_server.present import approval_public, command_public, task_detail
from tagent_server.schemas import (
    ApprovalPublic,
    ApproveRequest,
    CommandAckResponse,
    CommandPublic,
    DeviceEventBatch,
    DeviceEventBatchResult,
    RejectRequest,
    ReviseRequest,
    TaskDetail,
)
from tagent_server.tasks_service import (
    ack_command,
    approve_plan,
    expire_due,
    ingest_device_events,
    mark_delivered,
    open_commands,
    reject_plan,
    revise_plan,
    touch_device,
)

router = APIRouter(prefix="/device", tags=["device"])


@router.get("/commands", response_model=list[CommandPublic], openapi_extra=DEVICE_SECURITY)
def pull_commands(device: Device = Depends(require_device), session: Session = Depends(get_session)) -> list[CommandPublic]:
    now = utcnow()
    touch_device(session, device.device_id, now)
    expire_due(session, now, device.device_id)
    commands = open_commands(session, device.device_id, now)
    mark_delivered(session, commands, now)
    return [command_public(command) for command in commands]


@router.post("/commands/{command_id}/ack", response_model=CommandAckResponse, openapi_extra=DEVICE_SECURITY)
def ack(command_id: uuid.UUID, device: Device = Depends(require_device), session: Session = Depends(get_session)) -> CommandAckResponse:
    command = ack_command(session, device, command_id, utcnow())
    assert command.acked_at is not None
    return CommandAckResponse(command_id=command.command_id, status="acked", acked_at=command.acked_at)


@router.post("/events", response_model=DeviceEventBatchResult, openapi_extra=DEVICE_SECURITY)
def upload_events(
    payload: DeviceEventBatch,
    device: Device = Depends(require_device),
    session: Session = Depends(get_session),
) -> DeviceEventBatchResult:
    now = utcnow()
    touch_device(session, device.device_id, now)
    return ingest_device_events(session, device, payload, now)


@router.post("/plans/{plan_id}/approve", response_model=ApprovalPublic, openapi_extra=DEVICE_SECURITY)
def device_approve(
    plan_id: uuid.UUID,
    payload: ApproveRequest,
    request: Request,
    device: Device = Depends(require_device),
    session: Session = Depends(get_session),
) -> ApprovalPublic:
    now = utcnow()
    touch_device(session, device.device_id, now)
    expire_due(session, now)
    approval, run = approve_plan(session, request.app.state.settings, plan_id, payload, now, device_id=device.device_id)
    return approval_public(approval, run)


@router.post("/plans/{plan_id}/reject", response_model=TaskDetail, openapi_extra=DEVICE_SECURITY)
def device_reject(
    plan_id: uuid.UUID,
    payload: RejectRequest,
    request: Request,
    device: Device = Depends(require_device),
    session: Session = Depends(get_session),
) -> TaskDetail:
    now = utcnow()
    touch_device(session, device.device_id, now)
    expire_due(session, now)
    task = reject_plan(session, plan_id, payload, now, device_id=device.device_id)
    return task_detail(session, task, request.app.state.settings, now)


@router.post("/plans/{plan_id}/revise", response_model=TaskDetail, openapi_extra=DEVICE_SECURITY)
def device_revise(
    plan_id: uuid.UUID,
    payload: ReviseRequest,
    request: Request,
    device: Device = Depends(require_device),
    session: Session = Depends(get_session),
) -> TaskDetail:
    settings: Settings = request.app.state.settings
    now = utcnow()
    touch_device(session, device.device_id, now)
    expire_due(session, now)
    task = revise_plan(session, settings, plan_id, payload, now, device_id=device.device_id)
    return task_detail(session, task, settings, now)
