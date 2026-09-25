import json
import logging
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient
from sqlalchemy import inspect, text
from starlette.websockets import WebSocketDisconnect

from tagent_server.config import Settings
from tagent_server.main import create_app
from tagent_server.tasks_service import plan_content_hash
from tests.helpers import bearer, json_bytes, login, new_device_key, pair, signed_headers, signed_ws_headers

FINGERPRINT = "a" * 64
CONFIG_SNAPSHOT = "cfg-1"
MARKER = "SECRET_SOURCE_MARKER_SHOULD_NOT_STORE"


@dataclass
class Mac:
    key: Ed25519PrivateKey
    device_id: str
    project_id: str


def device_call(client: TestClient, mac: Mac, method: str, path: str, payload: dict | None = None):
    body = json_bytes(payload) if payload is not None else b""
    return client.request(method, path, content=body, headers=signed_headers(mac.key, mac.device_id, method, path, body))


def setup_mac(client: TestClient, token: str, label: str = "Mac", online: bool = True) -> Mac:
    key, public_key = new_device_key()
    device_id = pair(client, token, key, public_key, label=label)
    mac = Mac(key, device_id, "")
    created = device_call(client, mac, "POST", "/projects", {"display_name": f"{label} project"})
    assert created.status_code == 200, created.text
    mac.project_id = created.json()["project_id"]
    if online:
        beat = device_call(client, mac, "POST", f"/devices/{device_id}/heartbeat", {})
        assert beat.status_code == 200, beat.text
    return mac


def create_task(client: TestClient, token: str, mac: Mac, key: str | None = None, requirement: str = "增加健康检查"):
    return client.post(
        "/tasks",
        json={"project_id": mac.project_id, "requirement": requirement, "idempotency_key": key or uuid.uuid4().hex},
        headers=bearer(token),
    )


def get_task(client: TestClient, token: str, task_id: str) -> dict:
    response = client.get(f"/tasks/{task_id}", headers=bearer(token))
    assert response.status_code == 200, response.text
    return response.json()


def plan_body(goal: str = "增加 /health 健康检查") -> dict:
    return {
        "goal": goal,
        "scope": ["server 路由"],
        "non_goals": [],
        "modules": ["routers/health.py"],
        "steps": [{"step_id": "s1", "title": "添加路由", "description": "返回 ok"}],
        "commands": ["uv run pytest"],
        "external_actions": [],
        "verification": ["uv run pytest"],
        "acceptance": ["/health 返回 200"],
        "questions": [],
    }


def plan_payload(task: dict, mac: Mac, run_id: str, version: int, body: dict | None = None) -> dict:
    content = body or plan_body()
    content_hash = plan_content_hash(
        task_id=uuid.UUID(task["task_id"]),
        version=version,
        project_id=uuid.UUID(task["project_id"]),
        device_id=uuid.UUID(mac.device_id),
        body=content,
        workspace_fingerprint=FINGERPRINT,
        config_snapshot_id=CONFIG_SNAPSHOT,
    )
    return {
        "run_id": run_id,
        "version": version,
        "content_hash": content_hash,
        "body": content,
        "workspace_fingerprint": FINGERPRINT,
        "config_snapshot_id": CONFIG_SNAPSHOT,
    }


def pull_and_ack(client: TestClient, mac: Mac) -> list[dict]:
    pulled = device_call(client, mac, "GET", "/device/commands")
    assert pulled.status_code == 200, pulled.text
    for command in pulled.json():
        acked = device_call(client, mac, "POST", f"/device/commands/{command['command_id']}/ack")
        assert acked.status_code == 200, acked.text
    return pulled.json()


def to_review(client: TestClient, token: str, mac: Mac) -> tuple[dict, dict]:
    task = create_task(client, token, mac).json()
    [command] = pull_and_ack(client, mac)
    assert command["command_type"] == "plan_request"
    published = device_call(client, mac, "POST", f"/tasks/{task['task_id']}/plans", plan_payload(task, mac, command["run_id"], 1))
    assert published.status_code == 200, published.text
    return get_task(client, token, task["task_id"]), published.json()


