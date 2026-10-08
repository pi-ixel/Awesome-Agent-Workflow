"""Pair-parallel execution tests (用户方案第五部分).

The primary evidence that the no_skill/current runs of one
(case_id, trial_index) pair really executed simultaneously is a
``threading.Barrier`` inside the fake runner: both runs must be inside
``run()`` at the same time for the barrier to pass, and a serial scheduler
breaks it after the timeout. Wall-clock comparisons are only auxiliary.
"""

from __future__ import annotations

import io
import threading
import time
from datetime import datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update
from sqlalchemy.exc import OperationalError

from aaw_skill_eval.config import Settings
from aaw_skill_eval.database import is_locked_error, with_lock_retry
from aaw_skill_eval.models import Experiment, Run
from aaw_skill_eval.schemas import CaseSpec, EvalProfile
from aaw_skill_eval.services.orchestration import (
    EXECUTION_MODE_PAIR_PARALLEL,
    PAIR_CONCURRENCY_LIMIT,
)
from aaw_skill_eval.services.orchestration.scheduling import claim_run
from aaw_skill_eval.services.providers import ChrysJudge, ChrysRunner
from aaw_skill_eval.services.providers.base import RunOutcome
from aaw_skill_eval.services.providers.chrys.runtime import (
    RUNNER_PROFILE_NAME,
    materialize_run_chrys_home,
    prepare_experiment_chrys_template,
    prepare_isolated_home,
)
from aaw_skill_eval.services.providers.protocols.acp import AcpSession, AcpTurnResult

# --------------------------------------------------------------------- helpers


def _case(case_id: str) -> dict:
    return {
        "id": case_id,
        "name": f"Case {case_id}",
        "input": "Create result.md",
        "expected": "A useful result.md must exist",
        "weight": 1,
        "agent_context": "",
        "followups": [],
        "max_turns": 6,
        "graders": [
            {
                "id": "result-file",
                "type": "file_exists",
                "name": "Result file exists",
                "weight": 0,
                "hard_gate": True,
                "path": "result.md",
                "patterns": [],
                "timeout_seconds": 300,
            },
            {
                "id": "quality",
                "type": "llm_rubric",
                "name": "Quality",
                "weight": 100,
                "hard_gate": False,
                "rubric": "Judge quality",
                "timeout_seconds": 300,
            },
        ],
    }


