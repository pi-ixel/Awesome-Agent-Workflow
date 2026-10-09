from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .api import build_router
from .config import Settings, get_settings
from .database import (
    Base,
    build_engine,
    build_session_factory,
    migrate_schema,
    session_dependency,
)
from .errors import EvalError
from .jobs import JobManager
from .services.orchestration import ExperimentOrchestrator


def create_app(settings: Settings | None = None, *, engine=None) -> FastAPI:
    settings = settings or get_settings()
    settings.ensure_directories()
    engine = engine or build_engine(settings)
    Base.metadata.create_all(engine)
    migrate_schema(engine)
    session_factory = build_session_factory(engine)
    get_session = session_dependency(session_factory)
    orchestrator = ExperimentOrchestrator(settings, session_factory)
    jobs = JobManager(session_factory, orchestrator)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await jobs.start()
        try:
            yield
        finally:
            await jobs.stop()

    app = FastAPI(
        title="AAW Skill Eval",
        version="0.1.0",
        docs_url="/api/docs",
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.engine = engine
    app.state.session_factory = session_factory
    app.state.orchestrator = orchestrator
    app.state.jobs = jobs
    app.include_router(
        build_router(
            settings=settings,
            session_factory=session_factory,
            get_session=get_session,
            orchestrator=orchestrator,
            jobs=jobs,
        )
    )

    static_dir = Path(__file__).with_name("static")
    app.mount("/assets", StaticFiles(directory=static_dir), name="assets")

    @app.get("/", include_in_schema=False)
    def index():
        return FileResponse(static_dir / "index.html", media_type="text/html; charset=utf-8")

    @app.get("/health", include_in_schema=False)
    def health():
        return {"status": "ok"}

    @app.exception_handler(EvalError)
    async def eval_error_handler(_: Request, exc: EvalError):
        return JSONResponse(
            status_code=exc.status_code,
            content={"code": exc.code, "message": exc.message, "kind": exc.kind},
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(_: Request, exc: RequestValidationError):
        return JSONResponse(
            status_code=400,
            content={
                "code": "INVALID_REQUEST",
                "message": "; ".join(
                    f"{'.'.join(str(part) for part in item['loc'])}: {item['msg']}"
                    for item in exc.errors()
                )[:3000],
                "kind": "invalid",
            },
        )

    return app
