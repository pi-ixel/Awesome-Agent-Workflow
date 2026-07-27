from __future__ import annotations

import base64
import hashlib
import uuid

from aaw_contracts import AttributionRequest as SharedAttributionRequest
from fastapi.testclient import TestClient

from aaw_attribution.config import Settings
from aaw_attribution.contracts import AttributionRequest
from aaw_attribution.main import create_app


def request_body() -> dict:
    content = b"diff --git a/a.py b/a.py\n+++ b/a.py\n+one\n+two\n"
    return {
        "schema_version": "1.0",
        "request_id": str(uuid.UUID("22222222-2222-4222-8222-222222222222")),
        "project": {
            "key": "team/example",
            "canonical_url": "git@example.com:team/example.git",
            "target_branch": "main",
        },
        "development": {
            "branch": "feature/test",
            "head_sha_start": "a" * 40,
            "head_sha_end": "b" * 40,
            "completed_at": "2026-07-27T00:00:00Z",
        },
        "telemetry": {
            "repository": "team/example",
            "sr": "SR-1",
            "ar": "AR-1",
            "user_email": "developer@example.com",
        },
        "diff": {
            "sha256": hashlib.sha256(content).hexdigest(),
            "content_base64": base64.b64encode(content).decode("ascii"),
            "statistics": {"total_effective_lines": 2},
        },
    }


def test_service_reexports_the_shared_contract():
    assert AttributionRequest is SharedAttributionRequest


def test_mock_attribution_contract():
    client = TestClient(create_app())

    response = client.post("/api/v1/attributions", json=request_body())

    assert response.status_code == 200
    result = response.json()
    assert result["schema_version"] == "1.0"
    assert result["result_status"] == "finalized_match"
    assert result["dev_effective_lines"] == 2
    assert result["algorithm_version"] == "mock-v1"
    assert result["quality_flags"] == ["mock_attribution", "external_service"]


def test_rejects_diff_with_wrong_digest():
    client = TestClient(create_app())
    body = request_body()
    body["diff"]["sha256"] = "0" * 64

    response = client.post("/api/v1/attributions", json=body)

    assert response.status_code == 422


def test_optional_bearer_token():
    app = create_app(settings=Settings(api_token="secret"))
    client = TestClient(app)

    assert client.post("/api/v1/attributions", json=request_body()).status_code == 401
    assert (
        client.post(
            "/api/v1/attributions",
            json=request_body(),
            headers={"Authorization": "Bearer secret"},
        ).status_code
        == 200
    )
