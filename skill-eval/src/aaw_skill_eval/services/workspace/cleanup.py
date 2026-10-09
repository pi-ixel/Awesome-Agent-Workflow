from __future__ import annotations

import os
import shutil
import time
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from ...config import Settings
from ...errors import EvalError
from ...models import Experiment, Run
from .paths import run_workspace

ACTIVE_RUN_STATUSES = {"queued", "running"}
REMOVE_ATTEMPTS = 3
REMOVE_RETRY_DELAY_SECONDS = 0.4


def _remove_tree_with_retry(path: Path) -> bool:
    """删除目录树；Windows 上文件锁（残留句柄/杀毒扫描）常见，重试若干次。"""
    for attempt in range(REMOVE_ATTEMPTS):
        try:
            shutil.rmtree(path)
            return True
        except OSError:
            if attempt + 1 < REMOVE_ATTEMPTS:
                time.sleep(REMOVE_RETRY_DELAY_SECONDS)
    return False


def _guard_under_workspace_root(path: Path, workspace_root: Path) -> Path:
    """清理红线：只允许删除 workspaces/ 之内的路径，越界直接拒绝。"""
    resolved = path.resolve()
    if not resolved.is_relative_to(workspace_root):
        raise OSError("Run workspace is outside the workspace root")
    return resolved


def remove_run_workspace_dirs(
    settings: Settings,
    experiment_id: str,
    run_id: str,
    attempt: int,
) -> dict[str, list[str]]:
    """删除指定 attempt 的 run 现场目录（尽力而为），返回删除/失败路径。

    只作用于 workspaces/ 之内的目录；数据库记录与 artifacts/ 证据包不受影响。
    """
    legacy_name = run_id if attempt == 1 else f"r{attempt}-{run_id[:8]}"
    candidates = [
        run_workspace(settings, experiment_id, run_id, attempt),
        settings.workspaces_dir / experiment_id / "runs" / legacy_name,
    ]
    workspace_root = settings.workspaces_dir.resolve()
    removed: list[str] = []
    failed: list[str] = []
    for candidate in candidates:
        if not candidate.exists():
            continue
        try:
            target = _guard_under_workspace_root(candidate, workspace_root)
        except OSError:
            failed.append(str(candidate))
            continue
        if _remove_tree_with_retry(target):
            removed.append(str(target))
        else:
            failed.append(str(target))
    return {"removed": removed, "failed": failed}


def cleanup_run_workspace(
    settings: Settings,
    session_factory: sessionmaker[Session],
    run_id: str,
) -> dict[str, object]:
    """手动清理单个 run 的现场（仅终态 run；运行中的现场拒绝清理）。"""
    with session_factory() as session:
        run = session.get(Run, run_id)
        if run is None:
            raise EvalError("RUN_NOT_FOUND", "Run was not found", status_code=404)
        if run.status in ACTIVE_RUN_STATUSES:
            return {"skipped": f"Run 正在{run.status}，不能清理现场", "removed": [], "failed": []}
        result = remove_run_workspace_dirs(
            settings, run.experiment_id, run.id, run.current_attempt
        )
        run.workspace_retained = bool(result["failed"])
        session.commit()
    return result


def cleanup_experiment_workspaces(
    settings: Settings,
    session_factory: sessionmaker[Session],
    experiment_id: str,
) -> dict[str, object]:
    """手动清理整个实验的全部现场：终态 run 逐个清理，运行中的跳过。"""
    removed: list[str] = []
    failed: list[str] = []
    skipped: list[str] = []
    with session_factory() as session:
        experiment = session.get(Experiment, experiment_id)
        if experiment is None:
            raise EvalError("EXPERIMENT_NOT_FOUND", "Experiment was not found", status_code=404)
        runs = list(experiment.runs)
    for run in runs:
        if run.status in ACTIVE_RUN_STATUSES:
            skipped.append(run.id)
            continue
        result = remove_run_workspace_dirs(
            settings, run.experiment_id, run.id, run.current_attempt
        )
        removed.extend(result["removed"])
        failed.extend(result["failed"])
        mark_workspace_retained(session_factory, run.id, retained=bool(result["failed"]))
    return {"removed": removed, "failed": failed, "skipped": skipped}


def mark_workspace_retained(
    session_factory: sessionmaker[Session], run_id: str, *, retained: bool
) -> None:
    """同步 run 现场的在盘状态（workspace_retained = 现场仍在磁盘上）。"""
    with session_factory() as session:
        run = session.get(Run, run_id)
        if run is not None:
            run.workspace_retained = retained
            session.commit()


def cleanup_orphan_workspaces(settings: Settings, session_factory: sessionmaker[Session]) -> int:
    """启动时清理孤儿目录：磁盘上存在、但数据库无任何记录的工作区目录。

    数据库里有记录的现场（无论成功失败）一律保留，由用户手动清理。
    """
    known_experiment_names: set[str] = set()
    known_run_dirs: set[Path] = set()
    with session_factory() as session:
        for (experiment_id,) in session.execute(select(Experiment.id)):
            known_experiment_names.add(experiment_id.replace("-", "")[:12])
            known_experiment_names.add(experiment_id)
        for run in session.scalars(select(Run)):
            for attempt in range(1, run.current_attempt + 1):
                known_run_dirs.add(
                    run_workspace(settings, run.experiment_id, run.id, attempt).resolve()
                )
    workspace_root = settings.workspaces_dir.resolve()
    if not workspace_root.exists():
        return 0
    removed = 0
    for experiment_dir in workspace_root.iterdir():
        if not experiment_dir.is_dir():
            continue
        if experiment_dir.name not in known_experiment_names:
            if _remove_tree_with_retry(experiment_dir):
                removed += 1
            continue
        # base 是克隆源，无查看价值：无论实验状态一律启动即删
        base_dir = experiment_dir / "base"
        if base_dir.is_dir() and _remove_tree_with_retry(base_dir):
            removed += 1
        runs_dir = experiment_dir / "runs"
        if not runs_dir.is_dir():
            continue
        for run_dir in runs_dir.iterdir():
            if (
                run_dir.is_dir()
                and run_dir.resolve() not in known_run_dirs
                and _remove_tree_with_retry(run_dir)
            ):
                removed += 1
    return removed


def directory_size(path: Path) -> int:
    """目录字节大小（按需计算；调用方须避免放在轮询路径上）。"""
    total = 0
    for current, _dirs, files in os.walk(path, onerror=lambda _error: None):
        for name in files:
            try:
                total += (Path(current) / name).stat().st_size
            except OSError:
                continue
    return total


def workspace_usage(
    settings: Settings, session_factory: sessionmaker[Session], experiment_id: str
) -> dict[str, object]:
    """实验的现场占用：每个 run 的工作区大小与总量（按需调用）。"""
    runs: dict[str, int] = {}
    total = 0
    with session_factory() as session:
        experiment = session.get(Experiment, experiment_id)
        if experiment is None:
            raise EvalError("EXPERIMENT_NOT_FOUND", "Experiment was not found", status_code=404)
        experiment_runs = list(experiment.runs)
    for run in experiment_runs:
        workspace = run_workspace(settings, run.experiment_id, run.id, run.current_attempt)
        if not workspace.exists():
            continue
        size = directory_size(workspace)
        runs[run.id] = size
        total += size
    return {"total_bytes": total, "runs": runs}
