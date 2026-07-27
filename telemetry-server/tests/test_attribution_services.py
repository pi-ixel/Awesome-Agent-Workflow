from __future__ import annotations

import base64
import hashlib
import uuid
from datetime import UTC, datetime

import httpx
import pytest
from aaw_contracts import AttributionRequest as SharedAttributionRequest

from aaw_telemetry.services.attribution_service import (
    AttributionRequest,
    AttributionServiceError,
    DevelopmentContext,
    DiffPayload,
    ProjectContext,
    TelemetryContext,
)
from aaw_telemetry.services.remote_attribution_service import RemoteAttributionService


def attribution_request() -> AttributionRequest:
    content = b"+new line\n"
    return AttributionRequest(
        request_id=uuid.uuid4(),
        project=ProjectContext(key="team/example", target_branch="main"),
        development=DevelopmentContext(
            branch="feature/test",
            head_sha_start="a" * 40,
        ),
        telemetry=TelemetryContext(
            repository="team/example",
            sr="SR-1",
            user_email="developer@example.com",
        ),
        diff=DiffPayload(
            sha256=hashlib.sha256(content).hexdigest(),
            content_base64=base64.b64encode(content).decode(),
            statistics={"total_effective_lines": 1},
        ),
    )


def result_body(request_id: uuid.UUID) -> dict:
    return {
        "schema_version": "1.0",
        "request_id": str(request_id),
        "result_status": "finalized_match",
        "dev_effective_lines": 1,
        "attributed_lines_80": 1,
        "attributed_lines_90": 1,
        "confidence": 0.9,
        "quality_flags": [],
        "matched_mr_iid": None,
        "matched_mr_url": None,
        "mr_diff_version": None,
        "mr_source_branch": None,
        "target_branch": "main",
        "merge_commit_sha": None,
        "mr_merged_at": None,
        "algorithm_version": "test-v1",
        "diff_rule_version": "diff-v1",
        "matched_at": datetime.now(UTC).isoformat(),
    }


def test_telemetry_service_reexports_the_shared_contract():
    assert AttributionRequest is SharedAttributionRequest


def test_remote_service_sends_versioned_contract_and_token():
    request = attribution_request()

    def handler(http_request: httpx.Request) -> httpx.Response:
        assert http_request.url.path == "/api/v1/attributions"
        assert http_request.headers["Idempotency-Key"] == str(request.request_id)
        assert http_request.headers["Authorization"] == "Bearer secret"
        return httpx.Response(200, json=result_body(request.request_id))

    service = RemoteAttributionService(
        "http://attribution:8010/",
        timeout_seconds=2,
        api_token="secret",
        transport=httpx.MockTransport(handler),
    )

    result = service.attribute(request)

    assert result.request_id == request.request_id
    assert result.algorithm_version == "test-v1"


@pytest.mark.parametrize("status_code", [500, 503])
def test_remote_service_wraps_http_failures(status_code):
    request = attribution_request()
    service = RemoteAttributionService(
        "http://attribution:8010",
        timeout_seconds=2,
        transport=httpx.MockTransport(
            lambda _: httpx.Response(status_code, json={"detail": "unavailable"})
        ),
    )

    with pytest.raises(AttributionServiceError):
        service.attribute(request)


def test_remote_service_rejects_mismatched_response_id():
    request = attribution_request()
    service = RemoteAttributionService(
        "http://attribution:8010",
        timeout_seconds=2,
        transport=httpx.MockTransport(
            lambda _: httpx.Response(200, json=result_body(uuid.uuid4()))
        ),
    )

    with pytest.raises(AttributionServiceError, match="mismatched"):
        service.attribute(request)


def test_remote_service_rejects_incompatible_schema_version():
    request = attribution_request()
    body = result_body(request.request_id)
    body["schema_version"] = "2.0"
    service = RemoteAttributionService(
        "http://attribution:8010",
        timeout_seconds=2,
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json=body)),
    )

    with pytest.raises(AttributionServiceError, match="request failed"):
        service.attribute(request)


def test_remote_service_wraps_timeout():
    request = attribution_request()

    def timeout(http_request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=http_request)

    service = RemoteAttributionService(
        "http://attribution:8010",
        timeout_seconds=2,
        transport=httpx.MockTransport(timeout),
    )

    with pytest.raises(AttributionServiceError, match="request failed"):
        service.attribute(request)
