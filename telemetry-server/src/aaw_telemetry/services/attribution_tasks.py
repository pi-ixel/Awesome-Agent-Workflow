"""后台归因任务：独立线程中运行归因流水线，不阻塞事件循环。"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from functools import partial

from sqlalchemy import and_, select
from sqlalchemy.orm import Session

from ..config import ProjectRegistry, Settings
from ..database import build_engine, build_session_factory
from ..models import CodeAttribution, DevRun, TelemetryMessage, WorkflowRun
from .attribution_engine import AttributionEngine

logger = logging.getLogger("aaw_telemetry.attribution")

# 归因补跑的最大重试次数（指数退避到上限后匀速重试，直到 30 天窗口结束）
MAX_RETRY_COUNT = 30

# 重试间隔基数（指数退避）：1h, 2h, 4h, 8h, 16h, 32h, 32h, ...
INITIAL_RETRY_INTERVAL = timedelta(hours=1)

# 退避间隔上限
MAX_RETRY_INTERVAL = timedelta(hours=32)

# 补跑最大窗口：超过此时间不再重试
MAX_RETRY_WINDOW = timedelta(days=30)


def run_attribution_in_background(
    dev_run_id: uuid.UUID,
    settings: Settings,
    projects: ProjectRegistry,
    engine: AttributionEngine,
) -> None:
    """在独立线程中运行归因任务，并使用独立数据库 session。"""
    db_engine = build_engine(settings)
    session_factory = build_session_factory(db_engine)

    try:
        with session_factory() as session:
            _execute_attribution(session, dev_run_id, settings, projects, engine)
    except Exception as exc:
        logger.error(
            "后台归因任务执行失败",
            extra={
                "event": "attribution.background_failed",
                "dev_run_id": str(dev_run_id),
                "error_type": type(exc).__name__,
            },
            exc_info=True,
        )
    finally:
        db_engine.dispose()


def retry_pending_attributions(
    settings: Settings,
    projects: ProjectRegistry,
    engine: AttributionEngine,
) -> int:
    """扫描并触发已到补跑时间、仍处于 30 天窗口内的归因记录。"""
    now = datetime.now(UTC)
    db_engine = build_engine(settings)
    session_factory = build_session_factory(db_engine)
    retried = 0

    try:
        with session_factory() as session:
            cutoff = now - MAX_RETRY_WINDOW
            stmt = (
                select(CodeAttribution)
                .join(DevRun, CodeAttribution.dev_run_id == DevRun.id)
                .where(
                    and_(
                        CodeAttribution.attribution_status.in_(
                            ["finalized_no_match", "failed", "retry_pending"]
                        ),
                        CodeAttribution.retry_count < MAX_RETRY_COUNT,
                        DevRun.completed_at >= cutoff,
                        CodeAttribution.next_retry_at.is_(None)
                        | (CodeAttribution.next_retry_at <= now),
                    )
                )
                .order_by(CodeAttribution.next_retry_at.asc())
                .limit(50)
            )
            attributions = list(session.scalars(stmt).all())

            for attribution in attributions:
                attribution.attribution_status = "retry_pending"
                session.commit()

                dev_run_id = attribution.dev_run_id
                logger.info(
                    "未匹配的归因记录已安排再次尝试",
                    extra={
                        "event": "attribution.retry_scheduled",
                        "dev_run_id": str(dev_run_id),
                        "retry_count": attribution.retry_count + 1,
                    },
                )
                _spawn_retry_thread(dev_run_id, settings, projects, engine)
                retried += 1
    except Exception as exc:
        logger.error(
            "扫描待重试归因记录时发生异常",
            extra={
                "event": "attribution.retry_scan_failed",
                "error_type": type(exc).__name__,
            },
            exc_info=True,
        )
    finally:
        db_engine.dispose()

    return retried


def _spawn_retry_thread(
    dev_run_id: uuid.UUID,
    settings: Settings,
    projects: ProjectRegistry,
    engine: AttributionEngine,
) -> None:
    """启动独立线程执行补跑。"""
    import threading

    task = partial(
        run_attribution_in_background,
        dev_run_id=dev_run_id,
        settings=settings,
        projects=projects,
        engine=engine,
    )
    thread = threading.Thread(target=task, daemon=True)
    thread.start()


def _execute_attribution(
    session: Session,
    dev_run_id: uuid.UUID,
    settings: Settings,
    projects: ProjectRegistry,
    engine: AttributionEngine,
) -> None:
    """在给定 session 中执行归因流水线。"""
    now = datetime.now(UTC)

    dev_run = session.get(DevRun, dev_run_id)
    if dev_run is None:
        logger.warning(
            "归因任务对应的开发记录不存在，已跳过处理",
            extra={
                "event": "attribution.dev_run_missing",
                "dev_run_id": str(dev_run_id),
            },
        )
        return

    attribution = session.get(CodeAttribution, dev_run_id)
    if attribution is not None:
        if attribution.attribution_status == "finalized_match":
            logger.info(
                "该开发记录已经成功匹配，无需重复归因",
                extra={
                    "event": "attribution.skipped",
                    "dev_run_id": str(dev_run_id),
                    "reason": "already_matched",
                },
            )
            return

        if attribution.retry_count >= MAX_RETRY_COUNT:
            logger.info(
                "归因重试次数已达到上限，不再继续处理",
                extra={
                    "event": "attribution.skipped",
                    "dev_run_id": str(dev_run_id),
                    "reason": "max_retries_reached",
                    "retry_count": attribution.retry_count,
                },
            )
            return

        if _retry_window_expired(dev_run.completed_at, now):
            logger.info(
                "归因重试窗口已经结束，不再继续处理",
                extra={
                    "event": "attribution.skipped",
                    "dev_run_id": str(dev_run_id),
                    "reason": "retry_window_expired",
                    "retry_count": attribution.retry_count,
                },
            )
            return

        attribution.attribution_status = "running"
        session.commit()

    message = session.scalar(
        select(TelemetryMessage).where(TelemetryMessage.id == dev_run_id)
    )
    if message is None:
        logger.warning(
            "归因所需的步骤上报记录不存在，本次处理失败",
            extra={
                "event": "attribution.context_missing",
                "dev_run_id": str(dev_run_id),
                "missing": "telemetry_message",
            },
        )
        _mark_failed(session, dev_run_id, now, "message_not_found")
        return

    workflow = session.get(WorkflowRun, dev_run.workflow_run_id)
    project_entry = None
    if workflow is not None:
        project_entry = projects.get(workflow.project_key)

    if dev_run.patch_object_key is None:
        logger.warning(
            "归因所需的 Dev Patch 尚未确认，本次处理失败",
            extra={
                "event": "attribution.context_missing",
                "dev_run_id": str(dev_run_id),
                "missing": "patch_object",
            },
        )
        _mark_failed(session, dev_run_id, now, "no_patch_object")
        return

    diff_bytes = _read_diff_file(settings, dev_run.patch_object_key)
    if diff_bytes is None:
        logger.warning(
            "已登记的 Dev Patch 文件不存在，本次归因失败",
            extra={
                "event": "attribution.diff_missing",
                "dev_run_id": str(dev_run_id),
            },
        )
        _mark_failed(session, dev_run_id, now, "diff_file_missing")
        return

    try:
        result = engine.run(
            dev_run=dev_run,
            diff_bytes=diff_bytes,
            project_entry=project_entry,
            message=message,
        )
    except Exception as exc:
        logger.error(
            "归因计算引擎执行失败",
            extra={
                "event": "attribution.engine_failed",
                "dev_run_id": str(dev_run_id),
                "error_type": type(exc).__name__,
            },
            exc_info=True,
        )
        _mark_failed(session, dev_run_id, now, f"attribution_error:{exc!r}")
        return

    new_retry_count = (attribution.retry_count if attribution else 0) + 1
    _upsert_attribution(
        session,
        dev_run_id,
        result,
        now,
        new_retry_count,
        completed_at=dev_run.completed_at,
    )

    logger.info(
        "代码归因计算已完成",
        extra={
            "event": "attribution.completed",
            "dev_run_id": str(dev_run_id),
            "status": result.get("result_status"),
            "attributed_lines_80": result.get("attributed_lines_80", 0),
            "retry_count": new_retry_count,
        },
    )


def _read_diff_file(settings: Settings, object_key: str) -> bytes | None:
    """从对象存储读取 diff 文件内容；无效路径或文件不存在时返回 None。"""
    root = settings.object_storage_dir.resolve()
    target = (root / object_key).resolve()
    if not target.is_relative_to(root) or not target.is_file():
        return None
    return target.read_bytes()


def _compute_retry_interval(retry_count: int) -> timedelta:
    """计算指数退避间隔，最大为 32 小时。"""
    raw = INITIAL_RETRY_INTERVAL * (2 ** max(0, retry_count - 1))
    return min(raw, MAX_RETRY_INTERVAL)


def _upsert_attribution(
    session: Session,
    dev_run_id: uuid.UUID,
    values: dict,
    now: datetime,
    retry_count: int = 1,
    *,
    completed_at: datetime | None = None,
) -> None:
    """创建或更新归因结果，并为未匹配结果安排下一次补跑。"""
    attribution = session.get(CodeAttribution, dev_run_id)
    persisted_values = dict(values)
    result_status = persisted_values.get("result_status", "finalized_no_match")
    persisted_values["attribution_status"] = result_status
    persisted_values["retry_count"] = retry_count

    retry_interval = _compute_retry_interval(retry_count)
    next_retry = now + retry_interval
    can_retry = (
        result_status == "finalized_no_match"
        and retry_count < MAX_RETRY_COUNT
        and not _retry_window_expired(completed_at, next_retry)
    )
    if can_retry:
        persisted_values["next_retry_at"] = next_retry
        persisted_values["attribution_status"] = "retry_pending"
    else:
        persisted_values["next_retry_at"] = None

    if attribution is None:
        session.add(CodeAttribution(dev_run_id=dev_run_id, **persisted_values))
    else:
        for field, value in persisted_values.items():
            setattr(attribution, field, value)
    session.commit()


def _mark_failed(
    session: Session,
    dev_run_id: uuid.UUID,
    now: datetime,
    reason: str,
) -> None:
    """记录归因失败，并在次数和时间窗口允许时安排补跑。"""
    attribution = session.get(CodeAttribution, dev_run_id)
    dev_run = session.get(DevRun, dev_run_id)
    completed_at = dev_run.completed_at if dev_run is not None else None

    if attribution is None:
        retry_count = 1
        next_retry = now + _compute_retry_interval(retry_count)
        can_retry = not _retry_window_expired(completed_at, next_retry)
        session.add(
            CodeAttribution(
                dev_run_id=dev_run_id,
                dev_effective_lines=0,
                attributed_lines_80=0,
                attributed_lines_90=0,
                confidence=0.0,
                quality_flags=["armr-counter-v1", "failed", reason],
                result_status="finalized_no_match",
                attribution_status="retry_pending" if can_retry else "failed",
                retry_count=retry_count,
                next_retry_at=next_retry if can_retry else None,
                matched_mr_iid=None,
                matched_mr_url=None,
                mr_diff_version=None,
                mr_source_branch=None,
                target_branch=None,
                merge_commit_sha=None,
                mr_merged_at=None,
                algorithm_version="armr-counter-v1",
                diff_rule_version="unified-diff-additions-v1",
                matched_at=now,
                server_updated_at=now,
            )
        )
    else:
        attribution.retry_count += 1
        next_retry = now + _compute_retry_interval(attribution.retry_count)
        can_retry = (
            attribution.retry_count < MAX_RETRY_COUNT
            and not _retry_window_expired(completed_at, next_retry)
        )
        attribution.next_retry_at = next_retry if can_retry else None
        attribution.attribution_status = "retry_pending" if can_retry else "failed"
        attribution.quality_flags = list(attribution.quality_flags or []) + [
            "failed",
            reason,
        ]
        attribution.server_updated_at = now
    session.commit()


def _retry_window_expired(completed_at: datetime | None, at: datetime) -> bool:
    """判断指定时刻是否超过 Dev 完成后的 30 天补跑窗口。"""
    if completed_at is None:
        return False
    completed = (
        completed_at.replace(tzinfo=UTC)
        if completed_at.tzinfo is None
        else completed_at.astimezone(UTC)
    )
    return at - completed > MAX_RETRY_WINDOW
