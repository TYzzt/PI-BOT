import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

import jwt
from fastapi.testclient import TestClient
from sqlalchemy import inspect, text

from tagent_server.config import Settings
from tagent_server.main import create_app
from tests.helpers import PASSWORD, bearer, json_bytes, login, new_device_key, pair, signed_headers

FORBIDDEN_COLUMNS = {"absolute_path", "source", "diff", "private_key", "cookie", "api_key", "secret"}
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
}


def test_health(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_login_and_pairing_are_single_use(client: TestClient) -> None:
    assert client.post("/auth/login", json={"password": "wrong-password"}).status_code == 401
    assert client.get("/devices").status_code == 401
    token = login(client)
    created = client.post("/devices/pairing-codes", headers=bearer(token))
    assert created.status_code == 200
    code = created.json()["pairing_code"]
    private_key, public_key = new_device_key()
    first = client.post("/devices/pair", json={"pairing_code": code, "public_key": public_key, "label": "Mac"})
    assert first.status_code == 200
    device_id = first.json()["device_id"]
    again = client.post("/devices/pair", json={"pairing_code": code, "public_key": public_key, "label": "Mac"})
    assert again.status_code == 400
    assert again.json()["detail"] == "配对码无效"
    listed = client.get("/devices", headers=bearer(token))
    assert listed.status_code == 200
    assert [item["device_id"] for item in listed.json()] == [device_id]
    assert listed.json()[0]["presence"] == "offline"
    body = b"{}"
    heartbeat = client.post(f"/devices/{device_id}/heartbeat", content=body, headers=signed_headers(private_key, device_id, "POST", f"/devices/{device_id}/heartbeat", body))
    assert heartbeat.status_code == 200, heartbeat.text
    assert heartbeat.json()["presence"] == "online"


def test_expired_pairing_code_is_rejected(client: TestClient) -> None:
    token = login(client)
    created = client.post("/devices/pairing-codes", headers=bearer(token))
    code = created.json()["pairing_code"]
    with client.app.state.engine.begin() as connection:
        connection.execute(text("UPDATE pairing_codes SET expires_at = :expires_at"), {"expires_at": datetime.now(timezone.utc) - timedelta(seconds=5)})
    _, public_key = new_device_key()
    response = client.post("/devices/pair", json={"pairing_code": code, "public_key": public_key, "label": "Mac"})
    assert response.status_code == 400


def test_revoke_blocks_heartbeat_and_repair_creates_new_device(client: TestClient) -> None:
    token = login(client)
    private_key, public_key = new_device_key()
    device_id = pair(client, token, private_key, public_key)
    revoked = client.post(f"/devices/{device_id}/revoke", headers=bearer(token))
    assert revoked.status_code == 200
    revoked_at = revoked.json()["revoked_at"]
    assert revoked.json()["presence"] == "offline"
    again = client.post(f"/devices/{device_id}/revoke", headers=bearer(token))
    assert again.json()["revoked_at"] == revoked_at
    body = b"{}"
    heartbeat = client.post(
        f"/devices/{device_id}/heartbeat",
        content=body,
        headers=signed_headers(private_key, device_id, "POST", f"/devices/{device_id}/heartbeat", body),
    )
    assert heartbeat.status_code == 401
    new_id = pair(client, token, private_key, public_key, label="Mac again")
    assert new_id != device_id
    listed = client.get("/devices", headers=bearer(token)).json()
    old = next(item for item in listed if item["device_id"] == device_id)
    assert old["revoked_at"] == revoked_at
    assert old["presence"] == "offline"


def test_replay_and_bad_signature_fail(client: TestClient) -> None:
    token = login(client)
    private_key, public_key = new_device_key()
    device_id = pair(client, token, private_key, public_key)
    body = b"{}"
    headers = signed_headers(private_key, device_id, "POST", f"/devices/{device_id}/heartbeat", body)
    assert client.post(f"/devices/{device_id}/heartbeat", content=body, headers=headers).status_code == 200
    assert client.post(f"/devices/{device_id}/heartbeat", content=body, headers=headers).status_code == 401
    tampered = signed_headers(private_key, device_id, "POST", f"/devices/{device_id}/heartbeat", body)
    assert client.post(f"/devices/{device_id}/heartbeat", content=b'{"extra":1}', headers=tampered).status_code == 401


def test_projects_reject_code_fields_and_follow_device_lifecycle(client: TestClient) -> None:
    token = login(client)
    private_key, public_key = new_device_key()
    device_id = pair(client, token, private_key, public_key)
    marker = "SECRET_SOURCE_MARKER_SHOULD_NOT_ECHO"
    rejected = client.post(
        "/projects",
        content=json_bytes({"display_name": "Demo", "absolute_path": "/Users/me/code", "source": marker}),
        headers=signed_headers(private_key, device_id, "POST", "/projects", json_bytes({"display_name": "Demo", "absolute_path": "/Users/me/code", "source": marker})),
    )
    assert rejected.status_code == 422
    assert marker not in rejected.text
    assert "/Users/me/code" not in rejected.text
    body = json_bytes({"display_name": "Demo"})
    created = client.post("/projects", content=body, headers=signed_headers(private_key, device_id, "POST", "/projects", body))
    assert created.status_code == 200, created.text
    project_id = created.json()["project_id"]
    assert created.json()["availability"] == "available"
    assert client.post("/projects", json={"display_name": "Nope"}, headers=bearer(token)).status_code == 403
    listed = client.get("/projects", headers=bearer(token))
    assert listed.status_code == 200
    assert listed.json()[0]["display_name"] == "Demo"
    client.post(f"/devices/{device_id}/revoke", headers=bearer(token))
    hidden = client.get("/projects", headers=bearer(token)).json()[0]
    assert hidden["availability"] == "unavailable"
    other_key, other_public = new_device_key()
    other_id = pair(client, token, other_key, other_public, label="replacement")
    rebound = client.patch(f"/projects/{project_id}", json={"device_id": other_id}, headers=bearer(token))
    assert rebound.status_code == 200, rebound.text
    assert rebound.json()["device_id"] == other_id
    assert rebound.json()["availability"] == "available"
    foreign = json_bytes({"display_name": "hijack"})
    denied = client.patch(
        f"/projects/{project_id}",
        content=foreign,
        headers=signed_headers(private_key, device_id, "PATCH", f"/projects/{project_id}", foreign),
    )
    assert denied.status_code == 401
    own = json_bytes({"device_id": device_id})
    cannot_rebind = client.patch(
        f"/projects/{project_id}",
        content=own,
        headers=signed_headers(other_key, other_id, "PATCH", f"/projects/{project_id}", own),
    )
    assert cannot_rebind.status_code == 403


def test_schema_has_no_code_or_secret_columns_and_plaintext_is_absent(client: TestClient, caplog) -> None:
    caplog.set_level(logging.INFO)
    token = login(client)
    created = client.post("/devices/pairing-codes", headers=bearer(token))
    code = created.json()["pairing_code"]
    inspector = inspect(client.app.state.engine)
    tables = set(inspector.get_table_names())
    assert {"users", "pairing_codes", "devices", "device_nonces", "projects", "alembic_version"} <= tables
    for table in tables:
        names = {column["name"] for column in inspector.get_columns(table)}
        assert names.isdisjoint(FORBIDDEN_COLUMNS)
    project_columns = {column["name"] for column in inspector.get_columns("projects")}
    assert project_columns == {"project_id", "device_id", "display_name", "availability", "created_at", "updated_at"}
    stored = []
    with client.app.state.engine.connect() as connection:
        for table in tables - {"alembic_version"}:
            stored.append(str(connection.execute(text(f'SELECT * FROM "{table}"')).all()))
    snapshot = "\n".join(stored)
    assert PASSWORD not in snapshot
    assert code not in snapshot
    assert PASSWORD not in caplog.text
    assert code not in caplog.text
    assert token not in caplog.text


def test_expired_token_is_rejected(client: TestClient) -> None:
    token = jwt.encode({"sub": "00000000-0000-0000-0000-000000000000", "exp": 1}, "test-jwt-secret-must-be-32-characters", algorithm="HS256")
    response = client.get("/devices", headers=bearer(token))
    assert response.status_code == 401


def test_openapi_contract() -> None:
    app = create_app(
        Settings(
            database_url="postgresql+psycopg://tagent:tagent@localhost:5432/tagent",
            admin_password="export-placeholder",
            jwt_secret="export-placeholder-secret-32chars-min",
        )
    )
    spec = app.openapi()
    assert set(spec["paths"]) == EXPECTED_PATHS
    for reserved in ("/tasks", "/conversations", "/events", "/configs"):
        assert reserved not in spec["paths"]
    schemas = spec["components"]["schemas"]
    for name in ("ProjectCreate", "ProjectPatch", "PairRequest", "LoginRequest"):
        assert schemas[name]["additionalProperties"] is False
    assert "absolute_path" not in json.dumps(schemas)
    assert spec["paths"]["/projects"]["post"]["security"] == [
        {"DeviceId": [], "DeviceTimestamp": [], "DeviceNonce": [], "DeviceSignature": []}
    ]
    committed = Path("openapi.json").read_text(encoding="utf-8")
    assert committed == json.dumps(spec, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