def approve(client: TestClient, token: str, plan: dict, key: str | None = None, content_hash: str | None = None):
    return client.post(
        f"/plans/{plan['plan_id']}/approve",
        json={"version": plan["version"], "content_hash": content_hash or plan["content_hash"], "idempotency_key": key or uuid.uuid4().hex},
        headers=bearer(token),
    )


def to_running(client: TestClient, token: str, mac: Mac) -> tuple[dict, str]:
    task, plan = to_review(client, token, mac)
    approved = approve(client, token, plan)
    assert approved.status_code == 200, approved.text
    [command] = pull_and_ack(client, mac)
    assert command["command_type"] == "execute"
    return task, command["run_id"]


def device_event(task_id: str, run_id: str | None, seq: int, type: str, **payload) -> dict:
    return {
        "event_id": str(uuid.uuid4()),
        "producer_seq": seq,
        "type": type,
        "task_id": task_id,
        "run_id": run_id,
        "occurred_at": datetime.now(timezone.utc).isoformat(),
        "payload": payload,
    }


def scalar(client: TestClient, sql: str, **params):
    with client.app.state.engine.connect() as connection:
        return connection.execute(text(sql), params).scalar()


def test_s2_01_task_creation_is_idempotent_and_respects_availability(client: TestClient) -> None:
    token = login(client)
    offline = setup_mac(client, token, online=False)
    key = uuid.uuid4().hex
    first = create_task(client, token, offline, key=key)
    assert first.status_code == 200, first.text
    assert first.json()["status"] == "waiting_for_device"
    assert first.json()["device_presence"] == "offline"
    assert [run["phase"] for run in first.json()["runs"]] == ["plan"]
    again = create_task(client, token, offline, key=key)
    assert again.status_code == 200
    assert again.json()["task_id"] == first.json()["task_id"]
    assert create_task(client, token, offline, key=key, requirement="别的需求").status_code == 409
    assert len(client.get("/tasks", headers=bearer(token)).json()) == 1
    assert scalar(client, "SELECT count(*) FROM commands") == 1

    online = setup_mac(client, token, label="Online")
    assert create_task(client, token, online).json()["status"] == "queued"

    client.patch(f"/projects/{online.project_id}", json={"availability": "unavailable"}, headers=bearer(token))
    assert create_task(client, token, online).status_code == 409
    client.post(f"/devices/{offline.device_id}/revoke", headers=bearer(token))
    assert create_task(client, token, offline).status_code == 409
    assert create_task(client, token, Mac(offline.key, offline.device_id, str(uuid.uuid4()))).status_code == 404


def test_s2_02_device_socket_delivers_and_redelivers_until_ack(client: TestClient) -> None:
    token = login(client)
    mac = setup_mac(client, token, online=False)
    task = create_task(client, token, mac).json()
    assert task["status"] == "waiting_for_device"
    with client.websocket_connect("/ws/device", headers=signed_ws_headers(mac.key, mac.device_id)) as socket:
        message = socket.receive_json()
        assert message["type"] == "command"
        assert message["command_type"] == "plan_request"
        assert message["payload"]["requirement"] == "增加健康检查"
        command_id = message["command_id"]
    assert get_task(client, token, task["task_id"])["status"] == "queued"
    assert get_task(client, token, task["task_id"])["device_presence"] == "online"

    with client.websocket_connect("/ws/device", headers=signed_ws_headers(mac.key, mac.device_id)) as socket:
        redelivered = socket.receive_json()
        assert redelivered["command_id"] == command_id
        socket.send_json({"type": "ack", "command_id": command_id})
        assert socket.receive_json() == {"type": "ack_result", "command_id": command_id, "ok": True}
        socket.send_json({"type": "ack", "command_id": command_id})
        assert socket.receive_json()["ok"] is True
        socket.send_json({"type": "ping"})
        assert socket.receive_json() == {"type": "pong"}
        socket.send_json({"type": "ack", "command_id": "not-a-uuid"})
        assert socket.receive_json()["type"] == "error"
    detail = get_task(client, token, task["task_id"])
    assert detail["status"] == "planning"
    assert detail["runs"][0]["state"] == "running"
    assert device_call(client, mac, "GET", "/device/commands").json() == []
    assert scalar(client, "SELECT count(*) FROM events WHERE type = 'task.status_changed' AND payload->>'status' = 'planning'") == 1

    headers = signed_ws_headers(mac.key, mac.device_id)
    with client.websocket_connect("/ws/device", headers=headers) as socket:
        socket.send_json({"type": "ping"})
        assert socket.receive_json() == {"type": "pong"}
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/device", headers=headers) as socket:
            socket.receive_json()
    tampered = signed_ws_headers(mac.key, mac.device_id, path="/ws/other")
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/device", headers=tampered) as socket:
            socket.receive_json()


