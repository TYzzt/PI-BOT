import logging
import uuid

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from tagent_server.models import User
from tagent_server.security import hash_password

logger = logging.getLogger(__name__)


def bootstrap_admin(session: Session, password: str) -> None:
    existing = session.scalar(select(User.user_id))
    if existing is not None:
        logger.info("admin user exists")
        return
    session.add(User(user_id=uuid.uuid4(), password_hash=hash_password(password), singleton=True))
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        logger.info("admin user exists")
        return
    logger.info("bootstrapped admin user")
