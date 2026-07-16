from __future__ import annotations

from conftest import message


def test_endpoints_are_anonymous_and_old_batch_is_absent(client):
    document = client.get("/openapi.json").json()
    assert document.get("security") is None
    assert document["paths"]["/api/v1/telemetry/sync"]["post"].get("security") is None
    assert "/api/v1/telemetry/sync:batch" not in document["paths"]
    assert client.post("/api/v1/telemetry/sync", json=message()).status_code == 200


def test_openapi_explains_single_step_fields_in_chinese(client):
    operation = client.get("/openapi.json").json()["paths"]["/api/v1/telemetry/sync"]["post"]
    description = operation["description"]
    assert "一个请求上报一个" in description
    assert "message_id" in description
    assert "data.file" in description
    assert "Unix 毫秒" in description
    schema = operation["requestBody"]["content"]["application/json"]["schema"]
    assert schema["$ref"].endswith("TelemetrySyncRequest")


def test_request_body_limit_and_extra_fields_return_stable_errors(client):
    oversized = b"{" + b'"padding":"' + b"x" * (1024 * 1024) + b'"}'
    response = client.post(
        "/api/v1/telemetry/sync",
        content=oversized,
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 413
    assert response.json()["code"] == "PAYLOAD_TOO_LARGE"
    assert response.headers["X-Request-ID"] == response.json()["request_id"]

    payload = message()
    payload["installation_id"] = "forbidden"
    response = client.post("/api/v1/telemetry/sync", json=payload)
    assert response.status_code == 400
    assert response.json()["code"] == "INVALID_REQUEST"


def test_self_test_and_health_endpoints_remain_available(client):
    assert client.get("/health/live").json() == {"status": "ok"}
    assert client.get("/health/ready").json() == {"status": "ok"}
    page = client.get("/self-test")
    assert page.status_code == 200
    assert "text/html" in page.headers["content-type"]
