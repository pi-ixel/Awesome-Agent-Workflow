"""编排层：实验的创建、准备、(case, trial) 配对并行调度与执行门面。"""

from __future__ import annotations

from sqlalchemy.orm import Session, sessionmaker

from ...config import Settings
from ...models import Experiment, Run
from ...schemas import ExperimentCreateRequest
from . import execution, prepare
from .scheduling import EXECUTION_MODE_PAIR_PARALLEL, PAIR_CONCURRENCY_LIMIT

__all__ = [
    "EXECUTION_MODE_PAIR_PARALLEL",
    "PAIR_CONCURRENCY_LIMIT",
    "ExperimentOrchestrator",
]


class ExperimentOrchestrator:
    def __init__(
        self,
        settings: Settings,
        session_factory: sessionmaker[Session],
        *,
        runner=None,
        judge=None,
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.runner = runner
        self.judge = judge

    def create(self, request: ExperimentCreateRequest) -> Experiment:
        return prepare.create(self.settings, self.session_factory, request)

    def create_retry(self, experiment_id: str) -> Experiment:
        return prepare.create_retry(self.session_factory, experiment_id)

    def execute(self, experiment_id: str) -> None:
        return execution.execute(
            self.settings, self.session_factory, self.runner, self.judge, experiment_id
        )

    def execute_retry(self, run_id: str) -> None:
        return execution.execute_retry(
            self.settings, self.session_factory, self.runner, self.judge, run_id
        )

    def prepare_retry(self, run_id: str) -> Run:
        return execution.prepare_retry(self.settings, self.session_factory, run_id)

    def request_run_cancel(self, run_id: str) -> Run:
        return execution.request_run_cancel(self.session_factory, run_id)

    def request_experiment_cancel(self, experiment_id: str) -> Experiment:
        return execution.request_experiment_cancel(self.session_factory, experiment_id)