def test_s2_03_plan_publish_is_validated_and_immutable(client: TestClient) -> None:
    token = login(client)
    mac = setup_mac(client, token)
    other = setup_mac(client, token, label="Other")
    task = create_task(client, token, mac).json()
    [command] = pull_and_ack(client, mac)
    path = f"/tasks/{task['task_id']}/plans"
    valid = plan_payload(task, mac, command["run_id"], 1)

    wrong_hash = {**valid, "content_hash": "b" * 64}
    assert device_call(client, mac, "POST", path, wrong_hash).status_code == 400
    with_diff = {**valid, "diff": MARKER}
    rejected = device_call(client, mac, "POST", path, with_diff)
    assert rejected.status_code == 422
    assert MARKER not in rejected.text
    step_source = plan_body()
    step_source["steps"][0]["source"] = MARKER
    rejected = device_call(client, mac, "POST", path, {**valid, "body": step_source})
    assert rejected.status_code == 422
    assert MARKER not in rejected.text
    assert device_call(client, other, "POST", path, plan_payload(task, other, command["run_id"], 1)).status_code == 404
    assert client.post(path, json=valid, headers=bearer(token)).status_code == 403

    published = device_call(client, mac, "POST", path, valid)
    assert published.status_code == 200, published.text
    plan = published.json()
    detail = get_task(client, token, task["task_id"])
    assert detail["status"] == "awaiting_review"
    assert detail["latest_plan_id"] == plan["plan_id"]
    assert detail["runs"][0]["state"] == "completed"
    assert device_call(client, mac, "POST", path, valid).json()["plan_id"] == plan["plan_id"]
    changed = plan_payload(task, mac, command["run_id"], 1, body=plan_body(goal="换一个目标"))
    assert device_call(client, mac, "POST", path, changed).status_code == 409
    skipped = plan_payload(task, mac, command["run_id"], 3)
    assert device_call(client, mac, "POST", path, skipped).status_code == 409
    fetched = client.get(f"/plans/{plan['plan_id']}", headers=bearer(token))
    assert fetched.status_code == 200
    assert fetched.json()["body"] == plan_body()
    assert fetched.json()["content_hash"] == valid["content_hash"]


