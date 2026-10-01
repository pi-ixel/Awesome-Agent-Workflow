from __future__ import annotations

import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from aaw_skill_eval.config import Settings
from aaw_skill_eval.main import create_app
from aaw_skill_eval.services.runner import JudgeOutcome, JudgeScore, RunOutcome


def _git(path: Path, *args: str) -> None:
    result = subprocess.run(
        ["git", "-C", str(path), *args],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "project"
    root.mkdir()
    _git(root, "init")
    _git(root, "config", "user.email", "eval@example.test")
    _git(root, "config", "user.name", "Skill Eval")
    (root / "README.md").write_text("# fixture\n", encoding="utf-8")
    _git(root, "add", "README.md")
    _git(root, "commit", "-m", "fixture")
    return root


@pytest.fixture
def skill(tmp_path: Path) -> Path:
    root = tmp_path / "example-skill"
    root.mkdir()
    (root / "SKILL.md").write_text(
        "---\nname: example-skill\ndescription: Improve fixture output.\n---\n\n"
        "Create a useful result.\n",
        encoding="utf-8",
    )
    references = root / "references"
    references.mkdir()
    (references / "guide.md").write_text("Evidence first.\n", encoding="utf-8")
    return root


class FakeRunner:
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
        if on_progress:
            on_progress("activity", "Runner fixture produced output")
        label = "skill" if skill_name else "no-skill"
        output = f"runner fixture output for {label}\n"
        artifact_dir.mkdir(parents=True, exist_ok=True)
        (artifact_dir / "fixture-runner.stdout.txt").write_text(output, encoding="utf-8")
        if on_log:
            on_log("runner", "stdout", output)
        (workspace / "result.md").write_text(f"result from {label}\n", encoding="utf-8")
        return RunOutcome(
            exit_code=0,
            final_response=f"completed with {label}",
            events=[],
            duration_ms=123,
            input_tokens=10,
            output_tokens=20,
        )


class FakeJudge:
    def evaluate(
        self,
        *,
        anonymous_id,
        case,
        graders,
        evidence,
        profile,
        artifact_dir,
        on_progress=None,
        on_log=None,
        is_cancelled=None,
        chrys_home_root=None,
    ):
        if on_progress:
            on_progress("activity", "Judge fixture produced output")
        output = "judge fixture output\n"
        judge_dir = artifact_dir / "judge"
        judge_dir.mkdir(parents=True, exist_ok=True)
        (judge_dir / "fixture-judge.stdout.txt").write_text(output, encoding="utf-8")
        if on_log:
            on_log("judge", "stdout", output)
        score = 88 if "with skill" in evidence["final_response"] else 55
        return JudgeOutcome(
            scores=[
                JudgeScore(
                    grader_id=grader.id,
                    score=score,
                    evidence="fixture evidence",
                    reasoning="fixture reasoning",
                )
                for grader in graders
                if grader.type == "llm_rubric"
            ]
        )


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    settings = Settings(
        data_dir=tmp_path / "data",
        codex_command="codex",
        chrys_command="missing-chrys-for-tests",
        chrys_home=tmp_path / "chrys",
        max_skill_bytes=1024 * 1024,
    )
    app = create_app(settings)
    app.state.orchestrator.runner = FakeRunner()
    app.state.orchestrator.judge = FakeJudge()
    with TestClient(app, raise_server_exceptions=True) as test_client:
        yield test_client
    app.state.engine.dispose()
