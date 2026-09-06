from __future__ import annotations

import logging
import uuid
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import ProjectRegistry, Settings
from ..errors import ApiError
from ..models import Component, ComponentRepo
from ..services.admin import ATTRIBUTION_STATUSES, AdminAttributionService
from ..services.log_viewer import LOG_FILES, MAX_LINES, describe_files, read_tail
from ..services.registry import RegistryService

logger = logging.getLogger("aaw_telemetry.admin")


class ComponentCreate(BaseModel):
    component_id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=128)
    se: str | None = Field(default=None, max_length=64)


class ComponentUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    se: str | None = Field(default=None, max_length=64)


class RepoCreate(BaseModel):
    repo_key: str = Field(min_length=1, max_length=256)
    canonical_url: str = Field(min_length=1, max_length=2048)
    target_branch: str = Field(default="master", min_length=1, max_length=512)
    enabled: bool = True


class RepoUpdate(BaseModel):
    canonical_url: str | None = Field(default=None, min_length=1, max_length=2048)
    target_branch: str | None = Field(default=None, min_length=1, max_length=512)
    enabled: bool | None = None


def build_admin_router(
    session_dependency,
    settings: Settings,
    projects: ProjectRegistry,
    scheduler,
    log_directory: Path,
    *,
    prefix: str = "/api/v1/admin",
) -> APIRouter:
    router = APIRouter(prefix=prefix, tags=["admin"])

    # ------------------------------------------------------------------
    # Overview

    @router.get("/overview", summary="管理台总览")
    def overview(session: Session = Depends(session_dependency)):
        attribution = AdminAttributionService(session, settings)
        components = session.execute(
            select(func.count()).select_from(Component)
        ).scalar_one()
        repos = session.execute(
            select(func.count()).select_from(ComponentRepo)
        ).scalar_one()
        return {
            "scheduler": scheduler.status(),
            "attribution": attribution.counts(),
            "registry": {"components": components, "repos": repos},
            "logs": describe_files(log_directory),
        }

    # ------------------------------------------------------------------
    # Attribution queue

    @router.get("/attribution/queue", summary="归因队列")
    def queue(
        attribution_status: str | None = Query(default=None),
        result_status: str | None = Query(default=None),
        page: Annotated[int, Query(ge=1)] = 1,
        page_size: Annotated[int, Query(ge=1, le=100)] = 50,
        session: Session = Depends(session_dependency),
    ):
        if attribution_status is not None and attribution_status not in ATTRIBUTION_STATUSES:
            raise ApiError(
                400, "INVALID_STATUS", f"未知归因状态 {attribution_status}"
            )
        return AdminAttributionService(session, settings).queue(
            attribution_status=attribution_status,
            result_status=result_status,
            page=page,
            page_size=page_size,
        )

    @router.post("/attribution/{dev_run_id}/retry", summary="手动重置并重跑一条归因")
    def retry(dev_run_id: str, session: Session = Depends(session_dependency)):
        try:
            parsed = uuid.UUID(dev_run_id)
        except ValueError as exc:
            raise ApiError(400, "INVALID_ID", "dev_run_id 必须是 UUID") from exc
        return AdminAttributionService(session, settings).retry(parsed, scheduler)

    @router.post("/attribution/scan", summary="立即触发一轮归因扫描")
    def trigger_scan():
        revived = scheduler.revive()
        processed = scheduler.try_scan()
        if processed is None:
            return {"processed": None, "already_running": True, "revived": revived}
        logger.info(
            "管理员触发归因扫描",
            extra={"event": "admin.attribution_scan", "processed": processed},
        )
        return {"processed": processed, "already_running": False, "revived": revived}

    # ------------------------------------------------------------------
    # Registry

    @router.get("/registry", summary="注册表内容")
    def registry(session: Session = Depends(session_dependency)):
        return RegistryService(session, projects).snapshot()

    @router.post("/registry/components", status_code=201, summary="新增组件")
    def create_component(
        payload: ComponentCreate, session: Session = Depends(session_dependency)
    ):
        return RegistryService(session, projects).create_component(
            payload.component_id, payload.name, payload.se
        )

    @router.patch("/registry/components/{component_id}", summary="更新组件")
    def update_component(
        component_id: str,
        payload: ComponentUpdate,
        session: Session = Depends(session_dependency),
    ):
        return RegistryService(session, projects).update_component(
            component_id, payload.name, payload.se
        )

    @router.delete("/registry/components/{component_id}", summary="删除组件")
    def delete_component(component_id: str, session: Session = Depends(session_dependency)):
        return RegistryService(session, projects).delete_component(component_id)

    @router.post(
        "/registry/components/{component_id}/repos", status_code=201, summary="新增仓库"
    )
    def create_repo(
        component_id: str,
        payload: RepoCreate,
        session: Session = Depends(session_dependency),
    ):
        return RegistryService(session, projects).create_repo(
            component_id,
            payload.repo_key,
            payload.canonical_url,
            payload.target_branch,
            payload.enabled,
        )

    @router.patch(
        "/registry/components/{component_id}/repos/{repo_key}", summary="更新仓库"
    )
    def update_repo(
        component_id: str,
        repo_key: str,
        payload: RepoUpdate,
        session: Session = Depends(session_dependency),
    ):
        return RegistryService(session, projects).update_repo(
            component_id,
            repo_key,
            canonical_url=payload.canonical_url,
            target_branch=payload.target_branch,
            enabled=payload.enabled,
        )

    @router.delete(
        "/registry/components/{component_id}/repos/{repo_key}", summary="删除仓库"
    )
    def delete_repo(
        component_id: str, repo_key: str, session: Session = Depends(session_dependency)
    ):
        return RegistryService(session, projects).delete_repo(component_id, repo_key)

    # ------------------------------------------------------------------
    # Logs

    @router.get("/logs", summary="日志尾部查看")
    def logs(
        file: str = Query(description=f"日志文件名，可选：{', '.join(LOG_FILES)}"),
        lines: Annotated[int, Query(ge=1, le=MAX_LINES)] = 200,
        level: str | None = Query(default=None, description="按 [LEVEL] 标记过滤"),
        event: str | None = Query(default=None, description="按 event= 字段过滤"),
        q: str | None = Query(default=None, description="子串过滤"),
    ):
        return read_tail(
            log_directory, file, lines=lines, level=level, event=event, query=q
        )

    return router
