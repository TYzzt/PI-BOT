import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from tagent_server.security import decode_public_key

Availability = Literal["available", "unavailable"]
Presence = Literal["online", "offline"]


def _strip_required(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("不能为空")
    return value


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: str = Field(min_length=1, max_length=1024)


class TokenResponse(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int


class PairingCodeResponse(BaseModel):
    pairing_code: str
    expires_at: datetime


class PairRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pairing_code: str = Field(min_length=1, max_length=256)
    public_key: str = Field(min_length=1, max_length=128)
    label: str = Field(min_length=1, max_length=80)
    capabilities: list[str] = Field(default_factory=list, max_length=32)

    @field_validator("label")
    @classmethod
    def strip_label(cls, value: str) -> str:
        return _strip_required(value)

    @field_validator("public_key")
    @classmethod
    def check_public_key(cls, value: str) -> str:
        decode_public_key(value)
        return value

    @field_validator("capabilities")
    @classmethod
    def check_capabilities(cls, value: list[str]) -> list[str]:
        cleaned: list[str] = []
        for item in value:
            text = item.strip()
            if not text or len(text) > 64:
                raise ValueError("能力名称长度必须在 1 到 64 之间")
            cleaned.append(text)
        return cleaned


class DevicePublic(BaseModel):
    device_id: uuid.UUID
    label: str
    public_key: str
    capabilities: list[str]
    last_seen_at: datetime | None
    revoked_at: datetime | None
    presence: Presence


class ProjectCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    display_name: str = Field(min_length=1, max_length=120)
    availability: Availability = "available"

    @field_validator("display_name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        return _strip_required(value)


class ProjectPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    display_name: str | None = Field(default=None, min_length=1, max_length=120)
    availability: Availability | None = None
    device_id: uuid.UUID | None = None

    @field_validator("display_name")
    @classmethod
    def strip_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return _strip_required(value)

    @model_validator(mode="after")
    def at_least_one(self) -> "ProjectPatch":
        if self.display_name is None and self.availability is None and self.device_id is None:
            raise ValueError("至少提供一个字段")
        return self


class ProjectPublic(BaseModel):
    project_id: uuid.UUID
    device_id: uuid.UUID
    display_name: str
    availability: Availability
    created_at: datetime
    updated_at: datetime


class HealthResponse(BaseModel):
    ok: bool
