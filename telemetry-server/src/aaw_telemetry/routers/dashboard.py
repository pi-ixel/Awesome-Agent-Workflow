from __future__ import annotations

import logging
import uuid
from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from ..config import ProjectRegistry
from ..services.queries import QueryService, make_filters

logger = logging.getLogger(__name__)


def _log_query(endpoint: str, result: dict, **fields) -> None:
    extra = {"endpoint": endpoint, **fields}
    if "total" in result:
        extra["total"] = result["total"]
    if isinstance(result.get("items"), list):
        extra["returned"] = len(result["items"])
    if isinstance(result.get("points"), list):
        extra["returned"] = len(result["points"])
    logger.debug(
        "Dashboard 查询已完成",
        extra={"event": "dashboard.query_completed", **extra},
    )


def build_dashboard_router(
    session_dependency,
    projects: ProjectRegistry,
    *,
    prefix: str = "/api/v1",
    workflow_kind: str = "aaw",
) -> APIRouter:
    router = APIRouter(prefix=prefix, tags=["dashboard"])

    def filters(
        request: Request,
        from_date: Annotated[date | None, Query(alias="from")] = None,
        to_date: Annotated[date | None, Query(alias="to")] = None,
        repository: Annotated[list[str] | None, Query()] = None,
        user_email: Annotated[list[str] | None, Query()] = None,
        aaw_version: Annotated[list[str] | None, Query()] = None,
        sr: Annotated[list[str] | None, Query()] = None,
        ar: Annotated[list[str] | None, Query()] = None,
    ):
        return make_filters(
            from_date,
            to_date,
            (repository or []) + request.query_params.getlist("project_key"),
            (user_email or []) + request.query_params.getlist("git_user_email"),
            aaw_version or [],
            sr or [],
            ar or [],
            workflow_kind,
        )

    @router.get("/dashboard/filter-options")
    def filter_options(query=Depends(filters), session: Session = Depends(session_dependency)):
        result = QueryService(session, projects).filter_options(query)
        _log_query(
            "filter_options",
            result,
            repository_count=len(result["repositories"]),
            user_count=len(result["users"]),
        )
        return result

    @router.get("/dashboard/overview")
    def overview(query=Depends(filters), session: Session = Depends(session_dependency)):
        result = QueryService(session, projects).overview(query)
        _log_query("overview", result)
        return result

    @router.get("/dashboard/trends")
    def trends(
        granularity: Literal["day", "week"] = "day",
        query=Depends(filters),
        session: Session = Depends(session_dependency),
    ):
        result = QueryService(session, projects).trends(query, granularity)
        _log_query("trends", result, granularity=granularity)
        return result

    @router.get("/dashboard/projects")
    def projects_summary(
        page: Annotated[int, Query(ge=1)] = 1,
        page_size: Annotated[int, Query(ge=1, le=100)] = 50,
        query=Depends(filters),
        session: Session = Depends(session_dependency),
    ):
        result = QueryService(session, projects).projects_summary(query, page, page_size)
        _log_query("projects", result, page=page, page_size=page_size)
        return result

    @router.get("/dashboard/users")
    def users_summary(
        page: Annotated[int, Query(ge=1)] = 1,
        page_size: Annotated[int, Query(ge=1, le=100)] = 50,
        query=Depends(filters),
        session: Session = Depends(session_dependency),
    ):
        result = QueryService(session, projects).users_summary(query, page, page_size)
        _log_query("users", result, page=page, page_size=page_size)
        return result

    @router.get("/dashboard/steps")
    def steps_summary(
        page: Annotated[int, Query(ge=1)] = 1,
        page_size: Annotated[int, Query(ge=1, le=100)] = 50,
        query=Depends(filters),
        session: Session = Depends(session_dependency),
    ):
        result = QueryService(session, projects).steps_summary(query, page, page_size)
        _log_query("steps", result, page=page, page_size=page_size)
        return result

    @router.get("/dashboard/workflows")
    def workflows(
        state: Literal["in_progress", "completed", "active", "stalled"] | None = None,
        page: Annotated[int, Query(ge=1)] = 1,
        page_size: Annotated[int, Query(ge=1, le=100)] = 50,
        query=Depends(filters),
        session: Session = Depends(session_dependency),
    ):
        result = QueryService(session, projects).workflows(query, state, page, page_size)
        _log_query(
            "workflows",
            result,
            state=state,
            page=page,
            page_size=page_size,
        )
        return result

    @router.get("/workflows/{workflow_run_id}")
    def workflow_detail(
        workflow_run_id: uuid.UUID,
        session: Session = Depends(session_dependency),
    ):
        result = QueryService(session, projects).workflow_detail(workflow_run_id)
        _log_query("workflow_detail", result, workflow_id=str(workflow_run_id))
        return result

    @router.get("/statistics/code-attribution")
    def code_attributions(
        matched_mr_iid: str | None = None,
        result_status: Literal["finalized_match", "finalized_no_match"] | None = None,
        page: Annotated[int, Query(ge=1)] = 1,
        page_size: Annotated[int, Query(ge=1, le=100)] = 50,
        query=Depends(filters),
        session: Session = Depends(session_dependency),
    ):
        result = QueryService(session, projects).code_attributions(
            query, matched_mr_iid, result_status, page, page_size
        )
        _log_query(
            "code_attributions",
            result,
            result_status=result_status,
            page=page,
            page_size=page_size,
        )
        return result

    return router
