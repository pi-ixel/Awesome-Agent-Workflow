from __future__ import annotations

import logging
import re
import uuid
from datetime import date
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import ProjectRegistry, Settings
from ..errors import ApiError
from ..models import Component, ComponentRepo, WorkflowRun
from ..services.admin import (
    ATTRIBUTION_STATUSES,
    EXCLUDED_MODES,
    RECORD_KINDS,
    RECORD_STATUSES,
    AdminAttributionService,
    RecordFilters,
)
from ..services.log_viewer import LOG_FILES, MAX_LINES, describe_files, read_tail
from ..services.owner_overview import OwnerOverviewService
from ..services.people import PeopleService
from ..services.registry import RegistryService
from ..services.version_ops import DEFAULT_WINDOW_DAYS, VersionOpsService
from ..services.workflow_admin import WorkflowAdminService

logger = logging.getLogger("aaw_telemetry.admin")

# canonical url 必须是常见 git 地址形态，避免误录无意义文本污染注册表
_CANONICAL_URL_RE = re.compile(
    r"^(?:(?:https?|ssh|git)://\S+|git@[A-Za-z0-9._-]+[:/]\S+)$"
)


def _validate_canonical_url(value: str) -> None:
    if not _CANONICAL_URL_RE.match(value):
        raise ApiError(
            400,
            "INVALID_FIELD",
            "canonical url 须为 git 地址（https://、ssh://、git:// 或 git@host:path）",
        )


class ComponentCreate(BaseModel):
    component_id: str = Field(
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$", min_length=1, max_length=128
    )
    name: str = Field(min_length=1, max_length=128)
    se: str | None = Field(default=None, max_length=64)


class ComponentUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    se: str | None = Field(default=None, max_length=64)


class RepoCreate(BaseModel):
    repo_key: str = Field(
        pattern=r"^[A-Za-z0-9][A-Za-z0-9./_-]*$", min_length=1, max_length=256
    )
    canonical_url: str = Field(min_length=1, max_length=2048)
    target_branch: str = Field(default="master", min_length=1, max_length=512)
    enabled: bool = True

    @field_validator("canonical_url")
    @classmethod
    def _check_url(cls, value: str) -> str:
        _validate_canonical_url(value)
        return value


class RepoUpdate(BaseModel):
    canonical_url: str | None = Field(default=None, min_length=1, max_length=2048)
    target_branch: str | None = Field(default=None, min_length=1, max_length=512)
    enabled: bool | None = None

    @field_validator("canonical_url")
    @classmethod
    def _check_url(cls, value: str | None) -> str | None:
        if value is not None:
            _validate_canonical_url(value)
        return value


class ExcludeRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=512)
    operator: str | None = Field(default=None, max_length=128)
    # 语义升级（设计说明书 §3.3）：删除必须挂结构化理由码，默认兼容旧调用
    reason_code: str = Field(default="other", max_length=32)


class RestoreRequest(BaseModel):
    operator: str | None = Field(default=None, max_length=128)


class DeleteRequest(BaseModel):
    reason_code: str = Field(min_length=1, max_length=32)
    reason: str | None = Field(default=None, max_length=512)
    operator: str | None = Field(default=None, max_length=128)


