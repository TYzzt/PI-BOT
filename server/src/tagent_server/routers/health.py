import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from tagent_server.schemas import HealthResponse

router = APIRouter(tags=["health"])
logger = logging.getLogger(__name__)


@router.get("/health", response_model=HealthResponse)
def health(request: Request) -> HealthResponse | JSONResponse:
    engine = getattr(request.app.state, "engine", None)
    if engine is None:
        return JSONResponse(status_code=503, content={"ok": False})
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
    except Exception:
        logger.error("health check failed")
        return JSONResponse(status_code=503, content={"ok": False})
    return HealthResponse(ok=True)