def test_s2_04_approval_is_single_and_bound_to_hash_and_expiry(client: TestClient) -> None:
    token = login(client)
    mac = setup_mac(client, token)
    task, plan = to_review(client, token, mac)
    assert approve(client, token, plan, content_hash="c" * 64).status_code == 409
    assert approve(client, token, {**plan, "version": 2}).status_code == 409

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: approve(client, token, plan), range(2)))
    assert [result.status_code for result in results] == [200, 200], [result.text for result in results]
    assert results[0].json()["approval_id"] == results[1].json()["approval_id"]
    assert results[0].json()["run_id"] == results[1].json()["run_id"]
    assert approve(client, token, plan, content_hash="c" * 64).status_code == 409
    assert scalar(client, "SELECT count(*) FROM approvals WHERE status = 'recorded'") == 1
    assert scalar(client, "SELECT count(*) FROM runs WHERE phase = 'execute'") == 1
    assert scalar(client, "SELECT count(*) FROM commands WHERE type = 'execute'") == 1
    assert get_task(client, token, task["task_id"])["status"] == "approved"

    past = datetime.now(timezone.utc) - timedelta(seconds=5)
    with client.app.state.engine.begin() as connection:
        connection.execute(text("UPDATE approvals SET expires_at = :past"), {"past": past})
        connection.execute(text("UPDATE commands SET expires_at = :past WHERE type = 'execute'"), {"past": past})
    execute_id = scalar(client, "SELECT command_id FROM commands WHERE type = 'execute'")
    assert device_call(client, mac, "GET", "/device/commands").json() == []
    expired_ack = device_call(client, mac, "POST", f"/device/commands/{execute_id}/ack")
    assert expired_ack.status_code == 409
    detail = get_task(client, token, task["task_id"])
    assert detail["status"] == "awaiting_review"
    assert [run["state"] for run in detail["runs"] if run["phase"] == "execute"] == ["expired"]
    assert scalar(client, "SELECT status FROM approvals") == "expired"

    again = approve(client, token, plan)
    assert again.status_code == 200, again.text
    assert again.json()["run_id"] != results[0].json()["run_id"]
    [command] = pull_and_ack(client, mac)
    assert command["command_type"] == "execute"
    assert command["payload"]["content_hash"] == plan["content_hash"]
    assert command["payload"]["approval_id"] == again.json()["approval_id"]


def test_s2_05_revision_supersedes_previous_version_and_reject_is_final(client: TestClient) -> None:
    token = login(client)
    mac = setup_mac(client, token)
    task, v1 = to_review(client, token, mac)
    key = uuid.uuid4().hex
    revised = client.post(f"/plans/{v1['plan_id']}/revise", json={"feedback": "补充测试", "idempotency_key": key}, headers=bearer(token))
    assert revised.status_code == 200, revised.text
    assert revised.json()["status"] == "queued"
    assert client.post(f"/plans/{v1['plan_id']}/revise", json={"feedback": "补充测试", "idempotency_key": key}, headers=bearer(token)).status_code == 200
    assert approve(client, token, v1).status_code == 409
    [command] = pull_and_ack(client, mac)
    assert command["command_type"] == "plan_revise"
    assert command["payload"]["base_version"] == 1
    assert command["payload"]["feedback"] == "补充测试"
    assert get_task(client, token, task["task_id"])["status"] == "planning"

    v2_payload = plan_payload(task, mac, command["run_id"], 2, body=plan_body(goal="增加健康检查和测试"))
    v2 = device_call(client, mac, "POST", f"/tasks/{task['task_id']}/plans", v2_payload)
    assert v2.status_code == 200, v2.text
    detail = get_task(client, token, task["task_id"])
    versions = {plan["version"]: plan for plan in detail["plans"]}
    assert versions[1]["superseded_at"] is not None
    assert versions[2]["superseded_at"] is None
    assert approve(client, token, v1).status_code == 409
    assert approve(client, token, v2.json()).status_code == 200
    assert scalar(client, "SELECT count(*) FROM events WHERE type = 'plan.superseded'") == 1

    other_task, other_plan = to_review(client, token, setup_mac(client, token, label="Other"))
    rejected = client.post(f"/plans/{other_plan['plan_id']}/reject", json={"idempotency_key": uuid.uuid4().hex}, headers=bearer(token))
    assert rejected.status_code == 200
    assert rejected.json()["status"] == "rejected"
    assert approve(client, token, other_plan).status_code == 409
    assert get_task(client, token, other_task["task_id"])["status"] == "rejected"


