"""Transactional execution of a reviewed legacy-layout migration plan."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any

from ..models import Workflow
from .constants import CURRENT_LAYOUT_VERSION, LAYOUT_VERSION_KEY
from .planner import MigrationPlan
from .validator import MigrationValidationError, validate_migrated_workflow, validate_plan


class MigrationExecutionError(RuntimeError):
    pass


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _inside(root: Path, path: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def execute_plan(repo_root: Path, workflow_path: Path, workflow: Workflow, plan: MigrationPlan) -> dict[str, Any]:
    try:
        validate_plan(plan)
    except MigrationValidationError as error:
        raise MigrationExecutionError(str(error)) from error

    sr_root = repo_root / ".sdd" / workflow.sr
    prepared: list[tuple[Path, Path, str | None]] = []
    for move in plan.moves:
        source = repo_root / Path(move.source)
        target = repo_root / Path(move.target)
        if not _inside(sr_root, source) or not _inside(sr_root, target):
            raise MigrationExecutionError(f"迁移路径超出当前 SR: {move.source} -> {move.target}")
        if source.exists() and target.exists():
            raise MigrationExecutionError(f"新旧位置同时存在文件，无法自动处理: {move.source} -> {move.target}")
        digest = _digest(source) if source.is_file() else None
        prepared.append((source, target, digest))

    replacements = {move.source: move.target for move in plan.moves}
    references_updated = 0
    for step in workflow.steps:
        step.vars[LAYOUT_VERSION_KEY] = CURRENT_LAYOUT_VERSION
        for direction in ("input", "output"):
            for item in getattr(step, direction):
                path = str(item.get("path") or "").replace("\\", "/")
                if path in replacements:
                    item["path"] = replacements[path]
                    references_updated += 1
    workflow.vars[LAYOUT_VERSION_KEY] = CURRENT_LAYOUT_VERSION
    try:
        validate_migrated_workflow(workflow)
    except MigrationValidationError as error:
        raise MigrationExecutionError(str(error)) from error

    moved: list[tuple[Path, Path]] = []
    try:
        for source, target, digest in prepared:
            if not source.exists():
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(source, target)
            moved.append((source, target))
            if digest is not None and _digest(target) != digest:
                raise MigrationExecutionError(f"文件移动后内容校验失败: {target}")

        temporary = workflow_path.with_name(workflow_path.name + ".layout-migration.tmp")
        workflow.to_yaml(temporary)
        os.replace(temporary, workflow_path)
    except Exception as error:
        for source, target in reversed(moved):
            if target.exists() and not source.exists():
                source.parent.mkdir(parents=True, exist_ok=True)
                os.replace(target, source)
        if isinstance(error, MigrationExecutionError):
            raise
        raise MigrationExecutionError(f"迁移失败，已回退文件移动: {error}") from error

    for source, _target in moved:
        directory = source.parent
        while directory != sr_root and _inside(sr_root, directory):
            try:
                directory.rmdir()
            except OSError:
                break
            directory = directory.parent

    return {
        "status": "migrated",
        "sr": workflow.sr,
        "moved": len(moved),
        "references_updated": references_updated,
        "moves": [move.to_dict() for move in plan.moves],
    }
