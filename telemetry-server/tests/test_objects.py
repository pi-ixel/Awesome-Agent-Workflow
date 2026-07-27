from __future__ import annotations

import hashlib
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

from conftest import DIFF, MESSAGE_ID, WORKFLOW_ID, message, sync, upload_diff
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from aaw_telemetry.models import CodeAttribution
from aaw_telemetry.services.attribution_service import AttributionServiceError
from aaw_telemetry.services.objects import ObjectService


def put_diff(client, payload: dict, content: bytes = DIFF):
    return client.put(
        f"/api/v1/objects/step-diffs/{payload['message_id']}",
        content=content,
        headers={"Content-Type": "application/octet-stream"},
    )


def wait_for_attribution(
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


def test_full_diff_flow_creates_statistics_and_mock_attribution(client):
    payload = message()
    assert sync(client, payload).status_code == 200
    confirmed = upload_diff(client, payload)

    assert confirmed["message_id"] == str(MESSAGE_ID)
    assert confirmed["status"] == "confirmed"
    assert confirmed["sha256"] == payload["data"]["file"]["sha256"]
    assert confirmed["object_key"] == f"step-diffs/{MESSAGE_ID}.diff"
    step = wait_for_attribution(client, "finalized_match")
    assert step["file_status"] == "confirmed"
    assert step["attribution_status"] == "finalized_match"
    assert step["attribution"]["dev_effective_lines"] == 2
    assert step["attribution"]["algorithm_version"] == "mock-v1"
    assert "mock_attribution" in step["attribution"]["quality_flags"]


def test_repeated_upload_of_the_same_diff_is_idempotent(client):
    payload = message()
    sync(client, payload)

    first = put_diff(client, payload)
    second = put_diff(client, payload)

    assert first.status_code == 200
    assert second.status_code == 200
    first_body = first.json()
    second_body = second.json()
    first_body.pop("request_id")
    second_body.pop("request_id")
    assert first_body == second_body


def test_concurrent_initial_uploads_reuse_the_committed_rows(
    concurrent_client,
    monkeypatch,
):
    payload = message()
    sync(concurrent_client, payload)
    pending_barrier = threading.Barrier(2)
    original_mark_pending = ObjectService._mark_attribution_pending

    def mark_pending_together(self, dev_run, now):
        original_mark_pending(self, dev_run, now)
        pending_barrier.wait(timeout=10)

    monkeypatch.setattr(ObjectService, "_mark_attribution_pending", mark_pending_together)
    service = concurrent_client.app.state.attribution_service
    original_attribute = service.attribute
    calls = 0
    calls_lock = threading.Lock()

    def count_attribute(request):
        nonlocal calls
        with calls_lock:
            calls += 1
        return original_attribute(request)

    monkeypatch.setattr(service, "attribute", count_attribute)
    second_client = TestClient(concurrent_client.app, raise_server_exceptions=False)
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(
                executor.map(
                    lambda active_client: put_diff(active_client, payload),
                    (concurrent_client, second_client),
                )
            )
    finally:
        second_client.close()

    assert [response.status_code for response in responses] == [200, 200]
    wait_for_attribution(concurrent_client, "finalized_match")
    assert calls == 1


def test_attribution_outage_does_not_rollback_diff_and_scheduler_retries(
    client,
    monkeypatch,
):
    payload = message()
    sync(client, payload)
    service = client.app.state.attribution_service
    original = service.attribute

    def fail_attribution(_):
        raise AttributionServiceError("unavailable")

    monkeypatch.setattr(service, "attribute", fail_attribution)

    confirmed = put_diff(client, payload)

    assert confirmed.status_code == 200
    step = wait_for_attribution(client, "retry_pending")
    assert step["file_status"] == "confirmed"
    assert step["attribution"]["retry_count"] == 1

    monkeypatch.setattr(service, "attribute", original)
    with Session(client.app.state.engine) as session:
        attribution = session.get(CodeAttribution, MESSAGE_ID)
        attribution.next_retry_at = datetime.now(UTC) - timedelta(seconds=1)
        session.commit()
    client.app.state.attribution_scheduler.run_once()
    step = wait_for_attribution(client, "finalized_match")

    assert step["attribution"]["retry_count"] == 1


def test_concurrent_failed_retries_claim_attribution_once(
    concurrent_client,
    monkeypatch,
):
    payload = message()
    sync(concurrent_client, payload)
    service = concurrent_client.app.state.attribution_service
    original_attribute = service.attribute

    def fail_attribution(_):
        raise AttributionServiceError("unavailable")

    monkeypatch.setattr(service, "attribute", fail_attribution)
    assert put_diff(concurrent_client, payload).status_code == 200
    wait_for_attribution(concurrent_client, "retry_pending")
    with Session(concurrent_client.app.state.engine) as session:
        attribution = session.get(CodeAttribution, MESSAGE_ID)
        attribution.next_retry_at = datetime.now(UTC) - timedelta(seconds=1)
        session.commit()

    started = threading.Event()
    release = threading.Event()
    calls = 0
    calls_lock = threading.Lock()

    def block_attribute(request):
        nonlocal calls
        with calls_lock:
            calls += 1
        started.set()
        assert release.wait(timeout=10)
        return original_attribute(request)

    monkeypatch.setattr(service, "attribute", block_attribute)
    scheduler = concurrent_client.app.state.attribution_scheduler
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(scheduler.run_once) for _ in range(2)]
        assert started.wait(timeout=10)
        release.set()
        processed = [future.result(timeout=10) for future in futures]

    assert sum(processed) == 1
    assert calls == 1
    wait_for_attribution(concurrent_client, "finalized_match")


