from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from ..config import ProjectRegistry, Settings
from ..services.admin_auth import AdminAuth
from ..services.anomalies import AnomalyService


class StrictPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AdminLogin(StrictPayload):
    password: str = Field(min_length=1, max_length=256)


class RulePayload(StrictPayload):
    name: str = Field(min_length=1, max_length=128)
    category: Literal["component", "workflow", "attribution", "version"]
    detector_type: str = Field(min_length=1, max_length=64)
    scope_type: Literal["platform", "component", "repository"] = "platform"
    scope_value: str | None = Field(default=None, max_length=256)
    params: dict[str, Any] = Field(default_factory=dict)
    allow_archive: bool = True
    status: Literal["draft", "enabled", "disabled"] = "draft"
    change_reason: str | None = Field(default=None, max_length=512)


class RuleStatusPayload(StrictPayload):
    status: Literal["enabled", "disabled"]
    reason: str = Field(min_length=1, max_length=512)


class RuleDeletePayload(StrictPayload):
    reason: str = Field(min_length=1, max_length=512)


class ArchiveRequestPayload(StrictPayload):
    reason: str = Field(min_length=1, max_length=1000)
    requested_by: str = Field(min_length=1, max_length=128)


class TargetArchivePayload(StrictPayload):
    """业务页（工作流/归因）对数据对象直接发起屏蔽申请。"""

    reason: str = Field(min_length=1, max_length=1000)
    requested_by: str = Field(min_length=1, max_length=128)


class ArchiveReviewPayload(StrictPayload):
    approved: bool
    note: str = Field(default="", max_length=1000)


class IssueFromAnomalyPayload(StrictPayload):
    suggestion: str = Field(min_length=1, max_length=5000)
    reporter: str = Field(min_length=1, max_length=100)
    assignee: str = Field(min_length=1, max_length=32)


