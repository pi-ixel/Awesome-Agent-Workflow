from __future__ import annotations

import json
import mimetypes
import os
import shutil
import subprocess
from collections import Counter, defaultdict, deque
from datetime import UTC, datetime
from pathlib import Path
from statistics import fmean
from threading import Lock
from time import monotonic
from urllib.parse import quote

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings
from .errors import EvalError
from .jobs import JobManager
from .models import (
    Experiment,
    HumanReview,
    Run,
    RunProgressEvent,
    Skill,
    SkillRevision,
    Suite,
)
from .schemas import (
    BaselineRequest,
    EvalProfile,
    ExperimentCreateRequest,
    HumanReviewRequest,
    RubricDraftRequest,
    SuiteCreateRequest,
)
from .services.chrys import ChrysRuntime
from .services.conversation import rebuild_conversation
from .services.logs import MAX_LOG_READ_BYTES, display_record, read_log_index
from .services.orchestrator import ExperimentOrchestrator
from .services.runner import command_prefix
from .services.suites import build_rubric_draft, create_suite, suite_definition


def _iso(value):
    """Serialize datetimes as explicit-UTC ISO strings.

    Bare "2026-09-28T08:54:58.750230" strings get parsed as *local* time by
    JavaScript, which made running-run durations read +8h on UTC+8 machines.
    """
    if not value:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _age_seconds(value) -> int | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return max(0, int((datetime.now(UTC) - value).total_seconds()))


