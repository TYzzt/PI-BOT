import base64
import hashlib
import uuid
from datetime import datetime

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from tagent_server.config import Settings

_hasher = PasswordHasher()


class AuthError(Exception):
    pass


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def hash_pairing_code(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


def issue_token(user_id: uuid.UUID, settings: Settings, now: datetime) -> str:
    payload = {"sub": str(user_id), "iat": int(now.timestamp()), "exp": int(now.timestamp()) + settings.jwt_ttl_seconds}
    return jwt.encode(payload, settings.jwt_secret.get_secret_value(), algorithm="HS256")


def read_user_id(token: str, settings: Settings) -> uuid.UUID:
    try:
        payload = jwt.decode(token, settings.jwt_secret.get_secret_value(), algorithms=["HS256"])
        return uuid.UUID(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError) as exc:
        raise AuthError from exc


def decode_public_key(value: str) -> bytes:
    try:
        raw = base64.b64decode(value, validate=True)
    except Exception as exc:
        raise ValueError("公钥必须是 32 字节 Ed25519 的标准 Base64") from exc
    if len(raw) != 32:
        raise ValueError("公钥必须是 32 字节 Ed25519 的标准 Base64")
    return raw


def canonical_message(timestamp: str, nonce: str, method: str, path: str, body: bytes) -> bytes:
    digest = hashlib.sha256(body).hexdigest()
    return f"{timestamp}.{nonce}.{method.upper()}.{path}.{digest}".encode()


def verify_device_signature(public_key_b64: str, signature_b64: str, message: bytes) -> None:
    try:
        public_key = Ed25519PublicKey.from_public_bytes(decode_public_key(public_key_b64))
        signature = base64.b64decode(signature_b64, validate=True)
        public_key.verify(signature, message)
    except (ValueError, InvalidSignature) as exc:
        raise AuthError from exc