class BulkRequest(BaseModel):
    action: Literal["retry", "force_retry", "exclude", "restore"]
    dry_run: bool = False
    reason: str | None = Field(default=None, max_length=512)
    operator: str | None = Field(default=None, max_length=128)
    reason_code: str = Field(default="other", max_length=32)
    # Combined search conditions, identical to GET /attribution/records.
    repository: str | None = None
    user: str | None = None
    sr: str | None = None
    ar: str | None = None
    mr: str | None = None
    attribution_status: str | None = None
    result_status: str | None = None
    quality_flag: str | None = None
    algorithm_version: str | None = None
    workflow_kind: str | None = None
    entry: str | None = None
    from_date: date | None = None
    to_date: date | None = None
    excluded: str = "hidden"


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
        workflow_counts = dict(
            session.execute(
                select(WorkflowRun.deleted, func.count()).group_by(WorkflowRun.deleted)
            ).all()
        )
        return {
            "scheduler": scheduler.status(),
            "attribution": attribution.counts(),
            "registry": {"components": components, "repos": repos},
            "workflows": {
                "active": workflow_counts.get(False, 0),
                "deleted": workflow_counts.get(True, 0),
            },
            "owners": OwnerOverviewService(session, projects).overview(),
            "logs": describe_files(log_directory),
        }

    @router.get("/people", summary="责任人下的人员使用情况（到人）")
    def people(
        repository: Annotated[list[str] | None, Query()] = None,
        window_days: Annotated[int, Query(ge=1, le=365)] = 30,
        session: Session = Depends(session_dependency),
    ):
        """按人聚合产出/采纳/版本；带 repository 时只看这批仓库上的人（责任人 scope）。"""
        return PeopleService(session, projects, settings).summary(
            list(repository or []), window_days=window_days
        )

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
        # 空轮是常态（演示页曾每秒点一次刷屏），只有真的处理了记录才值得 INFO
        if processed or revived:
            logger.info(
                f"管理员触发归因扫描，本轮处理 {processed} 条"
                + ("，调度器已从自暂停中恢复" if revived else ""),
                extra={"event": "admin.attribution_scan", "processed": processed},
            )
        else:
            logger.debug(
                "管理员触发归因扫描，本轮无待处理记录",
                extra={"event": "admin.attribution_scan", "processed": 0},
            )
        return {"processed": processed, "already_running": False, "revived": revived}

    # ------------------------------------------------------------------
    # Attribution management plane (检索 / 详情 / 无关化 / 强制重跑 / 批量 / 体检)

    def _record_filters(
        repository: str | None,
        user: str | None,
        sr: str | None,
        ar: str | None,
        mr: str | None,
        attribution_status: str | None,
        result_status: str | None,
        quality_flag: str | None,
        algorithm_version: str | None,
        workflow_kind: str | None,
        entry: str | None,
        from_date: date | None,
        to_date: date | None,
        excluded: str,
        record_kind: str = "all",
    ) -> RecordFilters:
        if attribution_status is not None and attribution_status not in RECORD_STATUSES:
            raise ApiError(400, "INVALID_STATUS", f"未知记录状态 {attribution_status}")
        if result_status is not None and result_status not in (
            "finalized_match",
            "finalized_no_match",
        ):
            raise ApiError(400, "INVALID_STATUS", f"未知结果状态 {result_status}")
        if workflow_kind is not None and workflow_kind not in ("aaw", "testing"):
            raise ApiError(400, "INVALID_FILTER", f"未知通道 {workflow_kind}")
        if entry is not None and entry not in ("sr", "ar", "dev"):
            raise ApiError(400, "INVALID_FILTER", f"未知入口类型 {entry}")
        if excluded not in EXCLUDED_MODES:
            raise ApiError(400, "INVALID_FILTER", f"未知排除模式 {excluded}")
        if record_kind not in RECORD_KINDS:
            raise ApiError(400, "INVALID_FILTER", f"未知记录类别 {record_kind}")
        if from_date and to_date and from_date > to_date:
            raise ApiError(400, "INVALID_FILTER", "from 必须早于 to")
        return RecordFilters(
            repository=repository,
            user=user,
            sr=sr,
            ar=ar,
            mr=mr,
            attribution_status=attribution_status,
            result_status=result_status,
            quality_flag=quality_flag,
            algorithm_version=algorithm_version,
            workflow_kind=workflow_kind,
            entry=entry,
            from_date=from_date,
            to_date=to_date,
            excluded=excluded,
            record_kind=record_kind,
        )

    @router.get("/attribution/records", summary="归因记录组合检索（含未入队）")
    def records(
        repository: str | None = Query(default=None),
        user: str | None = Query(default=None),
        sr: str | None = Query(default=None),
        ar: str | None = Query(default=None),
        mr: str | None = Query(default=None),
        attribution_status: str | None = Query(default=None),
        result_status: str | None = Query(default=None),
        quality_flag: str | None = Query(default=None),
        algorithm_version: str | None = Query(default=None),
        workflow_kind: str | None = Query(default=None),
        entry: str | None = Query(default=None),
        from_date: Annotated[date | None, Query(alias="from")] = None,
        to_date: Annotated[date | None, Query(alias="to")] = None,
        excluded: str = Query(default="hidden"),
        record_kind: str = Query(default="all"),
        page: Annotated[int, Query(ge=1)] = 1,
        page_size: Annotated[int, Query(ge=1, le=200)] = 25,
        session: Session = Depends(session_dependency),
    ):
        filters = _record_filters(
            repository, user, sr, ar, mr, attribution_status, result_status,
            quality_flag, algorithm_version, workflow_kind, entry,
            from_date, to_date, excluded, record_kind,
        )
        return AdminAttributionService(session, settings).records(
            filters, page=page, page_size=page_size
        )

    @router.get("/attribution/records/{dev_run_id}/detail", summary="归因记录详情")
    def record_detail(
        dev_run_id: str, session: Session = Depends(session_dependency)
    ):
        try:
            parsed = uuid.UUID(dev_run_id)
        except ValueError as exc:
            raise ApiError(400, "INVALID_ID", "dev_run_id 必须是 UUID") from exc
        return AdminAttributionService(session, settings).detail(parsed)

    @router.post(
        "/attribution/records/{dev_run_id}/exclude", summary="删除一条开发产出"
    )
    def exclude_record(
        dev_run_id: str,
        payload: ExcludeRequest,
        session: Session = Depends(session_dependency),
    ):
        try:
            parsed = uuid.UUID(dev_run_id)
        except ValueError as exc:
            raise ApiError(400, "INVALID_ID", "dev_run_id 必须是 UUID") from exc
        return AdminAttributionService(session, settings).exclude(
            parsed,
            reason=payload.reason,
            operator=payload.operator,
            reason_code=payload.reason_code,
        )

    @router.post(
        "/attribution/records/{dev_run_id}/restore", summary="恢复被无关化的开发记录"
    )
    def restore_record(
        dev_run_id: str,
        payload: RestoreRequest | None = None,
        session: Session = Depends(session_dependency),
    ):
        try:
            parsed = uuid.UUID(dev_run_id)
        except ValueError as exc:
            raise ApiError(400, "INVALID_ID", "dev_run_id 必须是 UUID") from exc
        operator = payload.operator if payload is not None else None
        return AdminAttributionService(session, settings).restore(
            parsed, operator=operator
        )

    @router.post(
        "/attribution/records/{dev_run_id}/retry", summary="手动重置并重跑一条归因"
    )
    def retry_record(dev_run_id: str, session: Session = Depends(session_dependency)):
        try:
            parsed = uuid.UUID(dev_run_id)
        except ValueError as exc:
            raise ApiError(400, "INVALID_ID", "dev_run_id 必须是 UUID") from exc
        return AdminAttributionService(session, settings).retry(parsed, scheduler)

    @router.post(
        "/attribution/records/{dev_run_id}/force-retry",
        summary="强制重跑（绕过重试窗口）",
    )
    def force_retry_record(
        dev_run_id: str, session: Session = Depends(session_dependency)
    ):
        try:
            parsed = uuid.UUID(dev_run_id)
        except ValueError as exc:
            raise ApiError(400, "INVALID_ID", "dev_run_id 必须是 UUID") from exc
        return AdminAttributionService(session, settings).force_retry(parsed, scheduler)

    @router.post("/attribution/bulk", summary="批量处理归因记录（支持预览）")
    def bulk(payload: BulkRequest, session: Session = Depends(session_dependency)):
        filters = _record_filters(
            payload.repository, payload.user, payload.sr, payload.ar, payload.mr,
            payload.attribution_status, payload.result_status, payload.quality_flag,
            payload.algorithm_version, payload.workflow_kind, payload.entry,
            payload.from_date, payload.to_date, payload.excluded,
        )
        needs_reason = payload.action == "exclude" and not payload.dry_run
        if needs_reason and not (payload.reason or "").strip():
            raise ApiError(400, "EXCLUSION_REASON_REQUIRED", "批量无关化必须填写原因")
        return AdminAttributionService(session, settings).bulk(
            action=payload.action,
            filters=filters,
            dry_run=payload.dry_run,
            reason=payload.reason,
            operator=payload.operator,
            scheduler=scheduler,
        )

    @router.get("/attribution/health", summary="归因积压体检与调度器健康")
    def attribution_health(session: Session = Depends(session_dependency)):
        return AdminAttributionService(session, settings).health(
            scheduler_status=scheduler.status()
        )

    # ------------------------------------------------------------------
    # Workflow management plane（工作流 tab：浏览 / 详情 / 三级删除 / 归档恢复）

    @router.get("/workflows", summary="工作流列表")
    def admin_workflows(
        user: str | None = Query(default=None),
        repository: str | None = Query(default=None),
        state: str = Query(default="all"),
        lifecycle: str = Query(default="active"),
        workflow_kind: str = Query(default="aaw"),
        from_date: Annotated[date | None, Query(alias="from")] = None,
        to_date: Annotated[date | None, Query(alias="to")] = None,
        page: Annotated[int, Query(ge=1)] = 1,
        page_size: Annotated[int, Query(ge=1, le=100)] = 25,
        session: Session = Depends(session_dependency),
    ):
        return WorkflowAdminService(session, settings).list_workflows(
            user=user,
            repository=repository,
            state=state,
            lifecycle=lifecycle,
            workflow_kind=workflow_kind,
            from_date=from_date,
            to_date=to_date,
            page=page,
            page_size=page_size,
        )

    @router.get("/workflows/{workflow_id}/detail", summary="工作流详情（步骤/产出/归因三级同屏）")
    def admin_workflow_detail(
        workflow_id: str, session: Session = Depends(session_dependency)
    ):
        try:
            parsed = uuid.UUID(workflow_id)
        except ValueError as exc:
            raise ApiError(400, "INVALID_ID", "workflow_id 必须是 UUID") from exc
        return WorkflowAdminService(session, settings).detail(parsed)

    @router.post("/workflows/{workflow_id}/delete", summary="删除工作流（连带全部产出与归因）")
    def admin_workflow_delete(
        workflow_id: str,
        payload: DeleteRequest,
        session: Session = Depends(session_dependency),
    ):
        try:
            parsed = uuid.UUID(workflow_id)
        except ValueError as exc:
            raise ApiError(400, "INVALID_ID", "workflow_id 必须是 UUID") from exc
        return WorkflowAdminService(session, settings).delete_workflow(
            parsed,
            reason_code=payload.reason_code,
            reason=payload.reason,
            operator=payload.operator,
        )

    @router.post("/workflows/{workflow_id}/restore", summary="恢复已删除的工作流")
    def admin_workflow_restore(
        workflow_id: str,
        payload: RestoreRequest | None = None,
        session: Session = Depends(session_dependency),
    ):
        try:
            parsed = uuid.UUID(workflow_id)
        except ValueError as exc:
            raise ApiError(400, "INVALID_ID", "workflow_id 必须是 UUID") from exc
        operator = payload.operator if payload is not None else None
        return WorkflowAdminService(session, settings).restore_workflow(
            parsed, operator=operator
        )

    @router.post("/dev-runs/{dev_run_id}/delete", summary="删除开发产出（分母剔除其生成行数）")
    def admin_dev_run_delete(
        dev_run_id: str,
        payload: DeleteRequest,
        session: Session = Depends(session_dependency),
    ):
        try:
            parsed = uuid.UUID(dev_run_id)
        except ValueError as exc:
            raise ApiError(400, "INVALID_ID", "dev_run_id 必须是 UUID") from exc
        return WorkflowAdminService(session, settings).delete_dev_run(
            parsed,
            reason_code=payload.reason_code,
            reason=payload.reason,
            operator=payload.operator,
        )

    @router.post("/dev-runs/{dev_run_id}/restore", summary="恢复已删除的开发产出")
    def admin_dev_run_restore(
        dev_run_id: str,
        payload: RestoreRequest | None = None,
        session: Session = Depends(session_dependency),
    ):
        try:
            parsed = uuid.UUID(dev_run_id)
        except ValueError as exc:
            raise ApiError(400, "INVALID_ID", "dev_run_id 必须是 UUID") from exc
        operator = payload.operator if payload is not None else None
        return WorkflowAdminService(session, settings).restore_dev_run(
            parsed, operator=operator
        )

    @router.get(
        "/dev-runs/{dev_run_id}/patch",
        summary="补丁文件内容（默认 JSON 预览，download=true 附件下载）",
    )
    def admin_dev_run_patch(
        dev_run_id: str,
        download: bool = Query(default=False),
        session: Session = Depends(session_dependency),
    ):
        try:
            parsed = uuid.UUID(dev_run_id)
        except ValueError as exc:
            raise ApiError(400, "INVALID_ID", "dev_run_id 必须是 UUID") from exc
        result = WorkflowAdminService(session, settings).patch_content(parsed)
        raw = result.pop("raw", None)
        if download:
            if raw is None:
                raise ApiError(
                    404, "PATCH_NOT_FOUND", result.get("reason", "补丁文件不存在")
                )
            safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", result["file_name"])
            return Response(
                content=raw,
                media_type="text/plain; charset=utf-8",
                headers={
                    "Content-Disposition": f'attachment; filename="{safe_name}"'
                },
            )
        return result

    @router.post(
        "/attributions/{dev_run_id}/delete",
        summary="删除归因结果（该产出退回未归因状态）",
    )
    def admin_attribution_delete(
        dev_run_id: str,
        payload: DeleteRequest,
        session: Session = Depends(session_dependency),
    ):
        try:
            parsed = uuid.UUID(dev_run_id)
        except ValueError as exc:
            raise ApiError(400, "INVALID_ID", "dev_run_id 必须是 UUID") from exc
        return WorkflowAdminService(session, settings).delete_attribution(
            parsed,
            reason_code=payload.reason_code,
            reason=payload.reason,
            operator=payload.operator,
        )

    @router.post("/attributions/{dev_run_id}/restore", summary="恢复已删除的归因结果")
    def admin_attribution_restore(
        dev_run_id: str,
        payload: RestoreRequest | None = None,
        session: Session = Depends(session_dependency),
    ):
        try:
            parsed = uuid.UUID(dev_run_id)
        except ValueError as exc:
            raise ApiError(400, "INVALID_ID", "dev_run_id 必须是 UUID") from exc
        operator = payload.operator if payload is not None else None
        return WorkflowAdminService(session, settings).restore_attribution(
            parsed, operator=operator
        )

    # ------------------------------------------------------------------
    # Version operations (版本运营视图)

    @router.get("/versions/roster", summary="旧版本使用名单")
    def versions_roster(
        window_days: Annotated[int, Query(ge=1, le=365)] = DEFAULT_WINDOW_DAYS,
        session: Session = Depends(session_dependency),
    ):
        return VersionOpsService(session, settings).roster(window_days)

    @router.get("/versions/distribution", summary="版本分布")
    def versions_distribution(
        window_days: Annotated[int, Query(ge=1, le=365)] = DEFAULT_WINDOW_DAYS,
        session: Session = Depends(session_dependency),
    ):
        return VersionOpsService(session, settings).distribution(window_days)

    @router.get("/versions/timeline", summary="用户版本升级轨迹")
    def versions_timeline(
        user_email: str = Query(min_length=3),
        session: Session = Depends(session_dependency),
    ):
        return VersionOpsService(session, settings).timeline(user_email)

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
        since: str | None = Query(
            default=None, description="起始时间（本地时间 YYYY-MM-DD [HH:MM[:SS]]）"
        ),
        until: str | None = Query(
            default=None, description="结束时间（本地时间，含该分钟）"
        ),
    ):
        return read_tail(
            log_directory,
            file,
            lines=lines,
            level=level,
            event=event,
            query=q,
            since=since,
            until=until,
        )

    return router
