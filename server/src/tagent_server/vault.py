"""AES-GCM vault. Key file: {active: key_id, keys: {key_id: base64(32 bytes)}}."""
import base64
import json
import os
from pathlib import Path
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import HTTPException

class Vault:
    def __init__(self, path: Path | None):
        try:
            if path is None: raise ValueError()
            data = json.loads(path.read_text())
            self.keys = {k: base64.b64decode(v, validate=True) for k, v in data['keys'].items()}
            self.active = data['active']
            if self.active not in self.keys or any(len(v) != 32 for v in self.keys.values()): raise ValueError()
        except Exception:
            raise HTTPException(503, '凭据同步不可用：请检查服务端加密密钥文件') from None
    def seal(self, secret: str, config_id: str, version: int) -> dict:
        nonce = os.urandom(12)
        value = AESGCM(self.keys[self.active]).encrypt(nonce, secret.encode(), f'{config_id}:{version}'.encode())
        return {'key_id': self.active, 'nonce': base64.b64encode(nonce).decode(), 'ciphertext': base64.b64encode(value).decode(), 'version': version}
    def open(self, value: dict, config_id: str) -> str:
        try:
            return AESGCM(self.keys[value['key_id']]).decrypt(base64.b64decode(value['nonce']), base64.b64decode(value['ciphertext']), f"{config_id}:{value['version']}".encode()).decode()
        except Exception:
            raise HTTPException(503, '凭据无法解密，请检查加密密钥') from None
