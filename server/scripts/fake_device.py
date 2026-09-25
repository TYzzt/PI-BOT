"""模拟 Mac 设备：配对、登记项目、连接 /ws/device、发布计划并上报执行事件。

默认一直运行，按 Ctrl+C 退出。加 --demo 时同时扮演用户：创建任务、提修改意见、批准，
看到任务完成后退出，用于本地联调和演示。
"""

import argparse
import base64
import hashlib
import json
import secrets
import sys
import threading
import time
import uuid
from datetime import datetime, timezone

import httpx
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from websockets.sync.client import connect

FINGERPRINT = hashlib.sha256(b"fake-workspace").hexdigest()
CONFIG_SNAPSHOT = "fake-config-1"


def canonical_json(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def plan_hash(task_id: str, version: int, project_id: str, device_id: str, body: dict) -> str:
    material = {
        "task_id": task_id,
        "version": version,
        "project_id": project_id,
        "device_id": device_id,
        "body": body,
        "workspace_fingerprint": FINGERPRINT,
        "config_snapshot_id": CONFIG_SNAPSHOT,
    }
    return hashlib.sha256(canonical_json(material)).hexdigest()


class FakeDevice:
    def __init__(self, base_url: str, key: Ed25519PrivateKey, device_id: str, project_id: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.key = key
        self.device_id = device_id
        self.project_id = project_id
        self.http = httpx.Client(base_url=self.base_url, timeout=10)
        self.seq = 0
        self.versions: dict[str, int] = {}

    def headers(self, method: str, path: str, body: bytes) -> dict[str, str]:
        timestamp = str(int(time.time()))
        nonce = secrets.token_hex(16)
        message = f"{timestamp}.{nonce}.{method}.{path}.{hashlib.sha256(body).hexdigest()}".encode()
        return {
            "X-TAgnet-Device-Id": self.device_id,
            "X-TAgnet-Timestamp": timestamp,
            "X-TAgnet-Nonce": nonce,
            "X-TAgnet-Signature": base64.b64encode(self.key.sign(message)).decode(),
        }

    def call(self, method: str, path: str, payload: dict | None = None) -> dict:
        body = canonical_json(payload) if payload is not None else b""
        headers = {**self.headers(method, path, body), "Content-Type": "application/json"}
        response = self.http.request(method, path, content=body, headers=headers)
        response.raise_for_status()
        return response.json()

    def events(self, task_id: str, run_id: str, *items: tuple[str, dict]) -> None:
        batch = []
        for kind, payload in items:
            self.seq += 1
            batch.append(
                {
                    "event_id": str(uuid.uuid4()),
                    "producer_seq": self.seq,
                    "type": kind,
                    "task_id": task_id,
                    "run_id": run_id,
                    "occurred_at": datetime.now(timezone.utc).isoformat(),
                    "payload": payload,
                }
            )
        self.call("POST", "/device/events", {"events": batch})

    def handle(self, command: dict) -> None:
        kind = command["command_type"]
        task_id = command["task_id"]
        run_id = command["run_id"]
        print(f"[device] 收到 {kind} task={task_id}")
        if kind in ("plan_request", "plan_revise"):
            version = self.versions.get(task_id, 0) + 1
            self.versions[task_id] = version
            note = command["payload"].get("feedback") or command["payload"].get("requirement", "")
            body = {
                "goal": f"模拟计划 v{version}：{note[:200]}",
                "scope": ["模拟范围"],
                "non_goals": [],
                "modules": ["demo"],
                "steps": [{"step_id": "s1", "title": "模拟修改", "description": "不做真实改动"}],
                "commands": ["echo test"],
                "external_actions": [],
                "verification": ["echo test"],
                "acceptance": ["任务完成"],
                "questions": [],
            }
            self.call(
                "POST",
                f"/tasks/{task_id}/plans",
                {
                    "run_id": run_id,
                    "version": version,
                    "content_hash": plan_hash(task_id, version, command["payload"]["project_id"], self.device_id, body),
                    "body": body,
                    "workspace_fingerprint": FINGERPRINT,
                    "config_snapshot_id": CONFIG_SNAPSHOT,
                },
            )
            print(f"[device] 已发布计划 v{version}")
        elif kind == "execute":
            self.events(
                task_id,
                run_id,
                ("run.started", {}),
                ("step.started", {"step_id": "s1", "title": "模拟修改"}),
                ("tool.finished", {"tool_name": "shell", "status": "ok", "exit_code": 0, "summary": "echo test", "verification": "passed"}),
                ("step.completed", {"step_id": "s1"}),
                ("run.completed", {"verification": "passed"}),
            )
            print("[device] 执行完成")
        elif kind == "cancel":
            self.events(task_id, run_id, ("run.cancelled", {}))
            print("[device] 已取消")

    def serve(self, stop: threading.Event) -> None:
        ws_url = self.base_url.replace("http", "ws", 1) + "/ws/device"
        while not stop.is_set():
            try:
                with connect(ws_url, additional_headers=self.headers("GET", "/ws/device", b"")) as socket:
                    print("[device] 已连接 /ws/device")
                    while not stop.is_set():
                        try:
                            message = json.loads(socket.recv(timeout=1))
                        except TimeoutError:
                            continue
                        if message.get("type") != "command":
                            continue
                        socket.send(json.dumps({"type": "ack", "command_id": message["command_id"]}))
                        result = json.loads(socket.recv(timeout=10))
                        while result.get("type") != "ack_result":
                            result = json.loads(socket.recv(timeout=10))
                        if result["ok"]:
                            self.handle(message)
                        else:
                            print(f"[device] ack 被拒绝：{result.get('detail')}")
            except Exception as exc:  # noqa: BLE001
                print(f"[device] 连接断开：{type(exc).__name__}，1 秒后重连")
                stop.wait(1)


def wait_for(http: httpx.Client, task_id: str, statuses: set[str], timeout: float = 30) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        task = http.get(f"/tasks/{task_id}").json()
        if task["status"] in statuses:
            return task
        time.sleep(0.5)
    raise SystemExit(f"等待任务状态 {statuses} 超时")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--password", required=True, help="T_AGNET_ADMIN_PASSWORD，用于发放配对码")
    parser.add_argument("--demo", action="store_true", help="同时扮演用户走完整流程")
    args = parser.parse_args()

    user = httpx.Client(base_url=args.base_url, timeout=10)
    token = user.post("/auth/login", json={"password": args.password}).raise_for_status().json()["access_token"]
    user.headers["Authorization"] = f"Bearer {token}"
    code = user.post("/devices/pairing-codes").raise_for_status().json()["pairing_code"]
    key = Ed25519PrivateKey.generate()
    public_key = base64.b64encode(key.public_key().public_bytes_raw()).decode()
    paired = user.post("/devices/pair", json={"pairing_code": code, "public_key": public_key, "label": "fake-mac"}).raise_for_status().json()
    device = FakeDevice(args.base_url, key, paired["device_id"], "")
    project = device.call("POST", "/projects", {"display_name": "fake project"})
    device.project_id = project["project_id"]
    print(f"[device] device_id={device.device_id} project_id={device.project_id}")

    stop = threading.Event()
    worker = threading.Thread(target=device.serve, args=(stop,), daemon=True)
    worker.start()
    try:
        if not args.demo:
            worker.join()
            return
        time.sleep(1)
        task = user.post(
            "/tasks", json={"project_id": device.project_id, "requirement": "演示需求", "idempotency_key": uuid.uuid4().hex}
        ).raise_for_status().json()
        print(f"[user] 创建任务 {task['task_id']}，状态 {task['status']}")
        task = wait_for(user, task["task_id"], {"awaiting_review"})
        user.post(
            f"/plans/{task['latest_plan_id']}/revise", json={"feedback": "请补充测试", "idempotency_key": uuid.uuid4().hex}
        ).raise_for_status()
        print("[user] 已提交修改意见")
        task = wait_for(user, task["task_id"], {"awaiting_review"})
        plan = user.get(f"/plans/{task['latest_plan_id']}").raise_for_status().json()
        approval = user.post(
            f"/plans/{plan['plan_id']}/approve",
            json={"version": plan["version"], "content_hash": plan["content_hash"], "idempotency_key": uuid.uuid4().hex},
        ).raise_for_status().json()
        print(f"[user] 已批准 v{plan['version']}，run={approval['run_id']}")
        task = wait_for(user, task["task_id"], {"completed", "failed"})
        events = user.get("/events", params={"task_id": task["task_id"], "limit": 500}).json()["events"]
        print(f"[user] 任务 {task['status']}，共 {len(events)} 条事件：")
        for event in events:
            print(f"  #{event['server_cursor']:>4} {event['type']}")
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        worker.join(timeout=3)
    sys.exit(0)


if __name__ == "__main__":
    main()
