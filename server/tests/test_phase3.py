import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi.testclient import TestClient

from tagent_server.config import Settings
from tagent_server.main import create_app
from tagent_server.schemas import PlanBody
from tagent_server.tasks_service import plan_content_hash
from tests.helpers import bearer, login
from tests.test_phase2 import EXPECTED_PATHS, approve, device_call, get_task, pull_and_ack, scalar, setup_mac, to_review

VECTOR = Path(__file__).parent / "fixtures" / "plan_hash_vector.json"


def device_approve(client: TestClient, mac, plan: dict, key: str | None = None):
    return device_call(
        client,
        mac,
        "POST",
        f"/device/plans/{plan['plan_id']}/approve",
        {"version": plan["version"], "content_hash": plan["content_hash"], "idempotency_key": key or uuid.uuid4().hex},
    )


def events_of(client: TestClient, token: str, task_id: str, type: str) -> list[dict]:
    response = client.get(f"/events?task_id={task_id}&limit=500", headers=bearer(token))
    assert response.status_code == 200, response.text
    return [event for event in response.json()["events"] if event["type"] == type]


def test_s3_01_device_approval_records_actor_and_issues_execute(client: TestClient) -> None:
    token = login(client)
    mac = setup_mac(client, token)
    task, plan = to_review(client, token, mac)
    approved = device_approve(client, mac, plan)
    assert approved.status_code == 200, approved.text
    assert approved.json()["actor"] == "device"
    assert get_task(client, token, task["task_id"])["status"] == "approved"
    [command] = pull_and_ack(client, mac)
    assert command["command_type"] == "execute"
    assert command["payload"]["approval_id"] == approved.json()["approval_id"]
    [recorded] = events_of(client, token, task["task_id"], "approval.recorded")
    assert recorded["payload"]["actor"] == "device"

    other_task, other_plan = to_review(client, token, mac)
    by_user = approve(client, token, other_plan)
    assert by_user.status_code == 200, by_user.text
    assert by_user.json()["actor"] == "user"
    assert get_task(client, token, other_task["task_id"])["status"] == "approved"


def test_s3_02_only_target_device_may_decide(client: TestClient) -> None:
    token = login(client)
    mac = setup_mac(client, token)
    other = setup_mac(client, token, label="Other")
    task, plan = to_review(client, token, mac)
    assert device_approve(client, other, plan).status_code == 403
    rejected = device_call(client, other, "POST", f"/device/plans/{plan['plan_id']}/reject", {"idempotency_key": uuid.uuid4().hex})
    assert rejected.status_code == 403
    revised = device_call(
        client, other, "POST", f"/device/plans/{plan['plan_id']}/revise", {"feedback": "换个做法", "idempotency_key": uuid.uuid4().hex}
    )
    assert revised.status_code == 403
    no_signature = client.post(
        f"/device/plans/{plan['plan_id']}/approve",
        json={"version": 1, "content_hash": plan["content_hash"], "idempotency_key": uuid.uuid4().hex},
        headers=bearer(token),
    )
    assert no_signature.status_code == 403
    assert get_task(client, token, task["task_id"])["status"] == "awaiting_review"
    assert scalar(client, "SELECT count(*) FROM approvals") == 0


def test_s3_03_user_and_device_race_yields_single_run(client: TestClient) -> None:
    token = login(client)
    mac = setup_mac(client, token)
    task, plan = to_review(client, token, mac)
    with ThreadPoolExecutor(max_workers=2) as pool:
        user_future = pool.submit(approve, client, token, plan)
        device_future = pool.submit(device_approve, client, mac, plan)
        results = [user_future.result(), device_future.result()]
    assert [result.status_code for result in results] == [200, 200], [result.text for result in results]
    assert results[0].json()["approval_id"] == results[1].json()["approval_id"]
    assert scalar(client, "SELECT count(*) FROM runs WHERE phase = 'execute'") == 1
    assert scalar(client, "SELECT count(*) FROM commands WHERE type = 'execute'") == 1
    assert len(events_of(client, token, task["task_id"], "approval.recorded")) == 1


def test_s3_04_device_reject_and_revise_record_actor(client: TestClient) -> None:
    token = login(client)
    mac = setup_mac(client, token)
    task, plan = to_review(client, token, mac)
    revised = device_call(
        client, mac, "POST", f"/device/plans/{plan['plan_id']}/revise", {"feedback": "先补测试", "idempotency_key": uuid.uuid4().hex}
    )
    assert revised.status_code == 200, revised.text
    assert revised.json()["status"] == "queued"
    assert scalar(client, "SELECT actor FROM plan_feedback") == "device"
    [requested] = events_of(client, token, task["task_id"], "plan.revision_requested")
    assert requested["payload"]["actor"] == "device"
    [command] = pull_and_ack(client, mac)
    assert command["command_type"] == "plan_revise"
    assert command["payload"]["feedback"] == "先补测试"

    rejected_task, rejected_plan = to_review(client, token, mac)
    rejected = device_call(client, mac, "POST", f"/device/plans/{rejected_plan['plan_id']}/reject", {"idempotency_key": uuid.uuid4().hex})
    assert rejected.status_code == 200, rejected.text
    assert rejected.json()["status"] == "rejected"
    [event] = events_of(client, token, rejected_task["task_id"], "approval.rejected")
    assert event["payload"]["actor"] == "device"
    assert device_approve(client, mac, rejected_plan).status_code == 409


def test_s3_05_plan_hash_vector_is_shared_with_desktop() -> None:
    vector = json.loads(VECTOR.read_text(encoding="utf-8"))
    data = vector["input"]
    body = PlanBody.model_validate(data["body"]).model_dump(mode="json")
    assert body == data["body"]
    assert (
        plan_content_hash(
            task_id=uuid.UUID(data["task_id"]),
            version=data["version"],
            project_id=uuid.UUID(data["project_id"]),
            device_id=uuid.UUID(data["device_id"]),
            body=body,
            workspace_fingerprint=data["workspace_fingerprint"],
            config_snapshot_id=data["config_snapshot_id"],
        )
        == vector["content_hash"]
    )


def test_s3_06_openapi_lists_device_decision_endpoints() -> None:
    app = create_app(
        Settings(
            database_url="postgresql+psycopg://tagent:tagent@localhost:5432/tagent",
            admin_password="export-placeholder",
            jwt_secret="export-placeholder-secret-32chars-min",
        )
    )
    spec = app.openapi()
    device_paths = {"/device/plans/{plan_id}/approve", "/device/plans/{plan_id}/reject", "/device/plans/{plan_id}/revise"}
    assert EXPECTED_PATHS | device_paths <= set(spec["paths"])
    for path in device_paths:
        assert spec["paths"][path]["post"]["security"] == [
            {"DeviceId": [], "DeviceTimestamp": [], "DeviceNonce": [], "DeviceSignature": []}
        ]
    assert "actor" in spec["components"]["schemas"]["ApprovalPublic"]["required"]
