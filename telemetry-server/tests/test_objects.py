from __future__ import annotations

import hashlib
import uuid

from conftest import DIFF, MESSAGE_ID, WORKFLOW_ID, message, sync, upload_diff


def put_diff(client, payload: dict, content: bytes = DIFF):
    return client.put(
        f"/api/v1/objects/step-diffs/{payload['message_id']}",
        content=content,
        headers={"Content-Type": "application/octet-stream"},
    )


def test_full_diff_flow_creates_statistics_and_mock_attribution(client):
    payload = message()
    assert sync(client, payload).status_code == 200
    confirmed = upload_diff(client, payload)

    assert confirmed["message_id"] == str(MESSAGE_ID)
    assert confirmed["status"] == "confirmed"
    assert confirmed["sha256"] == payload["data"]["file"]["sha256"]
    assert confirmed["object_key"] == f"step-diffs/{MESSAGE_ID}.diff"
    detail = client.get(f"/api/v1/workflows/{WORKFLOW_ID}").json()
    step = detail["steps"][0]
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
