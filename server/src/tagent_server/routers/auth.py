import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from tagent_server.config import utcnow
from tagent_server.deps import get_session
from tagent_server.models import User
from tagent_server.schemas import LoginRequest, TokenResponse
from tagent_server.security import issue_token, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])
logger = logging.getLogger(__name__)


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, request: Request, session: Session = Depends(get_session)) -> TokenResponse:
    user = session.scalar(select(User).limit(1))
    if user is None or not verify_password(user.password_hash, payload.password):
        logger.info("login failed")
        raise HTTPException(status_code=401, detail="认证失败")
    settings = request.app.state.settings
    logger.info("login succeeded")
    return TokenResponse(access_token=issue_token(user.user_id, settings, utcnow()), expires_in=settings.jwt_ttl_seconds)
