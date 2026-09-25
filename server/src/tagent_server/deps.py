import uuid
from collections.abc import Generator, Mapping
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request
from sqlalchemy import delete
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from tagent_server.config import Settings, utcnow
from tagent_server.models import Device, DeviceNonce, User
from tagent_server.security import AuthError, canonical_message, read_user_id, verify_device_signature


def get_session(request: Request) -> Generator[Session, None, None]:
    factory = sessionmaker(bind=request.app.state.engine)
    session = factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


async def read_body(request: Request) -> bytes:
    body = await request.body()
    request.state.raw_body = body
    return body


def require_user(request: Request, session: Session = Depends(get_session)) -> User:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(status_code=401, detail="需要认证")
    try:
        user_id = read_user_id(token.strip(), request.app.state.settings)
    except AuthError as exc:
        raise HTTPException(status_code=401, detail="认证失败") from exc
    user = session.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="认证失败")
    return user


def _required_header(headers: Mapping[str, str], name: str) -> str:
    value = headers.get(name, "").strip()
    if not value:
        raise HTTPException(status_code=401, detail="设备认证失败")
    return value


def authenticate_device(request: Request, session: Session, body: bytes) -> Device:
    return verify_device_request(request.headers, request.method, request.url.path, body, request.app.state.settings, session)


def verify_device_request(
    headers: Mapping[str, str],
    method: str,
    path: str,
    body: bytes,
    settings: Settings,
    session: Session,
) -> Device:
    device_id_raw = _required_header(headers, "x-tagnet-device-id")
    timestamp = _required_header(headers, "x-tagnet-timestamp")
    nonce = _required_header(headers, "x-tagnet-nonce")
    signature = _required_header(headers, "x-tagnet-signature")
    if len(nonce) < 16 or len(nonce) > 128 or len(signature) > 512:
        raise HTTPException(status_code=401, detail="设备认证失败")
    try:
        device_id = uuid.UUID(device_id_raw)
        issued_at = int(timestamp)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="设备认证失败") from exc
    now = utcnow()
    if abs(int(now.timestamp()) - issued_at) > settings.signature_skew_seconds:
        raise HTTPException(status_code=401, detail="设备认证失败")
    device = session.get(Device, device_id)
    if device is None or device.revoked_at is not None:
        raise HTTPException(status_code=401, detail="设备认证失败")
    message = canonical_message(timestamp, nonce, method, path, body)
    try:
        verify_device_signature(device.public_key, signature, message)
    except AuthError as exc:
        raise HTTPException(status_code=401, detail="设备认证失败") from exc
    session.execute(delete(DeviceNonce).where(DeviceNonce.expires_at < now))
    session.add(
        DeviceNonce(
            device_id=device.device_id,
            nonce=nonce,
            expires_at=datetime.fromtimestamp(issued_at, timezone.utc) + timedelta(seconds=settings.signature_skew_seconds),
        )
    )
    try:
        session.flush()
    except IntegrityError as exc:
        raise HTTPException(status_code=401, detail="设备认证失败") from exc
    return device


def require_device(request: Request, body: bytes = Depends(read_body), session: Session = Depends(get_session)) -> Device:
    if request.headers.get("authorization"):
        raise HTTPException(status_code=403, detail="当前身份不能执行此操作")
    return authenticate_device(request, session, body)


def require_actor(
    request: Request,
    body: bytes = Depends(read_body),
    session: Session = Depends(get_session),
) -> tuple[str, User | Device]:
    has_user = bool(request.headers.get("authorization"))
    has_device = bool(request.headers.get("x-tagnet-signature"))
    if has_user and has_device:
        raise HTTPException(status_code=400, detail="不能同时使用用户令牌和设备签名")
    if has_user:
        return "user", require_user(request, session)
    if has_device:
        return "device", authenticate_device(request, session, body)
    raise HTTPException(status_code=401, detail="需要认证")
