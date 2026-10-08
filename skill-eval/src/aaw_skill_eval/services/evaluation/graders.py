from __future__ import annotations

import fnmatch
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from ...schemas import CaseSpec
from ..observability.logs import LogCallback
from ..providers.base import JudgeOutcome
from ..workspace.repository import run_trusted_command


@dataclass
class ScoreComponent:
    grader_id: str
    name: str
    grader_type: str
    score: float
    weight: float
    hard_gate: bool
    passed: bool
    evidence: str
    reasoning: str = ""
    invalid: bool = False


def _safe_relative(workspace: Path, raw: str) -> Path | None:
    candidate = (workspace / raw).resolve()
    try:
        candidate.relative_to(workspace.resolve())
    except ValueError:
        return None
    return candidate


EXECUTION_TIME_GRADER_ID = "__execution_time__"


def execution_time_component(case: CaseSpec, duration_ms: int | None) -> ScoreComponent | None:
    """把 run 总耗时按用例的 time_scoring 配置折算为「执行效率」分量。

    ≤target_seconds 满分、≥limit_seconds 零分、中间线性；用例未配置或无时长数据时
    返回 None（不计入评价标准，历史实验不受影响）。
    """
    spec = case.time_scoring
    if spec is None or duration_ms is None:
        return None
    seconds = duration_ms / 1000
    if seconds <= spec.target_seconds:
        ratio = 1.0
    elif seconds >= spec.limit_seconds:
        ratio = 0.0
    else:
        ratio = (spec.limit_seconds - seconds) / (spec.limit_seconds - spec.target_seconds)
    score = round(100.0 * ratio, 1)
    return ScoreComponent(
        grader_id=EXECUTION_TIME_GRADER_ID,
        name="执行效率",
        grader_type="duration",
        score=score,
        weight=spec.weight,
        hard_gate=False,
        passed=score >= 60,
        evidence=(
            f"总耗时 {seconds:.0f}s；计分窗口：≤{spec.target_seconds}s → 100 分，"
            f"≥{spec.limit_seconds}s → 0 分，线性折算（权重 {spec.weight:g}）"
        ),
    )


def evaluate_deterministic(
    case: CaseSpec,
    *,
    workspace: Path,
    changed_files: list[str],
    artifact_dir: Path | None = None,
    on_log: LogCallback | None = None,
) -> tuple[list[ScoreComponent], list[dict[str, Any]]]:
    components: list[ScoreComponent] = []
    command_results: list[dict[str, Any]] = []
    for grader in case.graders:
        if grader.type == "llm_rubric":
            continue
        if grader.type == "command":
            safe_id = "".join(
                character if character.isalnum() or character in {"-", "_"} else "-"
                for character in grader.id
            )
            stdout_path = (
                artifact_dir / "logs" / f"validator-{safe_id}.stdout.txt"
                if artifact_dir is not None
                else None
            )
            stderr_path = (
                artifact_dir / "logs" / f"validator-{safe_id}.stderr.txt"
                if artifact_dir is not None
                else None
            )
            if on_log is not None:
                on_log("validator", "event", f"开始验证器：{grader.name}")
            result = run_trusted_command(
                grader.command or "",
                workspace,
                grader.timeout_seconds,
                on_log=on_log,
                source="validator",
                stdout_path=stdout_path,
                stderr_path=stderr_path,
            )
            command_results.append(result)
            timed_out = bool(result.get("timed_out"))
            passed = result.get("exit_code") == 0 and not timed_out
            if on_log is not None:
                on_log(
                    "validator",
                    "event",
                    f"验证器结束：{grader.name}（{'通过' if passed else '失败'}）",
                )
            evidence = (
                f"exit_code={result.get('exit_code')}\n"
                f"stdout:\n{result.get('stdout', '')[-4000:]}\n"
                f"stderr:\n{result.get('stderr', '')[-4000:]}"
            )
            components.append(
                ScoreComponent(
                    grader_id=grader.id,
                    name=grader.name,
                    grader_type=grader.type,
                    score=100.0 if passed else 0.0,
                    weight=grader.weight,
                    hard_gate=grader.hard_gate,
                    passed=passed,
                    evidence=evidence,
                    invalid=timed_out,
                    reasoning="Validator timed out" if timed_out else "",
                )
            )
        elif grader.type == "file_exists":
            candidate = _safe_relative(workspace, grader.path or "")
            passed = bool(candidate and candidate.exists())
            if on_log is not None:
                on_log(
                    "validator",
                    "event",
                    f"文件检查：{grader.path or ''}（{'通过' if passed else '失败'}）",
                )
            components.append(
                ScoreComponent(
                    grader_id=grader.id,
                    name=grader.name,
                    grader_type=grader.type,
                    score=100.0 if passed else 0.0,
                    weight=grader.weight,
                    hard_gate=grader.hard_gate,
                    passed=passed,
                    evidence=str(candidate) if candidate else "Unsafe path rejected",
                    invalid=candidate is None,
                )
            )
        elif grader.type == "forbidden_changes":
            matched = sorted(
                {
                    path
                    for path in changed_files
                    for pattern in grader.patterns
                    if fnmatch.fnmatch(path, pattern)
                }
            )
            passed = not matched
            if on_log is not None:
                on_log(
                    "validator",
                    "event",
                    f"变更约束检查：{grader.name}（{'通过' if passed else '失败'}）",
                )
            components.append(
                ScoreComponent(
                    grader_id=grader.id,
                    name=grader.name,
                    grader_type=grader.type,
                    score=100.0 if passed else 0.0,
                    weight=grader.weight,
                    hard_gate=grader.hard_gate,
                    passed=passed,
                    evidence="No forbidden changes" if passed else "\n".join(matched),
                )
            )
    return components, command_results


def merge_scores(
    case: CaseSpec,
    deterministic: list[ScoreComponent],
    judge: JudgeOutcome,
    extra: ScoreComponent | None = None,
) -> dict[str, Any]:
    by_id = {component.grader_id: component for component in deterministic}
    grader_by_id = {grader.id: grader for grader in case.graders}
    for result in judge.scores:
        grader = grader_by_id[result.grader_id]
        by_id[result.grader_id] = ScoreComponent(
            grader_id=grader.id,
            name=grader.name,
            grader_type=grader.type,
            score=max(0.0, min(100.0, result.score)),
            weight=grader.weight,
            hard_gate=grader.hard_gate,
            passed=result.score >= 60,
            evidence=result.evidence,
            reasoning=result.reasoning,
        )
    components = [by_id[grader.id] for grader in case.graders if grader.id in by_id]
    # 合成分量（如「执行效率」执行时间分）不来自 case.graders，追加在评分维度之后
    if extra is not None and all(
        component.grader_id != extra.grader_id for component in components
    ):
        components.append(extra)
    invalid = judge.error is not None or any(component.invalid for component in components)
    quality = [component for component in components if not component.hard_gate]
    total_weight = sum(component.weight for component in quality)
    quality_score = (
        sum(component.score * component.weight for component in quality) / total_weight
        if total_weight
        else None
    )
    gates = [component for component in components if component.hard_gate]
    return {
        "quality_score": quality_score,
        "hard_gates_passed": sum(1 for component in gates if component.passed),
        "hard_gates_total": len(gates),
        "invalid": invalid,
        "judge_error": judge.error,
        "components": [asdict(component) for component in components],
    }
