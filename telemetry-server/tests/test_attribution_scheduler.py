from __future__ import annotations

import asyncio
import threading
import time
from datetime import UTC, datetime, timedelta

from conftest import DIFF, MESSAGE_ID, WORKFLOW_ID, message, sync
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from aaw_telemetry.database import build_session_factory
from aaw_telemetry.models import CodeAttribution, DevRun
from aaw_telemetry.services.attribution_scheduler import (
    MAX_CONSECUTIVE_SCAN_FAILURES,
    MAX_RETRY_COUNT,
    AttributionScheduler,
)
from aaw_telemetry.services.attribution_service import AttributionServiceError


def put_diff(client: TestClient, payload: dict):
    return client.put(
        f"/api/v1/objects/step-diffs/{payload['message_id']}",
        content=DIFF,
        headers={"Content-Type": "application/octet-stream"},
    )


def wait_for_status(
    client: TestClient,
    expected_status: str,
    *,
    timeout: float = 5,
) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        step = client.get(f"/api/v1/workflows/{WORKFLOW_ID}").json()["steps"][0]
        if step["attribution_status"] == expected_status:
            return step
        time.sleep(0.01)
    raise AssertionError(f"attribution did not reach {expected_status!r}")


def test_diff_upload_does_not_wait_for_attribution(client, monkeypatch):
    payload = message()
    assert sync(client, payload).status_code == 200
    service = client.app.state.attribution_service
    original_attribute = service.attribute
    started = threading.Event()
    release = threading.Event()

    def slow_attribute(request):
        started.set()
        assert release.wait(timeout=10)
        return original_attribute(request)

    monkeypatch.setattr(service, "attribute", slow_attribute)
    started_at = time.monotonic()
    response = put_diff(client, payload)
    elapsed = time.monotonic() - started_at

    try:
        assert response.status_code == 200
        assert elapsed < 1
        assert started.wait(timeout=5)
    finally:
        release.set()

    wait_for_status(client, "finalized_match")


def test_new_scheduler_recovers_persisted_failed_record(client):
    payload = message()
    assert sync(client, payload).status_code == 200
    assert put_diff(client, payload).status_code == 200
    wait_for_status(client, "finalized_match")

    with Session(client.app.state.engine) as session:
        attribution = session.get(CodeAttribution, MESSAGE_ID)
        attribution.attribution_status = "failed"
        attribution.retry_count = 1
        attribution.next_retry_at = None
        session.commit()

    restarted_scheduler = AttributionScheduler(
        build_session_factory(client.app.state.engine),
        client.app.state.settings,
        client.app.state.projects,
        client.app.state.attribution_service,
    )

    assert restarted_scheduler.run_once() == 1
    step = wait_for_status(client, "finalized_match")
    assert step["attribution"]["retry_count"] == 1


def test_stale_running_lease_is_recovered(client):
    payload = message()
    assert sync(client, payload).status_code == 200
    assert put_diff(client, payload).status_code == 200
    wait_for_status(client, "finalized_match")

    with Session(client.app.state.engine) as session:
        attribution = session.get(CodeAttribution, MESSAGE_ID)
        attribution.attribution_status = "running"
        attribution.server_updated_at = datetime.now(UTC) - timedelta(minutes=2)
        session.commit()

    assert client.app.state.attribution_scheduler.run_once() == 1
    wait_for_status(client, "finalized_match")


def test_retry_limit_becomes_terminal_failed(client, monkeypatch):
    payload = message()
    assert sync(client, payload).status_code == 200
    service = client.app.state.attribution_service

    def fail_attribution(_):
        raise AttributionServiceError("unavailable")

    monkeypatch.setattr(service, "attribute", fail_attribution)
    assert put_diff(client, payload).status_code == 200
    client.app.state.attribution_scheduler.run_once()
    wait_for_status(client, "retry_pending")

    with Session(client.app.state.engine) as session:
        attribution = session.get(CodeAttribution, MESSAGE_ID)
        attribution.attribution_status = "retry_pending"
        attribution.retry_count = MAX_RETRY_COUNT - 1
        attribution.next_retry_at = datetime.now(UTC) - timedelta(seconds=1)
        session.commit()

    assert client.app.state.attribution_scheduler.run_once() == 1
    step = wait_for_status(client, "failed")
    assert step["attribution"]["retry_count"] == MAX_RETRY_COUNT
    assert client.app.state.attribution_scheduler.run_once() == 0


def test_retry_window_expiry_becomes_terminal_failed(client):
    payload = message()
    assert sync(client, payload).status_code == 200
    assert put_diff(client, payload).status_code == 200
    wait_for_status(client, "finalized_match")

    with Session(client.app.state.engine) as session:
        dev_run = session.get(DevRun, MESSAGE_ID)
        dev_run.completed_at = datetime.now(UTC) - timedelta(days=31)
        attribution = session.get(CodeAttribution, MESSAGE_ID)
        attribution.attribution_status = "retry_pending"
        attribution.next_retry_at = datetime.now(UTC) - timedelta(seconds=1)
        session.commit()

    assert client.app.state.attribution_scheduler.run_once() == 0
    step = wait_for_status(client, "failed")
    assert step["attribution"]["next_retry_at"] is None


def test_scheduler_pauses_after_repeated_scan_failures(client, monkeypatch):
    scheduler = AttributionScheduler(
        build_session_factory(client.app.state.engine),
        client.app.state.settings,
        client.app.state.projects,
        client.app.state.attribution_service,
    )
    attempts = 0

    def fail_scan():
        nonlocal attempts
        attempts += 1
        raise RuntimeError("invalid scheduler configuration")

    async def skip_wait():
        return None

    monkeypatch.setattr(scheduler, "run_once", fail_scan)
    monkeypatch.setattr(scheduler, "_wait_for_next_scan", skip_wait)

    asyncio.run(scheduler.run())

    assert attempts == MAX_CONSECUTIVE_SCAN_FAILURES
