from datetime import datetime, timezone
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

MAX_BODY_BYTES = 64 * 1024


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

    database_url: str
    admin_password: SecretStr = Field(min_length=8)
    jwt_secret: SecretStr = Field(min_length=32)
    jwt_ttl_seconds: int = Field(default=3600, ge=60, le=86400)
    presence_ttl_seconds: int = Field(default=60, ge=5, le=3600)
    pairing_ttl_seconds: int = Field(default=600, ge=30, le=3600)
    signature_skew_seconds: int = Field(default=300, ge=30, le=3600)
