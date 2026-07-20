from __future__ import annotations

import math
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Any

from sqlalchemy import exists, select
from sqlalchemy.orm import Session

from ..config import ProjectRegistry
from ..errors import ApiError
from ..models import DevRun, TelemetryMessage, WorkflowRun


@dataclass
class Filters:
    from_date: date
    to_date: date
    repositories: list[str]
    users: list[str]
    versions: list[str]
    srs: list[str]
    ars: list[str]

    @property
    def start(self) -> datetime:
        return datetime.combine(self.from_date, time.min, tzinfo=UTC)

    @property
    def end_exclusive(self) -> datetime:
        return datetime.combine(self.to_date + timedelta(days=1), time.min, tzinfo=UTC)


def make_filters(
    from_date: date | None,
    to_date: date | None,
    repositories: list[str],
    users: list[str],
    versions: list[str],
    srs: list[str],
    ars: list[str],
) -> Filters:
    today = datetime.now(UTC).date()
    end = to_date or today
    start = from_date or end - timedelta(days=29)
    if start > end:
        raise ApiError(400, "INVALID_FILTER", "from must not be later than to")
    if (end - start).days > 3660:
        raise ApiError(400, "INVALID_FILTER", "date range is too large")
    return Filters(
        start,
        end,
        repositories,
        [item.strip().lower() for item in users],
        versions,
        srs,
        ars,
    )


def apply_workflow_filters(statement, filters: Filters, *, include_dates: bool = True):
    if include_dates:
        statement = statement.where(
            WorkflowRun.started_at >= filters.start,
            WorkflowRun.started_at < filters.end_exclusive,
        )
    for column, values in (
        (WorkflowRun.project_key, filters.repositories),
        (WorkflowRun.sr, filters.srs),
    ):
        if values:
            statement = statement.where(column.in_(values))
    for column, values in (
        (TelemetryMessage.user_email, filters.users),
        (TelemetryMessage.aaw_version, filters.versions),
        (TelemetryMessage.ar, filters.ars),
    ):
        if values:
            statement = statement.where(
                exists().where(
                    TelemetryMessage.workflow_run_id == WorkflowRun.id,
                    column.in_(values),
                )
            )
    return statement


def apply_snapshot_filters(statement, filters: Filters):
    return apply_workflow_filters(statement, filters, include_dates=False)


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _milliseconds(value: datetime | None) -> int | None:
    return int(_aware(value).timestamp() * 1000) if value is not None else None


def _percentile(values: list[int], fraction: float) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    rank = max(0, math.ceil(fraction * len(ordered)) - 1)
    return ordered[rank]


def _bucket_date(value: date, granularity: str) -> date:
    return value if granularity == "day" else value - timedelta(days=value.weekday())


