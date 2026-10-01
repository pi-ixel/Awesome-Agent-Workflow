from __future__ import annotations

import asyncio
from contextlib import suppress
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.orm import Session, sessionmaker

from .models import Experiment, Run
from .services.cleanup import cleanup_expired_workspaces
from .services.orchestrator import ExperimentOrchestrator


def mark_service_restart(session_factory: sessionmaker[Session]) -> None:
    """Mark unfinished work as interrupted after a service restart.

    With pair-parallel execution an active experiment has two runs in the
    ``running`` state (the no_skill/current pair); the conditional UPDATE
    covers every active run of every experiment, so both runs of a pair are
    marked as infrastructure-interrupted together.
    """
    with session_factory() as session:
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
        cleanup_expired_workspaces(
            self.orchestrator.settings,
            self.session_factory,
        )
        mark_service_restart(self.session_factory)
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