def test_s2_06_device_events_dedupe_detect_gaps_and_drive_projection(client: TestClient) -> None:
    token = login(client)
    mac = setup_mac(client, token)
    other = setup_mac(client, token, label="Other")
    task, run_id = to_running(client, token, mac)
    task_id = task["task_id"]
    batch = {"events": [device_event(task_id, run_id, 1, "run.started"), device_event(task_id, run_id, 2, "step.started", step_id="s1", title="添加路由")]}
    first = device_call(client, mac, "POST", "/device/events", batch)
    assert first.status_code == 200, first.text
    assert first.json() == {"accepted": 2, "duplicates": 0, "gaps": [], "last_seq": 2}
    assert get_task(client, token, task_id)["status"] == "running"
    repeat = device_call(client, mac, "POST", "/device/events", batch)
    assert repeat.json() == {"accepted": 0, "duplicates": 2, "gaps": [], "last_seq": 2}

    gap = device_call(client, mac, "POST", "/device/events", {"events": [device_event(task_id, run_id, 5, "step.completed", step_id="s1")]})
    assert gap.json()["gaps"] == [{"expected": 3, "received": 5}]
    tool = device_event(task_id, run_id, 6, "tool.finished", tool_name="shell", status="ok", exit_code=0, summary="测试通过", verification="passed")
    assert device_call(client, mac, "POST", "/device/events", {"events": [tool]}).status_code == 200

    raw = device_event(task_id, run_id, 7, "tool.finished", tool_name="shell")
    raw["payload"]["stdout"] = MARKER
    rejected = device_call(client, mac, "POST", "/device/events", {"events": [raw]})
    assert rejected.status_code == 422
    assert MARKER not in rejected.text
    too_long = device_event(task_id, run_id, 7, "tool.finished", summary="x" * 2001)
    assert device_call(client, mac, "POST", "/device/events", {"events": [too_long]}).status_code == 422
    assert device_call(client, mac, "POST", "/device/events", {"events": [device_event(task_id, None, 7, "run.completed")]}).status_code == 400
    assert device_call(client, other, "POST", "/device/events", {"events": [device_event(task_id, run_id, 1, "run.failed")]}).status_code == 404
    assert client.post("/device/events", json=batch, headers=bearer(token)).status_code == 403
    assert client.patch(f"/tasks/{task_id}", json={"status": "completed"}, headers=bearer(token)).status_code == 405
    assert get_task(client, token, task_id)["status"] == "running"

    done = device_call(client, mac, "POST", "/device/events", {"events": [device_event(task_id, run_id, 7, "run.completed", verification="passed")]})
    assert done.status_code == 200
    detail = get_task(client, token, task_id)
    assert detail["status"] == "completed"
    assert [run["state"] for run in detail["runs"] if run["phase"] == "execute"] == ["completed"]
    events = client.get("/events", params={"task_id": task_id, "limit": 500}, headers=bearer(token)).json()["events"]
    stored_tool = next(event for event in events if event["event_id"] == tool["event_id"])
    assert stored_tool["producer_id"] == mac.device_id
    assert stored_tool["producer_seq"] == 6
    assert stored_tool["payload"] == {"tool_name": "shell", "status": "ok", "exit_code": 0, "summary": "测试通过", "verification": "passed"}


