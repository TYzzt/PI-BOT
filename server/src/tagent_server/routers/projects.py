import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from tagent_server.config import utcnow
from tagent_server.deps import get_session, require_actor, require_device, require_user
from tagent_server.models import Device, Project, User
from tagent_server.openapi_extra import DEVICE_SECURITY, MIXED_SECURITY, USER_SECURITY
from tagent_server.present import project_out
from tagent_server.schemas import ProjectCreate, ProjectPatch, ProjectPublic

router = APIRouter(prefix="/projects", tags=["projects"])


def _load(session: Session, project_id: uuid.UUID) -> tuple[Project, Device]:
    row = session.execute(
        select(Project, Device).join(Device, Project.device_id == Device.device_id).where(Project.project_id == project_id)
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="项目不存在")
    return row[0], row[1]


@router.get("", response_model=list[ProjectPublic], openapi_extra=USER_SECURITY)
def list_projects(
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
) -> list[ProjectPublic]:
    del user
    rows = session.execute(
        select(Project, Device).join(Device, Project.device_id == Device.device_id).order_by(Project.created_at, Project.project_id)
    ).all()
    return [project_out(project, device) for project, device in rows]


@router.post("", response_model=ProjectPublic, openapi_extra=DEVICE_SECURITY)
def create_project(
    payload: ProjectCreate,
    device: Device = Depends(require_device),
    session: Session = Depends(get_session),
) -> ProjectPublic:
    project_id = uuid.uuid5(device.device_id, str(payload.request_id)) if payload.request_id else uuid.uuid4()
    existing = session.get(Project, project_id)
    if existing is not None:
        return project_out(existing, device)
    now = utcnow()
    project = Project(
        project_id=project_id,
        device_id=device.device_id,
        display_name=payload.display_name,
        availability=payload.availability,
        created_at=now,
        updated_at=now,
    )
    try:
        with session.begin_nested():
            session.add(project)
            session.flush()
    except IntegrityError:
        existing = session.get(Project, project_id)
        if existing is None:
            raise
        return project_out(existing, device)
    return project_out(project, device)


@router.patch("/{project_id}", response_model=ProjectPublic, openapi_extra=MIXED_SECURITY)
def update_project(
    project_id: uuid.UUID,
    payload: ProjectPatch,
    actor: tuple[str, User | Device] = Depends(require_actor),
    session: Session = Depends(get_session),
) -> ProjectPublic:
    kind, identity = actor
    project, device = _load(session, project_id)
    if kind == "device":
        if not isinstance(identity, Device) or project.device_id != identity.device_id:
            raise HTTPException(status_code=404, detail="项目不存在")
        if payload.device_id is not None:
            raise HTTPException(status_code=403, detail="设备不能改绑项目")
    elif payload.device_id is not None:
        target = session.get(Device, payload.device_id)
        if target is None:
            raise HTTPException(status_code=404, detail="设备不存在")
        if target.revoked_at is not None:
            raise HTTPException(status_code=400, detail="目标设备已撤销")
        project.device_id = target.device_id
        device = target
    if payload.display_name is not None:
        project.display_name = payload.display_name
    if payload.availability is not None:
        project.availability = payload.availability
    project.updated_at = utcnow()
    session.flush()
    return project_out(project, device)
