from __future__ import annotations

from pathlib import Path

from ...config import Settings


def experiment_workspace(settings: Settings, experiment_id: str) -> Path:
    return settings.workspaces_dir / experiment_id.replace("-", "")[:12]


def run_workspace(
    settings: Settings,
    experiment_id: str,
    run_id: str,
    attempt: int = 1,
) -> Path:
    name = run_id.replace("-", "")[:12]
    if attempt > 1:
        name = f"r{attempt}-{name}"
    return experiment_workspace(settings, experiment_id) / "runs" / name
