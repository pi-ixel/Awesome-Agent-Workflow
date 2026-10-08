"""Conclusion rules: hard gates outrank quality scores; missing trials make a
group's score provisional and its deltas non-formal."""

from __future__ import annotations

import threading
import time
from pathlib import Path

from fastapi.testclient import TestClient
from test_api_flow import _suite, _wait

from aaw_skill_eval.services.providers.base import RunOutcome


def _launch(client: TestClient, suite_id: str, *, mode: str = "quick", name: str) -> dict:
    response = client.post(
        "/api/v1/experiments",
        json={
            "suite_id": suite_id,
            "mode": mode,
            "profile": {
                "name": name,
                "runner_model": "fixture-model",
                "judge_model": "fixture-model",
                "network": False,
            },
        },
    )
    assert response.status_code == 202, response.text
    return _wait(client, response.json()["id"])


def test_solid_conclusion_when_gates_pass_and_trials_complete(
    client: TestClient, project: Path, skill: Path
) -> None:
    suite = _suite(client, project, skill)
    experiment = _launch(client, suite["id"], name="conclusion-solid")

    assert experiment["status"] == "completed"
    conclusion = experiment["conclusion"]
    assert conclusion["verdict"] == "solid"
    assert conclusion["expected_trials_per_group"] == 1
    assert conclusion["formal_deltas"] == {"no_skill": True, "baseline": False}
    for group in ("no_skill", "current"):
        info = conclusion["groups"][group]
        assert info["provisional"] is False
        assert info["missing"] is False
        assert info["gates_failed"] is False
        assert info["gates_total"] == 1 and info["gates_passed"] == 1
    assert conclusion["groups"]["baseline"]["missing"] is True


def test_gate_failure_keeps_scores_but_verdict_is_gates_failed(
    client: TestClient, project: Path, skill: Path
) -> None:
    class NoResultFileRunner:
        """Completes the turn but never creates result.md, so the hard
        file_exists gate fails while the LLM rubric still scores the run."""

        def run(self, **kwargs):
            if kwargs.get("on_progress"):
                kwargs["on_progress"]("activity", "runner produced output")
            if kwargs.get("on_log"):
                kwargs["on_log"]("runner", "stdout", "no result file\n")
            label = "skill" if kwargs.get("skill_name") else "no-skill"
            return RunOutcome(
                exit_code=0,
                final_response=f"completed with {label}",
                events=[],
                duration_ms=50,
            )

    client.app.state.orchestrator.runner = NoResultFileRunner()
    suite = _suite(client, project, skill)
    experiment = _launch(client, suite["id"], name="conclusion-gates-failed")

    assert experiment["status"] == "completed"
    conclusion = experiment["conclusion"]
    # gates win over quality: verdict is gates_failed even though scores exist
    assert conclusion["verdict"] == "gates_failed"
    current = conclusion["groups"]["current"]
    assert current["gates_failed"] is True
    assert current["gates_total"] == 1 and current["gates_passed"] == 0
    # scores are kept for analysis
    assert current["score"] == 88
    assert experiment["scores"]["current"] == 88
    # gates failing does not make the comparison provisional (trials complete)
    assert conclusion["formal_deltas"]["no_skill"] is True


def test_missing_trials_make_scores_provisional_and_deltas_non_formal(
    client: TestClient, project: Path, skill: Path
) -> None:
    original = client.app.state.orchestrator.runner

    class OneTrialPerGroupRunner:
        """Runs succeed for trial 1 (both groups), then time out for the
        remaining formal trials, leaving every group at 1/3 completed.

        The counter is guarded by a lock: the trial-1 pair runs in two
        threads under pair-parallel execution, and an unsynchronized
        ``calls += 1`` can lose updates and let trial 2 succeed too.
        """

        lock = threading.Lock()
        calls = 0

        def run(self, **kwargs):
            with self.lock:
                type(self).calls += 1
                call_index = self.calls
            if call_index <= 2:
                return original.run(**kwargs)
            return RunOutcome(
                exit_code=None,
                final_response="",
                events=[],
                duration_ms=600_000,
                error_kind="timeout",
                error_message="Runner produced no output before timeout",
            )

    client.app.state.orchestrator.runner = OneTrialPerGroupRunner()
    suite = _suite(client, project, skill)
    experiment = _launch(client, suite["id"], mode="formal", name="conclusion-provisional")

    assert experiment["status"] == "completed_with_failures"
    conclusion = experiment["conclusion"]
    assert conclusion["expected_trials_per_group"] == 3
    assert conclusion["verdict"] == "provisional"
    for group in ("no_skill", "current"):
        info = conclusion["groups"][group]
        assert info["completed_trials"] == 1
        assert info["provisional"] is True
        # the score is still computed from the completed trial
        assert info["score"] is not None
    # deltas that involve a provisional group are not formal
    assert conclusion["formal_deltas"]["no_skill"] is False
    # ...but the delta value itself is still shown for analysis
    assert experiment["delta_no_skill"] == 33


def test_no_completed_runs_give_no_score_verdict(
    client: TestClient, project: Path, skill: Path
) -> None:
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

    client.app.state.orchestrator.runner = TimeoutRunner()
    suite = _suite(client, project, skill)
    experiment = _launch(client, suite["id"], name="conclusion-no-score")

    assert experiment["status"] == "completed_with_failures"
    conclusion = experiment["conclusion"]
    assert conclusion["verdict"] == "no_score"
    assert conclusion["groups"]["current"]["score"] is None
    assert conclusion["groups"]["current"]["completed_trials"] == 0
    assert conclusion["formal_deltas"]["no_skill"] is False


def test_conclusion_appears_in_experiment_list_too(
    client: TestClient, project: Path, skill: Path
) -> None:
    suite = _suite(client, project, skill)
    experiment = _launch(client, suite["id"], name="conclusion-listed")
    time.sleep(0.1)

    listed = client.get("/api/v1/experiments?limit=50").json()["items"]
    item = next(entry for entry in listed if entry["id"] == experiment["id"])
    assert item["conclusion"]["verdict"] == "solid"


def test_detail_page_is_hash_routed_not_a_modal() -> None:
    """The experiment detail must be a standalone view reachable via
    #/experiments/{id}, not the old modal dialog."""
    static_dir = Path(__file__).resolve().parents[1] / "src" / "aaw_skill_eval" / "static"
    index = (static_dir / "index.html").read_text(encoding="utf-8")
    app = (static_dir / "app.js").read_text(encoding="utf-8")

    assert 'id="experimentView"' in index
    assert 'id="homeView"' in index
    assert 'id="backToList"' in index
    assert 'id="detailBody"' in index
    assert "detailModal" not in index, "the detail modal must be gone from the page"
    assert "detailModal" not in app, "app.js must not reference the removed modal"

    # hash routing: navigate + back + hashchange wiring
    assert "#/experiments/" in app
    assert "hashchange" in app
    assert "navigateToExperiment" in app
    # the comparison matrix and conclusion strip are rendered on the page
    assert "comparisonMarkup" in app and "conclusionMarkup" in app
    assert 'id="detailComparisonBody"' in app
    # judge conversation entry points open the read-only replay panel
    assert "data-judge-log" in app and "openConversationAt" in app and "toggleConversation" in app
    # human reviews are displayed alongside automated scores
    assert "caseReviewsMarkup" in app and "run-reviews" in app