def _masked_diagnostic(value):
    if isinstance(value, str):
        return display_record({"text": value}, mode="raw", unmasked=False)["text"]
    if isinstance(value, dict):
        return {key: _masked_diagnostic(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_masked_diagnostic(item) for item in value]
    return value


def _active_run_view(run: Run) -> dict:
    activity_age = _age_seconds(run.last_activity_at)
    return {
        "id": run.id,
        "group": run.group_name,
        "case_id": run.case_id,
        "trial": run.trial_index,
        "pair_id": run.pair_id,
        "stage": run.current_stage,
        "started_at": _iso(run.started_at),
        "activity_age_seconds": activity_age,
        "heartbeat_age_seconds": _age_seconds(run.last_heartbeat_at),
        "stalled": bool(
            run.status == "running" and activity_age is not None and activity_age >= 120
        ),
        "cancel_requested": run.cancel_requested_at is not None,
    }


def _progress_payload(experiment: Experiment) -> dict:
    counts = Counter(run.status for run in experiment.runs)
    total = len(experiment.runs)
    completed = counts["completed"]
    # Pair-parallel execution has up to two runs active at once (the
    # no_skill/current pair of one block). active_runs[] lists every running
    # run; the legacy single-run fields keep describing the first one so old
    # clients keep working.
    active_runs = [run for run in experiment.runs if run.status == "running"]
    active_views = [_active_run_view(run) for run in active_runs]
    primary = active_views[0] if active_views else None
    tracked = any(run.current_stage or run.progress_events for run in experiment.runs)
    return {
        "total": total,
        "completed": completed,
        "running": counts["running"],
        "queued": counts["queued"],
        "failed": total - completed - counts["running"] - counts["queued"],
        "tracking_available": tracked,
        "active_run_id": primary["id"] if primary else None,
        "active_runs": active_views,
        "active_stage": primary["stage"] if primary else None,
        "active_activity_age_seconds": primary["activity_age_seconds"] if primary else None,
        "active_heartbeat_age_seconds": primary["heartbeat_age_seconds"] if primary else None,
        "stalled": any(view["stalled"] for view in active_views),
    }


def _group_score(experiment: Experiment, definition: dict, group_name: str) -> float | None:
    weights = {case["id"]: float(case.get("weight", 1)) for case in definition["cases"]}
    case_scores: list[tuple[float, float]] = []
    for case_id, weight in weights.items():
        scores = [
            run.quality_score
            for run in experiment.runs
            if run.case_id == case_id
            and run.group_name == group_name
            and run.quality_score is not None
            and run.status == "completed"
        ]
        if scores:
            case_scores.append((fmean(scores), weight))
    total_weight = sum(weight for _, weight in case_scores)
    if not total_weight:
        return None
    return sum(score * weight for score, weight in case_scores) / total_weight


def _conclusion_payload(experiment: Experiment, definition: dict, group_scores: dict) -> dict:
    """Conclusion rules: hard gates outrank quality scores.

    - A group whose gates failed keeps every score for analysis, but the
      overall verdict is "gates_failed" (candidate did not qualify).
    - A group missing trials shows a provisional score; deltas that involve a
      provisional group are not formal comparisons.
    """
    expected = experiment.trials * len(definition["cases"])
    groups = {}
    for group in ("no_skill", "baseline", "current"):
        runs = [run for run in experiment.runs if run.group_name == group]
        completed = [run for run in runs if run.status == "completed"]
        gates_total = sum(run.hard_gates_total for run in completed)
        gates_passed = sum(run.hard_gates_passed for run in completed)
        groups[group] = {
            "missing": not runs,
            "score": group_scores[group],
            "completed_trials": len(completed),
            "expected_trials": expected,
            "provisional": len(completed) < expected,
            "gates_passed": gates_passed,
            "gates_total": gates_total,
            "gates_failed": gates_total > 0 and gates_passed < gates_total,
        }
    current = groups["current"]
    formal_deltas = {
        side: not (current["provisional"] or groups[side]["provisional"])
        for side in ("no_skill", "baseline")
    }
    if not current["completed_trials"]:
        verdict = "no_score"
    elif current["gates_failed"]:
        verdict = "gates_failed"
    elif current["provisional"]:
        verdict = "provisional"
    else:
        verdict = "solid"
    return {
        "verdict": verdict,
        "expected_trials_per_group": expected,
        "groups": groups,
        "formal_deltas": formal_deltas,
    }


def _profile_payload(experiment: Experiment) -> dict:
    raw = json.loads(experiment.profile_json)
    profile = EvalProfile.model_validate(raw)

    def role_payload(role: str) -> dict:
        provider = getattr(profile, f"{role}_provider")
        model = getattr(profile, f"{role}_model")
        snapshot = getattr(profile, f"{role}_snapshot")
        return {
            "provider": provider,
            "model": model,
            "model_name": snapshot.model_profile_name if snapshot else model,
            "model_id": snapshot.model_id if snapshot else model,
            "runtime_version": snapshot.runtime_version if snapshot else None,
            "agent_profile": snapshot.agent_profile if snapshot else None,
            "isolation": snapshot.isolation if snapshot else "unknown",
            "network_policy": snapshot.network_policy
            if snapshot
            else ("enabled" if profile.network and role == "runner" else "disabled"),
        }

    runner = role_payload("runner")
    judge = role_payload("judge")
    return {
        "name": profile.name,
        "hash": experiment.profile_hash,
        "schema_version": profile.schema_version,
        "legacy": "schema_version" not in raw,
        "runner": runner,
        "judge": judge,
        "self_judge": (
            runner["provider"] == judge["provider"] and runner["model"] == judge["model"]
        ),
    }


def _experiment_summary(experiment: Experiment) -> dict:
    definition = json.loads(experiment.suite_snapshot_json)
    scores = {
        group: _group_score(experiment, definition, group)
        for group in ("no_skill", "baseline", "current")
    }
    current = scores["current"]
    baseline = scores["baseline"]
    no_skill = scores["no_skill"]
    return {
        "id": experiment.id,
        "suite_id": experiment.suite_id,
        "suite_name": experiment.suite.name,
        "skill_id": experiment.suite.skill_id,
        "project_path": experiment.suite.project_path,
        "project_commit": experiment.project_commit,
        "status": experiment.status,
        "retry_of_experiment_id": experiment.retry_of_experiment_id,
        "retry_experiment_ids": [retry.id for retry in experiment.retries],
        "mode": experiment.mode,
        "trials": experiment.trials,
        # Pair-parallel execution metadata (方案第五部分); NULL/absent on
        # legacy experiments and reported as-is, never backfilled.
        "execution_mode": experiment.execution_mode,
        "concurrency_limit": experiment.concurrency_limit,
        "created_at": _iso(experiment.created_at),
        "completed_at": _iso(experiment.completed_at),
        "scores": scores,
        "conclusion": _conclusion_payload(experiment, definition, scores),
        "delta_no_skill": (
            current - no_skill if current is not None and no_skill is not None else None
        ),
        "delta_baseline": (
            current - baseline if current is not None and baseline is not None else None
        ),
        "current_revision": experiment.current_revision.content_hash,
        "current_revision_id": experiment.current_revision_id,
        "baseline_revision": (
            experiment.baseline_revision.content_hash if experiment.baseline_revision else None
        ),
        "baseline_revision_id": experiment.baseline_revision_id,
        "error_kind": experiment.error_kind,
        "error_message": experiment.error_message,
        "profile": _profile_payload(experiment),
        "progress": _progress_payload(experiment),
    }


def _codex_config_path() -> Path:
    home = os.environ.get("CODEX_HOME")
    return Path(home).expanduser() if home else Path.home() / ".codex"


def _codex_models() -> list[dict[str, object]]:
    """Model candidates from the local Codex config (CLI has no models command).

    Reads the default `model` plus every `[profiles.<name>] model` so the form
    can offer real candidates instead of an empty free-text box.
    """
    path = _codex_config_path() / "config.toml"
    if not path.is_file():
        return []
    try:
        import tomllib

        with path.open("rb") as stream:
            config = tomllib.load(stream)
    except Exception:
        return []
    default = config.get("model")
    found: dict[str, dict[str, object]] = {}
    if isinstance(default, str) and default:
        found[default] = {"id": default, "name": f"{default} · 默认", "active": True}
    profiles = config.get("profiles")
    if isinstance(profiles, dict):
        for profile_name, profile in profiles.items():
            if not isinstance(profile, dict):
                continue
            model = profile.get("model")
            if isinstance(model, str) and model and model not in found:
                found[model] = {
                    "id": model,
                    "name": f"{model} · profile {profile_name}",
                    "active": False,
                }
    return list(found.values())


def _codex_runtime_payload(settings: Settings) -> dict:
    command = shutil.which(settings.codex_command)
    version = None
    if command:
        try:
            result = subprocess.run(
                [*command_prefix(settings.codex_command), "--version"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=10,
                shell=False,
                check=False,
            )
            if result.returncode == 0:
                version = result.stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            command = None
    return {
        "available": bool(command),
        "path": command,
        "version": version,
        "models": _codex_models(),
        "isolation": "workspace-write",
        "network_policy": "disabled",
    }


def build_router(
    *,
    settings: Settings,
    get_session,
    orchestrator: ExperimentOrchestrator,
    jobs: JobManager,
) -> APIRouter:
    router = APIRouter(prefix="/api/v1")
    runtime_cache: dict | None = None
    runtime_cache_expires_at = 0.0
    runtime_cache_lock = Lock()

    @router.get("/runtime")
    def runtime(refresh: bool = False):
        nonlocal runtime_cache, runtime_cache_expires_at
        if not refresh and runtime_cache is not None and monotonic() < runtime_cache_expires_at:
            return runtime_cache

        with runtime_cache_lock:
            if not refresh and runtime_cache is not None and monotonic() < runtime_cache_expires_at:
                return runtime_cache

            # Probe Codex and Chrys concurrently: serial probing kept the
            # Runner dropdown empty for 15-20s whenever either CLI was slow.
            from concurrent.futures import ThreadPoolExecutor

            with ThreadPoolExecutor(max_workers=2) as pool:
                codex_future = pool.submit(_codex_runtime_payload, settings)
                chrys_future = pool.submit(ChrysRuntime(settings).payload, ensure_profiles=True)
                codex = codex_future.result()
                chrys = chrys_future.result()
            runtime_cache = {
                "codex_available": codex["available"],
                "codex_path": codex["path"],
                "codex_version": codex["version"],
                "chrys_available": chrys["available"],
                "chrys_path": chrys["path"],
                "chrys_version": chrys["version"],
                "providers": {"codex": codex, "chrys": chrys},
                "data_dir": str(settings.data_dir),
            }
            runtime_cache_expires_at = monotonic() + 600
            return runtime_cache

    @router.post("/rubric-drafts")
    def rubric_draft(request: RubricDraftRequest):
        return build_rubric_draft(request, settings)

    @router.post("/suites", status_code=201)
    def save_suite(request: SuiteCreateRequest, session: Session = Depends(get_session)):
        suite = create_suite(session, settings, request)
        return _suite_payload(suite)

    @router.get("/suites")
    def list_suites(session: Session = Depends(get_session)):
        suites = session.scalars(select(Suite).order_by(Suite.updated_at.desc())).all()
        return {"items": [_suite_payload(suite) for suite in suites]}

    @router.get("/suites/{suite_id}")
    def get_suite(suite_id: str, session: Session = Depends(get_session)):
        suite = session.get(Suite, suite_id)
        if suite is None:
            raise EvalError("SUITE_NOT_FOUND", "Evaluation suite was not found", status_code=404)
        return {**_suite_payload(suite), "definition": suite_definition(suite)}

    @router.post("/experiments", status_code=202)
    async def create_experiment(
        request: ExperimentCreateRequest,
        session: Session = Depends(get_session),
    ):
        experiment = orchestrator.create(request)
        created = session.get(Experiment, experiment.id)
        assert created is not None
        summary = _experiment_summary(created)
        await jobs.enqueue(experiment.id)
        return {"id": experiment.id, "status": experiment.status, "experiment": summary}

    @router.post("/experiments/{experiment_id}/retry", status_code=202)
    async def retry_experiment(experiment_id: str, session: Session = Depends(get_session)):
        experiment = orchestrator.create_retry(experiment_id)
        created = session.get(Experiment, experiment.id)
        assert created is not None
        summary = _experiment_summary(created)
        await jobs.enqueue(experiment.id)
        return {"id": experiment.id, "status": experiment.status, "experiment": summary}

    @router.get("/experiments")
    def list_experiments(limit: int = 50, session: Session = Depends(get_session)):
        limit = min(max(limit, 1), 200)
        experiments = session.scalars(
            select(Experiment).order_by(Experiment.created_at.desc()).limit(limit)
        ).all()
        return {"items": [_experiment_summary(item) for item in experiments]}

    @router.get("/experiments/{experiment_id}")
    def get_experiment(experiment_id: str, session: Session = Depends(get_session)):
        experiment = session.get(Experiment, experiment_id)
        if experiment is None:
            raise EvalError("EXPERIMENT_NOT_FOUND", "Experiment was not found", status_code=404)
        reviews = defaultdict(list)
        run_ids = [run.id for run in experiment.runs]
        if run_ids:
            for review in session.scalars(
                select(HumanReview).where(HumanReview.run_id.in_(run_ids))
            ):
                reviews[review.run_id].append(
                    {
                        "id": review.id,
                        "score": review.score,
                        "note": review.note,
                        "reviewer": review.reviewer,
                        "created_at": _iso(review.created_at),
                    }
                )
        runs = []
        for run in sorted(
            experiment.runs,
            key=lambda item: (item.case_id, item.trial_index, item.group_name),
        ):
            runs.append(
                {
                    "id": run.id,
                    "case_id": run.case_id,
                    "group": run.group_name,
                    "trial": run.trial_index,
                    "pair_id": run.pair_id,
                    "pair_launch_skew_ms": run.pair_launch_skew_ms,
                    "anonymous_id": run.anonymous_id,
                    "status": run.status,
                    "quality_score": run.quality_score,
                    "hard_gates": {
                        "passed": run.hard_gates_passed,
                        "total": run.hard_gates_total,
                    },
                    "duration_ms": run.duration_ms,
                    "input_tokens": run.input_tokens,
                    "output_tokens": run.output_tokens,
                    "exit_code": run.exit_code,
                    "error_kind": run.error_kind,
                    "error_message": run.error_message,
                    "current_stage": run.current_stage,
                    "stage_started_at": _iso(run.stage_started_at),
                    "last_heartbeat_at": _iso(run.last_heartbeat_at),
                    "last_activity_at": _iso(run.last_activity_at),
                    "heartbeat_age_seconds": _age_seconds(run.last_heartbeat_at),
                    "activity_age_seconds": _age_seconds(run.last_activity_at),
                    "stalled": bool(
                        run.status == "running"
                        and run.last_activity_at
                        and (_age_seconds(run.last_activity_at) or 0) >= 120
                    ),
                    "started_at": _iso(run.started_at),
                    "completed_at": _iso(run.completed_at),
                    "current_attempt": run.current_attempt,
                    "cancel_requested": run.cancel_requested_at is not None,
                    "artifact_available": bool(run.artifact_path),
                    "output_bytes": _run_output_bytes(settings, run),
                    "tracking_available": bool(run.current_stage or run.progress_events),
                    "attempts": [
                        {
                            "attempt": attempt.attempt_index,
                            "status": attempt.status,
                            "stage": attempt.stage,
                            "error_kind": attempt.error_kind,
                            "error_message": attempt.error_message,
                            "started_at": _iso(attempt.started_at),
                            "completed_at": _iso(attempt.completed_at),
                        }
                        for attempt in sorted(run.attempts, key=lambda item: item.attempt_index)
                    ],
                    "scores": json.loads(run.score_json) if run.score_json else None,
                    "reviews": reviews[run.id],
                }
            )
        return {
            **_experiment_summary(experiment),
            "profile_config": json.loads(experiment.profile_json),
            "suite_snapshot": json.loads(experiment.suite_snapshot_json),
            "runs": runs,
        }

    @router.post("/experiments/{experiment_id}/cancel", status_code=202)
    def cancel_experiment(experiment_id: str):
        experiment = orchestrator.request_experiment_cancel(experiment_id)
        return {"id": experiment.id, "status": experiment.status, "cancel_requested": True}

    @router.post("/runs/{run_id}/cancel", status_code=202)
    def cancel_run(run_id: str):
        run = orchestrator.request_run_cancel(run_id)
        return {"id": run.id, "status": run.status, "cancel_requested": True}

    @router.post("/runs/{run_id}/retry", status_code=202)
    async def retry_run(run_id: str):
        run = orchestrator.prepare_retry(run_id)
        await jobs.enqueue_retry(run.id)
        return {"id": run.id, "status": run.status, "attempt": run.current_attempt}

    @router.get("/runs/{run_id}/events")
    def run_events(
        run_id: str,
        after: int = 0,
        limit: int = 500,
        session: Session = Depends(get_session),
    ):
        run = session.get(Run, run_id)
        if run is None:
            raise EvalError("RUN_NOT_FOUND", "Run was not found", status_code=404)
        limit = min(max(limit, 1), 2000)
        events = session.scalars(
            select(RunProgressEvent)
            .where(RunProgressEvent.run_id == run_id, RunProgressEvent.id > max(after, 0))
            .order_by(RunProgressEvent.id)
            .limit(limit)
        ).all()
        return {
            "items": [
                {
                    "id": item.id,
                    "attempt": item.attempt,
                    "kind": item.kind,
                    "stage": item.stage,
                    "message": item.message,
                    "created_at": _iso(item.created_at),
                }
                for item in events
            ],
            "state": {
                "status": run.status,
                "stage": run.current_stage,
                "heartbeat_age_seconds": _age_seconds(run.last_heartbeat_at),
                "activity_age_seconds": _age_seconds(run.last_activity_at),
                "stalled": bool(
                    run.status == "running"
                    and run.last_activity_at
                    and (_age_seconds(run.last_activity_at) or 0) >= 120
                ),
            },
        }

    @router.get("/experiments/{experiment_id}/logs")
    def experiment_logs(
        experiment_id: str,
        cursor: str | None = None,
        channels: str | None = None,
        sources: str | None = None,
        mode: str = "events",
        unmasked: bool = False,
        limit_bytes: int = MAX_LOG_READ_BYTES,
        session: Session = Depends(get_session),
    ):
        if session.get(Experiment, experiment_id) is None:
            raise EvalError("EXPERIMENT_NOT_FOUND", "Experiment was not found", status_code=404)
        return _log_stream_payload(
            settings.artifacts_dir / experiment_id / "logs" / "index.jsonl",
            cursor=cursor,
            channels=channels,
            sources=sources,
            mode=mode,
            unmasked=unmasked,
            limit_bytes=limit_bytes,
        )

    @router.get("/runs/{run_id}/logs")
    def run_logs(
        run_id: str,
        attempt: int | None = None,
        cursor: str | None = None,
        channels: str | None = None,
        sources: str | None = None,
        mode: str = "events",
        unmasked: bool = False,
        limit_bytes: int = MAX_LOG_READ_BYTES,
        tail: int | None = None,
        session: Session = Depends(get_session),
    ):
        run = session.get(Run, run_id)
        if run is None:
            raise EvalError("RUN_NOT_FOUND", "Run was not found", status_code=404)
        artifact_dir = _attempt_artifact_dir(settings, run, attempt)
        if tail is not None and cursor is None:
            return {"items": _legacy_log_items(artifact_dir, tail)}
        if artifact_dir is None:
            return {
                "records": [],
                "next_cursor": "",
                "reset_required": False,
                "historical": False,
                "pending": True,
                "has_more": False,
            }
        return _log_stream_payload(
            artifact_dir / "logs" / "index.jsonl",
            cursor=cursor,
            channels=channels,
            sources=sources,
            mode=mode,
            unmasked=unmasked,
            limit_bytes=limit_bytes,
        )

    @router.get("/runs/{run_id}/diagnostics")
    def run_diagnostics(
        run_id: str,
        attempt: int | None = None,
        session: Session = Depends(get_session),
    ):
        run = session.get(Run, run_id)
        if run is None:
            raise EvalError("RUN_NOT_FOUND", "Run was not found", status_code=404)
        artifact_dir = _attempt_artifact_dir(settings, run, attempt)
        invocations = []
        recent = deque(maxlen=100)
        if artifact_dir is not None:
            path = artifact_dir / "logs" / "index.jsonl"
            if path.is_file():
                with path.open(encoding="utf-8", errors="replace") as stream:
                    for line in stream:
                        try:
                            record = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if not isinstance(record, dict):
                            continue
                        safe = display_record(record, mode="raw", unmasked=False)
                        if safe["channel"] == "invocation":
                            invocations.append(safe["details"])
                        else:
                            fields = ("timestamp", "source", "channel", "text")
                            recent.append({key: safe[key] for key in fields})
        return _masked_diagnostic({
            "run_id": run.id,
            "experiment_id": run.experiment_id,
            "case_id": run.case_id,
            "group": run.group_name,
            "trial": run.trial_index,
            "attempt": attempt or run.current_attempt,
            "status": run.status,
            "stage": run.current_stage,
            "started_at": _iso(run.started_at),
            "stage_started_at": _iso(run.stage_started_at),
            "completed_at": _iso(run.completed_at),
            "error_kind": run.error_kind,
            "error_message": display_record(
                {"text": run.error_message or ""}, mode="raw", unmasked=False
            )["text"],
            "heartbeat_age_seconds": _age_seconds(run.last_heartbeat_at),
            "activity_age_seconds": _age_seconds(run.last_activity_at),
            "output_bytes": _run_output_bytes(settings, run),
            "profile": _profile_payload(run.experiment),
            "invocations": invocations,
            "recent_logs": list(recent),
        })

    @router.get("/experiments/{experiment_id}/log-files")
    def list_experiment_log_files(experiment_id: str, session: Session = Depends(get_session)):
        if session.get(Experiment, experiment_id) is None:
            raise EvalError("EXPERIMENT_NOT_FOUND", "Experiment was not found", status_code=404)
        root = settings.artifacts_dir / experiment_id / "logs"
        return {"items": _log_file_items(root, f"/api/v1/experiments/{experiment_id}/log-files")}

    @router.get("/experiments/{experiment_id}/log-files/{name:path}")
    def get_experiment_log_file(
        experiment_id: str,
        name: str,
        preview: bool = False,
        unmasked: bool = False,
        session: Session = Depends(get_session),
    ):
        if session.get(Experiment, experiment_id) is None:
            raise EvalError("EXPERIMENT_NOT_FOUND", "Experiment was not found", status_code=404)
        root = settings.artifacts_dir / experiment_id / "logs"
        if preview:
            return _log_file_preview(root, name, unmasked=unmasked)
        return _log_file_response(root, name)

    @router.get("/runs/{run_id}/log-files")
    def list_run_log_files(
        run_id: str,
        attempt: int | None = None,
        session: Session = Depends(get_session),
    ):
        run = session.get(Run, run_id)
        if run is None:
            raise EvalError("RUN_NOT_FOUND", "Run was not found", status_code=404)
        artifact_dir = _attempt_artifact_dir(settings, run, attempt)
        if artifact_dir is None:
            return {"items": [], "pending": True}
        suffix = f"?attempt={attempt}" if attempt is not None else ""
        return {
            "items": _log_file_items(
                artifact_dir,
                f"/api/v1/runs/{run_id}/log-files",
                suffix=suffix,
            )
        }

    @router.get("/runs/{run_id}/log-files/{name:path}")
    def get_run_log_file(
        run_id: str,
        name: str,
        attempt: int | None = None,
        preview: bool = False,
        unmasked: bool = False,
        session: Session = Depends(get_session),
    ):
        run = session.get(Run, run_id)
        if run is None:
            raise EvalError("RUN_NOT_FOUND", "Run was not found", status_code=404)
        artifact_dir = _attempt_artifact_dir(settings, run, attempt)
        if artifact_dir is None:
            raise EvalError("ARTIFACT_NOT_FOUND", "Run logs were not found", status_code=404)
        if preview:
            return _log_file_preview(artifact_dir, name, unmasked=unmasked)
        return _log_file_response(artifact_dir, name)

    @router.post("/skills/{skill_id}/baseline")
    def set_baseline(
        skill_id: str,
        request: BaselineRequest,
        session: Session = Depends(get_session),
    ):
        skill = session.get(Skill, skill_id)
        revision = session.get(SkillRevision, request.revision_id)
        if skill is None or revision is None or revision.skill_id != skill.id:
            raise EvalError("REVISION_NOT_FOUND", "Skill revision was not found", status_code=404)
        skill.baseline_revision_id = revision.id
        session.commit()
        return {"skill_id": skill.id, "baseline_revision_id": revision.id}

    @router.post("/runs/{run_id}/reviews", status_code=201)
    def add_review(
        run_id: str,
        request: HumanReviewRequest,
        session: Session = Depends(get_session),
    ):
        if session.get(Run, run_id) is None:
            raise EvalError("RUN_NOT_FOUND", "Run was not found", status_code=404)
        review = HumanReview(run_id=run_id, **request.model_dump())
        session.add(review)
        session.commit()
        session.refresh(review)
        return {"id": review.id, "created_at": _iso(review.created_at)}

    @router.get("/runs/{run_id}/conversation")
    def run_conversation(
        run_id: str,
        source: str = "runner",
        unmasked: bool = False,
        session: Session = Depends(get_session),
    ):
        """Structured, read-only replay of one run's ACP conversation.

        Returns every attempt, each rebuilt as turns with prompt references,
        agent messages/thoughts and tool calls (input + result). Text fields
        are masked by default, matching the log console behaviour.
        """
        run = session.get(Run, run_id)
        if run is None:
            raise EvalError("RUN_NOT_FOUND", "Run was not found", status_code=404)
        if source not in {"runner", "judge"}:
            raise EvalError(
                "INVALID_SOURCE", "Conversation source must be runner or judge", status_code=400
            )
        attempts = []
        for attempt_index, artifact_dir in _attempt_dirs(settings, run):
            payload = rebuild_conversation(artifact_dir, source, run_status=run.status)
            payload["attempt"] = attempt_index
            attempts.append(payload)
        result = {
            "source": source,
            "run_id": run.id,
            "status": run.status,
            "pending": run.status == "running",
            "attempts": attempts,
        }
        if not unmasked:
            result = _masked_diagnostic(result)
        return result

    @router.get("/runs/{run_id}/artifacts")
    def list_run_artifacts(run_id: str, session: Session = Depends(get_session)):
        run = session.get(Run, run_id)
        artifact_dir = _artifact_dir(settings, run)
        return {
            "items": [
                {
                    "name": path.name,
                    "size": path.stat().st_size,
                    "url": f"/api/v1/runs/{run_id}/artifacts/{path.name}",
                }
                for path in sorted(artifact_dir.iterdir(), key=lambda item: item.name)
                if path.is_file()
            ]
        }

    @router.get("/runs/{run_id}/artifacts/{name}")
    def get_run_artifact(
        run_id: str,
        name: str,
        session: Session = Depends(get_session),
    ):
        run = session.get(Run, run_id)
        artifact_dir = _artifact_dir(settings, run)
        path = (artifact_dir / name).resolve()
        if path.parent != artifact_dir or not path.is_file():
            raise EvalError("ARTIFACT_NOT_FOUND", "Artifact was not found", status_code=404)
        # Text evidence (markdown reports, patches, scores) renders inline in
        # the browser instead of triggering a download.
        disposition = "inline" if path.suffix.lower() in TEXT_MEDIA_TYPES else "attachment"
        return FileResponse(
            path,
            media_type=_media_type_for(path),
            content_disposition_type=disposition,
        )

    @router.get("/dashboard/skills")
    def dashboard(session: Session = Depends(get_session)):
        skills = session.scalars(select(Skill).order_by(Skill.name)).all()
        items = []
        for skill in skills:
            grouped = defaultdict(list)
            for suite in session.scalars(select(Suite).where(Suite.skill_id == skill.id)):
                experiments = session.scalars(
                    select(Experiment).where(
                        Experiment.suite_id == suite.id,
                        Experiment.status == "completed",
                    )
                ).all()
                for experiment in experiments:
                    grouped[(suite.project_path, experiment.profile_hash, experiment.mode)].append(
                        experiment
                    )
            revisions = [
                {
                    "id": revision.id,
                    "hash": revision.content_hash,
                    "label": revision.label,
                    "created_at": _iso(revision.created_at),
                }
                for revision in sorted(
                    skill.revisions,
                    key=lambda item: item.created_at,
                    reverse=True,
                )
            ]
            for key in sorted(grouped):
                selected = max(grouped[key], key=lambda item: item.created_at)
                summary = _experiment_summary(selected)
                items.append(
                    {
                        **summary,
                        "experiment_id": summary["id"],
                        "skill_id": skill.id,
                        "skill_name": skill.name,
                        "source_path": skill.source_path,
                        "baseline_revision_id": skill.baseline_revision_id,
                        "score": summary["scores"]["current"],
                        "latest_experiment_at": summary["created_at"],
                        "revisions": revisions,
                    }
                )
        return {"items": items}

    return router


def _suite_payload(suite: Suite) -> dict:
    return {
        "id": suite.id,
        "name": suite.name,
        "skill_id": suite.skill_id,
        "skill_name": suite.skill.name,
        "project_path": suite.project_path,
        "definition_hash": suite.definition_hash,
        "definition_path": suite.definition_path,
        "created_at": _iso(suite.created_at),
        "updated_at": _iso(suite.updated_at),
    }


def _artifact_dir(settings: Settings, run: Run | None) -> Path:
    if run is None or not run.artifact_path:
        raise EvalError("RUN_NOT_FOUND", "Run or its artifacts were not found", status_code=404)
    artifact_dir = _safe_artifact_dir(settings, run.artifact_path)
    if artifact_dir is None:
        raise EvalError("ARTIFACT_NOT_FOUND", "Run artifacts were not found", status_code=404)
    return artifact_dir


def _safe_artifact_dir(settings: Settings, raw_path: str | None) -> Path | None:
    if not raw_path:
        return None
    root = settings.artifacts_dir.resolve()
    artifact_dir = Path(raw_path).resolve()
    if not artifact_dir.is_relative_to(root) or not artifact_dir.is_dir():
        return None
    return artifact_dir


def _run_output_bytes(settings: Settings, run: Run) -> dict[str, int]:
    artifact_dir = _safe_artifact_dir(settings, run.artifact_path)
    if artifact_dir is None:
        return {"stdout": 0, "stderr": 0}
    root = artifact_dir / "judge" if run.current_stage == "judge" else artifact_dir
    stdout = [*root.glob("chrys-turn-*.json"), *root.glob("*.jsonl"), *root.glob("*.stdout.txt")]
    stderr = list(root.glob("*.stderr.txt"))
    return {
        "stdout": sum(path.stat().st_size for path in stdout if path.is_file()),
        "stderr": sum(path.stat().st_size for path in stderr if path.is_file()),
    }


def _attempt_artifact_dir(settings: Settings, run: Run, attempt: int | None) -> Path | None:
    if attempt is None or attempt == run.current_attempt:
        return _safe_artifact_dir(settings, run.artifact_path)
    for previous in run.attempts:
        if previous.attempt_index == attempt:
            return _safe_artifact_dir(settings, previous.artifact_path)
    raise EvalError("ATTEMPT_NOT_FOUND", "Run attempt was not found", status_code=404)


def _attempt_dirs(settings: Settings, run: Run) -> list[tuple[int, Path]]:
    """All attempt artifact directories (oldest first), current attempt included."""
    found: list[tuple[int, Path]] = []
    seen: set[Path] = set()
    for attempt in sorted(run.attempts, key=lambda item: item.attempt_index):
        artifact_dir = _safe_artifact_dir(settings, attempt.artifact_path)
        if artifact_dir is not None and artifact_dir not in seen:
            seen.add(artifact_dir)
            found.append((attempt.attempt_index, artifact_dir))
    current = _safe_artifact_dir(settings, run.artifact_path)
    if current is not None and current not in seen:
        found.append((run.current_attempt, current))
    return sorted(found, key=lambda item: item[0])


def _csv_filter(value: str | None) -> set[str] | None:
    if value is None or not value.strip():
        return None
    return {item.strip() for item in value.split(",") if item.strip()}


def _log_stream_payload(
    path: Path,
    *,
    cursor: str | None,
    channels: str | None,
    sources: str | None,
    mode: str,
    unmasked: bool,
    limit_bytes: int,
) -> dict:
    if mode not in {"events", "raw"}:
        raise EvalError("INVALID_LOG_MODE", "Log mode must be events or raw")
    payload = read_log_index(
        path,
        cursor=cursor,
        limit_bytes=min(max(limit_bytes, 1), MAX_LOG_READ_BYTES),
    )
    channel_filter = _csv_filter(channels)
    source_filter = _csv_filter(sources)
    records = []
    for record in payload.pop("records"):
        if channel_filter is not None and record.get("channel") not in channel_filter:
            continue
        if source_filter is not None and record.get("source") not in source_filter:
            continue
        records.append(display_record(record, mode=mode, unmasked=unmasked and mode == "raw"))
    return {**payload, "records": records, "mode": mode}


EVIDENCE_FILE_NAMES = {
    "changes.patch",
    "final-response.md",
    "scores.json",
    "input-and-rubric.json",
    "run.json",
}

# Windows machines have no registry entries for several text artifact
# extensions (.md/.patch/.jsonl), so mimetypes.guess_type returns None and
# FileResponse falls back to application/octet-stream — browsers then download
# (or fail, e.g. ERR_FAILED in embedded browsers) instead of rendering inline.
TEXT_MEDIA_TYPES = {
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".patch": "text/x-diff",
    ".diff": "text/x-diff",
    ".json": "application/json",
    ".jsonl": "application/x-ndjson",
    ".txt": "text/plain",
    ".log": "text/plain",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".py": "text/plain",
    ".toml": "text/plain",
}


def _media_type_for(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in TEXT_MEDIA_TYPES:
        base = TEXT_MEDIA_TYPES[suffix]
        return f"{base}; charset=utf-8" if base.startswith("text/") else base
    guessed = mimetypes.guess_type(path.name)[0]
    if guessed and guessed.startswith("text/"):
        return f"{guessed}; charset=utf-8"
    return guessed or "application/octet-stream"


def _is_log_file(path: Path) -> bool:
    if path.parent.name == "invocations" and path.name.endswith(".prompt.txt"):
        return True
    if path.name in EVIDENCE_FILE_NAMES:
        return True
    return path.name.endswith((".jsonl", ".stderr.txt", ".stdout.txt")) or path.name.startswith(
        "chrys-turn-"
    )


def _legacy_log_items(artifact_dir: Path | None, tail: int) -> list[dict]:
    if artifact_dir is None:
        return []
    tail = min(max(tail, 20), 5000)
    candidates = [path for path in artifact_dir.rglob("*") if path.is_file() and _is_log_file(path)]
    items = []
    for path in sorted(candidates, key=lambda item: (item.stat().st_mtime, item.name)):
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        items.append(
            {
                "name": str(path.relative_to(artifact_dir)),
                "content": "\n".join(lines[-tail:]),
                "truncated": len(lines) > tail,
            }
        )
    return items


def _log_file_items(root: Path, url_prefix: str, *, suffix: str = "") -> list[dict]:
    if not root.is_dir():
        return []
    candidates = [path for path in root.rglob("*") if path.is_file() and _is_log_file(path)]
    return [
        {
            "name": path.relative_to(root).as_posix(),
            "size": path.stat().st_size,
            "url": f"{url_prefix}/{quote(path.relative_to(root).as_posix())}{suffix}",
        }
        for path in sorted(candidates, key=lambda item: item.relative_to(root).as_posix())
    ]


def _log_file_path(root: Path, name: str) -> Path:
    base = root.resolve()
    path = (base / name).resolve()
    if not path.is_relative_to(base) or not path.is_file() or not _is_log_file(path):
        raise EvalError("LOG_FILE_NOT_FOUND", "Log file was not found", status_code=404)
    return path


def _log_file_preview(root: Path, name: str, *, unmasked: bool) -> dict:
    path = _log_file_path(root, name)
    size = path.stat().st_size
    with path.open("rb") as stream:
        if size > MAX_LOG_READ_BYTES:
            stream.seek(size - MAX_LOG_READ_BYTES)
        content = stream.read(MAX_LOG_READ_BYTES).decode("utf-8", "replace")
    return {
        "name": name,
        "content": display_record({"text": content}, mode="raw", unmasked=unmasked)["text"],
        "size": size,
        "truncated": size > MAX_LOG_READ_BYTES,
    }


def _log_file_response(root: Path, name: str) -> FileResponse:
    path = _log_file_path(root, name)
    return FileResponse(path, media_type=_media_type_for(path), filename=path.name)
