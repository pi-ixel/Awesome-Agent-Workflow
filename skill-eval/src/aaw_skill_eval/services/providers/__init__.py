"""提供商层：Runner/Judge 契约、协议工具与各平台实现，注册表工厂在此汇出。"""

from ...config import Settings
from ...errors import InfrastructureError
from .base import (
    CancelCallback,
    Judge,
    JudgeOutcome,
    JudgeScore,
    ProgressCallback,
    Runner,
    RunOutcome,
    command_prefix,
    judge_scores,
)
from .chrys import ChrysJudge, ChrysRunner
from .codex import CodexJudge, CodexRunner

_RUNNERS: dict[str, type[Runner]] = {"chrys": ChrysRunner, "codex": CodexRunner}
_JUDGES: dict[str, type[Judge]] = {"chrys": ChrysJudge, "codex": CodexJudge}


def build_runner(settings: Settings, provider: str) -> Runner:
    """按注册表构造 runner；查不到对应平台时抛 InfrastructureError。"""
    try:
        return _RUNNERS[provider](settings)
    except KeyError:
        raise InfrastructureError(
            "PROVIDER_UNKNOWN", f"Unknown runner provider: {provider}"
        ) from None


def build_judge(settings: Settings, provider: str) -> Judge:
    """按注册表构造 judge；查不到对应平台时抛 InfrastructureError。"""
    try:
        return _JUDGES[provider](settings)
    except KeyError:
        raise InfrastructureError(
            "PROVIDER_UNKNOWN", f"Unknown judge provider: {provider}"
        ) from None


__all__ = [
    "CancelCallback",
    "ChrysJudge",
    "ChrysRunner",
    "CodexJudge",
    "CodexRunner",
    "Judge",
    "JudgeOutcome",
    "JudgeScore",
    "ProgressCallback",
    "RunOutcome",
    "Runner",
    "build_judge",
    "build_runner",
    "command_prefix",
    "judge_scores",
]