def _suite(client: TestClient, project: Path, skill: Path, cases: list[dict]) -> dict:
    response = client.post(
        "/api/v1/suites",
        json={
            "name": "Parallel suite",
            "project_path": str(project),
            "skill_path": str(skill),
            "setup": {"commands": [], "preflight": [], "network": False},
            "cases": cases,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def _experiment(
    client: TestClient,
    suite_id: str,
    *,
    mode: str = "quick",
    name: str = "parallel-fixture",
    profile: dict | None = None,
) -> str:
    body_profile = {
        "name": name,
        "runner_model": "fixture-model",
        "judge_model": "fixture-model",
        "network": False,
    }
    if profile:
        body_profile.update(profile)
    response = client.post(
        "/api/v1/experiments",
        json={"suite_id": suite_id, "mode": mode, "profile": body_profile},
    )
    assert response.status_code == 202, response.text
    return response.json()["id"]


def _wait(client: TestClient, experiment_id: str, timeout: float = 30.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        item = client.get(f"/api/v1/experiments/{experiment_id}").json()
        if item["status"] in {
            "completed",
            "completed_with_failures",
            "failed",
            "invalid",
            "cancelled",
            "interrupted",
        }:
            return item
        time.sleep(0.05)
    raise AssertionError(f"experiment did not finish: {item['status']}")


def _wait_for_active_runs(
    client: TestClient, experiment_id: str, count: int, timeout: float = 15.0
) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        payload = client.get(f"/api/v1/experiments/{experiment_id}").json()
        if len(payload["progress"]["active_runs"]) >= count:
            return payload
        time.sleep(0.02)
    raise AssertionError(
        f"expected {count} active runs, saw {len(payload['progress']['active_runs'])}"
    )


def _parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _wait_gone(path: Path, timeout: float = 5.0) -> bool:
    """Wait for a directory to disappear.

    The experiment reaches its terminal status slightly before the finally
    block removes the run workspace and the chrys template, and Windows AV
    can briefly hold handles to freshly written files — so deletion is
    asserted with a grace window instead of instantaneously.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not path.exists():
            return True
        time.sleep(0.05)
    return not path.exists()


class PairProbeRunner:
    """FakeRunner wrapper that proves the pair executed simultaneously.

    Both pair runs (no_skill/current) of a case must be inside ``run()`` at
    the same time for the per-case barrier to pass. A serial scheduler would
    time the first run out on the barrier and set ``broken``. Baseline runs
    skip the barrier (they are scheduled after the pair by design).
    """

    def __init__(
        self,
        delegate,
        session_factory,
        *,
        hold: threading.Event | None = None,
        barrier_timeout: float = 15.0,
    ):
        self.delegate = delegate
        self.session_factory = session_factory
        self.hold = hold
        self.barrier_timeout = barrier_timeout
        self._lock = threading.Lock()
        self._barriers: dict[str, threading.Barrier] = {}
        self.active = 0
        self.max_active = 0
        self.entries: list[dict] = []
        self.broken = False

    def _group_for(self, artifact_dir: Path) -> str | None:
        name = artifact_dir.name
        run_id = artifact_dir.parent.name if name.startswith("attempt-") else name
        with self.session_factory() as session:
            run = session.get(Run, run_id)
            return run.group_name if run is not None else None

    def run(
        self,
        *,
        workspace,
        artifact_dir,
        case,
        profile,
        skill_name,
        on_progress=None,
        on_log=None,
        is_cancelled=None,
        chrys_home_root=None,
    ):
        group = self._group_for(Path(artifact_dir))
        entry = {
            "case": case.id,
            "group": group,
            "entered_at": time.monotonic(),
            "workspace": str(workspace),
            "artifact_dir": str(artifact_dir),
            "chrys_home_root": str(chrys_home_root) if chrys_home_root else None,
            "exited_at": None,
        }
        with self._lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            self.entries.append(entry)
        try:
            if group in ("no_skill", "current"):
                with self._lock:
                    barrier = self._barriers.setdefault(case.id, threading.Barrier(2))
                try:
                    barrier.wait(timeout=self.barrier_timeout)
                except threading.BrokenBarrierError:
                    self.broken = True
            if self.hold is not None:
                deadline = time.monotonic() + 30.0
                while not self.hold.is_set() and time.monotonic() < deadline:
                    if is_cancelled is not None and is_cancelled():
                        break
                    time.sleep(0.01)
            return self.delegate.run(
                workspace=workspace,
                artifact_dir=artifact_dir,
                case=case,
                profile=profile,
                skill_name=skill_name,
                on_progress=on_progress,
                on_log=on_log,
                is_cancelled=is_cancelled,
                chrys_home_root=chrys_home_root,
            )
        finally:
            with self._lock:
                self.active -= 1
                entry["exited_at"] = time.monotonic()


# ------------------------------------------------------- database retry helpers


def test_with_lock_retry_retries_locked_errors_with_backoff(monkeypatch):
    import aaw_skill_eval.database as database_module

    attempts = []
    sleeps = []

    # replace the module's time/random references (not the global modules,
    # whose sleep is used by every other thread in the test process); fixing
    # the jitter makes the backoff-growth assertion deterministic
    monkeypatch.setattr(
        database_module,
        "time",
        type("TimeStub", (), {"sleep": staticmethod(lambda delay: sleeps.append(delay))}),
    )
    monkeypatch.setattr(
        database_module,
        "random",
        type("RandomStub", (), {"random": staticmethod(lambda: 0.5)}),
    )

    def flaky():
        attempts.append(1)
        if len(attempts) < 3:
            raise OperationalError("statement", {}, "database is locked")
        return "ok"

    assert with_lock_retry(flaky) == "ok"
    assert len(attempts) == 3
    assert len(sleeps) == 2
    assert all(delay > 0 for delay in sleeps)
    assert sleeps[1] > sleeps[0]  # exponential backoff grows


def test_with_lock_retry_propagates_non_lock_errors_immediately():
    def boom():
        raise OperationalError("statement", {}, "no such table: runs")

    with pytest.raises(OperationalError):
        with_lock_retry(boom)
    assert not is_locked_error(OperationalError("statement", {}, "no such table: runs"))
    assert is_locked_error(OperationalError("statement", {}, "database is locked"))


def test_claim_run_is_atomic_against_concurrent_claims(
    client: TestClient, project: Path, skill: Path
):
    suite = _suite(client, project, skill, [_case("case-1")])
    experiment_id = _experiment(client, suite["id"])
    payload = _wait(client, experiment_id)
    run_id = payload["runs"][0]["id"]
    with client.app.state.session_factory() as session:
        session.execute(update(Run).where(Run.id == run_id).values(status="queued"))
        session.commit()

    results: list[dict | None] = []

    def claim():
        results.append(claim_run(client.app.state.session_factory, run_id))

    threads = [threading.Thread(target=claim) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert sorted(info is not None for info in results) == [False, True]
    claimed = next(info for info in results if info is not None)
    assert claimed["run_id"] == run_id
    # once running, a further claim loses (queued -> running is one-shot)
    assert claim_run(client.app.state.session_factory, run_id) is None


# ------------------------------------------------------- pair-parallel evidence


def test_pair_runs_execute_simultaneously_and_api_reports_both(
    client: TestClient, project: Path, skill: Path
):
    """同步屏障测试：同配对两 Run 曾同时 running（进程内屏障 + API/DB 双证据）。"""
    original = client.app.state.orchestrator.runner
    hold = threading.Event()
    probe = PairProbeRunner(original, client.app.state.session_factory, hold=hold)
    client.app.state.orchestrator.runner = probe

    suite = _suite(client, project, skill, [_case("case-1")])
    experiment_id = _experiment(client, suite["id"])

    live = _wait_for_active_runs(client, experiment_id, count=2)
    # API-level evidence: two active runs, both of the same pair block
    active = live["progress"]["active_runs"]
    assert len(active) == 2
    assert {item["group"] for item in active} == {"no_skill", "current"}
    assert {item["case_id"] for item in active} == {"case-1"}
    assert all(item["stage"] for item in active)
    assert all(item["started_at"] for item in active)
    assert all(item["stalled"] is False for item in active)
    assert all(item["cancel_requested"] is False for item in active)
    # backward compatibility: active_run_id still describes one active run
    assert live["progress"]["active_run_id"] == active[0]["id"]
    assert live["progress"]["running"] == 2
    running_ids = {
        run["id"] for run in live["runs"] if run["status"] == "running"
    }
    assert running_ids == {item["id"] for item in active}

    hold.set()
    finished = _wait(client, experiment_id)

    # In-process evidence: the barrier passed, i.e. both runs of the pair
    # were inside run() at the same moment (a serial run would break it).
    assert probe.broken is False
    assert probe.max_active == 2
    assert len(probe.entries) == 2
    assert {entry["group"] for entry in probe.entries} == {"no_skill", "current"}
    # per-run isolation: workspaces, artifact dirs and log roots differ
    assert len({entry["workspace"] for entry in probe.entries}) == 2
    assert len({entry["artifact_dir"] for entry in probe.entries}) == 2

    assert finished["status"] == "completed"
    assert finished["execution_mode"] == EXECUTION_MODE_PAIR_PARALLEL
    assert finished["concurrency_limit"] == PAIR_CONCURRENCY_LIMIT == 2
    assert all(run["status"] == "completed" for run in finished["runs"])
    assert {run["pair_id"] for run in finished["runs"]} == {"case-1#t1"}
    skews = {run["pair_launch_skew_ms"] for run in finished["runs"]}
    assert len(skews) == 1
    assert 0 <= skews.pop() < 10_000


def test_parallel_pair_wall_clock_beats_serial_sum(
    client: TestClient, project: Path, skill: Path
):
    """墙钟辅助证据：并行配对耗时 ≈ 较慢 Run，而不是两次等待之和。"""
    original = client.app.state.orchestrator.runner

    class SleepingRunner:
        def run(self, **kwargs):
            time.sleep(0.35)
            return original.run(**kwargs)

    probe = PairProbeRunner(
        SleepingRunner(), client.app.state.session_factory, barrier_timeout=15.0
    )
    client.app.state.orchestrator.runner = probe

    suite = _suite(client, project, skill, [_case("case-1")])
    experiment_id = _experiment(client, suite["id"])
    finished = _wait(client, experiment_id)
    assert finished["status"] == "completed"

    assert probe.broken is False and probe.max_active == 2
    durations = [
        entry["exited_at"] - entry["entered_at"] for entry in probe.entries
    ]
    pair_span = max(entry["exited_at"] for entry in probe.entries) - min(
        entry["entered_at"] for entry in probe.entries
    )
    serial_floor = sum(durations)
    assert len(durations) == 2
    assert all(duration >= 0.3 for duration in durations)
    # parallel pair finishes in about one run's time, far below the sum
    assert pair_span < 0.75 * serial_floor, (pair_span, serial_floor)


def test_concurrency_capped_at_two_and_blocks_run_in_order(
    client: TestClient, project: Path, skill: Path
):
    """多个配对块按套件顺序执行，任意时刻最多两个 Agent Run。"""
    original = client.app.state.orchestrator.runner
    probe = PairProbeRunner(original, client.app.state.session_factory)
    client.app.state.orchestrator.runner = probe

    suite = _suite(client, project, skill, [_case("case-1"), _case("case-2")])
    experiment_id = _experiment(client, suite["id"])
    finished = _wait(client, experiment_id)
    assert finished["status"] == "completed"

    assert probe.broken is False
    assert probe.max_active == 2  # pairs overlap, never three runs
    assert len(probe.entries) == 4
    first_block = [entry for entry in probe.entries if entry["case"] == "case-1"]
    second_block = [entry for entry in probe.entries if entry["case"] == "case-2"]
    # block 2 only starts after both runs of block 1 reached a terminal state
    assert max(entry["exited_at"] for entry in first_block) < min(
        entry["entered_at"] for entry in second_block
    )
    assert {run["pair_id"] for run in finished["runs"]} == {
        "case-1#t1",
        "case-2#t1",
    }
    assert all(run["status"] == "completed" for run in finished["runs"])


def test_baseline_runs_after_both_pair_runs_finish(
    client: TestClient, project: Path, skill: Path
):
    """baseline 在配对两 Run 均终态后执行，且不占并发位。"""
    original = client.app.state.orchestrator.runner

    first_suite = _suite(client, project, skill, [_case("case-1")])
    first = _wait(client, _experiment(client, first_suite["id"], name="baseline-prep"))
    revision_a = first["current_revision_id"]
    skill_id = first["skill_id"]

    # a second skill revision becomes the current candidate; revision A is
    # pinned as the baseline
    (skill / "SKILL.md").write_text(
        (skill / "SKILL.md").read_text(encoding="utf-8") + "\nUpdated guidance.\n",
        encoding="utf-8",
    )
    second_suite = _suite(client, project, skill, [_case("case-1")])
    response = client.post(
        f"/api/v1/skills/{skill_id}/baseline", json={"revision_id": revision_a}
    )
    assert response.status_code == 200, response.text

    probe = PairProbeRunner(original, client.app.state.session_factory)
    client.app.state.orchestrator.runner = probe
    experiment_id = _experiment(client, second_suite["id"], name="baseline-fixture")
    finished = _wait(client, experiment_id)

    assert finished["status"] == "completed"
    assert finished["baseline_revision_id"] == revision_a
    runs = finished["runs"]
    assert len(runs) == 3
    assert {run["group"] for run in runs} == {"no_skill", "current", "baseline"}
    assert {run["pair_id"] for run in runs} == {"case-1#t1"}

    pair = [entry for entry in probe.entries if entry["group"] != "baseline"]
    baseline_entries = [entry for entry in probe.entries if entry["group"] == "baseline"]
    assert len(pair) == 2 and len(baseline_entries) == 1
    assert probe.max_active == 2  # baseline alone never runs beside the pair
    assert max(entry["exited_at"] for entry in pair) < baseline_entries[0]["entered_at"]

    baseline_run = next(run for run in runs if run["group"] == "baseline")
    pair_runs = [run for run in runs if run["group"] != "baseline"]
    assert _parse_ts(baseline_run["started_at"]) >= max(
        _parse_ts(run["completed_at"]) for run in pair_runs
    )
    # blind scoring: baseline installs the skill snapshot like current
    assert finished["scores"] == {
        "no_skill": 55,
        "baseline": 88,
        "current": 88,
    }


def test_pair_failure_does_not_stop_partner_or_later_blocks(
    client: TestClient, project: Path, skill: Path
):
    """一个 Run 失败时配对另一个继续，后续配对块照常调度。"""
    original = client.app.state.orchestrator.runner
    failed: set[str] = set()

    class FailFirstNoSkillRunner:
        def run(self, *, case, skill_name, **kwargs):
            if skill_name is None and case.id == "case-1" and case.id not in failed:
                failed.add(case.id)
                return RunOutcome(
                    exit_code=None,
                    final_response="",
                    events=[],
                    duration_ms=25,
                    error_kind="infra_error",
                    error_message="fixture pair failure",
                )
            return original.run(case=case, skill_name=skill_name, **kwargs)

    client.app.state.orchestrator.runner = FailFirstNoSkillRunner()
    suite = _suite(client, project, skill, [_case("case-1"), _case("case-2")])
    experiment_id = _experiment(client, suite["id"], name="failure-fixture")
    finished = _wait(client, experiment_id)

    assert finished["status"] == "completed_with_failures"
    runs = {(run["case_id"], run["group"]): run for run in finished["runs"]}
    failed_run = runs[("case-1", "no_skill")]
    partner_run = runs[("case-1", "current")]
    assert failed_run["status"] == "infra_error"
    assert failed_run["error_message"] == "fixture pair failure"
    assert partner_run["status"] == "completed"
    assert runs[("case-2", "no_skill")]["status"] == "completed"
    assert runs[("case-2", "current")]["status"] == "completed"
    # the next block only started after both runs of block 1 finished
    assert _parse_ts(runs[("case-2", "no_skill")]["started_at"]) >= _parse_ts(
        failed_run["completed_at"]
    )
    assert _parse_ts(runs[("case-2", "no_skill")]["started_at"]) >= _parse_ts(
        partner_run["completed_at"]
    )


def test_cancelling_one_active_run_leaves_partner_running(
    client: TestClient, project: Path, skill: Path
):
    """取消单个 Run 不影响配对另一个。"""
    original = client.app.state.orchestrator.runner
    release = threading.Event()

    class BlockingRunner:
        def run(self, **kwargs):
            deadline = time.monotonic() + 30.0
            while time.monotonic() < deadline:
                if kwargs["is_cancelled"] is not None and kwargs["is_cancelled"]():
                    return RunOutcome(
                        exit_code=None,
                        final_response="",
                        events=[],
                        duration_ms=50,
                        error_kind="cancelled",
                        error_message="Run cancelled by user",
                    )
                if release.is_set():
                    break
                time.sleep(0.01)
            return original.run(**kwargs)

    client.app.state.orchestrator.runner = BlockingRunner()
    suite = _suite(client, project, skill, [_case("case-1")])
    experiment_id = _experiment(client, suite["id"], name="cancel-run-fixture")

    live = _wait_for_active_runs(client, experiment_id, count=2)
    active = live["progress"]["active_runs"]
    victim = active[0]["id"]
    survivor = next(item["id"] for item in active if item["id"] != victim)

    cancelled = client.post(f"/api/v1/runs/{victim}/cancel")
    assert cancelled.status_code == 202, cancelled.text

    # the partner keeps running while the cancelled run winds down
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        payload = client.get(f"/api/v1/experiments/{experiment_id}").json()
        statuses = {run["id"]: run["status"] for run in payload["runs"]}
        if statuses[victim] == "cancelled":
            break
        time.sleep(0.02)
    assert statuses[victim] == "cancelled"
    assert statuses[survivor] == "running", statuses

    release.set()
    finished = _wait(client, experiment_id)
    final = {run["id"]: run["status"] for run in finished["runs"]}
    assert final[victim] == "cancelled"
    assert final[survivor] == "completed"
    assert finished["status"] == "completed_with_failures"


def test_cancelling_experiment_stops_pair_and_skips_later_blocks(
    client: TestClient, project: Path, skill: Path
):
    """取消实验：两个活动 Run 都收到通知，后续配对块不再派发。"""
    original = client.app.state.orchestrator.runner

    class BlockingRunner:
        def run(self, **kwargs):
            deadline = time.monotonic() + 30.0
            while time.monotonic() < deadline:
                if kwargs["is_cancelled"] is not None and kwargs["is_cancelled"]():
                    return RunOutcome(
                        exit_code=None,
                        final_response="",
                        events=[],
                        duration_ms=50,
                        error_kind="cancelled",
                        error_message="Run cancelled by user",
                    )
                time.sleep(0.01)
            return original.run(**kwargs)

    client.app.state.orchestrator.runner = BlockingRunner()
    suite = _suite(client, project, skill, [_case("case-1"), _case("case-2")])
    experiment_id = _experiment(client, suite["id"], name="cancel-exp-fixture")

    live = _wait_for_active_runs(client, experiment_id, count=2)
    assert live["progress"]["running"] == 2

    cancelled = client.post(f"/api/v1/experiments/{experiment_id}/cancel")
    assert cancelled.status_code == 202, cancelled.text

    finished = _wait(client, experiment_id)
    assert finished["status"] == "cancelled"
    statuses = {run["group"] + "@" + run["case_id"]: run for run in finished["runs"]}
    assert len(finished["runs"]) == 4
    for key, run in statuses.items():
        assert run["status"] == "cancelled", (key, run)
    dispatched = [run for run in finished["runs"] if run["started_at"]]
    skipped = [run for run in finished["runs"] if not run["started_at"]]
    assert len(dispatched) == 2  # only the active pair was ever started
    assert {run["case_id"] for run in dispatched} == {"case-1"}
    assert {run["case_id"] for run in skipped} == {"case-2"}
    assert all(
        run["error_message"] == "Experiment cancelled before this run started"
        for run in skipped
    )


def test_service_restart_marks_both_active_runs_interrupted(
    client: TestClient, project: Path, skill: Path
):
    """服务重启时两个活动 Run 都标记为基础设施中断。"""
    from aaw_skill_eval.jobs import mark_service_restart

    suite = _suite(client, project, skill, [_case("case-1")])
    experiment_id = _experiment(client, suite["id"], name="restart-fixture")
    _wait(client, experiment_id)

    # simulate an interrupted pair: both runs of the block back to running
    with client.app.state.session_factory() as session:
        session.execute(
            update(Run)
            .where(Run.experiment_id == experiment_id)
            .values(status="running", completed_at=None)
        )
        session.execute(
            update(Experiment)
            .where(Experiment.id == experiment_id)
            .values(status="running", completed_at=None)
        )
        session.commit()

    mark_service_restart(client.app.state.session_factory)

    payload = client.get(f"/api/v1/experiments/{experiment_id}").json()
    assert payload["status"] == "interrupted"
    assert payload["error_kind"] == "infra_error"
    assert len(payload["runs"]) == 2
    assert all(run["status"] == "infra_error" for run in payload["runs"])
    assert all(run["error_message"] == "Service restarted" for run in payload["runs"])


def test_execution_metadata_and_legacy_compatibility(
    client: TestClient, project: Path, skill: Path
):
    """并行元数据随实验保存；旧记录缺字段时按缺失呈现，不补造。"""
    suite = _suite(client, project, skill, [_case("case-1")])
    experiment_id = _experiment(client, suite["id"], name="metadata-fixture")
    finished = _wait(client, experiment_id)
    assert finished["execution_mode"] == EXECUTION_MODE_PAIR_PARALLEL
    assert finished["concurrency_limit"] == 2
    assert all(
        run["pair_id"] == "case-1#t1" and run["pair_launch_skew_ms"] is not None
        for run in finished["runs"]
    )

    # simulate a legacy experiment: the new columns are NULL
    with client.app.state.session_factory() as session:
        session.execute(
            update(Experiment)
            .where(Experiment.id == experiment_id)
            .values(execution_mode=None, concurrency_limit=None)
        )
        session.execute(
            update(Run)
            .where(Run.experiment_id == experiment_id)
            .values(pair_id=None, pair_launch_skew_ms=None)
        )
        session.commit()
    legacy = client.get(f"/api/v1/experiments/{experiment_id}").json()
    assert legacy["execution_mode"] is None
    assert legacy["concurrency_limit"] is None
    assert all(
        run["pair_id"] is None and run["pair_launch_skew_ms"] is None
        for run in legacy["runs"]
    )
    assert legacy["scores"]["current"] == 88  # scoring unaffected


def test_resumed_interrupted_experiment_runs_pending_baseline(
    client: TestClient, project: Path, skill: Path
):
    """恢复被中断的实验：已终态的配对不重跑，仍排队的 baseline 继续执行。"""
    first_suite = _suite(client, project, skill, [_case("case-1")])
    first = _wait(client, _experiment(client, first_suite["id"], name="resume-prep"))
    revision_a = first["current_revision_id"]
    (skill / "SKILL.md").write_text(
        (skill / "SKILL.md").read_text(encoding="utf-8") + "\nResume revision.\n",
        encoding="utf-8",
    )
    second_suite = _suite(client, project, skill, [_case("case-1")])
    assert (
        client.post(
            f"/api/v1/skills/{first['skill_id']}/baseline",
            json={"revision_id": revision_a},
        ).status_code
        == 200
    )
    experiment_id = _experiment(client, second_suite["id"], name="resume-fixture")
    _wait(client, experiment_id)

    # simulate a service interruption in the middle of the block: the pair
    # was marked infra_error, the baseline never started
    with client.app.state.session_factory() as session:
        session.execute(
            update(Run)
            .where(Run.experiment_id == experiment_id, Run.group_name != "baseline")
            .values(status="infra_error", error_kind="infra_error")
        )
        session.execute(
            update(Run)
            .where(Run.experiment_id == experiment_id, Run.group_name == "baseline")
            .values(status="queued", started_at=None, completed_at=None)
        )
        session.execute(
            update(Experiment)
            .where(Experiment.id == experiment_id)
            .values(status="interrupted", completed_at=None)
        )
        session.commit()

    client.app.state.orchestrator.execute(experiment_id)

    payload = client.get(f"/api/v1/experiments/{experiment_id}").json()
    assert payload["status"] == "completed_with_failures"
    baseline = next(run for run in payload["runs"] if run["group"] == "baseline")
    pair = [run for run in payload["runs"] if run["group"] != "baseline"]
    assert baseline["status"] == "completed"
    assert all(run["status"] == "infra_error" for run in pair)  # not re-executed


# --------------------------------------------------------- mode combinations


def test_formal_mode_creates_paired_trials_with_correct_scores(
    client: TestClient, project: Path, skill: Path
):
    """正式模式：3 trial × 2 组 = 6 个 Run，按 trial 配对并行，分数取均值。"""
    original = client.app.state.orchestrator.runner
    probe = PairProbeRunner(original, client.app.state.session_factory)
    client.app.state.orchestrator.runner = probe

    suite = _suite(client, project, skill, [_case("case-1")])
    experiment_id = _experiment(client, suite["id"], mode="formal", name="formal-fixture")
    finished = _wait(client, experiment_id, timeout=60.0)

    assert finished["status"] == "completed"
    assert finished["trials"] == 3
    assert len(finished["runs"]) == 6
    assert probe.broken is False
    assert probe.max_active == 2

    by_pair: dict[str, list[dict]] = {}
    for run in finished["runs"]:
        by_pair.setdefault(run["pair_id"], []).append(run)
    assert set(by_pair) == {"case-1#t1", "case-1#t2", "case-1#t3"}
    for pair_id, runs in by_pair.items():
        assert {run["group"] for run in runs} == {"no_skill", "current"}, pair_id
        # both runs of the trial were running at the same time
        first, second = runs
        assert _parse_ts(second["started_at"]) <= _parse_ts(first["completed_at"])
        assert _parse_ts(first["started_at"]) <= _parse_ts(second["completed_at"])

    # blocks run strictly in trial order
    for earlier, later in zip(sorted(by_pair), sorted(by_pair)[1:], strict=False):
        assert min(
            _parse_ts(run["started_at"]) for run in by_pair[later]
        ) >= max(_parse_ts(run["completed_at"]) for run in by_pair[earlier])

    assert finished["scores"] == {"no_skill": 55, "baseline": None, "current": 88}
    assert finished["delta_no_skill"] == 33


def test_quick_mode_with_baseline_combines_three_groups(
    client: TestClient, project: Path, skill: Path
):
    """快速模式 + baseline：1 trial × 3 组 = 3 个 Run。"""
    first_suite = _suite(client, project, skill, [_case("case-1")])
    first = _wait(client, _experiment(client, first_suite["id"], name="quick-prep"))
    revision_a = first["current_revision_id"]
    (skill / "SKILL.md").write_text(
        (skill / "SKILL.md").read_text(encoding="utf-8") + "\nSecond revision.\n",
        encoding="utf-8",
    )
    second_suite = _suite(client, project, skill, [_case("case-1")])
    assert (
        client.post(
            f"/api/v1/skills/{first['skill_id']}/baseline",
            json={"revision_id": revision_a},
        ).status_code
        == 200
    )
    experiment_id = _experiment(client, second_suite["id"], name="quick-baseline")
    finished = _wait(client, experiment_id)

    assert finished["mode"] == "quick"
    assert finished["trials"] == 1
    assert len(finished["runs"]) == 3
    assert {run["group"] for run in finished["runs"]} == {
        "no_skill",
        "baseline",
        "current",
    }
    assert finished["scores"] == {"no_skill": 55, "baseline": 88, "current": 88}


# ----------------------------------------------------- chrys per-run isolation


def test_chrys_template_and_per_run_homes(tmp_path: Path):
    settings = Settings(
        data_dir=tmp_path / "data",
        chrys_home=tmp_path / "chrys",
        chrys_command="missing-chrys-for-test",
    )
    (tmp_path / "chrys" / "agents").mkdir(parents=True)

    template = prepare_experiment_chrys_template(settings, "exp-1")
    assert template == settings.data_dir / "chrys-templates" / "exp-1"
    agents = template / "chrys" / "agents"
    assert (agents / f"{RUNNER_PROFILE_NAME}.yaml").is_file()
    # legacy shared home is not touched by template preparation
    assert not (settings.data_dir / "chrys-isolated").exists()

    run_a = tmp_path / "runs" / "a"
    run_b = tmp_path / "runs" / "b"
    home_a = materialize_run_chrys_home(template, run_a)
    home_b = materialize_run_chrys_home(template, run_b)
    assert home_a == run_a / "chrys-home" and home_b == run_b / "chrys-home"
    assert home_a != home_b
    for home in (home_a, home_b):
        assert (home / "chrys" / "agents" / f"{RUNNER_PROFILE_NAME}.yaml").is_file()
    assert materialize_run_chrys_home(None, run_a) is None


def test_chrys_experiment_gives_each_run_private_config_home(
    client: TestClient, project: Path, skill: Path, monkeypatch
):
    """Chrys 实验：模板生成一次，每个 Run 复制出独立配置目录并在结束后清理。"""
    import aaw_skill_eval.services.orchestration.execution as execution_module
    import aaw_skill_eval.services.orchestration.prepare as prepare_module

    monkeypatch.setattr(prepare_module, "enrich_profile", lambda settings, profile: profile)
    monkeypatch.setattr(prepare_module, "verify_profile", lambda settings, profile: None)
    monkeypatch.setattr(execution_module, "verify_profile", lambda settings, profile: None)

    original = client.app.state.orchestrator.runner
    captured: list[dict] = []

    class CapturingRunner:
        def run(self, **kwargs):
            # record the per-run isolation state while the run is alive:
            # successful runs are cleaned up afterwards by design
            root = kwargs["chrys_home_root"]
            marker = (
                Path(root) / "chrys" / "agents" / f"{RUNNER_PROFILE_NAME}.yaml"
                if root is not None
                else None
            )
            captured.append(
                {
                    "root": str(root) if root is not None else None,
                    "workspace": str(kwargs["workspace"]),
                    "marker_ok": marker.is_file() if marker is not None else False,
                }
            )
            return original.run(**kwargs)

    client.app.state.orchestrator.runner = CapturingRunner()

    suite = _suite(client, project, skill, [_case("case-1")])
    experiment_id = _experiment(
        client,
        suite["id"],
        name="chrys-fixture",
        profile={"runner_provider": "chrys", "judge_provider": "chrys"},
    )
    finished = _wait(client, experiment_id)
    assert finished["status"] == "completed"

    assert len(captured) == 2
    roots = [item["root"] for item in captured]
    assert all(root is not None for root in roots)
    assert len(set(roots)) == 2  # distinct config home per run
    assert all(item["marker_ok"] for item in captured)
    # workspaces stay per-run as well
    assert len({item["workspace"] for item in captured}) == 2

    settings = client.app.state.settings
    # successful runs and the experiment template are cleaned up afterwards
    assert _wait_gone(settings.data_dir / "chrys-templates" / experiment_id)
    for root in roots:
        assert _wait_gone(Path(root))


def test_chrys_runner_and_judge_receive_per_run_config_root(tmp_path: Path, monkeypatch):
    import aaw_skill_eval.services.providers.chrys.runner as runner_module

    captured: list[dict] = []
    judge_payload = (
        '{"candidate_id":"candidate-1","scores":[{"grader_id":"quality",'
        '"score":90,"evidence":"e","reasoning":"r"}]}'
    )

    class StubAcpSession:
        def __init__(self, **kwargs):
            captured.append(kwargs)
            self.skills_loaded = []

        def start(self):
            pass

        def initialize(self):
            pass

        def new_session(self, cwd):
            return "session-1"

        def ensure_model(self, model):
            return model

        def prompt(self, text, **kwargs):
            if "盲评 Judge" in text:
                return AcpTurnResult(stop_reason="end_turn", text=judge_payload)
            return AcpTurnResult(stop_reason="end_turn", text="runner ok")

        def close(self):
            pass

    monkeypatch.setattr(runner_module, "AcpSession", StubAcpSession)
    settings = Settings(
        data_dir=tmp_path / "data",
        chrys_home=tmp_path / "chrys",
        chrys_command="missing-chrys-for-test",
    )
    profile = EvalProfile(name="chrys", runner_model="m", judge_model="m")
    case = CaseSpec.model_validate(_case("case-1"))
    per_run_root = tmp_path / "run-root" / "chrys-home"

    ChrysRunner(settings).run(
        workspace=tmp_path / "ws",
        artifact_dir=tmp_path / "artifacts",
        case=case,
        profile=profile,
        skill_name=None,
        chrys_home_root=per_run_root,
    )
    assert captured[0]["isolated_root"] == per_run_root

    judge = ChrysJudge(settings)
    outcome = judge.evaluate(
        anonymous_id="candidate-1",
        case=case,
        graders=case.graders,
        evidence={"final_response": "completed with skill"},
        profile=profile,
        artifact_dir=tmp_path / "artifacts",
        chrys_home_root=per_run_root,
    )
    assert captured[1]["isolated_root"] == per_run_root
    assert outcome.error is None
    assert [score.grader_id for score in outcome.scores] == ["quality"]


def test_acp_session_uses_provided_root_without_shared_home(tmp_path: Path, monkeypatch):
    """提供 isolated_root 时直接使用，绝不改写共享 chrys-isolated 目录。"""
    import aaw_skill_eval.services.providers.chrys.runtime as chrys_module
    import aaw_skill_eval.services.providers.protocols.acp.session as acp_module

    def forbidden(*args, **kwargs):
        raise AssertionError("shared chrys-isolated home must not be prepared")

    monkeypatch.setattr(chrys_module, "prepare_isolated_home", forbidden)

    spawned: list[dict] = []

    class FakeProcess:
        def __init__(self):
            self.pid = 4242
            self.stdin = io.BytesIO()
            self.stdout = io.BytesIO(b"")
            self.stderr = io.BytesIO(b"")
            self.returncode = 0

        def poll(self):
            return 0

    def fake_popen(command, **kwargs):
        spawned.append(kwargs)
        return FakeProcess()

    monkeypatch.setattr(acp_module.subprocess, "Popen", fake_popen)

    per_run_root = tmp_path / "runs" / "abc" / "chrys-home"
    session = AcpSession(
        command=["chrys", "acp"],
        env={"APPDATA": str(per_run_root)},
        agent_profile=RUNNER_PROFILE_NAME,
        cwd=tmp_path,
        artifact_dir=tmp_path,
        isolated_root=per_run_root,
    )
    session.start()
    session.close()

    assert per_run_root.is_dir()
    assert spawned[0]["env"]["APPDATA"] == str(per_run_root)


def test_prepare_isolated_home_still_supports_shared_root(tmp_path: Path):
    """默认（无 root 参数）仍生成共享隔离目录，兼容既有调用。"""
    settings = Settings(
        data_dir=tmp_path / "data",
        chrys_home=tmp_path / "chrys",
        chrys_command="missing-chrys-for-test",
    )
    root = prepare_isolated_home(settings)
    assert root == settings.data_dir / "chrys-isolated"
    assert (root / "chrys" / "agents").is_dir()