def build_anomalies_router(
    session_dependency,
    settings: Settings,
    projects: ProjectRegistry,
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/anomalies", tags=["anomalies"])
    auth = AdminAuth(settings)

    @router.post("/admin/login")
    def login(payload: AdminLogin, request: Request, response: Response):
        context = auth.login(request, response, payload.password)
        return {
            "authenticated": True,
            "csrf_token": context.csrf_token,
            "expires_at": context.expires_at,
        }

    @router.post("/admin/logout")
    def logout(request: Request, response: Response):
        auth.require(request, csrf=True)
        auth.logout(response)
        return {"authenticated": False}

    @router.get("/admin/session")
    def session_status(request: Request):
        context = auth.require(request)
        return {
            "authenticated": True,
            "csrf_token": context.csrf_token,
            "expires_at": context.expires_at,
        }

    @router.get("/detector-types")
    def detector_types():
        """检测类型目录：判定句模板与默认参数。

        按 AI Master 查看自己异常时，/events 与 /summary 都是公开的，而表格里
        "?"悬停提示要用这里的文案，所以这里同样不能要管理员密码——否则非管理员
        使用者一进页面就取不到目录、整页空白。内容只是内置检测器的静态元数据，
        不含规则配置或用户数据；带启停与审计的 /rules 仍然要求管理员。
        """
        return AnomalyService.detector_catalog()

    @router.get("/rules")
    def list_rules(
        request: Request,
        include_deleted: bool = False,
        session: Session = Depends(session_dependency),
    ):
        auth.require(request)
        return AnomalyService(session, projects).list_rules(include_deleted)

    @router.post("/rules", status_code=201)
    def create_rule(
        payload: RulePayload,
        request: Request,
        session: Session = Depends(session_dependency),
    ):
        context = auth.require(request, csrf=True)
        return AnomalyService(session, projects).create_rule(payload.model_dump(), context.actor)

    @router.post("/rules/preview")
    def preview_rule(
        payload: RulePayload,
        request: Request,
        session: Session = Depends(session_dependency),
    ):
        auth.require(request, csrf=True)
        return AnomalyService(session, projects).preview_rule(payload.model_dump())

    @router.get("/rules/{rule_id}")
    def rule_detail(
        rule_id: uuid.UUID,
        request: Request,
        session: Session = Depends(session_dependency),
    ):
        auth.require(request)
        return AnomalyService(session, projects).rule_detail(rule_id)

    @router.put("/rules/{rule_id}")
    def update_rule(
        rule_id: uuid.UUID,
        payload: RulePayload,
        request: Request,
        session: Session = Depends(session_dependency),
    ):
        context = auth.require(request, csrf=True)
        return AnomalyService(session, projects).update_rule(
            rule_id, payload.model_dump(), context.actor
        )

    @router.post("/rules/{rule_id}/status")
    def change_rule_status(
        rule_id: uuid.UUID,
        payload: RuleStatusPayload,
        request: Request,
        session: Session = Depends(session_dependency),
    ):
        context = auth.require(request, csrf=True)
        return AnomalyService(session, projects).change_rule_status(
            rule_id, payload.status, payload.reason, context.actor
        )

    @router.delete("/rules/{rule_id}")
    def delete_rule(
        rule_id: uuid.UUID,
        payload: RuleDeletePayload,
        request: Request,
        session: Session = Depends(session_dependency),
    ):
        context = auth.require(request, csrf=True)
        return AnomalyService(session, projects).delete_rule(rule_id, payload.reason, context.actor)

    @router.post("/rules/evaluate")
    def evaluate_rules(
        request: Request,
        rule_id: uuid.UUID | None = None,
        dry_run: bool = False,
        session: Session = Depends(session_dependency),
    ):
        auth.require(request, csrf=True)
        return AnomalyService(session, projects).evaluate(rule_id, dry_run=dry_run)

    @router.get("/summary")
    def summary(
        request: Request,
        ai_master_id: uuid.UUID | None = None,
        admin_view: bool = False,
        session: Session = Depends(session_dependency),
    ):
        if admin_view:
            auth.require(request)
        return AnomalyService(session, projects).summary(ai_master_id, admin_view=admin_view)

    @router.get("/events")
    def list_events(
        request: Request,
        ai_master_id: uuid.UUID | None = None,
        include_closed: bool = False,
        admin_view: bool = False,
        category: Literal["component", "workflow", "attribution", "version"] | None = None,
        session: Session = Depends(session_dependency),
    ):
        if admin_view or include_closed:
            auth.require(request)
        return AnomalyService(session, projects).list_events(
            ai_master_id=ai_master_id,
            include_closed=include_closed,
            admin_view=admin_view,
            category=category,
        )

    @router.get("/events/{event_id}")
    def event_detail(
        event_id: uuid.UUID,
        session: Session = Depends(session_dependency),
    ):
        return AnomalyService(session, projects).event_detail(event_id)

    @router.post("/events/{event_id}/archive-requests", status_code=201)
    def request_archive(
        event_id: uuid.UUID,
        payload: ArchiveRequestPayload,
        session: Session = Depends(session_dependency),
    ):
        return AnomalyService(session, projects).request_archive(
            event_id, payload.reason, payload.requested_by
        )

    @router.post("/targets/{target_type}/{target_id}/archive-requests", status_code=201)
    def request_archive_for_target(
        target_type: str,
        target_id: uuid.UUID,
        payload: TargetArchivePayload,
        request: Request,
        session: Session = Depends(session_dependency),
    ):
        auth.require(request, csrf=True)
        return AnomalyService(session, projects).request_archive_for_target(
            target_type,
            target_id,
            reason=payload.reason,
            requested_by=payload.requested_by,
        )

    @router.post("/events/{event_id}/issues", status_code=201)
    def create_issue(
        event_id: uuid.UUID,
        payload: IssueFromAnomalyPayload,
        session: Session = Depends(session_dependency),
    ):
        return AnomalyService(session, projects).create_issue(
            event_id,
            suggestion=payload.suggestion,
            reporter=payload.reporter,
            assignee=payload.assignee,
        )

    @router.get("/archive-requests")
    def archive_requests(
        request: Request,
        status: Literal["pending", "approved", "rejected", "cancelled"] | None = None,
        session: Session = Depends(session_dependency),
    ):
        auth.require(request)
        return AnomalyService(session, projects).list_archive_requests(status)

    @router.post("/archive-requests/{request_id}/review")
    def review_archive(
        request_id: uuid.UUID,
        payload: ArchiveReviewPayload,
        request: Request,
        session: Session = Depends(session_dependency),
    ):
        context = auth.require(request, csrf=True)
        return AnomalyService(session, projects).review_archive(
            request_id,
            approved=payload.approved,
            note=payload.note,
            actor=context.actor,
        )

    return router
