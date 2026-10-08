from __future__ import annotations

import json
import shutil
import time
from pathlib import Path

from sqlalchemy.orm import Session, sessionmaker

from ...config import Settings
from ...errors import EvalError, InfrastructureError
from ...models import Experiment, Run, RunAttempt, RunProgressEvent, SkillRevision, Suite
from ...schemas import CaseSpec, EvalProfile, SetupSpec
from ..catalog.skills import install_snapshot, prepare_eval_workspace
from ..evaluation.graders import (
    evaluate_deterministic,
    execution_time_component,
    merge_scores,
)
from ..observability.logs import LogWriter
from ..providers import build_judge, build_runner
from ..providers.chrys.runtime import (
    materialize_run_chrys_home,
    prepare_experiment_chrys_template,
    verify_profile,
)
from ..storage.artifacts import archive_untracked, canonical_json, write_json
from ..workspace.paths import experiment_workspace, run_workspace
from ..workspace.repository import (
    capture_changes,
    clone_at_commit,
    file_tree_manifest,
    inspect_clean_project,
)
from .prepare import prepare_base, prepare_experiment
from .progress import RunProgress, now
from .scheduling import (
    EXECUTION_MODE_PAIR_PARALLEL,
    PAIR_CONCURRENCY_LIMIT,
    claim_run,
    db_write,
    experiment_cancelled,
    ordered_blocks,
    run_block,
)


def remove_tree_with_retry(path: Path, *, attempts: int = 3, delay: float = 0.2) -> None:
    """Best-effort directory removal with a short retry for Windows.

    Antivirus software briefly holds handles to freshly written files (the
    chrys template is written moments earlier), which can make a single
    rmtree leave files behind. Retrying a couple of times keeps stale
    template directories from accumulating; the final attempt still ignores
    errors because a leftover template is harmless (it is regenerated per
    experiment id).
    """
    for attempt in range(attempts):
        shutil.rmtree(path, ignore_errors=True)
        if not path.exists():
            return
        if attempt < attempts - 1:
            time.sleep(delay)


def execute(
    settings: Settings,
    session_factory: sessionmaker[Session],
    runner,
    judge,
    experiment_id: str,
) -> None:
    with session_factory() as session:
        experiment = session.get(Experiment, experiment_id)
        if experiment is None or experiment.status not in {"queued", "interrupted"}:
            return
        experiment.status = "preparing"
        experiment.started_at = now()
        session.commit()
        suite = session.get(Suite, experiment.suite_id)
        assert suite is not None
        definition = json.loads(experiment.suite_snapshot_json)
        profile = EvalProfile.model_validate_json(experiment.profile_json)
        current = session.get(SkillRevision, experiment.current_revision_id)
        baseline = (
            session.get(SkillRevision, experiment.baseline_revision_id)
            if experiment.baseline_revision_id
            else None
        )
        assert current is not None
        _ = current.skill.name
        if baseline is not None:
            _ = baseline.skill.name

    root = experiment_workspace(settings, experiment_id)
    base = root / "base"
    experiment_log = LogWriter(
        settings.artifacts_dir / experiment_id / "logs",
        scope="experiment",
    )
    experiment_log.event("system", "实验开始准备")
    chrys_template: Path | None = None
    try:
        chrys_template = prepare_experiment(
            settings,
            session_factory,
            experiment_id,
            root=root,
            base=base,
            experiment=experiment,
            suite=suite,
            definition=definition,
            profile=profile,
            has_baseline=baseline is not None,
            experiment_log=experiment_log,
        )
        with session_factory() as session:
            item = session.get(Experiment, experiment_id)
            assert item is not None
            item.status = "running"
            item.execution_mode = EXECUTION_MODE_PAIR_PARALLEL
            item.concurrency_limit = PAIR_CONCURRENCY_LIMIT
            session.commit()
        experiment_log.event(
            "system",
            f"运行队列已创建，按 (case, trial) 配对并行执行"
            f"（单实验并发上限 {PAIR_CONCURRENCY_LIMIT}）",
            stage="running",
        )
        for block in ordered_blocks(session_factory, experiment_id, definition):
            if experiment_cancelled(session_factory, experiment_id):
                experiment_log.event(
                    "system", "实验已取消，停止派发后续配对块", stage="cancelled"
                )
                break
            run_block(
                block,
                experiment_id,
                base,
                current,
                baseline,
                profile,
                definition,
                chrys_template,
                experiment_log,
                settings=settings,
                session_factory=session_factory,
                runner=runner,
                judge=judge,
            )
        finish_experiment(settings, session_factory, experiment_id)
    except EvalError as exc:
        experiment_log.event("system", f"实验准备失败：{exc.kind} · {exc.message}", stage="failed")
        fail_experiment(settings, session_factory, experiment_id, exc.kind, exc.message)
    except Exception as exc:
        experiment_log.event(
            "system", f"实验基础设施异常：{type(exc).__name__}: {exc}", stage="failed"
        )
        fail_experiment(
            settings, session_factory, experiment_id, "infra_error", f"{type(exc).__name__}: {exc}"
        )
    finally:
        if chrys_template is not None:
            remove_tree_with_retry(chrys_template)
        shutil.rmtree(base, ignore_errors=True)


