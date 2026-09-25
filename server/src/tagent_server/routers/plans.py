import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from tagent_server.config import Settings, utcnow
from tagent_server.deps import get_session, require_user
from tagent_server.models import Plan, User
from tagent_server.openapi_extra import USER_SECURITY
from tagent_server.present import approval_public, plan_public, task_detail
from tagent_server.schemas import ApprovalPublic, ApproveRequest, PlanPublic, RejectRequest, ReviseRequest, TaskDetail
from tagent_server.tasks_service import approve_plan, expire_due, reject_plan, revise_plan

router = APIRouter(prefix="/plans", tags=["plans"])


@router.get("/{plan_id}", response_model=PlanPublic, openapi_extra=USER_SECURITY)
def get_plan(
    plan_id: uuid.UUID,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
) -> PlanPublic:
    del user
    plan = session.get(Plan, plan_id)
    if plan is None:
        raise HTTPException(status_code=404, detail="计划不存在")
    return plan_public(plan)


@router.post("/{plan_id}/approve", response_model=ApprovalPublic, openapi_extra=USER_SECURITY)
def approve(
    plan_id: uuid.UUID,
    payload: ApproveRequest,
    request: Request,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
) -> ApprovalPublic:
    del user
    now = utcnow()
    expire_due(session, now)
    approval, run = approve_plan(session, request.app.state.settings, plan_id, payload, now)
    return approval_public(approval, run)


@router.post("/{plan_id}/reject", response_model=TaskDetail, openapi_extra=USER_SECURITY)
def reject(
    plan_id: uuid.UUID,
    payload: RejectRequest,
    request: Request,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
) -> TaskDetail:
    del user
    now = utcnow()
    expire_due(session, now)
    task = reject_plan(session, plan_id, payload, now)
    return task_detail(session, task, request.app.state.settings, now)


@router.post("/{plan_id}/revise", response_model=TaskDetail, openapi_extra=USER_SECURITY)
def revise(
    plan_id: uuid.UUID,
    payload: ReviseRequest,
    request: Request,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
) -> TaskDetail:
    del user
    settings: Settings = request.app.state.settings
    now = utcnow()
    expire_due(session, now)
    task = revise_plan(session, settings, plan_id, payload, now)
    return task_detail(session, task, settings, now)