def test_s2_07_cancel_waits_for_device_confirmation(client: TestClient) -> None:
    token = login(client)
    mac = setup_mac(client, token, online=False)
    waiting = create_task(client, token, mac).json()
    cancelled = client.post(f"/tasks/{waiting['task_id']}/cancel", json={}, headers=bearer(token))
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"
    assert scalar(client, "SELECT status FROM commands WHERE task_id = :task_id", task_id=waiting["task_id"]) == "superseded"
    assert device_call(client, mac, "GET", "/device/commands").json() == []

    task, run_id = to_running(client, token, mac)
    task_id = task["task_id"]
    device_call(client, mac, "POST", "/device/events", {"events": [device_event(task_id, run_id, 1, "run.started")]})
    pending = client.post(f"/tasks/{task_id}/cancel", json={}, headers=bearer(token))
    assert pending.status_code == 200
    assert pending.json()["status"] == "running"
    assert pending.json()["cancel_requested"] is True
    assert client.post(f"/tasks/{task_id}/cancel", json={}, headers=bearer(token)).status_code == 200
    assert scalar(client, "SELECT count(*) FROM commands WHERE type = 'cancel'") == 1

    with client.websocket_connect("/ws/device", headers=signed_ws_headers(mac.key, mac.device_id)) as socket:
        message = socket.receive_json()
        assert message["command_type"] == "cancel"
        assert message["run_id"] == run_id
        socket.send_json({"type": "ack", "command_id": message["command_id"]})
        assert socket.receive_json()["ok"] is True
    assert get_task(client, token, task_id)["status"] == "running"
    device_call(client, mac, "POST", "/device/events", {"events": [device_event(task_id, run_id, 2, "run.cancelled")]})
    assert get_task(client, token, task_id)["status"] == "cancelled"
    assert client.post(f"/tasks/{task_id}/cancel", json={}, headers=bearer(token)).status_code == 200


def _collect(socket, count: int) -> list[dict]:
    received = []
    while len(received) < count:
        message = socket.receive_json()
        assert message["type"] == "event"
        received.append(message["event"])
    return received


def _all_events(client: TestClient, token: str, after: int = 0) -> list[dict]:
    events: list[dict] = []
    while True:
        page = client.get("/events", params={"after": after, "limit": 2}, headers=bearer(token)).json()
        events.extend(page["events"])
        after = page["next_cursor"]
        if not page["has_more"]:
            return events


def test_s2_08_event_socket_replays_then_streams_without_gaps(client: TestClient) -> None:
    token = login(client)
    mac = setup_mac(client, token)
    create_task(client, token, mac)
    initial = _all_events(client, token)
    assert len(initial) >= 1
    with client.websocket_connect("/ws/events", headers=bearer(token)) as socket:
        socket.send_json({"type": "subscribe", "after": 0})
        replayed = _collect(socket, len(initial))
        assert replayed == initial
        create_task(client, token, mac)
        live_expected = _all_events(client, token, after=initial[-1]["server_cursor"])
        live = _collect(socket, len(live_expected))
        assert live == live_expected
        socket.send_json({"type": "ping"})
        assert socket.receive_json() == {"type": "pong"}
    last_cursor = live[-1]["server_cursor"]
    to_review(client, token, setup_mac(client, token, label="Second"))
    missed = _all_events(client, token, after=last_cursor)
    with client.websocket_connect("/ws/events", headers=bearer(token)) as socket:
        socket.send_json({"type": "subscribe", "after": last_cursor})
        resumed = _collect(socket, len(missed))
        socket.send_json({"type": "ping"})
        assert socket.receive_json() == {"type": "pong"}
    assert resumed == missed
    cursors = [event["server_cursor"] for event in initial + live + resumed]
    assert cursors == sorted(set(cursors))
    assert len({event["event_id"] for event in initial + live + resumed}) == len(cursors)

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/events", headers=bearer("invalid")) as socket:
            socket.receive_json()


def test_s2_09_revoked_device_is_disconnected(client: TestClient) -> None:
    token = login(client)
    mac = setup_mac(client, token)
    with client.websocket_connect("/ws/device", headers=signed_ws_headers(mac.key, mac.device_id)) as socket:
        socket.send_json({"type": "ping"})
        assert socket.receive_json() == {"type": "pong"}
        assert client.post(f"/devices/{mac.device_id}/revoke", headers=bearer(token)).status_code == 200
        with pytest.raises(WebSocketDisconnect) as closed:
            socket.receive_json()
        assert closed.value.code == 4401
    assert device_call(client, mac, "GET", "/device/commands").status_code == 401
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/device", headers=signed_ws_headers(mac.key, mac.device_id)) as socket:
            socket.receive_json()
    assert create_task(client, token, mac).status_code == 409