def test_late_failure_cannot_replace_a_finalized_result(client):
    payload = message()
    sync(client, payload)
    assert put_diff(client, payload).status_code == 200

    client.app.state.attribution_scheduler.run_once()
    wait_for_attribution(client, "finalized_match")
    client.app.state.attribution_scheduler._record_failure(
        MESSAGE_ID,
        datetime.now(UTC),
        "late_failure",
    )

    detail = client.get(f"/api/v1/workflows/{WORKFLOW_ID}").json()
    assert detail["steps"][0]["attribution_status"] == "finalized_match"
    assert detail["steps"][0]["attribution"]["retry_count"] == 0


def test_upload_requires_an_existing_message(client):
    payload = message(message_id=uuid.UUID(int=999))
    response = put_diff(client, payload)

    assert response.status_code == 404
    assert response.json()["code"] == "MESSAGE_NOT_FOUND"


def test_upload_rejects_content_that_does_not_match_declared_hash(client):
    payload = message()
    sync(client, payload)

    short = put_diff(client, payload, DIFF[:-1])
    wrong_same_size = put_diff(client, payload, b"x" * len(DIFF))

    assert short.status_code == 422
    assert short.json()["code"] == "FILE_HASH_MISMATCH"
    assert wrong_same_size.status_code == 422
    assert wrong_same_size.json()["code"] == "FILE_HASH_MISMATCH"
    detail = client.get(f"/api/v1/workflows/{WORKFLOW_ID}").json()
    assert detail["steps"][0]["file_status"] == "pending"


def test_failed_retry_does_not_replace_an_already_confirmed_diff(client):
    payload = message()
    sync(client, payload)
    confirmed = put_diff(client, payload)

    rejected = put_diff(client, payload, b"different")

    assert confirmed.status_code == 200
    assert rejected.status_code == 422
    assert rejected.json()["code"] == "FILE_HASH_MISMATCH"
    repeated = put_diff(client, payload)
    repeated_body = repeated.json()
    confirmed_body = confirmed.json()
    repeated_body.pop("request_id")
    confirmed_body.pop("request_id")
    assert repeated_body == confirmed_body


def test_non_dev_message_cannot_upload_diff(client):
    payload = message(step_type="review", with_file=False)
    sync(client, payload)
    response = put_diff(client, payload)

    assert response.status_code == 409
    assert response.json()["code"] == "FILE_CONFLICT"


def test_diff_upload_uses_object_limit_not_json_limit(client):
    payload = message()
    declared = b"x" * (1024 * 1024 + 1)
    payload["data"]["file"]["sha256"] = hashlib.sha256(declared).hexdigest()
    sync(client, payload)

    accepted = put_diff(client, payload, declared)
    assert accepted.status_code == 200

    second = message(message_id=uuid.UUID(int=998))
    oversized = b"x" * (2 * 1024 * 1024 + 1)
    second["data"]["file"]["sha256"] = hashlib.sha256(oversized).hexdigest()
    sync(client, second)
    rejected = put_diff(client, second, oversized)
    assert rejected.status_code == 413
    assert rejected.json()["code"] == "PAYLOAD_TOO_LARGE"


def test_old_upload_session_endpoints_are_removed(client):
    document = client.get("/openapi.json").json()
    assert "/api/v1/objects/step-diffs/{message_id}" in document["paths"]
    assert "/api/v1/objects/uploads" not in document["paths"]
    operation = document["paths"]["/api/v1/objects/step-diffs/{message_id}"]["put"]
    body = operation["requestBody"]
    assert body["required"] is True
    assert body["content"]["application/octet-stream"]["schema"] == {
        "type": "string",
        "format": "binary",
    }
    assert "不需要上传会话、文件大小或单独确认" in operation["description"]
