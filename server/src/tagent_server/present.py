from datetime import datetime, timedelta

from tagent_server.config import Settings
from tagent_server.models import Device, Project
from tagent_server.schemas import DevicePublic, ProjectPublic


def device_presence(device: Device, settings: Settings, now: datetime) -> str:
    if device.revoked_at is not None or device.last_seen_at is None:
        return "offline"
    if now - device.last_seen_at <= timedelta(seconds=settings.presence_ttl_seconds):
        return "online"
    return "offline"


def device_out(device: Device, settings: Settings, now: datetime) -> DevicePublic:
    return DevicePublic(
        device_id=device.device_id,
        label=device.label,
        public_key=device.public_key,
        capabilities=list(device.capabilities),
        last_seen_at=device.last_seen_at,
        revoked_at=device.revoked_at,
        presence=device_presence(device, settings, now),
    )


def project_out(project: Project, device: Device) -> ProjectPublic:
    availability = "unavailable" if device.revoked_at is not None else project.availability
    return ProjectPublic(
        project_id=project.project_id,
        device_id=project.device_id,
        display_name=project.display_name,
        availability=availability,
        created_at=project.created_at,
        updated_at=project.updated_at,
    )