def test_s2_10_no_source_or_raw_output_is_stored(client: TestClient, caplog) -> None:
    caplog.set_level(logging.INFO)
    token = login(client)
    mac = setup_mac(client, token)
    task, run_id = to_running(client, token, mac)
    path = f"/tasks/{task['task_id']}/plans"
    for forbidden in ({"diff": MARKER}, {"source": MARKER}, {"absolute_path": MARKER}):
        payload = {**plan_payload(task, mac, run_id, 2), **forbidden}
        assert device_call(client, mac, "POST", path, payload).status_code == 422
    for field in ("stdout", "stderr", "diff", "path"):
        event = device_event(task["task_id"], run_id, 1, "tool.finished")
        event["payload"][field] = MARKER
        assert device_call(client, mac, "POST", "/device/events", {"events": [event]}).status_code == 422
    device_call(client, mac, "POST", "/device/events", {"events": [device_event(task["task_id"], run_id, 1, "tool.finished", tool_name="shell", summary="ok")]})

    inspector = inspect(client.app.state.engine)
    forbidden_columns = {"absolute_path", "path", "source", "diff", "stdout", "stderr", "raw_output", "api_key", "cookie", "private_key"}
    tables = set(inspector.get_table_names()) - {"alembic_version"}
    assert {"tasks", "plans", "approvals", "runs", "commands", "events", "plan_feedback", "device_event_sequences"} <= tables
    dump = []
    with client.app.state.engine.connect() as connection:
        for table in tables:
            assert {column["name"] for column in inspector.get_columns(table)}.isdisjoint(forbidden_columns)
            dump.append(str(connection.execute(text(f'SELECT * FROM "{table}"')).all()))
    assert MARKER not in "\n".join(dump)
    assert MARKER not in caplog.text


EXPECTED_PATHS = {
    "/health",
    "/auth/login",
    "/devices",
    "/devices/pairing-codes",
    "/devices/pair",
    "/devices/{device_id}/heartbeat",
    "/devices/{device_id}/revoke",
    "/projects",
    "/projects/{project_id}",
    "/tasks",
    "/tasks/{task_id}",
    "/tasks/{task_id}/cancel",
    "/tasks/{task_id}/plans",
    "/plans/{plan_id}",
    "/plans/{plan_id}/approve",
    "/plans/{plan_id}/reject",
    "/plans/{plan_id}/revise",
    "/device/commands",
    "/device/commands/{command_id}/ack",
    "/device/events",
    "/events",
}


def test_s2_11_openapi_contract() -> None:
    app = create_app(
        Settings(
            database_url="postgresql+psycopg://tagent:tagent@localhost:5432/tagent",
            admin_password="export-placeholder",
            jwt_secret="export-placeholder-secret-32chars-min",
        )
    )
    spec = app.openapi()
    assert EXPECTED_PATHS <= set(spec["paths"])
    schemas = spec["components"]["schemas"]
    for name in ("TaskCreate", "PlanPublish", "PlanBody", "PlanStep", "ApproveRequest", "ReviseRequest", "DeviceEventIn", "DeviceEventPayload"):
        assert schemas[name]["additionalProperties"] is False, name
    for name in ("WsCommandMessage", "WsAckMessage", "WsAckResultMessage", "WsSubscribeMessage", "WsEventMessage", "WsPingMessage"):
        assert name in schemas
    assert spec["paths"]["/tasks/{task_id}/plans"]["post"]["security"] == [
        {"DeviceId": [], "DeviceTimestamp": [], "DeviceNonce": [], "DeviceSignature": []}
    ]
    assert spec["paths"]["/plans/{plan_id}/approve"]["post"]["security"] == [{"UserBearer": []}]
    committed = Path("openapi.json").read_text(encoding="utf-8")
    assert committed == json.dumps(spec, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
