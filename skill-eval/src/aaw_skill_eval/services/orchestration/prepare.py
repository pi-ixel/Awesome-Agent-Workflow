from __future__ import annotations

import random
import secrets
import shutil
import uuid
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from ...config import Settings
from ...errors import EvalError
from ...models import Experiment, Run, RunProgressEvent, Suite
from ...schemas import CaseSpec, EvalProfile, ExperimentCreateRequest, SetupSpec
from ..catalog.skills import import_skill
from ..observability.logs import LogWriter
from ..providers.chrys.runtime import (
    enrich_profile,
    prepare_experiment_chrys_template,
    verify_profile,
)
from ..storage.artifacts import canonical_json, content_hash, write_json
from ..workspace.repository import (
    clone_at_commit,
    file_tree_manifest,
    inspect_clean_project,
    inspect_project_commit,
    run_trusted_command,
)
from .progress import now


def create(
    settings: Settings,
    session_factory: sessionmaker[Session],
    request: ExperimentCreateRequest,
) -> Experiment:
    with session_factory() as session:
        suite = session.get(Suite, request.suite_id)
        if suite is None:
            raise EvalError(
                "SUITE_NOT_FOUND",
                "Evaluation suite was not found",
                status_code=404,
            )
        project = inspect_clean_project(suite.project_path)
        current = import_skill(session, settings, suite.skill.source_path)
        session.refresh(suite.skill)
        baseline_id = suite.skill.baseline_revision_id
        if baseline_id == current.id:
            baseline_id = None
        profile = enrich_profile(settings, request.profile)
        profile_data = profile.model_dump(mode="json")
        profile_identity = {key: value for key, value in profile_data.items() if key != "name"}
        profile_json = canonical_json(profile_data)
        experiment = Experiment(
            suite_id=suite.id,
            current_revision_id=current.id,
            baseline_revision_id=baseline_id,
            project_commit=project.commit,
            suite_hash=suite.definition_hash,
            profile_hash=content_hash(profile_identity),
            profile_json=profile_json,
            suite_snapshot_json=suite.definition_json,
            mode=request.mode,
            trials=1 if request.mode == "quick" else 3,
            seed=secrets.randbits(31),
            status="queued",
        )
        session.add(experiment)
        session.commit()
        session.refresh(experiment)
        return experiment


def create_retry(session_factory: sessionmaker[Session], experiment_id: str) -> Experiment:
    with session_factory() as session:
        original = session.get(Experiment, experiment_id)
        if original is None:
            raise EvalError(
                "EXPERIMENT_NOT_FOUND",
                "Experiment was not found",
                status_code=404,
            )
        suite = session.get(Suite, original.suite_id)
        assert suite is not None
        project_path = suite.project_path
        snapshot = {
            "suite_id": original.suite_id,
            "current_revision_id": original.current_revision_id,
            "baseline_revision_id": original.baseline_revision_id,
            "project_commit": original.project_commit,
            "suite_hash": original.suite_hash,
            "profile_hash": original.profile_hash,
            "profile_json": original.profile_json,
            "suite_snapshot_json": original.suite_snapshot_json,
            "mode": original.mode,
            "trials": original.trials,
            "seed": original.seed,
        }

    inspect_project_commit(project_path, snapshot["project_commit"])

    with session_factory() as session:
        original = session.get(Experiment, experiment_id)
        assert original is not None
        if original.status in {"queued", "interrupted"}:
            original.status = "cancelled"
            original.cancel_requested_at = original.cancel_requested_at or now()
            original.error_kind = "cancelled"
            original.error_message = "Experiment cancelled because a retry was requested"
            original.completed_at = original.completed_at or now()
        elif original.status in {"preparing", "running"}:
            original.cancel_requested_at = original.cancel_requested_at or now()
            original.error_kind = "cancelled"
            original.error_message = (
                "Experiment cancellation requested because a retry was requested"
            )

        retry = Experiment(
            **snapshot,
            retry_of_experiment_id=original.id,
            status="queued",
        )
        session.add(retry)
        session.commit()
        session.refresh(retry)
        return retry


