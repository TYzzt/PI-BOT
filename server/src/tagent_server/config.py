from datetime import datetime, timezone
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

MAX_BODY_BYTES = 8 * 1024 * 1024


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def project_root() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "alembic.ini").is_file():
            return parent
    raise RuntimeError("找不到 alembic.ini")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="T_AGNET_", env_file=".env", extra="ignore")

    sync_key_file: Path | None = None
    database_url: str
    admin_password: SecretStr = Field(min_length=8)
    jwt_secret: SecretStr = Field(min_length=32)
    jwt_ttl_seconds: int = Field(default=3600, ge=60, le=86400)
    presence_ttl_seconds: int = Field(default=60, ge=5, le=3600)
    pairing_ttl_seconds: int = Field(default=600, ge=30, le=3600)
    signature_skew_seconds: int = Field(default=300, ge=30, le=3600)
    approval_ttl_seconds: int = Field(default=900, ge=60, le=86400)
    command_ttl_seconds: int = Field(default=86400, ge=60, le=604800)
    tavily_api_key: SecretStr | None = None
    worker_lease_seconds: int = Field(default=60, ge=15, le=3600)
    worker_poll_seconds: float = Field(default=1.0, gt=0, le=60)
