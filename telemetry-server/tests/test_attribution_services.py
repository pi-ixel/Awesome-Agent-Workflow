from __future__ import annotations

import uuid
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from aaw_telemetry.services import attribution_tasks
from aaw_telemetry.services.attribution_engine import AttributionEngine
from aaw_telemetry.services.real_attribution_service import (
    RealAttributionService,
    _create_pending_attribution,
)


class StubAttributionEngine(AttributionEngine):
    def __init__(self, result=None, error: Exception | None = None):
        self.result = result or {}
        self.error = error

    def run(self, dev_run, diff_bytes: bytes, project_entry, message) -> dict:
        if self.error is not None:
            raise self.error
        return self.result


def test_real_service_creates_pending_attribution_and_delegates(monkeypatch):
    session = MagicMock()
    session.get.return_value = None
    dev_run = SimpleNamespace(
        id=uuid.uuid4(),
        code_statistics={"total_effective_lines": 12},
    )
    now = datetime.now(UTC)
    triggered = MagicMock()
    scheduler = MagicMock()
    monkeypatch.setattr(
        "aaw_telemetry.services.real_attribution_service._trigger_async_attribution",
        triggered,
    )
    monkeypatch.setattr(
        "aaw_telemetry.services.real_attribution_service._start_retry_scheduler",
        scheduler,
    )
    engine = StubAttributionEngine()
    settings = SimpleNamespace()
    projects = SimpleNamespace()
    service = RealAttributionService(settings, projects, engine)

    service.on_diff_confirmed(session, dev_run, now)
    service.start_retry_scheduler(settings, projects)

    pending = session.add.call_args.args[0]
    assert pending.dev_run_id == dev_run.id
    assert pending.dev_effective_lines == 12
    assert pending.attribution_status == "pending"
    triggered.assert_called_once_with(dev_run.id, settings, projects, engine)
    scheduler.assert_called_once_with(settings, projects, engine)


def test_pending_attribution_resets_an_existing_row():
    existing = SimpleNamespace(
        attribution_status="failed",
        dev_effective_lines=0,
        quality_flags=[],
        server_updated_at=None,
    )
    session = MagicMock()
    session.get.return_value = existing
    now = datetime.now(UTC)
    dev_run = SimpleNamespace(
        id=uuid.uuid4(),
        code_statistics={"total_effective_lines": 7},
    )

    _create_pending_attribution(session, dev_run, now)

    assert existing.attribution_status == "pending"
    assert existing.dev_effective_lines == 7
    assert existing.quality_flags == ["armr-counter-v1", "pending"]
    assert existing.server_updated_at == now
    session.add.assert_not_called()


def test_execute_attribution_persists_engine_result(tmp_path):
    message_id = uuid.uuid4()
    object_root = tmp_path / "objects"
    diff_path = object_root / "step-diffs" / f"{message_id}.diff"
    diff_path.parent.mkdir(parents=True)
    diff_path.write_bytes(b"diff-content")
    dev_run = SimpleNamespace(
        id=message_id,
        workflow_run_id=uuid.uuid4(),
        patch_object_key=f"step-diffs/{message_id}.diff",
        completed_at=datetime.now(UTC),
    )
    attribution = SimpleNamespace(
        attribution_status="pending",
        retry_count=0,
        next_retry_at=None,
        server_updated_at=None,
        attributed_lines_80=0,
        result_status="finalized_no_match",
    )
    message = SimpleNamespace(repository="team/example-service")
    workflow = SimpleNamespace(project_key="team/example-service")
    session = MagicMock()
    session.get.side_effect = lambda model, key: {
        attribution_tasks.DevRun: dev_run,
        attribution_tasks.CodeAttribution: attribution,
        attribution_tasks.WorkflowRun: workflow,
    }[model]
    session.scalar.return_value = message
    project_entry = SimpleNamespace(
        canonical_url="git@example.com:team/example-service.git",
        target_branch="main",
        enabled=True,
    )
    projects = SimpleNamespace(
        get=lambda project_key: (
            project_entry if project_key == "team/example-service" else None
        )
    )
    settings = SimpleNamespace(object_storage_dir=object_root)
    engine = StubAttributionEngine(
        {
            "result_status": "finalized_match",
            "attributed_lines_80": 9,
        }
    )

    attribution_tasks._execute_attribution(
        session,
        message_id,
        settings,
        projects,
        engine,
    )

    assert attribution.attribution_status == "finalized_match"
    assert attribution.attributed_lines_80 == 9
    assert attribution.next_retry_at is None
    assert session.commit.call_count == 2


def test_execute_attribution_schedules_retry_after_engine_failure(tmp_path):
    message_id = uuid.uuid4()
    object_root = tmp_path / "objects"
    diff_path = object_root / "step-diffs" / f"{message_id}.diff"
    diff_path.parent.mkdir(parents=True)
    diff_path.write_bytes(b"diff-content")
    dev_run = SimpleNamespace(
        id=message_id,
        workflow_run_id=uuid.uuid4(),
        patch_object_key=f"step-diffs/{message_id}.diff",
        completed_at=datetime.now(UTC),
    )
    attribution = SimpleNamespace(
        attribution_status="pending",
        retry_count=0,
        next_retry_at=None,
        server_updated_at=None,
        quality_flags=["armr-counter-v1"],
    )
    message = SimpleNamespace(repository="missing")
    workflow = SimpleNamespace(project_key="missing")
    session = MagicMock()
    session.get.side_effect = lambda model, key: {
        attribution_tasks.DevRun: dev_run,
        attribution_tasks.CodeAttribution: attribution,
        attribution_tasks.WorkflowRun: workflow,
    }[model]
    session.scalar.return_value = message
    projects = SimpleNamespace(get=lambda _project_key: None)
    settings = SimpleNamespace(object_storage_dir=object_root)
    engine = StubAttributionEngine(error=RuntimeError("engine failed"))

    attribution_tasks._execute_attribution(
        session,
        message_id,
        settings,
        projects,
        engine,
    )

    assert attribution.retry_count == 1
    assert attribution.attribution_status == "retry_pending"
    assert attribution.next_retry_at is not None
    assert "failed" in attribution.quality_flags
    assert any("engine failed" in flag for flag in attribution.quality_flags)