class QueryService:
    def __init__(self, session: Session, projects: ProjectRegistry):
        self.session = session
        self.projects = projects

    def _workflows(self, filters: Filters) -> list[WorkflowRun]:
        return list(
            self.session.scalars(apply_workflow_filters(select(WorkflowRun), filters)).all()
        )

    def _messages(self, workflow_ids: list[uuid.UUID], filters: Filters) -> list[TelemetryMessage]:
        if not workflow_ids:
            return []
        statement = select(TelemetryMessage).where(
            TelemetryMessage.workflow_run_id.in_(workflow_ids)
        )
        for column, values in (
            (TelemetryMessage.repository, filters.repositories),
            (TelemetryMessage.user_email, filters.users),
            (TelemetryMessage.aaw_version, filters.versions),
            (TelemetryMessage.sr, filters.srs),
            (TelemetryMessage.ar, filters.ars),
        ):
            if values:
                statement = statement.where(column.in_(values))
        return list(self.session.scalars(statement).all())

    def _devs(self, message_ids: list[uuid.UUID]) -> list[DevRun]:
        if not message_ids:
            return []
        return list(self.session.scalars(select(DevRun).where(DevRun.id.in_(message_ids))).all())

    def filter_options(self, filters: Filters) -> dict[str, Any]:
        workflows = self._workflows(filters)
        messages = self._messages([row.id for row in workflows], filters)
        repositories = sorted({row.repository for row in messages})
        latest_users: dict[str, TelemetryMessage] = {}
        for row in sorted(messages, key=lambda item: _aware(item.client_updated_at)):
            latest_users[row.user_email] = row
        repository_items = [self._repository_display(key) for key in repositories]
        user_items = [
            {"user_email": email, "user_name": row.user_name}
            for email, row in sorted(latest_users.items())
        ]
        return {
            "repositories": repository_items,
            "users": user_items,
            # Read-only aliases keep the already deployed portal functional during migration.
            "projects": repository_items,
            "git_users": [
                {"git_user_email": row["user_email"], "git_user_name": row["user_name"]}
                for row in user_items
            ],
            "aaw_versions": sorted({row.aaw_version for row in messages}),
            "result_statuses": ["finalized_match", "finalized_no_match"],
        }

    def overview(self, filters: Filters) -> dict[str, Any]:
        workflows = self._workflows(filters)
        messages = self._messages([row.id for row in workflows], filters)
        devs = self._devs([row.id for row in messages])
        attributions = [row.attribution for row in devs if row.attribution is not None]
        effective_lines = sum(
            int(row.code_statistics["total_effective_lines"]) for row in devs if row.code_statistics
        )
        attributed_80 = sum(row.attributed_lines_80 for row in attributions)
        attributed_90 = sum(row.attributed_lines_90 for row in attributions)
        now = datetime.now(UTC)
        threshold = now - timedelta(hours=24)
        snapshot = list(
            self.session.scalars(
                apply_snapshot_filters(select(WorkflowRun), filters).where(
                    WorkflowRun.status == "in_progress"
                )
            ).all()
        )
        completed = sum(row.status == "completed" for row in workflows)
        return {
            "period": {
                "workflow_runs": len(workflows),
                "completed_workflows": completed,
                "workflow_completion_rate": completed / len(workflows) if workflows else None,
                "active_users": len({row.user_email for row in messages}),
                "active_repositories": len({row.repository for row in messages}),
                "active_projects": len({row.repository for row in messages}),
                "steps": len(messages),
                "dev_runs": len(devs),
                "completed_dev_runs": sum(row.status == "completed" for row in devs),
                "pending_attribution_dev_runs": sum(row.attribution is None for row in devs),
                "dev_effective_lines": effective_lines,
                "attributed_lines_80": attributed_80,
                "attributed_lines_90": attributed_90,
                "attribution_rate_80": attributed_80 / effective_lines if effective_lines else None,
                "attribution_rate_90": attributed_90 / effective_lines if effective_lines else None,
            },
            "snapshot": {
                "active_workflows": sum(
                    _aware(row.last_activity_at) >= threshold for row in snapshot
                ),
                "stalled_workflows": sum(
                    _aware(row.last_activity_at) < threshold for row in snapshot
                ),
                "activity_threshold_hours": 24,
            },
        }

    def trends(self, filters: Filters, granularity: str) -> dict[str, Any]:
        workflows = self._workflows(filters)
        messages = self._messages([row.id for row in workflows], filters)
        devs = self._devs([row.id for row in messages])
        workflow_by_id = {row.id: row for row in workflows}
        buckets: dict[date, dict[str, int]] = defaultdict(
            lambda: {
                "workflow_runs": 0,
                "completed_workflows": 0,
                "dev_effective_lines": 0,
                "attributed_lines_80": 0,
                "attributed_lines_90": 0,
            }
        )
        for workflow in workflows:
            key = _bucket_date(_aware(workflow.started_at).date(), granularity)
            buckets[key]["workflow_runs"] += 1
            buckets[key]["completed_workflows"] += workflow.status == "completed"
        for dev in devs:
            key = _bucket_date(
                _aware(workflow_by_id[dev.workflow_run_id].started_at).date(), granularity
            )
            if dev.code_statistics:
                buckets[key]["dev_effective_lines"] += dev.code_statistics["total_effective_lines"]
            if dev.attribution:
                buckets[key]["attributed_lines_80"] += dev.attribution.attributed_lines_80
                buckets[key]["attributed_lines_90"] += dev.attribution.attributed_lines_90
        cursor = _bucket_date(filters.from_date, granularity)
        end = _bucket_date(filters.to_date, granularity)
        increment = timedelta(days=1 if granularity == "day" else 7)
        points = []
        while cursor <= end:
            points.append({"date": cursor.isoformat(), **buckets[cursor]})
            cursor += increment
        return {"granularity": granularity, "points": points}

    def projects_summary(self, filters: Filters, page: int, page_size: int) -> dict[str, Any]:
        return self._paginate(self._summary_rows(filters, "repository"), page, page_size)

    def users_summary(self, filters: Filters, page: int, page_size: int) -> dict[str, Any]:
        return self._paginate(self._summary_rows(filters, "user"), page, page_size)

    def _summary_rows(self, filters: Filters, group: str) -> list[dict[str, Any]]:
        workflows = self._workflows(filters)
        messages = self._messages([row.id for row in workflows], filters)
        dev_by_id = {row.id: row for row in self._devs([row.id for row in messages])}
        groups: dict[str, list[TelemetryMessage]] = defaultdict(list)
        for message in messages:
            key = message.repository if group == "repository" else message.user_email
            groups[key].append(message)
        rows = []
        for key, group_messages in groups.items():
            devs = [dev_by_id[row.id] for row in group_messages if row.id in dev_by_id]
            effective = sum(
                row.code_statistics["total_effective_lines"] for row in devs if row.code_statistics
            )
            attrs = [row.attribution for row in devs if row.attribution]
            attributed_80 = sum(row.attributed_lines_80 for row in attrs)
            attributed_90 = sum(row.attributed_lines_90 for row in attrs)
            base = {
                "workflow_runs": len({row.workflow_run_id for row in group_messages}),
                "steps": len(group_messages),
                "dev_runs": len(devs),
                "completed_dev_runs": sum(row.status == "completed" for row in devs),
                "pending_attribution_dev_runs": sum(row.attribution is None for row in devs),
                "dev_effective_lines": effective,
                "attributed_lines_80": attributed_80,
                "attributed_lines_90": attributed_90,
                "attribution_rate_80": attributed_80 / effective if effective else None,
                "attribution_rate_90": attributed_90 / effective if effective else None,
            }
            if group == "repository":
                base.update(self._repository_display(key))
                base["active_users"] = len({row.user_email for row in group_messages})
            else:
                latest = max(group_messages, key=lambda row: _aware(row.client_updated_at))
                base.update(
                    {
                        "user_email": key,
                        "user_name": latest.user_name,
                        "git_user_email": key,
                        "git_user_name": latest.user_name,
                    }
                )
            rows.append(base)
        tie = "project_key" if group == "repository" else "user_email"
        return sorted(rows, key=lambda row: (-row["dev_effective_lines"], row[tie]))

    def steps_summary(self, filters: Filters, page: int, page_size: int) -> dict[str, Any]:
        workflows = self._workflows(filters)
        messages = self._messages([row.id for row in workflows], filters)
        grouped: dict[str, list[TelemetryMessage]] = defaultdict(list)
        for message in messages:
            grouped[message.step_type].append(message)
        results = []
        for key, steps in sorted(grouped.items()):
            reached = len({row.workflow_run_id for row in steps})
            completed = len({row.workflow_run_id for row in steps if row.status == "done"})
            durations = [
                int((_aware(row.step_completed_at) - _aware(row.step_started_at)).total_seconds())
                for row in steps
                if row.step_completed_at is not None
            ]
            results.append(
                {
                    "key": key,
                    "reached_workflows": reached,
                    "completed_workflows": completed,
                    "failed_steps": sum(row.status == "failed" for row in steps),
                    "blocked_steps": sum(row.status == "blocked" for row in steps),
                    "failed_attempts": sum(row.status == "failed" for row in steps),
                    "blocked_attempts": sum(row.status == "blocked" for row in steps),
                    "completion_rate": completed / reached if reached else None,
                    "duration_seconds": {
                        "p50": _percentile(durations, 0.5),
                        "p90": _percentile(durations, 0.9),
                        "p95": _percentile(durations, 0.95),
                    },
                }
            )
        return self._paginate(results, page, page_size)

    def workflows(
        self, filters: Filters, state: str | None, page: int, page_size: int
    ) -> dict[str, Any]:
        rows = self._workflows(filters)
        now = datetime.now(UTC)
        threshold = now - timedelta(hours=24)
        if state:
            rows = [row for row in rows if self._activity_state(row, threshold) == state]
        rows.sort(key=lambda row: (-_aware(row.last_activity_at).timestamp(), str(row.id)))
        items = [self._workflow_item(row, threshold) for row in rows]
        return self._paginate(items, page, page_size)

    def _workflow_item(self, workflow: WorkflowRun, threshold: datetime) -> dict[str, Any]:
        messages = list(
            self.session.scalars(
                select(TelemetryMessage)
                .where(TelemetryMessage.workflow_run_id == workflow.id)
                .order_by(TelemetryMessage.step_completed_at.asc())
            ).all()
        )
        devs = self._devs([row.id for row in messages])
        latest_users: dict[str, TelemetryMessage] = {}
        for row in messages:
            latest_users[row.user_email] = row
        latest_message = messages[-1] if messages else None
        return {
            "workflow_id": str(workflow.id),
            "workflow_run_id": str(workflow.id),
            "repository": workflow.project_key,
            "project_key": workflow.project_key,
            "participants": [
                {"user_email": email, "user_name": row.user_name}
                for email, row in sorted(latest_users.items())
            ],
            "sr": workflow.sr,
            "ar": latest_message.ar if latest_message else None,
            "git_user_email": latest_message.user_email if latest_message else None,
            "git_user_name": latest_message.user_name if latest_message else None,
            "aaw_version": workflow.aaw_version,
            "status": workflow.status,
            "activity_state": self._activity_state(workflow, threshold),
            "started_at": _milliseconds(workflow.started_at),
            "completed_at": _milliseconds(workflow.completed_at),
            "last_activity_at": _milliseconds(workflow.last_activity_at),
            "furthest_step_type": messages[-1].step_type if messages else None,
            "dev_effective_lines": sum(
                row.code_statistics["total_effective_lines"] for row in devs if row.code_statistics
            ),
            "attributed_lines_80": sum(
                row.attribution.attributed_lines_80 for row in devs if row.attribution
            ),
            "attributed_lines_90": sum(
                row.attribution.attributed_lines_90 for row in devs if row.attribution
            ),
        }

    @staticmethod
    def _activity_state(workflow: WorkflowRun, threshold: datetime) -> str:
        if workflow.status == "completed":
            return "completed"
        return "stalled" if _aware(workflow.last_activity_at) < threshold else "active"

    def workflow_detail(self, workflow_id: uuid.UUID) -> dict[str, Any]:
        workflow = self.session.get(WorkflowRun, workflow_id)
        if workflow is None:
            raise ApiError(404, "WORKFLOW_NOT_FOUND", "workflow does not exist")
        messages = list(
            self.session.scalars(
                select(TelemetryMessage)
                .where(TelemetryMessage.workflow_run_id == workflow_id)
                .order_by(TelemetryMessage.step_started_at.asc(), TelemetryMessage.id.asc())
            ).all()
        )
        dev_by_id = {row.id: row for row in self._devs([row.id for row in messages])}
        steps = []
        for message in messages:
            dev = dev_by_id.get(message.id)
            steps.append(self._message_item(message, dev))
        threshold = datetime.now(UTC) - timedelta(hours=24)
        return {"workflow": self._workflow_item(workflow, threshold), "steps": steps}

    def _message_item(self, message: TelemetryMessage, dev: DevRun | None) -> dict[str, Any]:
        upload = dev.object_upload if dev else None
        return {
            "message_id": str(message.id),
            "workflow_id": str(message.workflow_run_id),
            "aaw_version": message.aaw_version,
            "user_email": message.user_email,
            "user_name": message.user_name,
            "repository": message.repository,
            "sr": message.sr,
            "ar": message.ar,
            "step_type": message.step_type,
            "status": message.status,
            "started_at": _milliseconds(message.step_started_at),
            "completed_at": _milliseconds(message.step_completed_at),
            "updated_at": _milliseconds(message.client_updated_at),
            "file": (
                {"file_name": message.file_name, "sha256": message.file_sha256}
                if message.file_name
                else None
            ),
            "file_status": upload.status if upload else ("pending" if message.file_name else None),
            "attribution_status": (
                dev.attribution.attribution_status
                if dev and dev.attribution
                else ("pending" if dev else None)
            ),
            "attribution": (
                self._attribution_dict(dev.attribution) if dev and dev.attribution else None
            ),
        }

    def code_attributions(
        self,
        filters: Filters,
        matched_mr_iid: str | None,
        result_status: str | None,
        page: int,
        page_size: int,
    ) -> dict[str, Any]:
        workflows = self._workflows(filters)
        messages = self._messages([row.id for row in workflows], filters)
        by_id = {row.id: row for row in messages}
        items = []
        for dev in self._devs(list(by_id)):
            attribution = dev.attribution
            if attribution is None:
                continue
            if matched_mr_iid and attribution.matched_mr_iid != matched_mr_iid:
                continue
            if result_status and attribution.result_status != result_status:
                continue
            message = by_id[dev.id]
            item = self._attribution_dict(attribution)
            item.update(
                {
                    "message_id": str(message.id),
                    "workflow_id": str(message.workflow_run_id),
                    "repository": message.repository,
                    "project_key": message.repository,
                    "sr": message.sr,
                    "ar": message.ar,
                    "aaw_version": message.aaw_version,
                    "user_email": message.user_email,
                    "user_name": message.user_name,
                    "git_user_email": message.user_email,
                    "git_user_name": message.user_name,
                    "step_type": message.step_type,
                    "file_name": message.file_name,
                    "attribution_rate_80": (
                        attribution.attributed_lines_80 / attribution.dev_effective_lines
                        if attribution.dev_effective_lines
                        else None
                    ),
                    "attribution_rate_90": (
                        attribution.attributed_lines_90 / attribution.dev_effective_lines
                        if attribution.dev_effective_lines
                        else None
                    ),
                }
            )
            items.append(item)
        items.sort(key=lambda item: (-item["attributed_lines_80"], item["message_id"]))
        return self._paginate(items, page, page_size)

    @staticmethod
    def _attribution_dict(attribution) -> dict[str, Any]:
        result = {}
        for column in attribution.__table__.columns:
            value = getattr(attribution, column.name)
            result[column.name] = _milliseconds(value) if isinstance(value, datetime) else value
        return result

    def _repository_display(self, key: str) -> dict[str, Any]:
        entry = self.projects.get(key)
        return {
            "project_key": key,
            "canonical_url": entry.canonical_url if entry else None,
            "target_branch": entry.target_branch if entry else None,
            "enabled": entry.enabled if entry else None,
        }

    @staticmethod
    def _paginate(items: list[dict[str, Any]], page: int, page_size: int) -> dict[str, Any]:
        start = (page - 1) * page_size
        return {
            "items": items[start : start + page_size],
            "page": page,
            "page_size": page_size,
            "total": len(items),
        }
