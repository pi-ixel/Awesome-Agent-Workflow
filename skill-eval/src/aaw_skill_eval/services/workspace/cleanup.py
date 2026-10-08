from __future__ import annotations

import shutil
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from ...config import Settings
from ...models import Run
from .paths import run_workspace


def cleanup_expired_workspaces(
    settings: Settings,
    session_factory: sessionmaker[Session],
    *,
    now: datetime | None = None,
) -> int:
    """Remove retained failure workspaces after the configured grace period."""
    cutoff = (now or datetime.now(UTC)) - timedelta(days=settings.failed_workspace_retention_days)
    workspace_root = settings.workspaces_dir.resolve()
    cleaned = 0

    with session_factory() as session:
        runs = session.scalars(
            select(Run).where(
                Run.workspace_retained.is_(True),
                Run.completed_at.is_not(None),
                Run.completed_at < cutoff,
            )
        ).all()
        for run in runs:
            legacy_name = (
                run.id if run.current_attempt == 1 else f"r{run.current_attempt}-{run.id[:8]}"
            )
            candidates = (
                run_workspace(settings, run.experiment_id, run.id, run.current_attempt),
                settings.workspaces_dir / run.experiment_id / "runs" / legacy_name,
            )
            try:
                for candidate in candidates:
                    candidate = candidate.resolve()
                    if not candidate.is_relative_to(workspace_root):
                        raise OSError("Run workspace is outside the workspace root")
                    if candidate.exists():
                        shutil.rmtree(candidate)
            except OSError:
                continue
            run.workspace_retained = False
            cleaned += 1
        session.commit()
    return cleaned
