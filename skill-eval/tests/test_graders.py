from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from aaw_skill_eval.schemas import CaseSpec, GraderSpec, TimeScoringSpec
from aaw_skill_eval.services.evaluation.graders import (
    EXECUTION_TIME_GRADER_ID,
    evaluate_deterministic,
    execution_time_component,
    merge_scores,
)
from aaw_skill_eval.services.providers.base import JudgeOutcome, JudgeScore


def test_quality_score_and_hard_gate_are_independent(tmp_path: Path):
    case = CaseSpec(
        id="case-1",
        name="Fixture",
        input="Do work",
        expected="Good result",
        graders=[
            GraderSpec(
                id="no-prod",
                type="forbidden_changes",
                name="No production changes",
                hard_gate=True,
                patterns=["src/**"],
            ),
            GraderSpec(
                id="quality",
                type="llm_rubric",
                name="Quality",
                weight=100,
                rubric="Judge quality",
            ),
        ],
    )
    deterministic, _ = evaluate_deterministic(
        case,
        workspace=tmp_path,
        changed_files=["src/app.py"],
    )
    result = merge_scores(
        case,
        deterministic,
        JudgeOutcome(scores=[JudgeScore("quality", 92, "strong", "complete")]),
    )
    assert result["quality_score"] == 92
    assert result["hard_gates_passed"] == 0
    assert result["hard_gates_total"] == 1


def test_command_timeout_marks_grader_invalid(tmp_path: Path):
    case = CaseSpec(
        id="case-1",
        name="Fixture",
        input="Do work",
        expected="Good result",
        graders=[
            GraderSpec(
                id="check",
                type="command",
                name="Check",
                weight=100,
                command='python -c "import time; time.sleep(2)"',
                timeout_seconds=1,
            )
        ],
    )
    components, _ = evaluate_deterministic(case, workspace=tmp_path, changed_files=[])
    result = merge_scores(case, components, JudgeOutcome())
    assert result["invalid"] is True


def _timed_case() -> CaseSpec:
    return CaseSpec(
        id="case-1",
        name="Fixture",
        input="Do work",
        expected="Good result",
        time_scoring=TimeScoringSpec(target_seconds=600, limit_seconds=1800, weight=10),
        graders=[
            GraderSpec(
                id="quality",
                type="llm_rubric",
                name="Quality",
                weight=90,
                rubric="Judge quality",
            )
        ],
    )


def test_execution_time_component_linear_mapping():
    case = _timed_case()
    full = execution_time_component(case, 300_000)  # 5 分钟 ≤ target → 100
    mid = execution_time_component(case, 1_200_000)  # 20 分钟 → 窗口中点 → 50
    zero = execution_time_component(case, 1_800_000)  # 30 分钟 = limit → 0
    over = execution_time_component(case, 3_600_000)  # 超窗 → 仍为 0
    assert full.score == 100.0 and full.passed is True
    assert mid.score == 50.0
    assert zero.score == 0.0 and over.score == 0.0
    assert over.grader_id == EXECUTION_TIME_GRADER_ID
    assert over.grader_type == "duration"
    assert over.weight == 10
    assert over.hard_gate is False
    assert "1800" in over.evidence


def test_execution_time_component_skipped_when_unconfigured_or_missing():
    plain = CaseSpec(
        id="case-1",
        name="Fixture",
        input="Do work",
        expected="Good result",
        graders=[
            GraderSpec(
                id="quality",
                type="llm_rubric",
                name="Quality",
                weight=100,
                rubric="Judge quality",
            )
        ],
    )
    assert execution_time_component(plain, 60_000) is None  # 未配置 time_scoring
    assert execution_time_component(_timed_case(), None) is None  # 无时长数据


def test_time_scoring_requires_limit_greater_than_target():
    with pytest.raises(ValidationError):
        TimeScoringSpec(target_seconds=1800, limit_seconds=1800)


def test_time_component_enters_weighted_quality(tmp_path: Path):
    case = _timed_case()
    deterministic, _ = evaluate_deterministic(case, workspace=tmp_path, changed_files=[])
    result = merge_scores(
        case,
        deterministic,
        JudgeOutcome(scores=[JudgeScore("quality", 90, "ok", "done")]),
        extra=execution_time_component(case, 1_200_000),
    )
    # 90×90 + 50×10 → 加权均值 86.0
    assert result["quality_score"] == 86.0
    time_components = [
        component
        for component in result["components"]
        if component["grader_id"] == EXECUTION_TIME_GRADER_ID
    ]
    assert len(time_components) == 1
    assert time_components[0]["grader_type"] == "duration"
    assert result["hard_gates_total"] == 0
