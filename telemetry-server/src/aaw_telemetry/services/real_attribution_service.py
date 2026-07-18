"""真实归因服务 —— 内网版本使用。

diff 上传后创建 pending 归因记录并触发后台线程执行真实归因，
补跑调度器每小时扫描需要重试的记录。
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime
from functools import partial

from sqlalchemy.orm import Session

from ..models import DevRun
from .attribution_engine import AttributionEngine
from .attribution_service import AttributionService
from .attribution_tasks import retry_pending_attributions, run_attribution_in_background

logger = logging.getLogger("aaw_telemetry.attribution")


class RealAttributionService(AttributionService):
    """真实归因服务：异步执行归因流水线。"""

    def __init__(self, settings, projects, engine: AttributionEngine) -> None:
        self._settings = settings
        self._projects = projects
        self._engine = engine

    def on_diff_confirmed(
        self,
        session: Session,
        dev_run: DevRun,
        now: datetime,
    ) -> None:
        _create_pending_attribution(session, dev_run, now)
        _trigger_async_attribution(
            dev_run.id,
            self._settings,
            self._projects,
            self._engine,
        )

    def start_retry_scheduler(self, settings, projects) -> None:
        _start_retry_scheduler(settings, projects, self._engine)


def _create_pending_attribution(
    session: Session,
    dev_run: DevRun,
    now: datetime,
) -> None:
    """创建 pending 状态的 CodeAttribution 记录。"""
    from ..models import CodeAttribution

    total_effective = (
        int(dev_run.code_statistics["total_effective_lines"])
        if dev_run.code_statistics
        else 0
    )
    attribution = session.get(CodeAttribution, dev_run.id)
    if attribution is not None:
        attribution.attribution_status = "pending"
        attribution.dev_effective_lines = total_effective
        attribution.quality_flags = ["armr-counter-v1", "pending"]
        attribution.server_updated_at = now
        return

    attribution = CodeAttribution(
        dev_run_id=dev_run.id,
        dev_effective_lines=total_effective,
        attributed_lines_80=0,
        attributed_lines_90=0,
        confidence=0.0,
        quality_flags=["armr-counter-v1", "pending"],
        result_status="finalized_no_match",
        attribution_status="pending",
        retry_count=0,
        next_retry_at=None,
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
    session.add(attribution)


def _trigger_async_attribution(
    dev_run_id: uuid.UUID,
    settings,
    projects,
    engine: AttributionEngine,
) -> None:
    """通过线程池触发异步归因任务。"""
    import asyncio

    task = partial(
        run_attribution_in_background,
        dev_run_id=dev_run_id,
        settings=settings,
        projects=projects,
        engine=engine,
    )

    try:
        loop = asyncio.get_running_loop()
        loop.run_in_executor(None, task)
    except RuntimeError:
        import threading

        thread = threading.Thread(target=task, daemon=True)
        thread.start()


def _start_retry_scheduler(settings, projects, engine: AttributionEngine) -> None:
    """启动归因补跑定时调度器（后台线程，每小时执行一次）。"""
    import threading
    import time

    interval_seconds = 3600

    def _scheduler_loop():
        time.sleep(30)
        while True:
            try:
                retried = retry_pending_attributions(settings, projects, engine)
                if retried > 0:
                    logger.info(
                        "attribution_retry_scheduler: triggered %d retries",
                        retried,
                    )
            except Exception as exc:
                logger.error(
                    "attribution_retry_scheduler: error=%s",
                    exc,
                    exc_info=True,
                )
            time.sleep(interval_seconds)

    thread = threading.Thread(
        target=_scheduler_loop,
        daemon=True,
        name="attribution-retry-scheduler",
    )
    thread.start()
    logger.info(
        "attribution_retry_scheduler: started (interval=%ds)",
        interval_seconds,
    )
