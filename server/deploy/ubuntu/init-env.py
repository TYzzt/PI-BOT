#!/usr/bin/env python3
"""Create host-only deployment secrets once; subsequent runs preserve every key."""
import base64
import json
import os
from pathlib import Path
import secrets
import sys
import uuid

root = Path(sys.argv[1] if len(sys.argv) > 1 else "/opt/pi-bot")
root.mkdir(mode=0o700, parents=True, exist_ok=True)
env = root / ".env"
if not env.exists():
    values = {
        "PI_BOT_IMAGE_REPOSITORY": "registry.cn-beijing.aliyuncs.com/liuhx/pi-bot-server",
        "PI_BOT_BIND_ADDRESS": "0.0.0.0",
        "PI_BOT_HTTP_PORT": "8000",
        "POSTGRES_USER": "pibot",
        "POSTGRES_DB": "pibot",
        "POSTGRES_PASSWORD": secrets.token_hex(16),
        "PI_BOT_ADMIN_USERNAME": "admin",
        "PI_BOT_ADMIN_PASSWORD": secrets.token_hex(16),
        "PI_BOT_JWT_SECRET": secrets.token_hex(32),
        "PI_BOT_RUNNER_TOKEN": secrets.token_hex(32),
        "PI_BOT_SEARXNG_SECRET": secrets.token_hex(32),
        "PI_BOT_VAULT_KEY_ID": str(uuid.uuid4()),
        "PI_BOT_VAULT_KEY": base64.b64encode(secrets.token_bytes(32)).decode(),
        "PI_BOT_WORKER_CONCURRENCY": "2",
        "LANGFUSE_TRACING_ENABLED": "false",
        "LANGFUSE_BASE_URL": "",
        "LANGFUSE_PUBLIC_KEY": "",
        "LANGFUSE_SECRET_KEY": "",
        "LANGFUSE_TRACING_ENVIRONMENT": "production",
    }
    fd = os.open(env, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as out:
        out.write("# Generated on this server. Back up together with PostgreSQL.\n")
        out.writelines(f"{key}={value}\n" for key, value in values.items())
else:
    if env.is_symlink() or not env.is_file():
        raise SystemExit(".env must be a regular file")
    values = dict(line.split("=", 1) for line in env.read_text().splitlines() if line and not line.startswith("#"))
    env.chmod(0o600)

# Add new optional settings without replacing existing deployment credentials.
defaults = {"LANGFUSE_TRACING_ENABLED": "false", "LANGFUSE_BASE_URL": "", "LANGFUSE_PUBLIC_KEY": "", "LANGFUSE_SECRET_KEY": "", "LANGFUSE_TRACING_ENVIRONMENT": "production"}
missing = {key: value for key, value in defaults.items() if key not in values}
if missing:
    with env.open("a") as out:
        out.write("\n# Cloud Worker observability\n")
        out.writelines(f"{key}={value}\n" for key, value in missing.items())
    values.update(missing)

key_id = str(uuid.UUID(values["PI_BOT_VAULT_KEY_ID"]))
if len(base64.b64decode(values["PI_BOT_VAULT_KEY"], validate=True)) != 32:
    raise SystemExit("Vault key must contain 32 random bytes")
vault = root / "vault.json"
data = {"active": key_id, "keys": {key_id: values["PI_BOT_VAULT_KEY"]}}
if vault.exists():
    if vault.is_symlink() or not vault.is_file() or json.loads(vault.read_text()) != data:
        raise SystemExit("Existing vault differs from .env; refusing to replace encryption keys")
else:
    fd = os.open(vault, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
    with os.fdopen(fd, "w") as out:
        json.dump(data, out)
        out.write("\n")
if os.geteuid() == 0:
    os.chown(vault, 1000, 1000)  # The published image runs as the node user.
vault.chmod(0o400)
print(f"Secrets ready: {env}; existing secrets were preserved.")
