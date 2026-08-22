from __future__ import annotations

import argparse
import json
import time
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session, selectinload
from sqlalchemy.pool import StaticPool

from aaw_telemetry.config import (
    ComponentEntry,
    ComponentsDocument,
    ProjectEntry,
    ProjectRegistry,
)
from aaw_telemetry.database import Base
from aaw_telemetry.models import CodeAttribution, DevRun, TelemetryMessage, WorkflowRun
from aaw_telemetry.services.queries import QueryService, _aware, make_filters


class LegacyQueryService(QueryService):
    """Issue #119 修复前的查询方式，用于保留可复现的对照组。"""

    def _devs(self, message_ids: list[uuid.UUID]) -> list[DevRun]:
        if not message_ids:
            return []
        return list(
            self.session.scalars(select(DevRun).where(DevRun.id.in_(message_ids))).all()
        )

    def workflows(
        self, filters, state: str | None, page: int, page_size: int
    ) -> dict[str, Any]:
        rows = self._workflows(filters)
        threshold = datetime.now(UTC) - timedelta(hours=24)
        if state:
            rows = [row for row in rows if self._activity_state(row, threshold) == state]
        rows.sort(key=lambda row: (-_aware(row.last_activity_at).timestamp(), str(row.id)))
        items = [self._workflow_item(row, threshold) for row in rows]
        return self._paginate(items, page, page_size)


class EagerAttributionQueryService(LegacyQueryService):
    def _devs(self, message_ids: list[uuid.UUID]) -> list[DevRun]:
        if not message_ids:
            return []
        statement = (
            select(DevRun)
            .where(DevRun.id.in_(message_ids))
            .options(selectinload(DevRun.attribution))
        )
        return list(self.session.scalars(statement).all())


class EagerPageFirstQueryService(EagerAttributionQueryService):
    def workflows(
        self, filters, state: str | None, page: int, page_size: int
    ) -> dict[str, Any]:
        rows = self._workflows(filters)
        threshold = datetime.now(UTC) - timedelta(hours=24)
        if state:
            rows = [row for row in rows if self._activity_state(row, threshold) == state]
        rows.sort(key=lambda row: (-_aware(row.last_activity_at).timestamp(), str(row.id)))
        start = (page - 1) * page_size
        items = [
            self._workflow_item(row, threshold) for row in rows[start : start + page_size]
        ]
        return {"items": items, "page": page, "page_size": page_size, "total": len(rows)}


def _seed(engine, workflow_count: int) -> None:
    now = datetime.now(UTC).replace(microsecond=0)
    rows: list[Any] = []
    for index in range(workflow_count):
        workflow_id = uuid.uuid5(uuid.NAMESPACE_URL, f"profile-workflow-{index}")
        message_id = uuid.uuid5(uuid.NAMESPACE_URL, f"profile-message-{index}")
        started_at = now - timedelta(days=index % 30, minutes=index % 1440)
        repository = f"team/service-{index % 10}"
        email = f"developer-{index % 50}@example.com"
        workflow = WorkflowRun(
            id=workflow_id,
            workflow_kind="aaw",
            entry="ar" if index % 2 else "sr",
            project_key=repository,
            git_user_email=email,
            git_user_name=f"developer-{index % 50}",
            sr=f"SR-{index:06d}",
            ar=f"AR-{index:06d}",
            aaw_version="2.3.2",
            status="completed",
            started_at=started_at,
            completed_at=started_at + timedelta(minutes=30),
            last_activity_at=started_at + timedelta(minutes=30),
            client_updated_at=started_at + timedelta(minutes=30),
            client_payload_hash=f"{index:064x}",
            server_updated_at=started_at + timedelta(minutes=30),
        )
        message = TelemetryMessage(
            id=message_id,
            workflow_kind="aaw",
            entry=workflow.entry,
            workflow_run_id=workflow_id,
            aaw_version="2.3.2",
            user_email=email,
            user_name=f"developer-{index % 50}",
            repository=repository,
            sr=workflow.sr,
            ar=workflow.ar,
            step_type="task-dev",
            status="done",
            workflow_started_at=started_at,
            workflow_completed_at=started_at + timedelta(minutes=30),
            step_started_at=started_at,
            step_completed_at=started_at + timedelta(minutes=20),
            client_updated_at=started_at + timedelta(minutes=30),
            payload_hash=f"{index + 1:064x}",
            file_name=f"{workflow.sr}-{workflow.ar}.diff",
            file_sha256=f"{index + 2:064x}",
            server_updated_at=started_at + timedelta(minutes=30),
        )
        dev = DevRun(
            id=message_id,
            workflow_run_id=workflow_id,
            step_execution_id=uuid.uuid5(uuid.NAMESPACE_URL, f"profile-step-{index}"),
            branch="main",
            head_sha_start="0" * 40,
            head_sha_end="1" * 40,
            status="completed",
            started_at=started_at,
            completed_at=started_at + timedelta(minutes=20),
            window_ends_at=started_at + timedelta(hours=1),
            code_statistics={"total_effective_lines": 20},
            patch_object_key=f"step-diffs/{message_id}.diff",
            client_updated_at=started_at + timedelta(minutes=30),
            client_payload_hash=f"{index + 3:064x}",
            server_updated_at=started_at + timedelta(minutes=30),
        )
        attribution = CodeAttribution(
            dev_run_id=message_id,
            dev_effective_lines=20,
            attributed_lines_80=16,
            attributed_lines_90=12,
            confidence=0.9,
            attribution_status="finalized_match",
            retry_count=0,
            next_retry_at=None,
            quality_flags=[],
            result_status="finalized_match",
            matched_mr_iid=str(index),
            matched_mr_url=f"https://example.invalid/mr/{index}",
            mr_diff_version="v1",
            mr_source_branch="feature",
            target_branch="main",
            merge_commit_sha="2" * 40,
            mr_merged_at=started_at + timedelta(minutes=25),
            algorithm_version="profile-v1",
            diff_rule_version="profile-v1",
            matched_at=started_at + timedelta(minutes=25),
            server_updated_at=started_at + timedelta(minutes=30),
        )
        rows.extend((workflow, message, dev, attribution))
    with Session(engine) as session:
        session.add_all(rows)
        session.commit()


