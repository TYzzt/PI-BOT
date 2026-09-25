import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.openapi.utils import get_openapi
from fastapi.responses import JSONResponse
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from tagent_server.bootstrap import bootstrap_admin
from tagent_server.config import MAX_BODY_BYTES, Settings
from tagent_server.migrate import upgrade_database
from tagent_server.openapi_extra import SECURITY_SCHEMES
from tagent_server.routers import auth, devices, health, projects

logger = logging.getLogger(__name__)


def _sanitize_error(error: dict) -> dict:
    cleaned: dict = {}
    for key, value in error.items():
        if key == "input":
            continue
        if key == "loc":
            cleaned["loc"] = [str(item) for item in value]
        elif key == "ctx":
            cleaned["ctx"] = {str(name): str(item) for name, item in dict(value).items()}
        else:
            cleaned[key] = value
    return cleaned


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        upgrade_database()
        engine = create_engine(resolved.database_url, pool_pre_ping=True)
        app.state.engine = engine
        factory = sessionmaker(bind=engine)
        with factory() as session:
            bootstrap_admin(session, resolved.admin_password.get_secret_value())
        try:
            yield
        finally:
            engine.dispose()

    app = FastAPI(
        title="T-AGNET Server",
        version="0.1.0",
        description="阶段 1：单用户认证、设备配对与项目目录。不包含任务、聊天、事件回放和云端问答。",
        lifespan=lifespan,
        redirect_slashes=False,
    )
    app.state.settings = resolved
    app.include_router(health.router)
    app.include_router(auth.router)
    app.include_router(devices.router)
    app.include_router(projects.router)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(status_code=422, content={"detail": [_sanitize_error(error) for error in exc.errors()]})

    @app.middleware("http")
    async def limit_body(request: Request, call_next):
        body = await request.body()
        if len(body) > MAX_BODY_BYTES:
            return JSONResponse(status_code=413, content={"detail": "请求体过大"})
        return await call_next(request)

    def openapi() -> dict:
        if app.openapi_schema:
            return app.openapi_schema
        schema = get_openapi(title=app.title, version=app.version, description=app.description, routes=app.routes)
        components = schema.setdefault("components", {})
        schemes = components.setdefault("securitySchemes", {})
        schemes.update(SECURITY_SCHEMES)
        app.openapi_schema = schema
        return schema

    app.openapi = openapi  # type: ignore[method-assign]
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)
    return app
