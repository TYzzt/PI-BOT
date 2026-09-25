import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from tagent_server.deps import get_session, require_user
from tagent_server.models import Event, User
from tagent_server.openapi_extra import USER_SECURITY
from tagent_server.present import event_public
from tagent_server.schemas import EventPage

router = APIRouter(prefix="/events", tags=["events"])


def read_events(session: Session, after: int, limit: int, task_id: uuid.UUID | None = None) -> EventPage:
    query = select(Event).where(Event.server_cursor > after)
    if task_id is not None:
        query = query.where(Event.task_id == task_id)
    rows = session.scalars(query.order_by(Event.server_cursor).limit(limit + 1)).all()
    page = rows[:limit]
    return EventPage(
        events=[event_public(event) for event in page],
        next_cursor=page[-1].server_cursor if page else after,
        has_more=len(rows) > limit,
    )


@router.get("", response_model=EventPage, openapi_extra=USER_SECURITY)
def list_events(
    after: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    task_id: uuid.UUID | None = None,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
) -> EventPage:
    del user
    return read_events(session, after, limit, task_id)