def _projects() -> ProjectRegistry:
    repos = {
        f"team/service-{index}": ProjectEntry(
            canonical_url=f"https://example.invalid/team/service-{index}.git",
            target_branch="main",
        )
        for index in range(10)
    }
    return ProjectRegistry(
        ComponentsDocument(
            components={"profile": ComponentEntry(name="Profile", repos=repos)}
        )
    )


def _dashboard_calls(
    filters,
) -> list[tuple[str, Callable[[QueryService], dict[str, Any]]]]:
    """Return the requests made by one current dashboard page refresh."""
    return [
        (
            "filter-options",
            lambda service: service.filter_options(filters.workflow_kind),
        ),
        ("overview", lambda service: service.overview(filters)),
        ("trends", lambda service: service.trends(filters, "day")),
        ("projects", lambda service: service.projects_summary(filters, 1, 10, 7)),
        ("users", lambda service: service.users_summary(filters, 1, 10)),
        ("components", lambda service: service.components_summary(filters)),
        ("steps", lambda service: service.steps_summary(filters, 1, 10)),
        ("workflows", lambda service: service.workflows(filters, None, 1, 50)),
    ]


def _profile(
    engine,
    projects: ProjectRegistry,
    service_class: type[QueryService],
    name: str,
    call: Callable[[QueryService], dict[str, Any]],
) -> dict[str, Any]:
    statements = 0

    def count_statement(*_args) -> None:
        nonlocal statements
        statements += 1

    event.listen(engine, "before_cursor_execute", count_statement)
    try:
        with Session(engine) as session:
            service = service_class(session, projects)
            started = time.perf_counter()
            result = call(service)
            elapsed_ms = (time.perf_counter() - started) * 1000
    finally:
        event.remove(engine, "before_cursor_execute", count_statement)
    response_bytes = len(json.dumps(result, ensure_ascii=False, default=str).encode("utf-8"))
    return {
        "endpoint": name,
        "sql_statements": statements,
        "sqlite_elapsed_ms": round(elapsed_ms, 2),
        "response_bytes": response_bytes,
        "projected_db_wait_ms_at_3ms_per_statement": statements * 3,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workflows", type=int, default=100)
    parser.add_argument(
        "--scenario",
        choices=("legacy", "eager-attribution", "eager-and-page-first", "current"),
        default="current",
    )
    args = parser.parse_args()
    engine = create_engine(
        "sqlite+pysqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    _seed(engine, args.workflows)
    projects = _projects()
    today = datetime.now(UTC).date()
    filters = make_filters(
        today - timedelta(days=30),
        today,
        [],
        [],
        [],
        [],
        [],
    )
    endpoints = _dashboard_calls(filters)
    service_class = {
        "legacy": LegacyQueryService,
        "eager-attribution": EagerAttributionQueryService,
        "eager-and-page-first": EagerPageFirstQueryService,
        "current": QueryService,
    }[args.scenario]
    results = [
        _profile(engine, projects, service_class, name, call) for name, call in endpoints
    ]
    statistics_names = {"overview", "trends", "projects", "users"}
    statistics = [row for row in results if row["endpoint"] in statistics_names]
    by_name = {row["endpoint"]: row for row in results}
    statistics_total = sum(row["sql_statements"] for row in statistics)
    duplicates_projects = args.scenario != "current"
    statistics_with_duplicate_projects = statistics_total
    if duplicates_projects:
        statistics_with_duplicate_projects += by_name["projects"]["sql_statements"]
    full_page_total = (
        by_name["filter-options"]["sql_statements"]
        + statistics_with_duplicate_projects
        + by_name["steps"]["sql_statements"]
        + by_name["workflows"]["sql_statements"]
        + by_name["components"]["sql_statements"]
    )
    print(
        json.dumps(
            {
                "workflow_count": args.workflows,
                "scenario": args.scenario,
                "results": results,
                "statistics_request_sql_total": statistics_total,
                "statistics_request_sql_total_with_duplicate_projects_call": (
                    statistics_with_duplicate_projects
                ),
                "full_page_refresh_sql_total": full_page_total,
                "full_page_projected_db_wait_ms_at_3ms_per_statement": full_page_total * 3,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
