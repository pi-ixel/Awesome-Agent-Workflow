from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from ..config import Settings
from ..errors import ApiError
from ..models import CodeAttribution, DevRun, TelemetryMessage

logger = logging.getLogger("aaw_telemetry.admin.attribution")

ATTRIBUTION_STATUSES = (
    "pending",
    "running",
    "retry_pending",
    "failed",
    "finalized_match",
    "finalized_no_match",
)


def _now() -> datetime:
    value = datetime.now(UTC)
    return value.replace(microsecond=(value.microsecond // 1000) * 1000)


class AdminAttributionService:
    """Operations view over the attribution queue for the admin page."""

    def __init__(self, session: Session, settings: Settings):
        self.session = session
        self.settings = settings

    def counts(self) -> dict:
        rows = self.session.execute(
            select(CodeAttribution.attribution_status, func.count())
            .group_by(CodeAttribution.attribution_status)
        ).all()
        counts = {status: 0 for status in ATTRIBUTION_STATUSES}
        total = 0
        for status, count in rows:
            counts[status] = count
            total += count
        return {"total": total, "by_status": counts}

    def queue(
        self,
        *,
        attribution_status: str | None,
        result_status: str | None,
        page: int,
        page_size: int,
    ) -> dict:
        query = (
            select(CodeAttribution, DevRun, TelemetryMessage)
            .join(DevRun, CodeAttribution.dev_run_id == DevRun.id)
            .join(TelemetryMessage, TelemetryMessage.id == DevRun.id)
        )
        if attribution_status is not None:
            query = query.where(CodeAttribution.attribution_status == attribution_status)
        if result_status is not None:
            query = query.where(CodeAttribution.result_status == result_status)
        total = self.session.execute(
            select(func.count()).select_from(query.subquery())
        ).scalar_one()
        rows = self.session.execute(
            query.order_by(
                case((CodeAttribution.next_retry_at.is_(None), 1), else_=0),
                CodeAttribution.next_retry_at.asc(),
                CodeAttribution.server_updated_at.desc(),
            )
            .offset((page - 1) * page_size)
            .limit(page_size)
        ).all()
        cutoff = _now() - timedelta(seconds=self.settings.attribution_retry_window_seconds)
        items = [
            self._item(attribution, dev_run, message, cutoff)
            for attribution, dev_run, message in rows
        ]
        return {"total": total, "page": page, "page_size": page_size, "items": items}

    def retry(self, dev_run_id, scheduler) -> dict:
        attribution = self.session.get(CodeAttribution, dev_run_id)
        if attribution is None:
            raise ApiError(404, "ATTRIBUTION_NOT_FOUND", f"归因记录 {dev_run_id} 不存在")
        dev_run = self.session.get(DevRun, dev_run_id)
        cutoff = _now() - timedelta(seconds=self.settings.attribution_retry_window_seconds)
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
                    "开发记录的完成时间已超出重试窗口，扩大 "
                    "attribution_retry_window_seconds 后再试",
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
        message = self.session.get(TelemetryMessage, dev_run_id)
        return self._item(attribution, dev_run, message, cutoff)

    @staticmethod
    def _item(attribution, dev_run, message, cutoff: datetime) -> dict:
        completed_at = dev_run.completed_at
        if completed_at is not None and completed_at.tzinfo is None:
            completed_at = completed_at.replace(tzinfo=UTC)
        return {
            "dev_run_id": str(attribution.dev_run_id),
            "repository": message.repository,
            "sr": message.sr,
            "ar": message.ar,
            "user_name": message.user_name,
            "file_name": message.file_name,
            "attribution_status": attribution.attribution_status,
            "result_status": attribution.result_status,
            "retry_count": attribution.retry_count,
            "next_retry_at": (
                attribution.next_retry_at.isoformat()
                if attribution.next_retry_at is not None
                else None
            ),
            "quality_flags": attribution.quality_flags,
            "confidence": attribution.confidence,
            "dev_effective_lines": attribution.dev_effective_lines,
            "attributed_lines_80": attribution.attributed_lines_80,
            "matched_mr_iid": attribution.matched_mr_iid,
            "matched_mr_url": attribution.matched_mr_url,
            "dev_completed_at": (
                completed_at.isoformat() if completed_at is not None else None
            ),
            "server_updated_at": attribution.server_updated_at.isoformat(),
            "retry_window_expired": (
                completed_at is not None and completed_at < cutoff
            ),
        }