def execute_retry(
    settings: Settings,
    session_factory: sessionmaker[Session],
    runner,
    judge,
    run_id: str,
) -> None:
    with session_factory() as session:
        run = session.get(Run, run_id)
        if run is None or run.status != "queued" or run.current_attempt != 2:
            return
        experiment = session.get(Experiment, run.experiment_id)
        assert experiment is not None
        suite = session.get(Suite, experiment.suite_id)
        assert suite is not None
        definition = json.loads(experiment.suite_snapshot_json)
        profile = EvalProfile.model_validate_json(experiment.profile_json)
        current = session.get(SkillRevision, experiment.current_revision_id)
        baseline = (
            session.get(SkillRevision, experiment.baseline_revision_id)
            if experiment.baseline_revision_id
            else None
        )
        assert current is not None
        _ = current.skill.name
        if baseline is not None:
            _ = baseline.skill.name
        experiment.status = "running"
        session.commit()

    base = run_workspace(
        settings, experiment.id, run.id, run.current_attempt
    ) / "workspace"
    experiment_log = LogWriter(
        settings.artifacts_dir / experiment.id / "logs",
        scope="experiment",
    )
    experiment_log.event(
        "system",
        f"正在为 run {run.id[:8]} 准备正式重试 #{run.current_attempt}",
        stage="retry_preparing",
    )
    try:
        verify_profile(settings, profile)
        snapshot = inspect_clean_project(suite.project_path)
        if snapshot.commit != experiment.project_commit:
            raise EvalError(
                "PROJECT_MOVED",
                "Project HEAD changed after the experiment; create a new experiment",
            )
        clone_at_commit(snapshot, base)
        setup = SetupSpec.model_validate(definition.get("setup") or {})
        setup_log = prepare_base(base, setup, log_writer=experiment_log)
        write_json(
            settings.artifacts_dir
            / experiment.id
            / run.id
            / f"retry-setup-{run.current_attempt}.json",
            setup_log,
        )
        chrys_template: Path | None = None
        if profile.runner_provider == "chrys" or profile.judge_provider == "chrys":
            chrys_template = prepare_experiment_chrys_template(settings, experiment.id)
        execute_run(
            settings,
            session_factory,
            runner,
            judge,
            run.id,
            base,
            current,
            baseline,
            profile,
            definition,
            chrys_template,
        )
        finish_experiment(settings, session_factory, experiment.id)
    except EvalError as exc:
        experiment_log.event("system", f"重试准备失败：{exc.kind} · {exc.message}", stage="failed")
        artifact_dir = settings.artifacts_dir / experiment.id / run.id / "attempt-2"
        artifact_dir.mkdir(parents=True, exist_ok=True)
        fail_run(session_factory, run.id, exc.kind, exc.message, artifact_dir, retain=True)
        finish_experiment(settings, session_factory, experiment.id)
    finally:
        if chrys_template is not None:
            remove_tree_with_retry(chrys_template)


