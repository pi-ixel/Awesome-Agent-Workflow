from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime

from sqlalchemy.orm import Session, sessionmaker

from ...database import with_lock_retry
from ...models import Experiment, Run, RunProgressEvent


def now() -> datetime:
    return datetime.now(UTC)


class RunProgress:
    def __init__(
        self,
        session_factory: sessionmaker[Session],
        run_id: str,
        *,
        on_event: Callable[[str, str, str | None], None] | None = None,
    ) -> None:
        self.session_factory = session_factory
        self.run_id = run_id
        self.on_event = on_event

    def emit(
        self,
        kind: str,
        message: str,
        *,
        stage: str | None = None,
        activity: bool = False,
    ) -> None:
        timestamp = now()
        # Each call opens its own session (one per writing thread) and the
        # whole transaction is retried on SQLite lock errors: with the
        # no_skill/current pair executing in parallel, two runs plus the API
        # can contend on the database.
        def work(session: Session) -> tuple[bool, str | None]:
            run = session.get(Run, self.run_id)
            if run is None:
                return (False, None)
            if stage is not None and stage != run.current_stage:
                run.current_stage = stage
                run.stage_started_at = timestamp
            run.last_heartbeat_at = timestamp
            if activity or kind in {"stage", "activity", "error"}:
                run.last_activity_at = timestamp
            session.add(
                RunProgressEvent(
                    run_id=run.id,
                    attempt=run.current_attempt,
                    kind=kind,
                    stage=stage or run.current_stage,
                    message=message[:1000],
                    created_at=timestamp,
                )
            )
            return (True, stage or run.current_stage)

        found, emitted_stage = with_lock_retry(
            lambda: self._run_in_session(work),
        )
        if found and self.on_event is not None:
            self.on_event(kind, message, emitted_stage)

    def _run_in_session(self, work: Callable[[Session], tuple[bool, str | None]]):
        with self.session_factory() as session:
            result = work(session)
            session.commit()
            return result

    def stage(self, stage: str, message: str) -> None:
        self.emit("stage", message, stage=stage, activity=True)

    def activity(self, message: str) -> None:
        self.emit("activity", message, activity=True)

    def heartbeat(self, message: str = "子进程仍在运行") -> None:
        self.emit("heartbeat", message)

    def error(self, stage: str, message: str) -> None:
        self.emit("error", message, stage=stage, activity=True)

    def cancelled(self) -> bool:
        with self.session_factory() as session:
            run = session.get(Run, self.run_id)
            if run is None:
                return True
            experiment = session.get(Experiment, run.experiment_id)
            return bool(
                run.cancel_requested_at
                or (experiment is not None and experiment.cancel_requested_at)
            )
