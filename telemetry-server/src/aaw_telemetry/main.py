from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import text

from .config import ProjectRegistry, Settings, get_settings
from .database import build_engine, build_session_factory, session_dependency
from .errors import ApiError
from .logging import configure_logging, request_id_var
from .middleware import RequestBodyLimitMiddleware, RequestContextMiddleware
from .routers.dashboard import build_dashboard_router
from .routers.issues import build_issues_router
from .routers.objects import build_objects_router
from .routers.releases import build_releases_router
from .routers.telemetry import build_telemetry_router
from .routers.testing_telemetry import build_testing_telemetry_router
from .services.attribution_scheduler import AttributionScheduler
from .services.attribution_service import AttributionService
from .services.remote_attribution_service import RemoteAttributionService

logger = logging.getLogger("aaw_telemetry.system")


def create_app(
    settings: Settings | None = None,
    *,
    engine=None,
    projects: ProjectRegistry | None = None,
    attribution_service: AttributionService | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    log_directory = configure_logging(
        settings.logging_config_file,
        level=settings.log_level,
        directory_override=settings.log_directory,
    )
    engine = engine or build_engine(settings)
    projects = projects or ProjectRegistry.load(settings.projects_file)
    if attribution_service is None:
        attribution_service = RemoteAttributionService(
            settings.attribution_service_url,
            timeout_seconds=settings.attribution_timeout_seconds,
            api_token=(
                settings.attribution_api_token.get_secret_value()
                if settings.attribution_api_token
                else None
            ),
        )
    session_factory = build_session_factory(engine)
    get_session = session_dependency(session_factory)
    attribution_scheduler = AttributionScheduler(
        session_factory,
        settings,
        projects,
        attribution_service,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        scheduler_task = asyncio.create_task(
            attribution_scheduler.run(),
            name="attribution-scheduler",
        )
        logger.info(
            "Telemetry Server 已启动，可以接收请求",
            extra={"event": "service.started", "version": "0.1.0"},
        )
        try:
            yield
        finally:
            attribution_scheduler.stop()
            await scheduler_task
            logger.info("Telemetry Server 已停止", extra={"event": "service.stopped"})

    app = FastAPI(
        title="AAW Telemetry Server",
        version="0.1.0",
        docs_url="/docs",
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.log_directory = log_directory
    app.state.engine = engine
    app.state.projects = projects
    app.state.attribution_service = attribution_service
    app.state.attribution_scheduler = attribution_scheduler
    app.add_middleware(
        RequestBodyLimitMiddleware,
        max_bytes=settings.max_request_bytes,
        max_object_bytes=settings.max_patch_bytes,
    )
    app.add_middleware(RequestContextMiddleware)
    app.include_router(build_telemetry_router(get_session, projects, settings))
    app.include_router(build_dashboard_router(get_session, projects))
    app.include_router(build_testing_telemetry_router(get_session, projects, settings))
    app.include_router(
        build_dashboard_router(
            get_session, projects, prefix="/api/v1/testing", workflow_kind="testing"
        )
    )
    app.include_router(build_issues_router(get_session))
    app.include_router(
        build_objects_router(
            get_session,
            settings,
            attribution_scheduler.notify,
        )
    )
    app.include_router(
        build_objects_router(
            get_session,
            settings,
            attribution_scheduler.notify,
            prefix="/api/v1/testing/objects",
            workflow_kind="testing",
            diff_path="/code-changes/{message_id}",
        )
    )
    app.include_router(build_releases_router(settings))
    logger.info(
        "服务配置加载完成",
        extra={"event": "service.configured", "log_directory": str(log_directory)},
    )

    @app.get("/health/live", include_in_schema=False)
    def liveness():
        return {"status": "ok"}

    @app.get("/health/ready", include_in_schema=False)
    def readiness():
        try:
            with engine.connect() as connection:
                connection.execute(text("SELECT 1"))
            return {"status": "ok"}
        except Exception as exc:
            logger.error(
                "数据库连接不可用，服务暂未就绪",
                extra={"event": "health.database_unavailable"},
                exc_info=exc,
            )
            return JSONResponse(status_code=503, content={"status": "unavailable"})

    @app.get("/self-test", include_in_schema=False)
    def self_test_page():
        return FileResponse(
            Path(__file__).with_name("static") / "index.html",
            media_type="text/html; charset=utf-8",
        )

    @app.exception_handler(ApiError)
    async def api_error_handler(_: Request, exc: ApiError):
        level = logging.ERROR if exc.status_code >= 500 else logging.WARNING
        logger.log(
            level,
            "接口请求未能完成，已返回业务错误",
            extra={
                "event": "http.api_error",
                "status_code": exc.status_code,
                "error_code": exc.code,
                "retryable": exc.retryable,
            },
        )
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "request_id": request_id_var.get(),
                "code": exc.code,
                "message": exc.message,
                "retryable": exc.retryable,
            },
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, exc: RequestValidationError):
        code = "INVALID_FILTER" if "/dashboard/" in request.url.path else "INVALID_REQUEST"
        details = []
        for item in exc.errors():
            location = ".".join(str(part) for part in item["loc"])
            details.append(f"{location}: {item['msg']}")
        logger.warning(
            "接口参数校验失败，已拒绝请求",
            extra={
                "event": "http.validation_failed",
                "path": request.url.path,
                "error_code": code,
                "error_count": len(details),
            },
        )
        return JSONResponse(
            status_code=400,
            content={
                "request_id": request_id_var.get(),
                "code": code,
                "message": "; ".join(details)[:1000],
                "retryable": False,
            },
        )

    @app.exception_handler(Exception)
    async def unhandled_error_handler(_: Request, exc: Exception):
        logger.exception(
            "处理接口请求时发生未预期异常",
            extra={"event": "http.unhandled_error"},
            exc_info=exc,
        )
        return JSONResponse(
            status_code=500,
            content={
                "request_id": request_id_var.get(),
                "code": "INTERNAL_ERROR",
                "message": "unexpected service error",
                "retryable": True,
            },
        )

    return app


app = create_app()