def run_artifact_dir(settings: Settings, experiment_id: str, run_id: str, attempt: int) -> Path:
    artifact_dir = settings.artifacts_dir / experiment_id / run_id
    if attempt > 1:
        artifact_dir = artifact_dir / f"attempt-{attempt}"
    return artifact_dir


def execute_run(
    settings: Settings,
    session_factory: sessionmaker[Session],
    runner,
    judge,
    run_id: str,
    base: Path,
    current: SkillRevision,
    baseline: SkillRevision | None,
    profile: EvalProfile,
    definition: dict,
    chrys_template: Path | None = None,
) -> None:
    info = claim_run(session_factory, run_id)
    if info is None:
        return
    execute_claimed_run(
        settings, session_factory, runner, judge, info, base, current, baseline, profile,
        definition, chrys_template,
    )


def execute_claimed_run_safely(
    settings: Settings,
    session_factory: sessionmaker[Session],
    runner,
    judge,
    info: dict,
    base: Path,
    current: SkillRevision,
    baseline: SkillRevision | None,
    profile: EvalProfile,
    definition: dict,
    chrys_template: Path | None,
) -> None:
    try:
        execute_claimed_run(
            settings, session_factory, runner, judge, info, base, current, baseline,
            profile, definition, chrys_template,
        )
    except Exception as exc:  # pragma: no cover - defensive thread boundary
        artifact_dir = run_artifact_dir(
            settings, info["experiment_id"], info["run_id"], info["attempt"]
        )
        fail_run(
            session_factory,
            info["run_id"],
            "infra_error",
            f"{type(exc).__name__}: {exc}",
            artifact_dir,
            retain=True,
        )


