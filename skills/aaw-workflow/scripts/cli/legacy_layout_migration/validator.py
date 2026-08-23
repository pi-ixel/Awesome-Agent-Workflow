"""Final deterministic validation for every migration resolution path."""

from __future__ import annotations

from ..models import Workflow
from .constants import CURRENT_LAYOUT_VERSION, LAYOUT_VERSION_KEY
from .detector import iter_workflow_paths, looks_like_legacy_path
from .planner import MigrationPlan


class MigrationValidationError(RuntimeError):
    pass


def validate_plan(plan: MigrationPlan) -> None:
    if plan.unresolved:
        raise MigrationValidationError("仍有无法确定新位置的旧成果物")
    sources = [move.source for move in plan.moves]
    targets = [move.target for move in plan.moves]
    if len(sources) != len(set(sources)) or len(targets) != len(set(targets)):
        raise MigrationValidationError("迁移必须保持文件的一对一关系")


def validate_migrated_workflow(workflow: Workflow) -> None:
    if workflow.vars.get(LAYOUT_VERSION_KEY) != CURRENT_LAYOUT_VERSION:
        raise MigrationValidationError("工作流未切换到新的成果物目录")
    for step in workflow.steps:
        if step.vars.get(LAYOUT_VERSION_KEY) != CURRENT_LAYOUT_VERSION:
            raise MigrationValidationError(f"step {step.id} 未切换到新的成果物目录")
    remaining = [path for path in iter_workflow_paths(workflow) if looks_like_legacy_path(path, workflow.sr)]
    if remaining:
        raise MigrationValidationError("工作流中仍有旧成果物路径")
