import base64
import hashlib
import json
import secrets
import time

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

PASSWORD = "test-password"


def new_device_key() -> tuple[Ed25519PrivateKey, str]:
    private_key = Ed25519PrivateKey.generate()
    public_key = base64.b64encode(private_key.public_key().public_bytes_raw()).decode()
    return private_key, public_key


def login(client: TestClient) -> str:
    response = client.post("/auth/login", json={"password": PASSWORD})
    assert response.status_code == 200, response.text
    return response.json()["access_token"]


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def signed_headers(private_key: Ed25519PrivateKey, device_id: str, method: str, path: str, body: bytes) -> dict[str, str]:
    timestamp = str(int(time.time()))
    nonce = secrets.token_hex(16)
    digest = hashlib.sha256(body).hexdigest()
    message = f"{timestamp}.{nonce}.{method.upper()}.{path}.{digest}".encode()
    signature = base64.b64encode(private_key.sign(message)).decode()
    return {
        "X-TAgnet-Device-Id": device_id,
        "X-TAgnet-Timestamp": timestamp,
        "X-TAgnet-Nonce": nonce,
        "X-TAgnet-Signature": signature,
        "Content-Type": "application/json",
    }


def json_bytes(payload: dict) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()


def pair(client: TestClient, token: str, private_key: Ed25519PrivateKey, public_key: str, label: str = "Mac") -> str:
    created = client.post("/devices/pairing-codes", headers=bearer(token))
    assert created.status_code == 200, created.text
    response = client.post(
        "/devices/pair",
        json={"pairing_code": created.json()["pairing_code"], "public_key": public_key, "label": label, "capabilities": ["plan"]},
    )
    assert response.status_code == 200, response.text
    return response.json()["device_id"]