def execute_claimed_run(
    settings: Settings,
    session_factory: sessionmaker[Session],
    runner,
    judge,
    info: dict,
    base: Path,
    current: SkillRevision,
    baseline: SkillRevision | None,
    profile: EvalProfile,
    definition: dict,
    chrys_template: Path | None,
) -> None:
    run_id = info["run_id"]
    experiment_id = info["experiment_id"]
    group = info["group"]
    trial_index = info["trial_index"]
    anonymous_id = info["anonymous_id"]
    attempt = info["attempt"]
    case = CaseSpec.model_validate(
        next(item for item in definition["cases"] if item["id"] == info["case_id"])
    )

    run_root = run_workspace(settings, experiment_id, run_id, attempt)
    workspace = run_root / "workspace"
    artifact_dir = run_artifact_dir(settings, experiment_id, run_id, attempt)
    artifact_dir.mkdir(parents=True, exist_ok=True)
    chrys_home_root = materialize_run_chrys_home(chrys_template, run_root)

    def set_artifact_path(session: Session) -> None:
        run = session.get(Run, run_id)
        assert run is not None
        run.artifact_path = str(artifact_dir)

    db_write(session_factory, set_artifact_path)
    log_writer = LogWriter(artifact_dir / "logs", scope="run", attempt=attempt)

    def record_progress(kind: str, message: str, stage: str | None) -> None:
        log_writer.event("system", message, stage=stage)

    progress = RunProgress(session_factory, run_id, on_event=record_progress)
    log_writer.event(
        "system",
        f"开始执行 {group} · Trial {trial_index} · 尝试 #{attempt}",
        stage="creating_workspace",
    )
    try:
        progress.stage("creating_workspace", "正在创建独立工作区")
        if base.resolve() != workspace.resolve():
            shutil.copytree(base, workspace)
        prepare_eval_workspace(workspace)
        selected: SkillRevision | None = None
        if group == "current":
            selected = current
        elif group == "baseline":
            selected = baseline
        if selected is not None:
            progress.stage("installing_skill", "正在安装 Skill 快照")
            install_snapshot(
                Path(selected.snapshot_path),
                workspace,
                selected.skill.name,
                provider=profile.runner_provider,
            )

        runner = runner or build_runner(settings, profile.runner_provider)
        progress.stage("runner", "Runner 第 1 轮已启动")
        outcome = runner.run(
            workspace=workspace,
            artifact_dir=artifact_dir,
            case=case,
            profile=profile,
            skill_name=selected.skill.name if selected else None,
            on_progress=lambda kind, message: progress.emit(
                kind, message, activity=kind == "activity"
            ),
            on_log=log_writer.write,
            is_cancelled=progress.cancelled,
            chrys_home_root=chrys_home_root,
        )
        if outcome.error_kind == "cancelled":
            fail_run(
                session_factory,
                run_id,
                "cancelled",
                outcome.error_message or "Run cancelled by user",
                artifact_dir,
                retain=True,
            )
            return
        if outcome.error_kind == "timeout":
            fail_run(
                session_factory,
                run_id,
                "timeout",
                outcome.error_message or "Runner timed out",
                artifact_dir,
                retain=True,
            )
            return
        progress.stage("collecting_changes", "正在收集文件改动和响应证据")
        changes = capture_changes(workspace)
        progress.stage("validators", "正在执行确定性验证器")
        deterministic, command_results = evaluate_deterministic(
            case,
            workspace=workspace,
            changed_files=changes["changed_files"],
            artifact_dir=artifact_dir,
            on_log=log_writer.write,
        )
        evidence = {
            "final_response": outcome.final_response[-80_000:],
            "git_patch": changes["patch"][-120_000:],
            "changed_files": changes["changed_files"],
            "validator_results": command_results,
            "agent_exit_code": outcome.exit_code,
            "agent_error_kind": outcome.error_kind,
            "skill_invoked": outcome.skill_invoked,
        }
        judge_service = judge or build_judge(settings, profile.judge_provider)
        progress.stage("judge", "Judge 正在进行盲评")
        judge = judge_service.evaluate(
            anonymous_id=anonymous_id,
            case=case,
            graders=case.graders,
            evidence=evidence,
            profile=profile,
            artifact_dir=artifact_dir,
            on_progress=lambda kind, message: progress.emit(
                kind, message, activity=kind == "activity"
            ),
            on_log=log_writer.write,
            is_cancelled=progress.cancelled,
            chrys_home_root=chrys_home_root,
        )
        if progress.cancelled():
            fail_run(
                session_factory,
                run_id,
                "cancelled",
                "Run cancelled by user",
                artifact_dir,
                retain=True,
            )
            return
        progress.stage("scoring", "正在合并评分与 hard gates")
        merged = merge_scores(
            case, deterministic, judge, extra=execution_time_component(case, outcome.duration_ms)
        )
        merged["skill_invoked"] = outcome.skill_invoked
        merged["skills_loaded"] = list(outcome.skills_loaded)
        write_json(
            artifact_dir / "input-and-rubric.json",
            {"case": case.model_dump(mode="json"), "anonymous_id": anonymous_id},
        )
        (artifact_dir / "final-response.md").write_text(
            outcome.final_response, encoding="utf-8"
        )
        (artifact_dir / "changes.patch").write_text(changes["patch"], encoding="utf-8")
        write_json(artifact_dir / "file-tree.json", file_tree_manifest(workspace))
        included = archive_untracked(
            workspace, changes["untracked_files"], artifact_dir / "untracked.zip"
        )
        write_json(
            artifact_dir / "run.json",
            {
                "anonymous_id": anonymous_id,
                "outcome": {
                    "exit_code": outcome.exit_code,
                    "duration_ms": outcome.duration_ms,
                    "input_tokens": outcome.input_tokens,
                    "output_tokens": outcome.output_tokens,
                    "thread_id": outcome.thread_id,
                    "turns": outcome.turns,
                    "error_kind": outcome.error_kind,
                    "error_message": outcome.error_message,
                    "skill_invoked": outcome.skill_invoked,
                    "skills_loaded": list(outcome.skills_loaded),
                },
                "profile": profile.model_dump(mode="json"),
                "changed_files": changes["changed_files"],
                "untracked_archive": included,
                "scores": merged,
            },
        )
        write_json(artifact_dir / "scores.json", merged)
        status = outcome.error_kind or ("grader_invalid" if merged["invalid"] else "completed")
        progress.stage("persisting", "正在保存结果和证据包")

        def persist(session: Session) -> None:
            run = session.get(Run, run_id)
            assert run is not None
            run.status = status
            run.quality_score = merged["quality_score"]
            run.hard_gates_passed = merged["hard_gates_passed"]
            run.hard_gates_total = merged["hard_gates_total"]
            run.duration_ms = outcome.duration_ms
            run.input_tokens = outcome.input_tokens
            run.output_tokens = outcome.output_tokens
            run.exit_code = outcome.exit_code
            run.artifact_path = str(artifact_dir)
            run.score_json = canonical_json(merged)
            run.error_kind = "grader_invalid" if merged["invalid"] else outcome.error_kind
            run.error_message = merged.get("judge_error") or outcome.error_message
            run.workspace_retained = run.error_kind is not None
            run.completed_at = now()

        db_write(session_factory, persist)
        progress.stage(status, "Run 已完成" if status == "completed" else "Run 已结束")
        if status == "completed" and outcome.error_kind is None:
            shutil.rmtree(run_root, ignore_errors=True)
            if run_root.exists():
                def mark_retained(session: Session) -> None:
                    retained = session.get(Run, run_id)
                    assert retained is not None
                    retained.workspace_retained = True

                db_write(session_factory, mark_retained)
    except InfrastructureError as exc:
        fail_run(session_factory, run_id, exc.kind, exc.message, artifact_dir, retain=True)
    except Exception as exc:
        fail_run(
            session_factory,
            run_id,
            "infra_error",
            f"{type(exc).__name__}: {exc}",
            artifact_dir,
            retain=True,
        )


