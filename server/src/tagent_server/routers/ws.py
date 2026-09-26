import asyncio
import json
import time
import uuid

import anyio
from collections.abc import Awaitable, Callable

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import ValidationError
from sqlalchemy.orm import Session, sessionmaker
from starlette.concurrency import run_in_threadpool

from tagent_server.config import Settings, utcnow
from tagent_server.deps import verify_device_request
from tagent_server.models import Device, User
from tagent_server.present import command_public
from tagent_server.routers.events import read_events
from tagent_server.schemas import WsAckMessage, WsPingMessage, WsSubscribeMessage
from tagent_server.security import AuthError, read_token
from tagent_server.tasks_service import ack_command, expire_due, mark_delivered, open_commands, touch_device

router = APIRouter()

DEVICE_WS_PATH = "/ws/device"
CLOSE_UNAUTHORIZED = 4401
CLOSE_BAD_REQUEST = 4400
SUBSCRIBE_TIMEOUT_SECONDS = 30
EVENT_PAGE = 500


def _transaction(websocket: WebSocket, work: Callable[[Session], object]) -> object:
    factory = sessionmaker(bind=websocket.app.state.engine)
    with factory() as session:
        try:
            result = work(session)
            session.commit()
            return result
        except Exception:
            session.rollback()
            raise


async def _run(websocket: WebSocket, work: Callable[[Session], object]) -> object:
    return await run_in_threadpool(_transaction, websocket, work)


class _Sender:
    def __init__(self, websocket: WebSocket) -> None:
        self._websocket = websocket
        self._lock = asyncio.Lock()

    async def send(self, message: dict) -> None:
        async with self._lock:
            await self._websocket.send_text(json.dumps(message, ensure_ascii=False))


async def _race(*coroutines: Awaitable[None]) -> None:
    tasks = [asyncio.ensure_future(coroutine) for coroutine in coroutines]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            exception = task.exception()
            if exception is not None and not isinstance(exception, WebSocketDisconnect):
                raise exception
    finally:
        with anyio.CancelScope(shield=True):
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)


async def _wait(event: asyncio.Event, timeout: float) -> None:
    try:
        await asyncio.wait_for(event.wait(), timeout=timeout)
    except TimeoutError:
        pass


def _parse(raw: str) -> dict | None:
    try:
        value = json.loads(raw)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


@router.websocket(DEVICE_WS_PATH)
async def device_socket(websocket: WebSocket) -> None:
    settings: Settings = websocket.app.state.settings

    def authenticate(session: Session) -> uuid.UUID:
        device = verify_device_request(websocket.headers, "GET", DEVICE_WS_PATH, b"", settings, session)
        touch_device(session, device.device_id, utcnow())
        return device.device_id

    try:
        device_id = await _run(websocket, authenticate)
    except HTTPException:
        await websocket.close(code=CLOSE_UNAUTHORIZED)
        return
    assert isinstance(device_id, uuid.UUID)
    await websocket.accept()
    hub = websocket.app.state.hub
    waiter = hub.subscribe()
    sender = _Sender(websocket)
    sent: set[uuid.UUID] = set()
    heartbeat = max(1.0, min(15.0, settings.presence_ttl_seconds / 3))

    def cycle(session: Session) -> list[dict] | None:
        device = session.get(Device, device_id)
        if device is None or device.revoked_at is not None:
            return None
        now = utcnow()
        touch_device(session, device_id, now)
        expire_due(session, now, device_id)
        fresh = [command for command in open_commands(session, device_id, now) if command.command_id not in sent]
        mark_delivered(session, fresh, now)
        sent.update(command.command_id for command in fresh)
        return [{"type": "command", **command_public(command).model_dump(mode="json")} for command in fresh]

    async def push() -> None:
        while True:
            waiter.clear()
            messages = await _run(websocket, cycle)
            if messages is None:
                await websocket.close(code=CLOSE_UNAUTHORIZED)
                return
            assert isinstance(messages, list)
            for message in messages:
                await sender.send(message)
            await _wait(waiter, heartbeat)

    async def receive() -> None:
        while True:
            data = _parse(await websocket.receive_text())
            kind = data.get("type") if data else None
            try:
                if kind == "ack":
                    ack = WsAckMessage.model_validate(data)
                    await _handle_ack(ack.command_id)
                elif kind == "ping":
                    WsPingMessage.model_validate(data)
                    await _run(websocket, lambda session: touch_device(session, device_id, utcnow()))
                    await sender.send({"type": "pong"})
                else:
                    await sender.send({"type": "error", "detail": "无法识别的消息"})
            except ValidationError:
                await sender.send({"type": "error", "detail": "消息格式错误"})

    async def _handle_ack(command_id: uuid.UUID) -> None:
        def work(session: Session) -> None:
            device = session.get(Device, device_id)
            if device is None or device.revoked_at is not None:
                raise HTTPException(status_code=401, detail="设备认证失败")
            ack_command(session, device, command_id, utcnow())

        try:
            await _run(websocket, work)
        except HTTPException as exc:
            await sender.send({"type": "ack_result", "command_id": str(command_id), "ok": False, "detail": str(exc.detail)})
            return
        await sender.send({"type": "ack_result", "command_id": str(command_id), "ok": True})

    try:
        await _race(push(), receive())
    finally:
        hub.unsubscribe(waiter)


@router.websocket("/ws/events")
async def event_socket(websocket: WebSocket) -> None:
    settings: Settings = websocket.app.state.settings
    scheme, _, token = websocket.headers.get("authorization", "").partition(" ")

    def authenticate(session: Session) -> int:
        if scheme.lower() != "bearer" or not token.strip():
            raise AuthError
        user_id, expires_at = read_token(token.strip(), settings)
        if session.get(User, user_id) is None:
            raise AuthError
        return expires_at

    try:
        expires_at = await _run(websocket, authenticate)
    except AuthError:
        await websocket.close(code=CLOSE_UNAUTHORIZED)
        return
    assert isinstance(expires_at, int)
    await websocket.accept()
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=SUBSCRIBE_TIMEOUT_SECONDS)
        subscribe = WsSubscribeMessage.model_validate(_parse(raw))
    except (TimeoutError, ValidationError):
        await websocket.close(code=CLOSE_BAD_REQUEST)
        return
    except WebSocketDisconnect:
        return
    hub = websocket.app.state.hub
    waiter = hub.subscribe()
    sender = _Sender(websocket)
    cursor = subscribe.after

    async def push() -> None:
        nonlocal cursor
        while True:
            if time.time() >= expires_at:
                await websocket.close(code=CLOSE_UNAUTHORIZED)
                return
            waiter.clear()
            page = await _run(websocket, lambda session: read_events(session, cursor, EVENT_PAGE))
            for event in page.events:  # type: ignore[attr-defined]
                await sender.send({"type": "event", "event": event.model_dump(mode="json")})
            cursor = page.next_cursor  # type: ignore[attr-defined]
            if page.has_more:  # type: ignore[attr-defined]
                continue
            await _wait(waiter, 25.0)

    async def receive() -> None:
        while True:
            data = _parse(await websocket.receive_text())
            if data and data.get("type") == "ping":
                await sender.send({"type": "pong"})
            else:
                await sender.send({"type": "error", "detail": "无法识别的消息"})

    try:
        await _race(push(), receive())
    finally:
        hub.unsubscribe(waiter)
