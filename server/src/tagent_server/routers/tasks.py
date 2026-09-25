import uuid

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from tagent_server.config import Settings, utcnow
from tagent_server.deps import get_session, require_device, require_user
from tagent_server.models import Device, Task, User
from tagent_server.openapi_extra import DEVICE_SECURITY, USER_SECURITY
from tagent_server.present import plan_public, task_detail, task_summary
from tagent_server.schemas import CancelRequest, PlanPublic, PlanPublish, TaskCreate, TaskDetail, TaskSummary
from tagent_server.tasks_service import cancel_task, create_task, expire_due, load_task, publish_plan

router = APIRouter(prefix="/tasks", tags=["tasks"])


@router.post("", response_model=TaskDetail, openapi_extra=USER_SECURITY)
def create(
    payload: TaskCreate,
    request: Request,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
) -> TaskDetail:
    del user
    settings: Settings = request.app.state.settings
    now = utcnow()
    task = create_task(session, settings, payload, now)
    return task_detail(session, task, settings, now)


@router.get("", response_model=list[TaskSummary], openapi_extra=USER_SECURITY)
def list_tasks(
    request: Request,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
) -> list[TaskSummary]:
    del user
    settings: Settings = request.app.state.settings
    now = utcnow()
    expire_due(session, now)
    rows = session.execute(
        select(Task, Device).join(Device, Task.target_device_id == Device.device_id).order_by(Task.created_at.desc(), Task.task_id)
    ).all()
    return [task_summary(task, device, settings, now) for task, device in rows]


@router.get("/{task_id}", response_model=TaskDetail, openapi_extra=USER_SECURITY)
def get_task(
    task_id: uuid.UUID,
    request: Request,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
) -> TaskDetail:
    del user
    settings: Settings = request.app.state.settings
    now = utcnow()
    expire_due(session, now)
    return task_detail(session, load_task(session, task_id), settings, now)


@router.post("/{task_id}/cancel", response_model=TaskDetail, openapi_extra=USER_SECURITY)
def cancel(
    task_id: uuid.UUID,
    payload: CancelRequest,
    request: Request,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
) -> TaskDetail:
    del user, payload
    settings: Settings = request.app.state.settings
    now = utcnow()
    expire_due(session, now)
    task = cancel_task(session, settings, task_id, now)
    return task_detail(session, task, settings, now)


@router.post("/{task_id}/plans", response_model=PlanPublic, openapi_extra=DEVICE_SECURITY)
def publish(
    task_id: uuid.UUID,
    payload: PlanPublish,
    device: Device = Depends(require_device),
    session: Session = Depends(get_session),
) -> PlanPublic:
    return plan_public(publish_plan(session, device, task_id, payload, utcnow()))