def fail_run(
    session_factory: sessionmaker[Session],
    run_id: str,
    kind: str,
    message: str,
    artifact_dir: Path,
    *,
    retain: bool,
) -> None:
    write_json(artifact_dir / "error.json", {"kind": kind, "message": message})
    with session_factory() as session:
        run = session.get(Run, run_id)
        attempt = run.current_attempt if run is not None else None
    log_writer = LogWriter(artifact_dir / "logs", scope="run", attempt=attempt)
    log_writer.event("system", f"Run 失败：{kind} · {message}", stage=kind)
    progress = RunProgress(
        session_factory,
        run_id,
        on_event=lambda event_kind, event_message, stage: log_writer.event(
            "system", event_message, stage=stage
        ),
    )
    progress.error(kind, message)

    def persist(session: Session) -> None:
        run = session.get(Run, run_id)
        assert run is not None
        run.status = kind
        run.error_kind = kind
        run.error_message = message[:10_000]
        run.artifact_path = str(artifact_dir)
        run.workspace_retained = retain
        run.current_stage = kind
        run.completed_at = now()

    db_write(session_factory, persist)


def fail_experiment(
    settings: Settings,
    session_factory: sessionmaker[Session],
    experiment_id: str,
    kind: str,
    message: str,
) -> None:
    with session_factory() as session:
        experiment = session.get(Experiment, experiment_id)
        if experiment is None:
            return
        experiment.status = "invalid" if kind == "invalid" else "failed"
        experiment.error_kind = kind
        experiment.error_message = message[:10_000]
        experiment.completed_at = now()
        session.commit()
    LogWriter(
        settings.artifacts_dir / experiment_id / "logs",
        scope="experiment",
    ).event("system", f"实验失败：{kind} · {message}", stage="failed")


def finish_experiment(
    settings: Settings,
    session_factory: sessionmaker[Session],
    experiment_id: str,
) -> None:
    with session_factory() as session:
        experiment = session.get(Experiment, experiment_id)
        assert experiment is not None
        if experiment.cancel_requested_at:
            for run in experiment.runs:
                if run.status == "queued":
                    run.status = "cancelled"
                    run.current_stage = "cancelled"
                    run.error_kind = "cancelled"
                    run.error_message = "Experiment cancelled before this run started"
                    run.completed_at = now()
            experiment.status = "cancelled"
            experiment.error_kind = "cancelled"
            experiment.error_message = experiment.error_message or "Experiment cancelled by user"
        else:
            failures = [run for run in experiment.runs if run.status != "completed"]
            experiment.status = "completed_with_failures" if failures else "completed"
            if failures:
                experiment.error_kind = "run_failures"
                experiment.error_message = (
                    f"{len(failures)} run(s) did not complete successfully"
                )
        experiment.completed_at = now()
        session.commit()
        status = experiment.status
        message = experiment.error_message or "所有 run 已完成"
    LogWriter(
        settings.artifacts_dir / experiment_id / "logs",
        scope="experiment",
    ).event("system", f"实验结束：{status} · {message}", stage=status)


