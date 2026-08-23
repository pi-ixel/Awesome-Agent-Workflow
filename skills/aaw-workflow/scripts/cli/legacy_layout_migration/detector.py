"""Detection and user-facing explanation for legacy artifact layouts."""

from __future__ import annotations

from pathlib import Path, PurePosixPath

from ..models import Workflow
from .constants import CURRENT_LAYOUT_VERSION, LAYOUT_VERSION_KEY


def iter_workflow_paths(workflow: Workflow):
    for step in workflow.steps:
        for direction in ("input", "output"):
            for item in getattr(step, direction):
                path = item.get("path")
                if path:
                    yield str(path).replace("\\", "/")


def looks_like_legacy_path(path: str, sr: str) -> bool:
    parts = PurePosixPath(path).parts
    try:
        sr_index = parts.index(sr)
    except ValueError:
        return False
    relative = parts[sr_index + 1 :]
    if len(relative) == 3 and relative[1].endswith("_tasks") and relative[2] == "overview.md":
        return True
    if len(relative) != 2:
        return False
    filename = relative[-1]
    return filename.endswith(
        (
            "模块详细设计说明书.context.md",
            "模块详细设计说明书.md",
            "模块测试用例设计.md",
            "模块设计门禁结果.md",
        )
    )


def _disk_contains_legacy_paths(repo_root: Path, workflow: Workflow) -> bool:
    sr_root = repo_root / ".sdd" / workflow.sr
    if not sr_root.exists():
        return False
    return any(
        looks_like_legacy_path(candidate.relative_to(repo_root).as_posix(), workflow.sr)
        for candidate in sr_root.rglob("*.md")
    )


def requires_migration(workflow: Workflow, repo_root: Path | None = None) -> bool:
    if workflow.vars.get(LAYOUT_VERSION_KEY) != CURRENT_LAYOUT_VERSION:
        return True
    if any(looks_like_legacy_path(path, workflow.sr) for path in iter_workflow_paths(workflow)):
        return True
    return repo_root is not None and _disk_contains_legacy_paths(repo_root, workflow)


def _display_scope(workflow: Workflow) -> tuple[str, str, str, str]:
    merged = dict(workflow.vars)
    for step in workflow.steps:
        for key, value in step.vars.items():
            if value not in (None, ""):
                merged.setdefault(key, value)
        if merged.get("AR") and merged.get("模块组名") and merged.get("需求短名"):
            break
    return (
        str(merged.get("SR") or workflow.sr),
        str(merged.get("AR") or "{AR}"),
        str(merged.get("模块组名") or "{模块组名}"),
        str(merged.get("需求短名") or "{需求短名}"),
    )


def format_layout_notice(workflow: Workflow) -> str:
    sr, ar, group, requirement = _display_scope(workflow)
    root = f".sdd/{sr}/{ar}/"
    return f"""为了让同一模块的设计、测试、门禁和任务文档集中存放，我们更新了成果物的组织结构。

当前工作流所在的 SR 仍存在旧目录中的成果物，需要先完成迁移。

旧结构：
{root}
├── {ar}-{requirement}-{group}模块详细设计说明书.context.md
├── {ar}-{requirement}-{group}模块详细设计说明书.md
├── {ar}-{requirement}-{group}模块测试用例设计.md
├── {ar}-{requirement}-{group}模块设计门禁结果.md
└── {group}_tasks/
    └── overview.md

新结构：
{root}
└── {group}/
    ├── .context/
    │   ├── 详细设计上下文.md
    │   └── 模块设计门禁结果.md
    ├── 模块详细设计说明书.md
    ├── 模块测试用例设计.md
    └── tasks-overview.md

查看并执行迁移：
  aaw migrate-layout --sr {workflow.sr} --json
  aaw migrate-layout --sr {workflow.sr} --apply --json"""


def migration_notice(workflow: Workflow, repo_root: Path | None = None) -> str | None:
    return format_layout_notice(workflow) if requires_migration(workflow, repo_root) else None