def prepare_experiment(
    settings: Settings,
    session_factory: sessionmaker[Session],
    experiment_id: str,
    *,
    root: Path,
    base: Path,
    experiment: Experiment,
    suite: Suite,
    definition: dict,
    profile: EvalProfile,
    has_baseline: bool,
    experiment_log: LogWriter,
) -> Path | None:
    """Run the preparation phase of an experiment and return the chrys template.

    Verifies the Runner/Judge configuration, re-validates the project state,
    clones the fixed-commit evaluation copy, executes the setup commands,
    prepares the experiment-level chrys template (when needed) and creates the
    queued runs. Raises on the first failure so the caller can mark the
    experiment as failed.
    """
    chrys_template: Path | None = None
    experiment_log.event("system", "正在校验 Runner/Judge 配置", stage="preparing")
    verify_profile(settings, profile)
    experiment_log.event("system", "Runner/Judge 配置校验完成", stage="preparing")
    if experiment.retry_of_experiment_id:
        snapshot = inspect_project_commit(suite.project_path, experiment.project_commit)
    else:
        snapshot = inspect_clean_project(suite.project_path)
        if snapshot.commit != experiment.project_commit:
            raise EvalError(
                "PROJECT_MOVED",
                "Project HEAD changed after the experiment was queued; create a new experiment",
            )
    if root.exists():
        shutil.rmtree(root)
    experiment_log.event("system", "正在创建固定提交的评测副本", stage="cloning")
    clone_at_commit(snapshot, base)
    experiment_log.event("system", "评测副本已创建", stage="cloning")
    setup = SetupSpec.model_validate(definition.get("setup") or {})
    setup_log = prepare_base(base, setup, log_writer=experiment_log)
    write_json(settings.artifacts_dir / experiment_id / "setup.json", setup_log)
    if profile.runner_provider == "chrys" or profile.judge_provider == "chrys":
        chrys_template = prepare_experiment_chrys_template(settings, experiment_id)
        experiment_log.event(
            "system",
            "已生成实验级 Chrys 配置模板，每个 Run 将使用独立配置目录",
            stage="queuing_runs",
        )
    experiment_log.event("system", "正在创建独立评测运行", stage="queuing_runs")
    create_runs(session_factory, experiment_id, definition, has_baseline)
    return chrys_template


def prepare_base(
    base: Path,
    setup: SetupSpec,
    *,
    log_writer: LogWriter | None = None,
) -> dict:
    setup_log: dict[str, Any] = {"commands": [], "preflight": [], "network": setup.network}
    for index, command in enumerate(setup.commands, start=1):
        if log_writer is not None:
            log_writer.event("setup", f"开始 Setup 命令 #{index}: {command}", stage="setup")
        result = run_trusted_command(
            command,
            base,
            setup.timeout_seconds,
            on_log=log_writer.write if log_writer is not None else None,
            source="setup",
            stdout_path=(log_writer.root / f"setup-{index}.stdout.txt")
            if log_writer is not None
            else None,
            stderr_path=(log_writer.root / f"setup-{index}.stderr.txt")
            if log_writer is not None
            else None,
        )
        setup_log["commands"].append(result)
        if log_writer is not None:
            log_writer.event(
                "setup",
                f"Setup 命令 #{index} 结束（exit_code={result.get('exit_code')}）",
                stage="setup",
            )
        if result.get("exit_code") != 0:
            raise EvalError("SETUP_FAILED", f"Setup command failed: {command}")
    for index, command in enumerate(setup.preflight, start=1):
        if log_writer is not None:
            log_writer.event(
                "preflight", f"开始 Preflight 命令 #{index}: {command}", stage="preflight"
            )
        result = run_trusted_command(
            command,
            base,
            setup.timeout_seconds,
            on_log=log_writer.write if log_writer is not None else None,
            source="preflight",
            stdout_path=(log_writer.root / f"preflight-{index}.stdout.txt")
            if log_writer is not None
            else None,
            stderr_path=(log_writer.root / f"preflight-{index}.stderr.txt")
            if log_writer is not None
            else None,
        )
        setup_log["preflight"].append(result)
        if log_writer is not None:
            log_writer.event(
                "preflight",
                f"Preflight 命令 #{index} 结束（exit_code={result.get('exit_code')}）",
                stage="preflight",
            )
        if result.get("exit_code") != 0:
            raise EvalError("PREFLIGHT_FAILED", f"Preflight command failed: {command}")
    setup_log["manifest"] = file_tree_manifest(base)
    return setup_log


def create_runs(
    session_factory: sessionmaker[Session],
    experiment_id: str,
    definition: dict,
    has_baseline: bool,
) -> None:
    with session_factory() as session:
        experiment = session.get(Experiment, experiment_id)
        assert experiment is not None
        existing = session.scalar(select(Run).where(Run.experiment_id == experiment_id))
        if existing is not None:
            return
        groups = ["no_skill", "current"]
        if has_baseline:
            groups.insert(1, "baseline")
        rng = random.Random(experiment.seed)
        order = 0
        for case_data in definition["cases"]:
            case = CaseSpec.model_validate(case_data)
            for trial_index in range(1, experiment.trials + 1):
                pair_id = f"{case.id}#t{trial_index}"
                block = list(groups)
                rng.shuffle(block)
                for group in block:
                    anonymous = f"candidate-{uuid.uuid4().hex[:8].upper()}"
                    run = Run(
                        experiment_id=experiment_id,
                        case_id=case.id,
                        group_name=group,
                        trial_index=trial_index,
                        anonymous_id=anonymous,
                        status="queued",
                        pair_id=pair_id,
                        score_json=canonical_json({"execution_order": order}),
                    )
                    order += 1
                    session.add(run)
                    session.flush()
                    session.add(
                        RunProgressEvent(
                            run_id=run.id,
                            attempt=1,
                            kind="stage",
                            stage="queued",
                            message="等待所属配对块被调度",
                        )
                    )
        session.commit()
