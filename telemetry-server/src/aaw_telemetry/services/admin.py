from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import String, case, cast, func, select
from sqlalchemy.orm import Session

from ..config import Settings
from ..errors import ApiError
from ..models import CodeAttribution, DevRun, ObjectUpload, TelemetryMessage, WorkflowRun
from .queries import any_like
from .workflow_admin import WorkflowAdminService

logger = logging.getLogger("aaw_telemetry.admin.attribution")

ATTRIBUTION_STATUSES = (
    "pending",
    "running",
    "retry_pending",
    "failed",
    "finalized_match",
    "finalized_no_match",
)

# Virtual status for dev runs that never entered the attribution flow
# (patch upload never confirmed → no CodeAttribution row exists).
NOT_QUEUED = "not_queued"
RECORD_STATUSES = (*ATTRIBUTION_STATUSES, NOT_QUEUED)

# Batch operations must stay small enough to review in the preview dialog.
BULK_LIMIT = 200

EXCLUDED_MODES = ("hidden", "only", "all")
RECORD_KINDS = ("all", "queued", "not_queued")
WORKFLOW_KINDS = ("aaw", "testing")
ENTRY_TYPES = ("sr", "ar", "dev")

TREND_DAYS = 14

# Flags that describe lifecycle rather than a failure cause; the sweeper's
# window expiry leaves no engine reason at all → grouped as "unknown".
_SKIP_REASON_FLAGS = {"attribution_failed", "attribution_pending"}


