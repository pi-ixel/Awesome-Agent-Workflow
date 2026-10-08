from __future__ import annotations

import threading
from pathlib import Path

from sqlalchemy import select, update
from sqlalchemy.orm import Session, sessionmaker

from ...database import with_lock_retry
from ...models import Experiment, Run, SkillRevision
from ...schemas import EvalProfile
from ..observability.logs import LogWriter
from .progress import now

# no_skill/current pair-parallel execution (方案第五部分): the scheduling unit
# is one (case_id, trial_index) block whose no_skill and current runs launch
# together, capped at two concurrent agent runs per experiment. Baseline runs
# of a block execute after both pair runs reach a terminal state and do not
# occupy a concurrency slot.
EXECUTION_MODE_PAIR_PARALLEL = "pair_parallel_v1"
PAIR_CONCURRENCY_LIMIT = 2


def db_write(session_factory: sessionmaker[Session], work):
    """Run one session transaction with bounded retry on SQLite locks.

    Every execution thread opens its own short-lived session (the factory
    is thread-safe and pooled), so the two runs of a pair never share a
    session; this wrapper only adds lock-error resilience.
    """

    def attempt():
        with session_factory() as session:
            result = work(session)
            session.commit()
            return result

    return with_lock_retry(attempt)


def experiment_cancelled(
    session_factory: sessionmaker[Session], experiment_id: str
) -> bool:
    with session_factory() as session:
        experiment = session.get(Experiment, experiment_id)
        return bool(experiment is None or experiment.cancel_requested_at)


def ordered_blocks(
    session_factory: sessionmaker[Session], experiment_id: str, definition: dict
) -> list[dict]:
    """Group still-queued runs into (case, trial) blocks in suite order.

    Each block carries the pair runs (no_skill/current, launched in
    parallel) and the baseline runs (executed after the pair, outside the
    concurrency slots). Runs that already reached a terminal state — for
    example a re-executed interrupted experiment — are skipped.
    """
    case_order = {data["id"]: index for index, data in enumerate(definition["cases"])}
    with session_factory() as session:
        runs = list(
            session.scalars(
                select(Run).where(
                    Run.experiment_id == experiment_id, Run.status == "queued"
                )
            )
        )
    blocks: dict[tuple[int, int], dict] = {}
    for run in runs:
        key = (case_order.get(run.case_id, len(case_order)), run.trial_index)
        block = blocks.setdefault(
            key, {"pair": [], "baseline": [], "pair_id": run.pair_id}
        )
        if run.group_name == "baseline":
            block["baseline"].append(run.id)
        else:
            block["pair"].append((0 if run.group_name == "no_skill" else 1, run.id))
    ordered = []
    for key in sorted(blocks):
        block = blocks[key]
        block["pair"] = [run_id for _, run_id in sorted(block["pair"])]
        ordered.append(block)
    return ordered


def claim_run(session_factory: sessionmaker[Session], run_id: str) -> dict | None:
    """Atomically claim a queued run (queued -> running) and snapshot it.

    The conditional UPDATE makes the claim safe under concurrency: if two
    threads (or a retry racing the scheduler) try to claim the same run,
    exactly one UPDATE matches and the loser sees rowcount 0.
    """
    timestamp = now()

    def work(session: Session) -> dict | None:
        claimed = session.execute(
            update(Run)
            .where(Run.id == run_id, Run.status == "queued")
            .values(
                status="running",
                current_stage="creating_workspace",
                started_at=timestamp,
                stage_started_at=timestamp,
                last_activity_at=timestamp,
                last_heartbeat_at=timestamp,
            )
            .execution_options(synchronize_session=False)
        )
        if claimed.rowcount != 1:
            session.rollback()
            return None
        run = session.get(Run, run_id)
        assert run is not None
        return {
            "run_id": run.id,
            "experiment_id": run.experiment_id,
            "case_id": run.case_id,
            "group": run.group_name,
            "trial_index": run.trial_index,
            "anonymous_id": run.anonymous_id,
            "attempt": run.current_attempt,
            "pair_id": run.pair_id,
            "started_at": timestamp,
        }

    return db_write(session_factory, work)


def run_block(
    block: dict,
    experiment_id: str,
    base: Path,
    current: SkillRevision,
    baseline: SkillRevision | None,
    profile: EvalProfile,
    definition: dict,
    chrys_template: Path | None,
    experiment_log: LogWriter,
    *,
    settings,
    session_factory: sessionmaker[Session],
    runner=None,
    judge=None,
) -> None:
    """Execute one (case, trial) block: pair in parallel, then baseline."""
    # Deferred import to break the import cycle: execution.py imports this
    # module at load time (claim_run/db_write/constants), while the block
    # runner needs the execution functions below.
    from .execution import execute_claimed_run_safely, execute_run

    pair_ids = block["pair"]
    claimed = [
        info
        for info in (claim_run(session_factory, run_id) for run_id in pair_ids)
        if info
    ]
    if not claimed:
        # Nothing to launch in parallel — the pair runs are already
        # terminal (e.g. a resumed interrupted experiment) or were
        # cancelled while queued. The baseline of the block may still be
        # pending and does not depend on the pair results.
        if block["baseline"] and not experiment_cancelled(session_factory, experiment_id):
            for run_id in block["baseline"]:
                execute_run(
                    settings,
                    session_factory,
                    runner,
                    judge,
                    run_id,
                    base,
                    current,
                    baseline,
                    profile,
                    definition,
                    chrys_template,
                )
        return
    label = block["pair_id"] or f"{claimed[0]['case_id']}#t{claimed[0]['trial_index']}"
    if len(claimed) == 2:
        record_pair_launch(session_factory, claimed, experiment_log, label)
    threads = []
    for info in claimed:
        thread = threading.Thread(
            target=execute_claimed_run_safely,
            args=(
                settings,
                session_factory,
                runner,
                judge,
                info,
                base,
                current,
                baseline,
                profile,
                definition,
                chrys_template,
            ),
            name=f"skill-eval-run-{info['run_id'][:8]}",
            daemon=True,
        )
        threads.append(thread)
    for thread in threads:
        thread.start()
    # Both runs must reach a terminal state before the baseline of this
    # block or the next pair block is dispatched (方案第五部分).
    for thread in threads:
        thread.join()
    if not block["baseline"]:
        return
    if experiment_cancelled(session_factory, experiment_id):
        experiment_log.event(
            "system", f"实验已取消，跳过配对块 {label} 的 baseline", stage="cancelled"
        )
        return
    experiment_log.event(
        "system", f"配对块 {label} 两个 Run 均已终态，开始 baseline", stage="running"
    )
    for run_id in block["baseline"]:
        execute_run(
            settings,
            session_factory,
            runner,
            judge,
            run_id,
            base,
            current,
            baseline,
            profile,
            definition,
            chrys_template,
        )


def record_pair_launch(
    session_factory: sessionmaker[Session],
    claimed: list[dict],
    experiment_log: LogWriter,
    label: str,
) -> None:
    first, second = claimed
    skew_ms = int(
        abs((second["started_at"] - first["started_at"]).total_seconds() * 1000)
    )
    run_ids = [first["run_id"], second["run_id"]]

    def work(session: Session) -> None:
        for run_id in run_ids:
            run = session.get(Run, run_id)
            if run is not None:
                run.pair_launch_skew_ms = skew_ms

    db_write(session_factory, work)
    experiment_log.event(
        "system",
        f"配对块 {label}：no_skill 与 current 已并行启动"
        f"（并发上限 {PAIR_CONCURRENCY_LIMIT}，两 Run 启动时差 {skew_ms}ms）",
        stage="running",
    )
