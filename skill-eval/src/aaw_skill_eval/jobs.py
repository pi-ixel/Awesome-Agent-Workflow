from __future__ import annotations

import asyncio
from contextlib import suppress
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.orm import Session, sessionmaker

from .config import Settings
from .models import Experiment, Run
from .services.orchestration import ExperimentOrchestrator
from .services.workspace.cleanup import cleanup_orphan_workspaces, remove_run_workspace_dirs


def mark_service_restart(settings: Settings, session_factory: sessionmaker[Session]) -> None:
    """Mark unfinished work as interrupted after a service restart.

    With pair-parallel execution an active experiment has two runs in the
    ``running`` state (the no_skill/current pair); the conditional UPDATE
    covers every active run of every experiment, so both runs of a pair are
    marked as infrastructure-interrupted together.

    被打断的实验整体废弃：其现场目录随重启标记一并删除（重试会重新克隆）。
    """
    interrupted_runs: list[tuple[str, str, int]] = []
    with session_factory() as session:
        experiment_ids = session.scalars(
            select(Experiment.id).where(Experiment.status.in_(["preparing", "running"]))
        ).all()
        if experiment_ids:
            interrupted_runs = [
                (run.experiment_id, run.id, run.current_attempt)
                for run in session.scalars(
                    select(Run).where(
                        Run.experiment_id.in_(experiment_ids), Run.status == "running"
                    )
                ).all()
            ]
        session.execute(
            update(Experiment)
            .where(Experiment.status.in_(["preparing", "running"]))
            .values(
                status="interrupted",
                error_kind="infra_error",
                error_message="Service restarted",
            )
        )
        session.execute(
            update(Run)
            .where(Run.status == "running")
            .values(
                status="infra_error",
                current_stage="infra_error",
                error_kind="infra_error",
                error_message="Service restarted",
                completed_at=datetime.now(UTC),
            )
        )
        session.commit()
    for experiment_id, run_id, attempt in interrupted_runs:
        result = remove_run_workspace_dirs(settings, experiment_id, run_id, attempt)
        retained = bool(result["failed"])
        with session_factory() as session:
            run = session.get(Run, run_id)
            if run is not None:
                run.workspace_retained = retained
                session.commit()


class JobManager:
    def __init__(
        self,
        session_factory: sessionmaker[Session],
        orchestrator: ExperimentOrchestrator,
    ) -> None:
        self.session_factory = session_factory
        self.orchestrator = orchestrator
        self.queue: asyncio.Queue[tuple[str, str] | None] = asyncio.Queue()
        self.worker: asyncio.Task | None = None

    async def start(self) -> None:
        # 纯手动清理模式：启动时只清孤儿目录（数据库无记录的残留），
        # 有记录的现场一律保留，由用户在页面手动清理。
        cleanup_orphan_workspaces(
            self.orchestrator.settings,
            self.session_factory,
        )
        mark_service_restart(self.orchestrator.settings, self.session_factory)
        with self.session_factory() as session:
            queued = list(
                session.scalars(
                    select(Experiment.id)
                    .where(Experiment.status == "queued")
                    .order_by(Experiment.created_at)
                )
            )
            session.commit()
        self.worker = asyncio.create_task(self._run(), name="skill-eval-worker")
        for experiment_id in queued:
            await self.queue.put(("experiment", experiment_id))

    async def stop(self) -> None:
        if self.worker is None:
            return
        await self.queue.put(None)
        with suppress(asyncio.CancelledError):
            await self.worker
        self.worker = None

    async def enqueue(self, experiment_id: str) -> None:
        await self.queue.put(("experiment", experiment_id))

    async def enqueue_retry(self, run_id: str) -> None:
        await self.queue.put(("retry", run_id))

    async def _run(self) -> None:
        while True:
            job = await self.queue.get()
            try:
                if job is None:
                    return
                kind, item_id = job
                if kind == "retry":
                    await asyncio.to_thread(self.orchestrator.execute_retry, item_id)
                else:
                    await asyncio.to_thread(self.orchestrator.execute, item_id)
            except Exception as exc:
                if job is None or job[0] != "experiment":
                    continue
                experiment_id = job[1]
                with self.session_factory() as session:
                    experiment = session.get(Experiment, experiment_id)
                    if experiment is not None:
                        experiment.status = "failed"
                        experiment.error_kind = "infra_error"
                        experiment.error_message = f"{type(exc).__name__}: {exc}"[:10_000]
                        experiment.completed_at = datetime.now(UTC)
                        session.commit()
            finally:
                self.queue.task_done()