def request_run_cancel(session_factory: sessionmaker[Session], run_id: str) -> Run:
    with session_factory() as session:
        run = session.get(Run, run_id)
        if run is None:
            raise EvalError("RUN_NOT_FOUND", "Run was not found", status_code=404)
        if run.status not in {"queued", "running"}:
            raise EvalError("RUN_NOT_ACTIVE", "Only queued or running runs can be cancelled")
        run.cancel_requested_at = now()
        if run.status == "queued":
            run.status = "cancelled"
            run.current_stage = "cancelled"
            run.error_kind = "cancelled"
            run.error_message = "Run cancelled before it started"
            run.completed_at = now()
        session.commit()
        session.refresh(run)
        return run


def request_experiment_cancel(
    session_factory: sessionmaker[Session], experiment_id: str
) -> Experiment:
    with session_factory() as session:
        experiment = session.get(Experiment, experiment_id)
        if experiment is None:
            raise EvalError("EXPERIMENT_NOT_FOUND", "Experiment was not found", status_code=404)
        if experiment.status not in {"queued", "preparing", "running", "interrupted"}:
            raise EvalError("EXPERIMENT_NOT_ACTIVE", "Only active experiments can be cancelled")
        experiment.cancel_requested_at = now()
        if experiment.status == "queued":
            experiment.status = "cancelled"
            experiment.error_kind = "cancelled"
            experiment.error_message = "Experiment cancelled before it started"
            experiment.completed_at = now()
        session.commit()
        session.refresh(experiment)
        return experiment


def prepare_retry(session_factory: sessionmaker[Session], run_id: str) -> Run:
    with session_factory() as session:
        run = session.get(Run, run_id)
        if run is None:
            raise EvalError("RUN_NOT_FOUND", "Run was not found", status_code=404)
        if run.error_kind not in {"infra_error", "timeout"}:
            raise EvalError(
                "RUN_NOT_RETRIABLE",
                "Only infrastructure errors and timeouts can be formally retried",
            )
        if run.current_attempt >= 2:
            raise EvalError("RETRY_LIMIT_REACHED", "A formal retry was already used")
        session.add(
            RunAttempt(
                run_id=run.id,
                attempt_index=run.current_attempt,
                status=run.status,
                stage=run.current_stage,
                artifact_path=run.artifact_path,
                error_kind=run.error_kind,
                error_message=run.error_message,
                started_at=run.started_at,
                completed_at=run.completed_at,
            )
        )
        run.current_attempt += 1
        run.status = "queued"
        run.current_stage = "queued"
        run.stage_started_at = now()
        run.last_heartbeat_at = None
        run.last_activity_at = None
        run.cancel_requested_at = None
        run.quality_score = None
        run.hard_gates_passed = 0
        run.hard_gates_total = 0
        run.duration_ms = None
        run.input_tokens = None
        run.output_tokens = None
        run.exit_code = None
        run.artifact_path = None
        run.score_json = canonical_json({"retry": True})
        run.error_kind = None
        run.error_message = None
        run.workspace_retained = False
        run.started_at = None
        run.completed_at = None
        experiment = session.get(Experiment, run.experiment_id)
        assert experiment is not None
        experiment.status = "queued"
        experiment.error_kind = None
        experiment.error_message = None
        experiment.completed_at = None
        session.add(
            RunProgressEvent(
                run_id=run.id,
                attempt=run.current_attempt,
                kind="stage",
                stage="queued",
                message="正式重试已加入队列",
            )
        )
        session.commit()
        session.refresh(run)
        return run
