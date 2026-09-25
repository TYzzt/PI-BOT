import logging
import secrets
import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from tagent_server.config import Settings, utcnow
from tagent_server.deps import get_session, require_device, require_user
from tagent_server.models import Device, PairingCode, User
from tagent_server.openapi_extra import DEVICE_SECURITY, USER_SECURITY
from tagent_server.present import device_out
from tagent_server.schemas import DevicePublic, PairRequest, PairingCodeResponse
from tagent_server.security import hash_pairing_code

router = APIRouter(prefix="/devices", tags=["devices"])
logger = logging.getLogger(__name__)


@router.post("/pairing-codes", response_model=PairingCodeResponse, openapi_extra=USER_SECURITY)
def create_pairing_code(
    request: Request,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
) -> PairingCodeResponse:
    del user
    settings: Settings = request.app.state.settings
    now = utcnow()
    code = secrets.token_urlsafe(24)
    expires_at = now + timedelta(seconds=settings.pairing_ttl_seconds)
    session.add(PairingCode(code_hash=hash_pairing_code(code), expires_at=expires_at))
    logger.info("pairing code issued")
    return PairingCodeResponse(pairing_code=code, expires_at=expires_at)


@router.post("/pair", response_model=DevicePublic)
def pair_device(payload: PairRequest, request: Request, session: Session = Depends(get_session)) -> DevicePublic:
    settings: Settings = request.app.state.settings
    now = utcnow()
    consumed = session.execute(
        update(PairingCode)
        .where(
            PairingCode.code_hash == hash_pairing_code(payload.pairing_code),
            PairingCode.used_at.is_(None),
            PairingCode.expires_at > now,
        )
        .values(used_at=now)
        .returning(PairingCode.pairing_code_id)
    ).first()
    if consumed is None:
        raise HTTPException(status_code=400, detail="配对码无效")
    device = Device(public_key=payload.public_key, label=payload.label, capabilities=payload.capabilities)
    session.add(device)
    try:
        session.flush()
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="公钥已绑定未撤销设备") from exc
    logger.info("device paired")
    return device_out(device, settings, now)


@router.get("", response_model=list[DevicePublic], openapi_extra=USER_SECURITY)
def list_devices(
    request: Request,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
) -> list[DevicePublic]:
    del user
    now = utcnow()
    devices = session.scalars(select(Device).order_by(Device.created_at, Device.device_id)).all()
    return [device_out(device, request.app.state.settings, now) for device in devices]


@router.post("/{device_id}/heartbeat", response_model=DevicePublic, openapi_extra=DEVICE_SECURITY)
def heartbeat(
    device_id: uuid.UUID,
    request: Request,
    device: Device = Depends(require_device),
    session: Session = Depends(get_session),
) -> DevicePublic:
    if device.device_id != device_id:
        raise HTTPException(status_code=401, detail="设备认证失败")
    now = utcnow()
    device.last_seen_at = now
    session.flush()
    return device_out(device, request.app.state.settings, now)


@router.post("/{device_id}/revoke", response_model=DevicePublic, openapi_extra=USER_SECURITY)
def revoke_device(
    device_id: uuid.UUID,
    request: Request,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
) -> DevicePublic:
    del user
    device = session.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="设备不存在")
    if device.revoked_at is None:
        device.revoked_at = utcnow()
    return device_out(device, request.app.state.settings, utcnow())
