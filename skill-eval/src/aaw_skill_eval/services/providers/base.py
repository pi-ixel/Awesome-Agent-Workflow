"""Provider contract and shared building blocks for all runner/judge backends.

This module is the cross-provider contract: outcome dataclasses, the argv
helper shared by every backend, the JSON judge-score parser, and the abstract
Runner/Judge interfaces. Platform-specific implementations live in
``providers/codex`` and ``providers/chrys``; cross-backend process/protocol
utilities live in ``providers/protocols``.
"""

from __future__ import annotations

import abc
import json
import os
import shutil
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from ...schemas import CaseSpec, EvalProfile, GraderSpec
from ..observability.logs import LogCallback

ProgressCallback = Callable[[str, str], None]
CancelCallback = Callable[[], bool]


@dataclass
class RunOutcome:
    exit_code: int | None
    final_response: str
    events: list[dict[str, Any]]
    duration_ms: int
    input_tokens: int | None = None
    output_tokens: int | None = None
    thread_id: str | None = None
    error_kind: str | None = None
    error_message: str | None = None
    turns: int = 1
    skill_invoked: Literal["yes", "no", "unknown"] = "unknown"
    skills_loaded: list[str] = field(default_factory=list)


@dataclass
class JudgeScore:
    grader_id: str
    score: float
    evidence: str
    reasoning: str


@dataclass
class JudgeOutcome:
    scores: list[JudgeScore] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None


def _workspace_timeout_note(stats: dict[str, Any] | None) -> str:
    """Explain whether the agent was still writing files when the timeout hit."""
    if not stats:
        return ""
    changed = stats.get("changed_files") or 0
    age = stats.get("last_change_age_seconds")
    if changed and age is not None:
        return (
            f"；超时前 {max(0, round(age))}s 工作区仍有文件更新"
            f"（累计 {changed} 个文件变动），Agent 无输出但仍在工作，可考虑提高单轮超时"
        )
    if changed:
        return f"；超时前工作区累计有 {changed} 个文件变动"
    return "；超时期间工作区无任何文件改动（无输出且无活动）"


def command_prefix(command: str) -> list[str]:
    resolved = shutil.which(command) or command
    suffix = Path(resolved).suffix.lower()
    if os.name == "nt" and suffix in {".cmd", ".bat"}:
        return ["cmd.exe", "/d", "/s", "/c", resolved]
    if os.name == "nt" and suffix == ".ps1":
        return ["powershell.exe", "-NoProfile", "-NonInteractive", "-File", resolved]
    return [resolved]


def _toml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _json_object(raw: str) -> dict[str, Any]:
    candidates = [raw.strip()]
    if "```" in raw:
        chunks = raw.split("```")
        candidates.extend(chunk.removeprefix("json").strip() for chunk in chunks[1::2])
    start, end = raw.find("{"), raw.rfind("}")
    if start >= 0 and end > start:
        candidates.append(raw[start : end + 1])
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise ValueError("response does not contain a JSON object")


def judge_scores(
    raw: str,
    *,
    anonymous_id: str,
    graders: list[GraderSpec],
) -> list[JudgeScore]:
    result = _json_object(raw)
    if result.get("candidate_id") != anonymous_id:
        raise ValueError("candidate_id mismatch")
    items = result.get("scores")
    if not isinstance(items, list):
        raise ValueError("scores must be an array")
    by_id = {
        item.get("grader_id"): item
        for item in items
        if isinstance(item, dict) and isinstance(item.get("grader_id"), str)
    }
    expected_ids = {grader.id for grader in graders}
    if set(by_id) != expected_ids:
        raise ValueError("Judge grader ids do not match the rubric")
    scores = []
    for grader in graders:
        item = by_id[grader.id]
        score = float(item.get("score"))
        if not 0 <= score <= 100:
            raise ValueError(f"score out of range for {grader.id}")
        scores.append(
            JudgeScore(
                grader_id=grader.id,
                score=score,
                evidence=str(item.get("evidence", "")),
                reasoning=str(item.get("reasoning", "")),
            )
        )
    return scores


class Runner(abc.ABC):
    """Executes one evaluation case against a workspace and returns its outcome."""

    @abc.abstractmethod
    def run(
        self,
        *,
        workspace: Path,
        artifact_dir: Path,
        case: CaseSpec,
        profile: EvalProfile,
        skill_name: str | None,
        on_progress: ProgressCallback | None = None,
        on_log: LogCallback | None = None,
        is_cancelled: CancelCallback | None = None,
        chrys_home_root: Path | None = None,
    ) -> RunOutcome:
        """Run ``case`` inside ``workspace`` and record artifacts under ``artifact_dir``."""


class Judge(abc.ABC):
    """Blindly scores a candidate's evidence against the case rubrics."""

    @abc.abstractmethod
    def evaluate(
        self,
        *,
        anonymous_id: str,
        case: CaseSpec,
        graders: list[GraderSpec],
        evidence: dict[str, Any],
        profile: EvalProfile,
        artifact_dir: Path,
        on_progress: ProgressCallback | None = None,
        on_log: LogCallback | None = None,
        is_cancelled: CancelCallback | None = None,
        chrys_home_root: Path | None = None,
    ) -> JudgeOutcome:
        """Score ``evidence`` with ``graders`` and record artifacts under ``artifact_dir``."""
