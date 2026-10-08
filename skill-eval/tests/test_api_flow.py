from __future__ import annotations

import subprocess
import threading
import time
from pathlib import Path

from fastapi.testclient import TestClient

from aaw_skill_eval.services.observability.logs import MAX_LOG_READ_BYTES, LogWriter
from aaw_skill_eval.services.providers.base import RunOutcome


def _draft(client: TestClient, project: Path, skill: Path) -> dict:
    response = client.post(
        "/api/v1/rubric-drafts",
        json={
            "project_path": str(project),
            "skill_path": str(skill),
            "input": "Create result.md",
            "expected": "A useful result.md must exist",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def _suite(client: TestClient, project: Path, skill: Path) -> dict:
    draft = _draft(client, project, skill)
    draft["case"]["graders"].insert(
        0,
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
    )
    response = client.post(
        "/api/v1/suites",
        json={
            "name": "Fixture suite",
            "project_path": str(project),
            "skill_path": str(skill),
            "setup": {"commands": [], "preflight": [], "network": False},
            "cases": [draft["case"]],
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def _wait(client: TestClient, experiment_id: str) -> dict:
    for _ in range(100):
        item = client.get(f"/api/v1/experiments/{experiment_id}").json()
        if item["status"] in {"completed", "completed_with_failures", "failed", "invalid"}:
            return item
        time.sleep(0.05)
    raise AssertionError("experiment did not finish")


def test_create_suite_and_run_blind_ab_experiment(
    client: TestClient,
    project: Path,
    skill: Path,
):
    suite = _suite(client, project, skill)
    response = client.post(
        "/api/v1/experiments",
        json={
            "suite_id": suite["id"],
            "mode": "quick",
            "profile": {
                "name": "fixture",
                "runner_model": "fixture-model",
                "judge_model": "fixture-model",
                "runner_reasoning_effort": "high",
                "judge_reasoning_effort": "high",
                "network": False,
            },
        },
    )
    assert response.status_code == 202, response.text
    assert response.json()["experiment"]["id"] == response.json()["id"]
    assert response.json()["experiment"]["suite_name"] == suite["name"]
    experiment = _wait(client, response.json()["id"])
    assert experiment["status"] == "completed", experiment
    assert len(experiment["runs"]) == 2
    assert {run["group"] for run in experiment["runs"]} == {"no_skill", "current"}
    assert experiment["scores"]["current"] == 88
    assert experiment["scores"]["no_skill"] == 55
    assert experiment["delta_no_skill"] == 33
    assert experiment["profile"]["runner"]["provider"] == "codex"
    assert experiment["profile"]["judge"]["provider"] == "codex"
    assert experiment["profile"]["self_judge"] is True
    assert experiment["progress"] == {
        "total": 2,
        "completed": 2,
        "running": 0,
        "queued": 0,
        "failed": 0,
        "tracking_available": True,
        "active_run_id": None,
        "active_runs": [],
        "active_stage": None,
        "active_activity_age_seconds": None,
        "active_heartbeat_age_seconds": None,
        "stalled": False,
    }
    assert all(run["hard_gates"] == {"passed": 1, "total": 1} for run in experiment["runs"])

    tracked_run = experiment["runs"][0]
    assert tracked_run["current_stage"] == "completed"
    events = client.get(f"/api/v1/runs/{tracked_run['id']}/events")
    assert events.status_code == 200
    stages = {event["stage"] for event in events.json()["items"]}
    assert {"queued", "creating_workspace", "runner", "judge", "completed"} <= stages

    artifacts = client.get(f"/api/v1/runs/{experiment['runs'][0]['id']}/artifacts")
    assert artifacts.status_code == 200
    names = {item["name"] for item in artifacts.json()["items"]}
    assert {"final-response.md", "scores.json"} <= names
    score_file = client.get(f"/api/v1/runs/{experiment['runs'][0]['id']}/artifacts/scores.json")
    assert score_file.status_code == 200

    review = client.post(
        f"/api/v1/runs/{experiment['runs'][0]['id']}/reviews",
        json={"score": 91, "note": "Manual check", "reviewer": "tester"},
    )
    assert review.status_code == 201

    baseline = client.post(
        f"/api/v1/skills/{experiment['skill_id']}/baseline",
        json={"revision_id": experiment["current_revision_id"]},
    )
    assert baseline.status_code == 200

    dashboard = client.get("/api/v1/dashboard/skills")
    assert dashboard.status_code == 200
    item = dashboard.json()["items"][0]
    assert item["skill_name"] == "example-skill"
    assert item["project_path"] == str(project.resolve())
    assert item["score"] == 88

    second_suite = _suite(client, project, skill)
    second_run = client.post(
        "/api/v1/experiments",
        json={
            "suite_id": second_suite["id"],
            "mode": "quick",
            "profile": {
                "name": "fixture-2",
                "runner_model": "fixture-model",
                "judge_model": "fixture-model",
                "runner_reasoning_effort": "high",
                "judge_reasoning_effort": "high",
                "network": False,
            },
        },
    )
    assert second_run.status_code == 202
    assert _wait(client, second_run.json()["id"])["status"] == "completed"
    dashboard = client.get("/api/v1/dashboard/skills").json()["items"]
    assert len(dashboard) == 1
    assert dashboard[0]["project_path"] == str(project.resolve())


def test_run_logs_stream_incrementally_and_keep_raw_files(
    client: TestClient,
    project: Path,
    skill: Path,
):
    suite = _suite(client, project, skill)
    response = client.post(
        "/api/v1/experiments",
        json={
            "suite_id": suite["id"],
            "mode": "quick",
            "profile": {
                "name": "log-fixture",
                "runner_model": "fixture-model",
                "judge_model": "fixture-model",
                "network": False,
            },
        },
    )
    experiment = _wait(client, response.json()["id"])
    run = experiment["runs"][0]

    raw_logs = client.get(f"/api/v1/runs/{run['id']}/logs?mode=raw")
    assert raw_logs.status_code == 200, raw_logs.text
    payload = raw_logs.json()
    assert {record["source"] for record in payload["records"]} >= {
        "runner",
        "validator",
        "judge",
        "system",
    }
    assert any("runner fixture output" in record["text"] for record in payload["records"])

    resumed = client.get(
        f"/api/v1/runs/{run['id']}/logs?mode=raw&cursor={payload['next_cursor']}"
    )
    assert resumed.status_code == 200
    assert resumed.json()["records"] == []

    reset = client.get(f"/api/v1/runs/{run['id']}/logs?cursor=not-a-valid-cursor")
    assert reset.status_code == 200
    assert reset.json()["reset_required"] is True

    files = client.get(f"/api/v1/runs/{run['id']}/log-files")
    assert files.status_code == 200
    items = files.json()["items"]
    assert {item["name"] for item in items} >= {
        "fixture-runner.stdout.txt",
        "judge/fixture-judge.stdout.txt",
        "logs/index.jsonl",
    }
    assert client.get(items[0]["url"]).status_code == 200

    stdout_file = next(item for item in items if item["name"] == "fixture-runner.stdout.txt")
    artifact = client.app.state.settings.artifacts_dir / experiment["id"] / run["id"]
    prompt_dir = artifact / "invocations"
    prompt_dir.mkdir()
    (prompt_dir / "example.prompt.txt").write_text(
        'Please use api_key="test-secret"', encoding="utf-8"
    )
    prompt_url = f"/api/v1/runs/{run['id']}/log-files/invocations/example.prompt.txt"
    prompt_files = client.get(f"/api/v1/runs/{run['id']}/log-files").json()["items"]
    assert prompt_url in {item["url"] for item in prompt_files}
    assert "test-secret" not in client.get(f"{prompt_url}?preview=true").json()["content"]
    assert "test-secret" in client.get(f"{prompt_url}?preview=true&unmasked=true").json()["content"]
    LogWriter(artifact / "logs", scope="run", attempt=1).write(
        "runner", "stdout", 'api_key="diagnostic-secret"'
    )
    diagnostics = client.get(f"/api/v1/runs/{run['id']}/diagnostics")
    assert diagnostics.status_code == 200
    assert "diagnostic-secret" not in diagnostics.text
    assert "api_key" in diagnostics.text
    (artifact / stdout_file["name"]).write_text(
        "x" * MAX_LOG_READ_BYTES + "\napi_key=test-secret\n", encoding="utf-8"
    )
    preview = client.get(f"{stdout_file['url']}?preview=true")
    assert preview.status_code == 200
    assert preview.json()["truncated"] is True
    assert "api_key=***" in preview.json()["content"]
    assert "content-disposition" not in preview.headers
    unmasked = client.get(f"{stdout_file['url']}?preview=true&unmasked=true")
    assert "api_key=test-secret" in unmasked.json()["content"]

    experiment_logs = client.get(f"/api/v1/experiments/{experiment['id']}/logs")
    assert experiment_logs.status_code == 200
    assert any(record["source"] == "system" for record in experiment_logs.json()["records"])


def test_dirty_project_draft_returns_actionable_error(
    client: TestClient,
    project: Path,
    skill: Path,
):
    (project / "dirty.txt").write_text("dirty", encoding="utf-8")
    response = client.post(
        "/api/v1/rubric-drafts",
        json={
            "project_path": str(project),
            "skill_path": str(skill),
            "input": "Do work",
            "expected": "Good result",
        },
    )
    assert response.status_code == 400
    assert response.json()["code"] == "PROJECT_DIRTY"


def test_index_supports_expected_markdown_upload(client: TestClient):
    response = client.get("/")

    assert response.status_code == 200
    assert 'id="expectedFile"' in response.text
    assert 'accept=".md,.markdown,text/markdown,text/plain"' in response.text


def test_runtime_probe_is_cached_until_explicit_refresh(client: TestClient, monkeypatch):
    import aaw_skill_eval.api as api_module

    calls = 0

    def fake_run(arguments, **kwargs):
        nonlocal calls
        calls += 1
        return subprocess.CompletedProcess(arguments, 0, "codex-cli fixture\n", "")

    monkeypatch.setattr(api_module.subprocess, "run", fake_run)

    first = client.get("/api/v1/runtime")
    second = client.get("/api/v1/runtime")
    refreshed = client.get("/api/v1/runtime?refresh=true")

    assert first.status_code == 200
    assert second.json() == first.json()
    assert refreshed.status_code == 200
    assert calls == 2


def test_runner_timeout_ends_run_without_starting_judge(
    client: TestClient,
    project: Path,
    skill: Path,
):
    class TimeoutRunner:
        def run(self, **kwargs):
            return RunOutcome(
                exit_code=None,
                final_response="",
                events=[],
                duration_ms=600_000,
                error_kind="timeout",
                error_message="Runner produced no output before timeout",
            )

    class UnexpectedJudge:
        def evaluate(self, **kwargs):
            raise AssertionError("Judge must not run after a Runner timeout")

    client.app.state.orchestrator.runner = TimeoutRunner()
    client.app.state.orchestrator.judge = UnexpectedJudge()
    suite = _suite(client, project, skill)
    response = client.post(
        "/api/v1/experiments",
        json={
            "suite_id": suite["id"],
            "mode": "quick",
            "profile": {
                "name": "timeout-fixture",
                "runner_model": "fixture-model",
                "judge_model": "fixture-model",
            },
        },
    )
    experiment = _wait(client, response.json()["id"])
    assert experiment["status"] == "completed_with_failures"
    assert all(run["status"] == "timeout" for run in experiment["runs"])
    assert all(
        run["error_message"] == "Runner produced no output before timeout"
        for run in experiment["runs"]
    )


def test_infrastructure_failure_can_be_retried_once_without_losing_attempt(
    client: TestClient,
    project: Path,
    skill: Path,
):
    original = client.app.state.orchestrator.runner

    class FailOnceRunner:
        # pair-parallel execution calls the runner from two threads at once,
        # so the one-shot flag must be claimed atomically
        lock = threading.Lock()
        failed = False

        def run(self, **kwargs):
            with self.lock:
                should_fail = not self.failed
                self.failed = True
            if should_fail:
                return RunOutcome(
                    exit_code=None,
                    final_response="",
                    events=[],
                    duration_ms=25,
                    error_kind="infra_error",
                    error_message="fixture infrastructure failure",
                )
            return original.run(**kwargs)

    client.app.state.orchestrator.runner = FailOnceRunner()
    suite = _suite(client, project, skill)
    response = client.post(
        "/api/v1/experiments",
        json={
            "suite_id": suite["id"],
            "mode": "quick",
            "profile": {
                "name": "retry-fixture",
                "runner_model": "fixture-model",
                "judge_model": "fixture-model",
                "network": False,
            },
        },
    )
    experiment = _wait(client, response.json()["id"])
    assert experiment["status"] == "completed_with_failures"
    failed = next(run for run in experiment["runs"] if run["error_kind"] == "infra_error")

    retry = client.post(f"/api/v1/runs/{failed['id']}/retry")
    assert retry.status_code == 202, retry.text
    retried = None
    for _ in range(100):
        candidate = client.get(f"/api/v1/experiments/{experiment['id']}").json()
        candidate_run = next(item for item in candidate["runs"] if item["id"] == failed["id"])
        if candidate["status"] == "completed" and candidate_run["current_attempt"] == 2:
            retried = candidate
            break
        time.sleep(0.05)
    assert retried is not None, (
        candidate["status"],
        candidate_run["status"],
        candidate_run["current_stage"],
        candidate_run["error_kind"],
        candidate_run["error_message"],
        candidate_run["current_attempt"],
    )

    assert retried["status"] == "completed"
    run = next(item for item in retried["runs"] if item["id"] == failed["id"])
    assert run["current_attempt"] == 2
    assert run["status"] == "completed"
    assert run["attempts"][0]["status"] == "infra_error"
    assert run["attempts"][0]["error_message"] == "fixture infrastructure failure"


def test_active_run_can_be_cancelled_without_stopping_remaining_runs(
    client: TestClient,
    project: Path,
    skill: Path,
):
    original = client.app.state.orchestrator.runner
    release = threading.Event()

    class BlockingOnceRunner:
        # Under pair-parallel execution both runs of the block call run()
        # concurrently: exactly one blocks until it is cancelled (or released
        # as a safety net); the partner must keep running to completion.
        lock = threading.Lock()
        blocked_run_id: str | None = None

        def run(self, **kwargs):
            artifact_dir = Path(kwargs["artifact_dir"])
            run_id = (
                artifact_dir.parent.name
                if artifact_dir.name.startswith("attempt-")
                else artifact_dir.name
            )
            with self.lock:
                should_block = self.blocked_run_id is None
                if should_block:
                    self.blocked_run_id = run_id
            if not should_block:
                return original.run(**kwargs)
            while not kwargs["is_cancelled"]() and not release.is_set():
                kwargs["on_progress"]("heartbeat", "fixture process alive")
                time.sleep(0.01)
            if kwargs["is_cancelled"]():
                return RunOutcome(
                    exit_code=None,
                    final_response="",
                    events=[],
                    duration_ms=50,
                    error_kind="cancelled",
                    error_message="Run cancelled by user",
                )
            return original.run(**kwargs)

    runner = BlockingOnceRunner()
    client.app.state.orchestrator.runner = runner
    suite = _suite(client, project, skill)
    response = client.post(
        "/api/v1/experiments",
        json={
            "suite_id": suite["id"],
            "mode": "quick",
            "profile": {
                "name": "cancel-fixture",
                "runner_model": "fixture-model",
                "judge_model": "fixture-model",
                "network": False,
            },
        },
    )
    experiment_id = response.json()["id"]
    try:
        blocked_run_id = None
        for _ in range(500):
            with runner.lock:
                blocked_run_id = runner.blocked_run_id
            if blocked_run_id is not None:
                break
            time.sleep(0.02)
        assert blocked_run_id is not None

        cancelled = client.post(f"/api/v1/runs/{blocked_run_id}/cancel")
        assert cancelled.status_code == 202, cancelled.text
        finished = _wait(client, experiment_id)

        assert finished["status"] == "completed_with_failures"
        statuses = {run["id"]: run["status"] for run in finished["runs"]}
        assert statuses[blocked_run_id] == "cancelled"
        partner = next(run for run in finished["runs"] if run["id"] != blocked_run_id)
        assert partner["status"] == "completed"
    finally:
        release.set()
