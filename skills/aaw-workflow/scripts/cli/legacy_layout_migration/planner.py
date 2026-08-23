"""Build deterministic one-to-one migration plans for historical layouts."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..models import Workflow
from .detector import iter_workflow_paths, looks_like_legacy_path


@dataclass(frozen=True)
class LayoutMove:
    source: str
    target: str

    def to_dict(self) -> dict[str, str]:
        return {"source": self.source, "target": self.target}


@dataclass
class MigrationPlan:
    sr: str
    moves: list[LayoutMove] = field(default_factory=list)
    unresolved: list[str] = field(default_factory=list)
    allowed_targets: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "sr": self.sr,
            "moves": [move.to_dict() for move in self.moves],
            "unresolved": self.unresolved,
        }
        if self.unresolved:
            payload["llm_resolution"] = {
                "instruction": (
                    "根据文件路径、标题和内容，为每个 unresolved 文件选择唯一的新位置；"
                    "只能从 allowed_targets 中选择，不能合并、拆分或改写文件。"
                ),
                "allowed_targets": self.allowed_targets,
                "retry_option": "--map '<旧路径>=<新路径>'",
            }
        return payload


def _scope_values(workflow: Workflow) -> list[dict[str, str]]:
    scopes: list[dict[str, str]] = []
    base = {key: str(value) for key, value in workflow.vars.items() if value not in (None, "")}
    for step in workflow.steps:
        merged = dict(base)
        merged.update({key: str(value) for key, value in step.vars.items() if value not in (None, "")})
        if all(merged.get(key) for key in ("SR", "AR", "模块组名", "需求短名")):
            key = tuple(merged[name] for name in ("SR", "AR", "模块组名", "需求短名"))
            if not any(tuple(item[name] for name in ("SR", "AR", "模块组名", "需求短名")) == key for item in scopes):
                scopes.append(merged)
    return scopes


def _known_mappings(workflow: Workflow) -> dict[str, str]:
    mappings: dict[str, str] = {}
    for scope in _scope_values(workflow):
        sr, ar = scope["SR"], scope["AR"]
        group, requirement = scope["模块组名"], scope["需求短名"]
        root = f".sdd/{sr}/{ar}"
        prefix = f"{root}/{ar}-{requirement}-{group}"
        module_root = f"{root}/{group}"
        mappings.update(
            {
                f"{prefix}模块详细设计说明书.context.md": f"{module_root}/.context/详细设计上下文.md",
                f"{prefix}模块详细设计说明书.md": f"{module_root}/模块详细设计说明书.md",
                f"{prefix}模块测试用例设计.md": f"{module_root}/模块测试用例设计.md",
                f"{prefix}模块设计门禁结果.md": f"{module_root}/.context/模块设计门禁结果.md",
                f"{root}/{group}_tasks/overview.md": f"{module_root}/tasks-overview.md",
            }
        )
    return mappings


def _disk_legacy_paths(repo_root: Path, workflow: Workflow) -> set[str]:
    sr_root = repo_root / ".sdd" / workflow.sr
    if not sr_root.exists():
        return set()
    result: set[str] = set()
    for candidate in sr_root.rglob("*.md"):
        relative = candidate.relative_to(repo_root).as_posix()
        if looks_like_legacy_path(relative, workflow.sr):
            result.add(relative)
    return result


def build_plan(
    repo_root: Path,
    workflow: Workflow,
    manual_mappings: dict[str, str] | None = None,
) -> MigrationPlan:
    known = _known_mappings(workflow)
    allowed_targets = sorted(set(known.values()))
    supplied = {key.replace("\\", "/"): value.replace("\\", "/") for key, value in (manual_mappings or {}).items()}
    candidates = set(iter_workflow_paths(workflow)) | _disk_legacy_paths(repo_root, workflow)
    legacy = sorted(path for path in candidates if looks_like_legacy_path(path, workflow.sr))

    moves: list[LayoutMove] = []
    unresolved: list[str] = []
    for source in legacy:
        target = supplied.get(source) or known.get(source)
        if target is None or target not in allowed_targets:
            unresolved.append(source)
            continue
        moves.append(LayoutMove(source, target))

    target_sources: dict[str, set[str]] = {}
    for move in moves:
        target_sources.setdefault(move.target, set()).add(move.source)
    for target, sources in target_sources.items():
        if len(sources) > 1:
            unresolved.extend(sorted(sources))
            moves = [move for move in moves if move.target != target]

    return MigrationPlan(
        sr=workflow.sr,
        moves=sorted(moves, key=lambda item: item.source),
        unresolved=sorted(set(unresolved)),
        allowed_targets=allowed_targets,
    )