def _now() -> datetime:
    value = datetime.now(UTC)
    return value.replace(microsecond=(value.microsecond // 1000) * 1000)


@dataclass
class RecordFilters:
    """Combined search conditions for the attribution management plane."""

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
    record_kind: str = "all"


class AdminAttributionService:
    """Operations view over the attribution queue for the admin page."""

    def __init__(self, session: Session, settings: Settings):
        self.session = session
        self.settings = settings

    # ------------------------------------------------------------------
    # shared query building

    @staticmethod
    def _record_statement(filters: RecordFilters):
        virtual_status = func.coalesce(
            CodeAttribution.attribution_status, NOT_QUEUED
        )
        statement = (
            select(DevRun, TelemetryMessage, CodeAttribution, ObjectUpload)
            .join(TelemetryMessage, TelemetryMessage.id == DevRun.id)
            .join(WorkflowRun, DevRun.workflow_run_id == WorkflowRun.id)
            .outerjoin(CodeAttribution, CodeAttribution.dev_run_id == DevRun.id)
            .outerjoin(ObjectUpload, ObjectUpload.owner_id == DevRun.id)
        )
        if filters.record_kind == "queued":
            statement = statement.where(CodeAttribution.dev_run_id.is_not(None))
        elif filters.record_kind == "not_queued":
            statement = statement.where(CodeAttribution.dev_run_id.is_(None))
        if filters.attribution_status == NOT_QUEUED:
            statement = statement.where(CodeAttribution.dev_run_id.is_(None))
        elif filters.attribution_status is not None:
            statement = statement.where(
                CodeAttribution.attribution_status == filters.attribution_status
            )
        if filters.result_status is not None:
            statement = statement.where(
                CodeAttribution.result_status == filters.result_status
            )
        if filters.repository:
            repository_condition = any_like(TelemetryMessage.repository, filters.repository)
            if repository_condition is not None:
                statement = statement.where(repository_condition)
        if filters.user:
            like = f"%{filters.user}%"
            statement = statement.where(
                TelemetryMessage.user_name.like(like)
                | TelemetryMessage.user_email.like(like)
            )
        if filters.sr:
            statement = statement.where(TelemetryMessage.sr.like(f"%{filters.sr}%"))
        if filters.ar:
            statement = statement.where(TelemetryMessage.ar.like(f"%{filters.ar}%"))
        if filters.mr:
            statement = statement.where(
                CodeAttribution.matched_mr_iid.like(f"%{filters.mr}%")
            )
        if filters.quality_flag:
            statement = statement.where(
                cast(CodeAttribution.quality_flags, String).like(
                    f"%{filters.quality_flag}%"
                )
            )
        if filters.algorithm_version:
            statement = statement.where(
                CodeAttribution.algorithm_version == filters.algorithm_version
            )
        if filters.workflow_kind:
            statement = statement.where(
                TelemetryMessage.workflow_kind == filters.workflow_kind
            )
        if filters.entry:
            statement = statement.where(TelemetryMessage.entry == filters.entry)
        if filters.from_date is not None:
            start = datetime.combine(filters.from_date, datetime.min.time(), tzinfo=UTC)
            statement = statement.where(DevRun.started_at >= start)
        if filters.to_date is not None:
            end = datetime.combine(
                filters.to_date + timedelta(days=1), datetime.min.time(), tzinfo=UTC
            )
            statement = statement.where(DevRun.started_at < end)
        if filters.excluded == "hidden":
            # 默认只看"仍在统计口径内"的记录：产出已删除或工作流已删除的一并隐藏
            statement = statement.where(
                DevRun.admin_excluded.is_(False), WorkflowRun.deleted.is_(False)
            )
        elif filters.excluded == "only":
            statement = statement.where(DevRun.admin_excluded.is_(True))
        return statement, virtual_status

    @staticmethod
    def _record_order(virtual_status):
        # Actionable records float up: queued non-terminal states first, then
        # failures, then never-queued records, then matched/no-match history.
        priority = case(
            (virtual_status == "pending", 0),
            (virtual_status == "running", 1),
            (virtual_status == "retry_pending", 2),
            (virtual_status == "failed", 3),
            (virtual_status == NOT_QUEUED, 4),
            (virtual_status == "finalized_no_match", 5),
            else_=6,
        )
        return (
            priority,
            CodeAttribution.next_retry_at.is_(None),
            CodeAttribution.next_retry_at.asc(),
            DevRun.started_at.desc(),
        )

    def _window_cutoff(self) -> datetime:
        return _now() - timedelta(
            seconds=self.settings.attribution_retry_window_seconds
        )

    # ------------------------------------------------------------------
    # counts (existing overview tile)

    # ------------------------------------------------------------------
    # legacy queue endpoint (保留：被管理面检索取代包含)

    def queue(
        self,
        *,
        attribution_status: str | None,
        result_status: str | None,
        page: int,
        page_size: int,
    ) -> dict:
        filters = RecordFilters(
            attribution_status=attribution_status,
            result_status=result_status,
            record_kind="queued",
            excluded="all",
        )
        statement, _ = self._record_statement(filters)
        total = self.session.execute(
            select(func.count()).select_from(statement.subquery())
        ).scalar_one()
        rows = self.session.execute(
            statement.order_by(
                CodeAttribution.next_retry_at.is_(None),
                CodeAttribution.next_retry_at.asc(),
                CodeAttribution.server_updated_at.desc(),
            )
            .offset((page - 1) * page_size)
            .limit(page_size)
        ).all()
        cutoff = self._window_cutoff()
        items = [
            self._record_item(dev_run, message, attribution, upload, cutoff)
            for dev_run, message, attribution, upload in rows
        ]
        return {"total": total, "page": page, "page_size": page_size, "items": items}

    def counts(self) -> dict:
        # 已删除的产出/归因/工作流不进队列分布（删除即退出一切统计）
        live = (
            CodeAttribution.deleted.is_(False),
            DevRun.admin_excluded.is_(False),
            WorkflowRun.deleted.is_(False),
        )
        rows = self.session.execute(
            select(CodeAttribution.attribution_status, func.count())
            .select_from(CodeAttribution)
            .join(DevRun, CodeAttribution.dev_run_id == DevRun.id)
            .join(WorkflowRun, DevRun.workflow_run_id == WorkflowRun.id)
            .where(*live)
            .group_by(CodeAttribution.attribution_status)
        ).all()
        counts = {status: 0 for status in ATTRIBUTION_STATUSES}
        total = 0
        for status, count in rows:
            counts[status] = count
            total += count
        not_queued = self.session.execute(
            select(func.count())
            .select_from(DevRun)
            .join(WorkflowRun, DevRun.workflow_run_id == WorkflowRun.id)
            .where(
                DevRun.id.not_in(select(CodeAttribution.dev_run_id)),
                DevRun.admin_excluded.is_(False),
                WorkflowRun.deleted.is_(False),
            )
        ).scalar_one()
        counts[NOT_QUEUED] = not_queued
        return {"total": total + not_queued, "by_status": counts}

    # ------------------------------------------------------------------
    # combined search (C2.1 / C2.3)

    def records(
        self,
        filters: RecordFilters,
        *,
        page: int,
        page_size: int,
    ) -> dict:
        statement, virtual_status = self._record_statement(filters)
        total = self.session.execute(
            select(func.count())
            .select_from(statement.subquery())
        ).scalar_one()
        rows = self.session.execute(
            statement.order_by(*self._record_order(virtual_status))
            .offset((page - 1) * page_size)
            .limit(page_size)
        ).all()
        cutoff = self._window_cutoff()
        items = [
            self._record_item(dev_run, message, attribution, upload, cutoff)
            for dev_run, message, attribution, upload in rows
        ]
        return {"total": total, "page": page, "page_size": page_size, "items": items}

    # ------------------------------------------------------------------
    # detail (C2.2)

    def detail(self, dev_run_id: uuid.UUID) -> dict:
        row = self.session.execute(
            self._record_statement(RecordFilters(excluded="all"))[0]
            .where(DevRun.id == dev_run_id)
        ).first()
        if row is None:
            raise ApiError(404, "ATTRIBUTION_NOT_FOUND", f"归因记录 {dev_run_id} 不存在")
        dev_run, message, attribution, upload = row
        cutoff = self._window_cutoff()
        item = self._record_item(dev_run, message, attribution, upload, cutoff)
        workflow = self.session.get(WorkflowRun, dev_run.workflow_run_id)
        item["workflow"] = (
            {
                "workflow_run_id": str(workflow.id),
                "entry": workflow.entry,
                "workflow_kind": workflow.workflow_kind,
                "aaw_version": workflow.aaw_version,
                "project_key": workflow.project_key,
                "git_user_email": workflow.git_user_email,
                "git_user_name": workflow.git_user_name,
                "status": workflow.status,
                "started_at": _iso(workflow.started_at),
                "completed_at": _iso(workflow.completed_at),
            }
            if workflow is not None
            else None
        )
        item["dev_run"] = {
            "branch": dev_run.branch,
            "head_sha_start": dev_run.head_sha_start,
            "head_sha_end": dev_run.head_sha_end,
            "status": dev_run.status,
            "started_at": dev_run.started_at.isoformat() if dev_run.started_at else None,
            "completed_at": _iso(dev_run.completed_at),
            "code_statistics": dev_run.code_statistics,
            "patch_object_key": dev_run.patch_object_key,
        }
        item["attribution_detail"] = (
            {
                "attributed_lines_60": attribution.attributed_lines_60,
                "attributed_lines_80": attribution.attributed_lines_80,
                "attributed_lines_90": attribution.attributed_lines_90,
                "mr_commit_lines": attribution.mr_commit_lines,
                "confidence": attribution.confidence,
                "algorithm_version": attribution.algorithm_version,
                "diff_rule_version": attribution.diff_rule_version,
                "matched_at": _iso(attribution.matched_at),
                "mr_merged_at": _iso(attribution.mr_merged_at),
                "mr_source_branch": attribution.mr_source_branch,
                "target_branch": attribution.target_branch,
                "merge_commit_sha": attribution.merge_commit_sha,
                "mr_diff_version": attribution.mr_diff_version,
            }
            if attribution is not None
            else None
        )
        item["upload"] = (
            {
                "status": upload.status,
                "expires_at": _iso(upload.expires_at),
                "uploaded_at": _iso(upload.uploaded_at),
                "confirmed_at": _iso(upload.confirmed_at),
                "archived_at": _iso(upload.archived_at),
            }
            if upload is not None
            else None
        )
        item["governance"] = {
            "admin_excluded": dev_run.admin_excluded,
            "reason": dev_run.admin_excluded_reason,
            "at": _iso(dev_run.admin_excluded_at),
            "by": dev_run.admin_excluded_by,
            "deleted_reason_code": dev_run.deleted_reason_code,
            "workflow_deleted": bool(
                workflow is not None and workflow.deleted
            ),
            "attribution_deleted": bool(attribution is not None and attribution.deleted),
            "attribution_deleted_reason_code": (
                attribution.deleted_reason_code if attribution else None
            ),
            "attribution_deleted_reason": (
                attribution.deleted_reason if attribution else None
            ),
        }
        return item

    # ------------------------------------------------------------------
    # single-record operations

    def exclude(
        self,
        dev_run_id: uuid.UUID,
        *,
        reason: str,
        operator: str | None,
        reason_code: str = "other",
    ) -> dict:
        # 语义升级（设计说明书 §6）：无关化即"删除单条开发产出"，全口径生效；
        # 状态限制取消——已匹配的产出同样可以按理由删除（如重复生成）。
        WorkflowAdminService(self.session, self.settings).delete_dev_run(
            dev_run_id, reason_code=reason_code, reason=reason, operator=operator
        )
        return {"dev_run_id": str(dev_run_id), "excluded": True}

    def restore(self, dev_run_id: uuid.UUID, *, operator: str | None) -> dict:
        WorkflowAdminService(self.session, self.settings).restore_dev_run(
            dev_run_id, operator=operator
        )
        return {"dev_run_id": str(dev_run_id), "excluded": False}

    def retry(self, dev_run_id, scheduler) -> dict:
        attribution = self.session.get(CodeAttribution, dev_run_id)
        if attribution is None:
            raise ApiError(404, "ATTRIBUTION_NOT_FOUND", f"归因记录 {dev_run_id} 不存在")
        dev_run = self.session.get(DevRun, dev_run_id)
        cutoff = self._window_cutoff()
        if dev_run is not None and dev_run.completed_at is not None:
            completed = (
                dev_run.completed_at.replace(tzinfo=UTC)
                if dev_run.completed_at.tzinfo is None
                else dev_run.completed_at.astimezone(UTC)
            )
            if completed < cutoff:
                raise ApiError(
                    409,
                    "RETRY_WINDOW_EXPIRED",
                    "开发记录的完成时间已超出重试窗口，可改用强制重跑",
                )
        if attribution.attribution_status == "running":
            raise ApiError(
                409,
                "ATTRIBUTION_RUNNING",
                "归因任务正在执行中，请等待本轮结束",
            )
        attribution.attribution_status = "pending"
        attribution.retry_count = 0
        attribution.next_retry_at = None
        attribution.quality_flags = [
            *(attribution.quality_flags or []), "admin_retry"
        ]
        attribution.server_updated_at = _now()
        self.session.commit()
        scheduler.notify()
        logger.info(
            "管理员已重置归因任务并唤醒调度器",
            extra={"event": "admin.attribution_retry", "dev_run_id": str(dev_run_id)},
        )
        return self._legacy_item(attribution, dev_run, cutoff)

    def force_retry(self, dev_run_id: uuid.UUID, scheduler) -> dict:
        attribution = self.session.get(CodeAttribution, dev_run_id)
        if attribution is None:
            raise ApiError(
                409,
                "RECORD_NOT_QUEUED",
                "该记录未入队（补丁未确认上传），无法重跑归因",
            )
        if attribution.attribution_status == "running":
            raise ApiError(409, "ATTRIBUTION_RUNNING", "归因任务正在执行中，请等待本轮结束")
        attribution.attribution_status = "pending"
        attribution.retry_count = 0
        attribution.next_retry_at = None
        attribution.quality_flags = [
            *(attribution.quality_flags or []), "admin_retry_expired"
        ]
        attribution.server_updated_at = _now()
        self.session.commit()
        scheduler.notify()
        logger.warning(
            "管理员强制重跑超出重试窗口的归因任务",
            extra={
                "event": "admin.attribution_force_retry",
                "dev_run_id": str(dev_run_id),
            },
        )
        return self._legacy_item(
            attribution, self.session.get(DevRun, dev_run_id), self._window_cutoff()
        )

    # ------------------------------------------------------------------
    # batch operations (C2.6)

    def bulk(
        self,
        *,
        action: str,
        filters: RecordFilters,
        dry_run: bool,
        reason: str | None,
        operator: str | None,
        scheduler=None,
    ) -> dict:
        statement, _ = self._record_statement(filters)
        matched = self.session.execute(
            select(func.count()).select_from(statement.subquery())
        ).scalar_one()
        if matched > BULK_LIMIT:
            raise ApiError(
                409,
                "BULK_LIMIT_EXCEEDED",
                f"当前筛选命中 {matched} 条，超过单次上限 {BULK_LIMIT} 条，请缩小筛选范围",
            )
        rows = self.session.execute(statement).all()
        cutoff = self._window_cutoff()
        applicable: list[uuid.UUID] = []
        skipped_running = 0
        skipped_state = 0
        for dev_run, _, attribution, _ in rows:
            status = (
                attribution.attribution_status if attribution is not None else NOT_QUEUED
            )
            if action in ("retry", "force_retry"):
                if attribution is None or status == "running":
                    skipped_running += 1
                    continue
                if action == "retry" and self._window_expired(dev_run, cutoff):
                    skipped_state += 1
                    continue
            elif action == "exclude":
                # 语义升级后不再限制记录状态：任何未删除的产出都可按理由删除
                if dev_run.admin_excluded:
                    skipped_state += 1
                    continue
            elif action == "restore":
                if not dev_run.admin_excluded:
                    skipped_state += 1
                    continue
            applicable.append(dev_run.id)
        preview = {
            "action": action,
            "dry_run": dry_run,
            "matched": matched,
            "applicable": len(applicable),
            "skipped_running": skipped_running,
            "skipped_state": skipped_state,
        }
        if dry_run:
            return {**preview, "processed": 0, "failed": 0}
        processed = 0
        failed = 0
        errors: list[str] = []
        for dev_run_id in applicable:
            try:
                if action == "retry":
                    self.retry(dev_run_id, scheduler)
                elif action == "force_retry":
                    self.force_retry(dev_run_id, scheduler)
                elif action == "exclude":
                    self.exclude(
                        dev_run_id,
                        reason=reason or "",
                        operator=operator,
                    )
                elif action == "restore":
                    self.restore(dev_run_id, operator=operator)
                processed += 1
            except ApiError as exc:
                failed += 1
                errors.append(f"{dev_run_id}: {exc.message}")
        logger.info(
            "管理员批量处理归因记录完成",
            extra={
                "event": "admin.attribution_bulk",
                "action": action,
                "matched": matched,
                "processed": processed,
                "failed": failed,
                "operator": operator or "admin",
            },
        )
        return {**preview, "processed": processed, "failed": failed, "errors": errors[:20]}

    def _window_expired(self, dev_run: DevRun, cutoff: datetime) -> bool:
        if dev_run.completed_at is None:
            return False
        completed = (
            dev_run.completed_at.replace(tzinfo=UTC)
            if dev_run.completed_at.tzinfo is None
            else dev_run.completed_at.astimezone(UTC)
        )
        return completed < cutoff

    # ------------------------------------------------------------------
    # backlog health & failure analytics (C2.7 / C2.8 / C2.9)

    def health(self, *, scheduler_status: dict) -> dict:
        now = _now()
        cutoff = now - timedelta(
            seconds=self.settings.attribution_retry_window_seconds
        )
        queued = select(CodeAttribution.dev_run_id)
        not_queued = self.session.scalar(
            select(func.count())
            .select_from(DevRun)
            .join(WorkflowRun, DevRun.workflow_run_id == WorkflowRun.id)
            .where(
                DevRun.id.not_in(queued),
                DevRun.admin_excluded.is_(False),
                WorkflowRun.deleted.is_(False),
            )
        )
        counts = dict(
            self.session.execute(
                select(CodeAttribution.attribution_status, func.count())
                .group_by(CodeAttribution.attribution_status)
            ).all()
        )
        stale_running = self.session.execute(
            select(func.count())
            .select_from(CodeAttribution)
            .where(
                CodeAttribution.attribution_status == "running",
                CodeAttribution.server_updated_at
                <= now - timedelta(seconds=max(60.0, self.settings.attribution_timeout_seconds * 2)),
            )
        ).scalar_one()
        overdue_retry = self.session.execute(
            select(func.count())
            .select_from(CodeAttribution)
            .where(
                CodeAttribution.attribution_status == "retry_pending",
                CodeAttribution.next_retry_at.is_not(None),
                CodeAttribution.next_retry_at
                <= now - timedelta(
                    seconds=max(7200.0, self.settings.attribution_scan_interval_seconds * 4)
                ),
            )
        ).scalar_one()
        window_expired_failed = self.session.execute(
            select(func.count())
            .select_from(CodeAttribution)
            .join(DevRun, CodeAttribution.dev_run_id == DevRun.id)
            .join(WorkflowRun, DevRun.workflow_run_id == WorkflowRun.id)
            .where(
                CodeAttribution.attribution_status == "failed",
                CodeAttribution.deleted.is_(False),
                DevRun.admin_excluded.is_(False),
                WorkflowRun.deleted.is_(False),
                DevRun.completed_at.is_not(None),
                DevRun.completed_at < cutoff,
            )
        ).scalar_one()
        return {
            "backlog": {
                "waiting_patch": not_queued,
                "waiting_dispatch": counts.get("pending", 0),
                "backing_off": counts.get("retry_pending", 0),
                "suspected_stuck": stale_running + overdue_retry,
                "stuck_breakdown": {
                    "stale_running": stale_running,
                    "overdue_retry": overdue_retry,
                },
                "window_expired_failed": window_expired_failed,
            },
            "scheduler": scheduler_status,
            "failures": self._failure_groups(),
            "trend": self._processing_trend(),
            "algorithms": self._algorithm_distribution(),
        }

    def _failure_groups(self) -> list[dict]:
        flags_per_row = self.session.execute(
            select(CodeAttribution.quality_flags).where(
                CodeAttribution.attribution_status == "failed"
            )
        ).scalars().all()
        groups: dict[str, int] = {}
        for flags in flags_per_row:
            reason = "unknown"
            for flag in flags or []:
                if str(flag) in _SKIP_REASON_FLAGS or str(flag).startswith("admin_"):
                    continue
                reason = str(flag)
                break
            groups[reason] = groups.get(reason, 0) + 1
        return [
            {"reason": reason, "count": count}
            for reason, count in sorted(
                groups.items(), key=lambda item: (-item[1], item[0])
            )
        ]

    def _processing_trend(self) -> list[dict]:
        since = (_now() - timedelta(days=TREND_DAYS)).date()
        matched = dict(
            self.session.execute(
                select(func.date(CodeAttribution.matched_at), func.count())
                .where(
                    CodeAttribution.result_status == "finalized_match",
                    CodeAttribution.matched_at >= since,
                )
                .group_by(func.date(CodeAttribution.matched_at))
            ).all()
        )
        confidence = dict(
            self.session.execute(
                select(func.date(CodeAttribution.matched_at), func.avg(CodeAttribution.confidence))
                .where(
                    CodeAttribution.result_status == "finalized_match",
                    CodeAttribution.matched_at >= since,
                )
                .group_by(func.date(CodeAttribution.matched_at))
            ).all()
        )
        no_match = dict(
            self.session.execute(
                select(func.date(CodeAttribution.server_updated_at), func.count())
                .where(
                    CodeAttribution.result_status == "finalized_no_match",
                    CodeAttribution.server_updated_at >= since,
                )
                .group_by(func.date(CodeAttribution.server_updated_at))
            ).all()
        )
        failed = dict(
            self.session.execute(
                select(func.date(CodeAttribution.server_updated_at), func.count())
                .where(
                    CodeAttribution.attribution_status == "failed",
                    CodeAttribution.server_updated_at >= since,
                )
                .group_by(func.date(CodeAttribution.server_updated_at))
            ).all()
        )
        points = []
        for offset in range(TREND_DAYS - 1, -1, -1):
            day = (_now() - timedelta(days=offset)).date()
            key = day.isoformat() if not isinstance(day, str) else day
            points.append(
                {
                    "date": key,
                    "matched": matched.get(day, matched.get(key, 0)),
                    "no_match": no_match.get(day, no_match.get(key, 0)),
                    "failed": failed.get(day, failed.get(key, 0)),
                    "avg_confidence": (
                        round(confidence.get(day, confidence.get(key)), 4)
                        if confidence.get(day, confidence.get(key)) is not None
                        else None
                    ),
                }
            )
        return points

    def _algorithm_distribution(self) -> list[dict]:
        rows = self.session.execute(
            select(
                CodeAttribution.algorithm_version,
                CodeAttribution.result_status,
                func.count(),
            )
            .group_by(CodeAttribution.algorithm_version, CodeAttribution.result_status)
            .order_by(CodeAttribution.algorithm_version)
        ).all()
        return [
            {"algorithm_version": a, "result_status": r, "count": c} for a, r, c in rows
        ]

    # ------------------------------------------------------------------
    # payload builders

    def _record_item(
        self,
        dev_run: DevRun,
        message: TelemetryMessage,
        attribution: CodeAttribution | None,
        upload: ObjectUpload | None,
        cutoff: datetime,
    ) -> dict:
        completed_at = dev_run.completed_at
        if completed_at is not None and completed_at.tzinfo is None:
            completed_at = completed_at.replace(tzinfo=UTC)
        status = (
            attribution.attribution_status if attribution is not None else NOT_QUEUED
        )
        effective_lines = (
            attribution.dev_effective_lines
            if attribution is not None
            else int((dev_run.code_statistics or {}).get("total_effective_lines") or 0)
        )
        return {
            "dev_run_id": str(dev_run.id),
            "record_status": status,
            "attribution_status": status,
            "workflow_kind": message.workflow_kind,
            "entry": message.entry,
            "repository": message.repository,
            "sr": message.sr,
            "ar": message.ar,
            "user_name": message.user_name,
            "user_email": message.user_email,
            "file_name": message.file_name,
            "upload_status": upload.status if upload is not None else None,
            "dev_effective_lines": effective_lines,
            "attributed_lines_80": attribution.attributed_lines_80 if attribution else None,
            "confidence": attribution.confidence if attribution else None,
            "result_status": attribution.result_status if attribution else None,
            "algorithm_version": attribution.algorithm_version if attribution else None,
            "matched_mr_iid": attribution.matched_mr_iid if attribution else None,
            "matched_mr_url": attribution.matched_mr_url if attribution else None,
            "retry_count": attribution.retry_count if attribution else 0,
            "next_retry_at": _iso(attribution.next_retry_at) if attribution else None,
            "quality_flags": attribution.quality_flags if attribution else [],
            "dev_started_at": _iso(dev_run.started_at),
            "dev_completed_at": _iso(dev_run.completed_at),
            "server_updated_at": _iso(
                attribution.server_updated_at if attribution else dev_run.server_updated_at
            ),
            "admin_excluded": dev_run.admin_excluded,
            "admin_excluded_reason": dev_run.admin_excluded_reason,
            "admin_excluded_at": _iso(dev_run.admin_excluded_at),
            "admin_excluded_by": dev_run.admin_excluded_by,
            "deleted_reason_code": dev_run.deleted_reason_code,
            "attribution_deleted": bool(attribution is not None and attribution.deleted),
            "attribution_deleted_reason_code": (
                attribution.deleted_reason_code if attribution else None
            ),
            "workflow_deleted": bool(
                getattr(
                    self.session.get(WorkflowRun, dev_run.workflow_run_id),
                    "deleted",
                    False,
                )
            ),
            "retry_window_expired": (
                completed_at is not None and completed_at < cutoff
            ),
        }

    def _legacy_item(self, attribution, dev_run, cutoff: datetime) -> dict:
        """Payload shape kept for the legacy queue/retry endpoints."""
        upload = self.session.scalar(
            select(ObjectUpload).where(ObjectUpload.owner_id == attribution.dev_run_id)
        )
        message = self.session.get(TelemetryMessage, attribution.dev_run_id)
        dev_run = dev_run if dev_run is not None else self.session.get(
            DevRun, attribution.dev_run_id
        )
        return self._record_item(dev_run, message, attribution, upload, cutoff)


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.isoformat()
