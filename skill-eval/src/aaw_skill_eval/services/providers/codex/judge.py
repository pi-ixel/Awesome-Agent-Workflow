"""Codex CLI judge backend.

Blind LLM rubric judging through `codex exec` with a JSON schema constraint;
falls back to nothing — deterministic graders are handled elsewhere.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ....config import Settings
from ....schemas import CaseSpec, EvalProfile, GraderSpec
from ...observability.logs import LogCallback
from ...storage.artifacts import write_json
from ..base import CancelCallback, Judge, JudgeOutcome, JudgeScore, ProgressCallback
from ..protocols.jsonl import parse_jsonl
from .runner import CodexRunner, _config_args


class CodexJudge(Judge):
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.runner = CodexRunner(settings)

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
        _ = chrys_home_root  # codex judges have no chrys config home
        llm_graders = [grader for grader in graders if grader.type == "llm_rubric"]
        if not llm_graders:
            return JudgeOutcome()
        judge_dir = artifact_dir / "judge"
        judge_dir.mkdir(parents=True, exist_ok=True)
        schema_path = judge_dir / "schema.json"
        schema = {
            "type": "object",
            "additionalProperties": False,
            "required": ["candidate_id", "scores"],
            "properties": {
                "candidate_id": {"type": "string"},
                "scores": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["grader_id", "score", "evidence", "reasoning"],
                        "properties": {
                            "grader_id": {"type": "string"},
                            "score": {"type": "number", "minimum": 0, "maximum": 100},
                            "evidence": {"type": "string"},
                            "reasoning": {"type": "string"},
                        },
                    },
                },
            },
        }
        write_json(schema_path, schema)
        payload = {
            "candidate_id": anonymous_id,
            "task_input": case.input,
            "expected_effect": case.expected,
            "rubrics": [
                {"grader_id": grader.id, "name": grader.name, "rubric": grader.rubric}
                for grader in llm_graders
            ],
            "evidence": evidence,
        }
        prompt = (
            "你是独立的 Agent Skill 评测 Judge。候选产物已匿名化，你不知道它来自哪一组。"
            "只依据给定任务、预期效果、Rubric 和证据评分。每个 grader_id 必须恰好返回一次，"
            "分数范围 0-100。不要推测候选版本，不要奖励与 Rubric 无关的内容。\n\n"
            + json.dumps(payload, ensure_ascii=False, indent=2)
        )
        last_message = judge_dir / "result.json"
        arguments = [
            "exec",
            "--cd",
            str(judge_dir),
            "--skip-git-repo-check",
            "--ephemeral",
            "--json",
            "--ignore-user-config",
            "--ignore-rules",
            "--strict-config",
            "--sandbox",
            "read-only",
            "--model",
            profile.judge_model,
            "--output-schema",
            str(schema_path),
            "--output-last-message",
            str(last_message),
            *_config_args(profile, judge=True),
        ]
        code, stdout, stderr, _, timed_out, cancelled = self.runner._execute(
            arguments,
            prompt=prompt,
            cwd=judge_dir,
            state_dir=judge_dir / "codex-state",
            timeout_seconds=profile.timeout_seconds,
            stdout_path=judge_dir / "judge.jsonl",
            stderr_path=judge_dir / "judge.stderr.txt",
            on_progress=on_progress,
            on_log=on_log,
            log_source="judge",
            is_cancelled=is_cancelled,
        )
        events = parse_jsonl(stdout)
        if cancelled:
            return JudgeOutcome(events=events, error="Judge cancelled by user")
        if timed_out:
            return JudgeOutcome(events=events, error="Judge timed out")
        if code != 0 or not last_message.exists():
            return JudgeOutcome(
                events=events,
                error=(stderr.strip() or "Judge did not return structured output")[-3000:],
            )
        try:
            result = json.loads(last_message.read_text(encoding="utf-8"))
            if result.get("candidate_id") != anonymous_id:
                raise ValueError("candidate_id mismatch")
            by_id = {item["grader_id"]: item for item in result["scores"]}
            expected_ids = {grader.id for grader in llm_graders}
            if set(by_id) != expected_ids:
                raise ValueError("Judge grader ids do not match the rubric")
            scores = [
                JudgeScore(
                    grader_id=grader.id,
                    score=float(by_id[grader.id]["score"]),
                    evidence=str(by_id[grader.id]["evidence"]),
                    reasoning=str(by_id[grader.id]["reasoning"]),
                )
                for grader in llm_graders
            ]
            return JudgeOutcome(scores=scores, events=events)
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            return JudgeOutcome(events=events, error=f"Invalid Judge output: {exc}")