def test_execute_attribution_ignores_missing_context():
    session = MagicMock()
    session.get.side_effect = [None, None, None]

    attribution_tasks._execute_attribution(
        session,
        uuid.uuid4(),
        SimpleNamespace(object_storage_dir=Path(".")),
        SimpleNamespace(document=SimpleNamespace(projects={})),
        StubAttributionEngine(),
    )

    session.commit.assert_not_called()


def test_retry_pending_attributions_updates_rows_and_spawns(monkeypatch):
    row = SimpleNamespace(
        dev_run_id=uuid.uuid4(),
        attribution_status="retry_pending",
        next_retry_at=datetime.now(UTC),
        server_updated_at=None,
        retry_count=2,
    )
    session = MagicMock()
    session.scalars.return_value.all.return_value = [row]
    db_engine = MagicMock()

    @contextmanager
    def session_scope():
        yield session

    monkeypatch.setattr(attribution_tasks, "build_engine", lambda settings: db_engine)
    monkeypatch.setattr(
        attribution_tasks,
        "build_session_factory",
        lambda engine: session_scope,
    )
    spawned = MagicMock()
    monkeypatch.setattr(attribution_tasks, "_spawn_retry_thread", spawned)
    settings = SimpleNamespace()
    projects = SimpleNamespace()
    engine = StubAttributionEngine()

    count = attribution_tasks.retry_pending_attributions(settings, projects, engine)

    assert count == 1
    assert row.attribution_status == "retry_pending"
    spawned.assert_called_once_with(row.dev_run_id, settings, projects, engine)
    db_engine.dispose.assert_called_once()


def test_background_task_disposes_engine_on_success_and_failure(monkeypatch):
    db_engine = MagicMock()
    session = MagicMock()

    @contextmanager
    def session_scope():
        yield session

    monkeypatch.setattr(attribution_tasks, "build_engine", lambda settings: db_engine)
    monkeypatch.setattr(
        attribution_tasks,
        "build_session_factory",
        lambda engine: session_scope,
    )
    execute = MagicMock()
    monkeypatch.setattr(attribution_tasks, "_execute_attribution", execute)
    arguments = (
        uuid.uuid4(),
        SimpleNamespace(),
        SimpleNamespace(),
        StubAttributionEngine(),
    )

    attribution_tasks.run_attribution_in_background(*arguments)
    execute.side_effect = RuntimeError("failed")
    attribution_tasks.run_attribution_in_background(*arguments)

    assert db_engine.dispose.call_count == 2


def test_spawn_retry_thread_starts_daemon(monkeypatch):
    import threading

    thread = MagicMock()
    thread_type = MagicMock(return_value=thread)
    monkeypatch.setattr(threading, "Thread", thread_type)

    attribution_tasks._spawn_retry_thread(
        uuid.uuid4(),
        SimpleNamespace(),
        SimpleNamespace(),
        StubAttributionEngine(),
    )

    assert thread_type.call_args.kwargs["daemon"] is True
    thread.start.assert_called_once()


@pytest.mark.parametrize("object_key", ["missing.diff", "../outside.diff"])
def test_read_diff_returns_none_for_missing_or_escaping_object_keys(tmp_path, object_key):
    settings = SimpleNamespace(object_storage_dir=tmp_path)

    assert attribution_tasks._read_diff_file(settings, object_key) is None


@pytest.mark.parametrize(
    ("retry_count", "expected_hours"),
    [(1, 1), (2, 2), (3, 4), (6, 32), (20, 32)],
)
def test_compute_retry_interval_uses_capped_exponential_backoff(
    retry_count,
    expected_hours,
):
    assert attribution_tasks._compute_retry_interval(retry_count) == timedelta(
        hours=expected_hours
    )


def test_upsert_no_match_stops_retry_after_thirty_day_window():
    attribution = SimpleNamespace()
    session = MagicMock()
    session.get.return_value = attribution
    now = datetime.now(UTC)
    completed_at = now - timedelta(days=30)

    attribution_tasks._upsert_attribution(
        session,
        uuid.uuid4(),
        {"result_status": "finalized_no_match"},
        now,
        retry_count=5,
        completed_at=completed_at,
    )

    assert attribution.attribution_status == "finalized_no_match"
    assert attribution.next_retry_at is None
    session.commit.assert_called_once()


def test_mark_failed_stops_after_maximum_retry_count():
    message_id = uuid.uuid4()
    attribution = SimpleNamespace(
        retry_count=attribution_tasks.MAX_RETRY_COUNT - 1,
        next_retry_at=None,
        attribution_status="running",
        quality_flags=[],
        server_updated_at=None,
    )
    dev_run = SimpleNamespace(completed_at=datetime.now(UTC))
    session = MagicMock()
    session.get.side_effect = lambda model, key: {
        attribution_tasks.CodeAttribution: attribution,
        attribution_tasks.DevRun: dev_run,
    }[model]

    attribution_tasks._mark_failed(
        session,
        message_id,
        datetime.now(UTC),
        "engine_timeout",
    )

    assert attribution.retry_count == attribution_tasks.MAX_RETRY_COUNT
    assert attribution.attribution_status == "failed"
    assert attribution.next_retry_at is None
    assert attribution.quality_flags == ["failed", "engine_timeout"]
