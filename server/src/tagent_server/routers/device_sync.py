import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from tagent_server.config import utcnow
from tagent_server.deps import get_session, require_device
from tagent_server.models import Device
from tagent_server.openapi_extra import DEVICE_SECURITY
from tagent_server.present import command_public
from tagent_server.schemas import CommandAckResponse, CommandPublic, DeviceEventBatch, DeviceEventBatchResult
from tagent_server.tasks_service import ack_command, expire_due, ingest_device_events, mark_delivered, open_commands, touch_device

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
