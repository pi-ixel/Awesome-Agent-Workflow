"""Chrys 提供商实现包：ACP 驱动的 Runner/Judge 与运行时配置管理。"""

from .judge import ChrysJudge
from .runner import ChrysRunner, chrys_error_text
from .runtime import (
    EXPERIMENT_TEMPLATE_DIR,
    ISOLATED_HOME_DIR,
    JUDGE_PROFILE_ID,
    JUDGE_PROFILE_NAME,
    MANAGED_MARKER,
    RUN_CHRYS_HOME_DIR,
    RUNNER_PROFILE_ID,
    RUNNER_PROFILE_NAME,
    ChrysRuntime,
    enrich_profile,
    experiment_chrys_template_dir,
    materialize_run_chrys_home,
    prepare_experiment_chrys_template,
    prepare_isolated_home,
    verify_profile,
)

__all__ = [
    "EXPERIMENT_TEMPLATE_DIR",
    "ISOLATED_HOME_DIR",
    "JUDGE_PROFILE_ID",
    "JUDGE_PROFILE_NAME",
    "MANAGED_MARKER",
    "RUN_CHRYS_HOME_DIR",
    "RUNNER_PROFILE_ID",
    "RUNNER_PROFILE_NAME",
    "ChrysJudge",
    "ChrysRuntime",
    "ChrysRunner",
    "chrys_error_text",
    "enrich_profile",
    "experiment_chrys_template_dir",
    "materialize_run_chrys_home",
    "prepare_experiment_chrys_template",
    "prepare_isolated_home",
    "verify_profile",
]
