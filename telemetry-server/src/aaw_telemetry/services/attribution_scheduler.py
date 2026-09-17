from __future__ import annotations

import asyncio
import logging
import threading
import uuid
from contextlib import suppress
from datetime import UTC, datetime, timedelta

from sqlalchemy import String, and_, cast, or_, select, update
from sqlalchemy.orm import Session, sessionmaker

from ..config import ProjectRegistry, Settings
from ..models import CodeAttribution, DevRun, TelemetryMessage, WorkflowRun
from .attribution_service import (
    AttributionRequest,
    AttributionResult,
    AttributionService,
    AttributionServiceError,
    DevelopmentContext,
    DiffPayload,
    ProjectContext,
    TelemetryContext,
)

logger = logging.getLogger("aaw_telemetry.attribution")

MAX_RETRY_COUNT = 30
INITIAL_RETRY_INTERVAL = timedelta(hours=1)
MAX_RETRY_INTERVAL = timedelta(hours=32)
BATCH_SIZE = 50
MAX_CONSECUTIVE_SCAN_FAILURES = 5

# Records an admin force-ran past the retry window stay eligible for scans;
# the flag is admin bookkeeping, so match it textually against the JSON list.
FORCED_FLAG = "admin_retry_expired"
_forced = cast(CodeAttribution.quality_flags, String).like(f"%{FORCED_FLAG}%")


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _millisecond(value: datetime) -> datetime:
    value = _utc(value)
    return value.replace(microsecond=(value.microsecond // 1000) * 1000)


def _retry_interval(retry_count: int) -> timedelta:
    raw = INITIAL_RETRY_INTERVAL * (2 ** max(0, retry_count - 1))
    return min(raw, MAX_RETRY_INTERVAL)


def _within_retry_window(
    completed_at: datetime | None, next_retry_at: datetime, window: timedelta
) -> bool:
    if completed_at is None:
        return True
    return next_retry_at - _utc(completed_at) <= window


class AttributionScheduler:
    def __init__(
        self,
        session_factory: sessionmaker[Session],
        settings: Settings,
        projects: ProjectRegistry,
        attribution_service: AttributionService,
    ) -> None:
        self._session_factory = session_factory
        self._settings = settings
        self._projects = projects
        self._attribution_service = attribution_service
        self._wake_event: asyncio.Event | None = None
        self._stopping = False
        self._task: asyncio.Task | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._paused = False
        self._scan_lock = threading.Lock()
        self._last_scan_at: datetime | None = None
        self._last_scan_processed: int | None = None
        self._last_scan_error: str | None = None
        self._consecutive_failures = 0

    def start(self) -> asyncio.Task:
        """Run the background loop as a managed task on the running loop."""
        if self._task is not None and not self._task.done():
            return self._task
        self._loop = asyncio.get_running_loop()
        self._stopping = False
        self._paused = False
        self._consecutive_failures = 0
        self._task = asyncio.create_task(self.run(), name="attribution-scheduler")
        return self._task

    def revive(self) -> bool:
        """Restart the loop after it paused itself. Safe from worker threads.

        The scheduler gives up entirely after MAX_CONSECUTIVE_SCAN_FAILURES
        broken passes; without this nudge it stays dead until a restart.
        """
        if self._loop is None or not self._paused:
            return False
        self._loop.call_soon_threadsafe(self._ensure_task)
        return True

    def _ensure_task(self) -> None:
        if self._loop is None or (self._task is not None and not self._task.done()):
            return
        self._stopping = False
        self._paused = False
        self._consecutive_failures = 0
        self._task = self._loop.create_task(
            self.run(), name="attribution-scheduler"
        )

    @property
    def task(self) -> asyncio.Task | None:
        return self._task

    def status(self) -> dict:
        running = self._task is not None and not self._task.done()
        return {
            "running": running and not self._stopping,
            "paused": self._paused,
            "last_scan_at": self._last_scan_at.isoformat() if self._last_scan_at else None,
            "last_scan_processed": self._last_scan_processed,
            "last_scan_error": self._last_scan_error,
            "consecutive_failures": self._consecutive_failures,
            "scan_interval_seconds": self._settings.attribution_scan_interval_seconds,
            "retry_window_seconds": self._settings.attribution_retry_window_seconds,
        }

    def notify(self) -> None:
        if self._wake_event is not None:
            self._wake_event.set()

    def stop(self) -> None:
        self._stopping = True
        self.notify()

    async def run(self) -> None:
        self._wake_event = asyncio.Event()
        while not self._stopping:
            self._wake_event.clear()
            try:
                await asyncio.to_thread(self.scan_once)
            except Exception:
                self._consecutive_failures += 1
                logger.exception(
                    "扫描待归因记录时发生异常",
                    extra={
                        "event": "attribution.scheduler_failed",
                        "consecutive_failures": self._consecutive_failures,
                        "failure_limit": MAX_CONSECUTIVE_SCAN_FAILURES,
                    },
                )
                if self._consecutive_failures >= MAX_CONSECUTIVE_SCAN_FAILURES:
                    self._paused = True
                    logger.critical(
                        "归因调度器连续失败次数达到上限，已暂停后台扫描",
                        extra={
                            "event": "attribution.scheduler_paused",
                            "consecutive_failures": self._consecutive_failures,
                        },
                    )
                    return
            else:
                self._consecutive_failures = 0
            if self._stopping:
                break
            await self._wait_for_next_scan()

    def scan_once(self) -> int:
        """Run one scan pass and record the outcome for status reporting."""
        started_at = datetime.now(UTC)
        started = _millisecond(started_at)
        try:
            processed = self.run_once()
        except Exception as exc:
            self._last_scan_at = started
            self._last_scan_processed = 0
            self._last_scan_error = f"{type(exc).__name__}: {exc}"
            raise
        self._last_scan_at = started
        self._last_scan_processed = processed
        self._last_scan_error = None
        if processed:
            # 只有真处理了记录才留痕，空轮是常态不值得刷屏
            logger.info(
                f"后台归因扫描完成，本轮处理 {processed} 条",
                extra={
                    "event": "attribution.scan_completed",
                    "processed": processed,
                    "duration_ms": int(
                        (datetime.now(UTC) - started_at).total_seconds() * 1000
                    ),
                },
            )
        return processed

    def try_scan(self) -> int | None:
        """Run scan_once unless a scan is already in flight; None means busy."""
        if not self._scan_lock.acquire(blocking=False):
            return None
        try:
            return self.scan_once()
        finally:
            self._scan_lock.release()

    async def _wait_for_next_scan(self) -> None:
        with suppress(TimeoutError):
            await asyncio.wait_for(
                self._wake_event.wait(),
                timeout=self._settings.attribution_scan_interval_seconds,
            )

    def run_once(self) -> int:
        now = _millisecond(datetime.now(UTC))
        self._expire_retry_window(now)
        stale_before = now - timedelta(
            seconds=max(60.0, self._settings.attribution_timeout_seconds * 2)
        )
        candidate_ids = self._candidate_ids(now, stale_before)
        processed = 0
        for dev_run_id in candidate_ids:
            lease_at = self._claim(dev_run_id, now, stale_before)
            if lease_at is None:
                continue
            self._execute(dev_run_id, lease_at)
            processed += 1
        return processed

    def _expire_retry_window(self, now: datetime) -> None:
        cutoff = now - timedelta(seconds=self._settings.attribution_retry_window_seconds)
        # 已删除的开发记录/工作流不参与超窗标记（删除即退出归因流程）
        expired_dev_runs = (
            select(DevRun.id)
            .join(WorkflowRun, DevRun.workflow_run_id == WorkflowRun.id)
            .where(
                DevRun.completed_at < cutoff,
                DevRun.admin_excluded.is_(False),
                WorkflowRun.deleted.is_(False),
            )
        )
        with self._session_factory() as session:
            session.execute(
                update(CodeAttribution)
                .where(
                    CodeAttribution.dev_run_id.in_(expired_dev_runs),
                    CodeAttribution.deleted.is_(False),
                    CodeAttribution.attribution_status.in_(("pending", "retry_pending")),
                    # Force-rerun candidates keep their pending state so the
                    # admin's manual remedy is not undone by the sweeper.
                    ~_forced,
                )
                .values(
                    attribution_status="failed",
                    next_retry_at=None,
                    server_updated_at=now,
                )
                .execution_options(synchronize_session=False)
            )
            session.commit()

    def _candidate_ids(
        self,
        now: datetime,
        stale_before: datetime,
    ) -> list[uuid.UUID]:
        due = or_(
            CodeAttribution.attribution_status == "pending",
            and_(
                CodeAttribution.attribution_status.in_(("failed", "retry_pending")),
                or_(
                    CodeAttribution.next_retry_at.is_(None),
                    CodeAttribution.next_retry_at <= now,
                ),
            ),
            and_(
                CodeAttribution.attribution_status == "running",
                CodeAttribution.server_updated_at <= stale_before,
            ),
        )
        cutoff = now - timedelta(seconds=self._settings.attribution_retry_window_seconds)
        with self._session_factory() as session:
            stmt = (
                select(CodeAttribution.dev_run_id)
                .join(DevRun, CodeAttribution.dev_run_id == DevRun.id)
                .join(WorkflowRun, DevRun.workflow_run_id == WorkflowRun.id)
                .where(
                    due,
                    # 已删除的归因/产出/工作流永远不重扫（删除即终态）
                    CodeAttribution.deleted.is_(False),
                    CodeAttribution.retry_count < MAX_RETRY_COUNT,
                    DevRun.admin_excluded.is_(False),
                    WorkflowRun.deleted.is_(False),
                    or_(
                        DevRun.completed_at.is_(None),
                        DevRun.completed_at >= cutoff,
                        _forced,
                    ),
                )
                .order_by(CodeAttribution.next_retry_at.asc())
                .limit(BATCH_SIZE)
            )
            return list(session.scalars(stmt).all())

    def _claim(
        self,
        dev_run_id: uuid.UUID,
        now: datetime,
        stale_before: datetime,
    ) -> datetime | None:
        due = or_(
            CodeAttribution.attribution_status == "pending",
            and_(
                CodeAttribution.attribution_status.in_(("failed", "retry_pending")),
                or_(
                    CodeAttribution.next_retry_at.is_(None),
                    CodeAttribution.next_retry_at <= now,
                ),
            ),
            and_(
                CodeAttribution.attribution_status == "running",
                CodeAttribution.server_updated_at <= stale_before,
            ),
        )
        with self._session_factory() as session:
            claimed = session.execute(
                update(CodeAttribution)
                .where(
                    CodeAttribution.dev_run_id == dev_run_id,
                    CodeAttribution.retry_count < MAX_RETRY_COUNT,
                    due,
                )
                .values(
                    attribution_status="running",
                    server_updated_at=now,
                )
                .execution_options(synchronize_session=False)
            ).rowcount
            session.commit()
        return now if claimed == 1 else None
    def _execute(self, dev_run_id: uuid.UUID, lease_at: datetime) -> None:
        try:
            request = self._load_request(dev_run_id)
            result = self._attribution_service.attribute(request)
        except AttributionServiceError as exc:
            self._record_failure(dev_run_id, lease_at, f"remote_error:{type(exc).__name__}")
            return
        except Exception as exc:
            logger.exception(
                "归因任务执行失败",
                extra={
                    "event": "attribution.worker_failed",
                    "dev_run_id": str(dev_run_id),
                    "error_type": type(exc).__name__,
                },
            )
            self._record_failure(dev_run_id, lease_at, f"worker_error:{type(exc).__name__}")
            return
        self._persist_result(result, lease_at)

    def _load_request(self, dev_run_id: uuid.UUID) -> AttributionRequest:
        with self._session_factory() as session:
            dev_run = session.get(DevRun, dev_run_id)
            message = session.get(TelemetryMessage, dev_run_id)
            if dev_run is None or message is None or dev_run.patch_object_key is None:
                raise RuntimeError("attribution context is incomplete")
            target = (
                self._settings.object_storage_dir.resolve() / dev_run.patch_object_key
            ).resolve()
            root = self._settings.object_storage_dir.resolve()
            if not target.is_relative_to(root) or not target.is_file():
                raise RuntimeError("attribution diff is missing")
            diff_bytes = target.read_bytes()
            project_entry = self._projects.get(message.repository)
            return AttributionRequest(
                request_id=dev_run.id,
                project=ProjectContext(
                    key=message.repository,
                    canonical_url=(
                        project_entry.canonical_url if project_entry is not None else None
                    ),
                    target_branch=(
                        project_entry.target_branch if project_entry is not None else None
                    ),
                ),
                development=DevelopmentContext(
                    branch=dev_run.branch,
                    head_sha_start=dev_run.head_sha_start,
                    head_sha_end=dev_run.head_sha_end,
                    completed_at=dev_run.completed_at,
                    started_at=dev_run.started_at,
                ),
                telemetry=TelemetryContext(
                    repository=message.repository,
                    sr=message.sr,
                    ar=message.ar,
                    user_email=message.user_email,
                    user_name=message.user_name,
                ),
                diff=DiffPayload.from_bytes(diff_bytes, dev_run.code_statistics or {}),
            )

    def _persist_result(self, result: AttributionResult, lease_at: datetime) -> None:
        now = _millisecond(datetime.now(UTC))
        with self._session_factory() as session:
            attribution = session.get(CodeAttribution, result.request_id)
            if attribution is None:
                return
            values = result.model_dump(exclude={"schema_version", "request_id"})
            # Engine flags describe the result; admin markers (e.g. admin_retry)
            # are operational history and must survive re-runs.
            admin_flags = [
                flag
                for flag in (attribution.quality_flags or [])
                if str(flag).startswith("admin_")
            ]
            values["quality_flags"] = result.quality_flags + admin_flags
            values["retry_count"] = attribution.retry_count
            values["server_updated_at"] = now
            values["attribution_status"] = result.result_status
            values["next_retry_at"] = None
            updated = session.execute(
                update(CodeAttribution)
                .where(
                    CodeAttribution.dev_run_id == result.request_id,
                    CodeAttribution.deleted.is_(False),
                    CodeAttribution.attribution_status == "running",
                    CodeAttribution.server_updated_at == lease_at,
                )
                .values(**values)
                .execution_options(synchronize_session=False)
            ).rowcount
            session.commit()
        if not updated:
            logger.info(
                "过期的归因结果已忽略",
                extra={
                    "event": "attribution.stale_result_ignored",
                    "dev_run_id": str(result.request_id),
                },
            )
        else:
            # 终态写回是采纳统计的数据源头，必须可追溯
            outcome = "已匹配 MR" if result.result_status == "finalized_match" else "未匹配"
            logger.info(
                f"归因完成：{outcome}",
                extra={
                    "event": "attribution.completed",
                    "dev_run_id": str(result.request_id),
                    "result_status": result.result_status,
                    "confidence": round(result.confidence, 3),
                    "matched_mr_iid": result.matched_mr_iid,
                    "algorithm_version": result.algorithm_version,
                    "retry_count": values["retry_count"],
                },
            )

    def _record_failure(
        self,
        dev_run_id: uuid.UUID,
        lease_at: datetime,
        reason: str,
    ) -> None:
        now = _millisecond(datetime.now(UTC))
        with self._session_factory() as session:
            attribution = session.get(CodeAttribution, dev_run_id)
            dev_run = session.get(DevRun, dev_run_id)
            if attribution is None:
                return
            retry_count = attribution.retry_count + 1
            next_retry_at = now + _retry_interval(retry_count)
            can_retry = (
                retry_count < MAX_RETRY_COUNT
                and _within_retry_window(
                    dev_run.completed_at if dev_run is not None else None,
                    next_retry_at,
                    timedelta(seconds=self._settings.attribution_retry_window_seconds),
                )
            )
            quality_flags = list(attribution.quality_flags or [])
            for flag in ("attribution_failed", reason):
                if flag not in quality_flags:
                    quality_flags.append(flag)
            updated = session.execute(
                update(CodeAttribution)
                .where(
                    CodeAttribution.dev_run_id == dev_run_id,
                    CodeAttribution.deleted.is_(False),
                    CodeAttribution.attribution_status == "running",
                    CodeAttribution.server_updated_at == lease_at,
                )
                .values(
                    attribution_status="retry_pending" if can_retry else "failed",
                    retry_count=retry_count,
                    next_retry_at=next_retry_at if can_retry else None,
                    quality_flags=quality_flags,
                    server_updated_at=now,
                )
                .execution_options(synchronize_session=False)
            ).rowcount
            session.commit()
        if updated:
            logger.warning(
                "归因任务失败，已按重试策略更新状态",
                extra={
                    "event": "attribution.retry_scheduled" if can_retry else "attribution.failed",
                    "dev_run_id": str(dev_run_id),
                    "retry_count": retry_count,
                    "next_retry_at": next_retry_at.isoformat() if can_retry else None,
                    "reason": reason,
                },
            )
