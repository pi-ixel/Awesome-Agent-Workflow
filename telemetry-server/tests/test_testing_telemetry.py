from __future__ import annotations

import hashlib
import time
import uuid

from conftest import DIFF, STARTED_AT, UPDATED_AT, message, sync
from sqlalchemy.orm import Session

from aaw_telemetry.models import CodeAttribution


def build_testing_message(*, with_change: bool = True) -> dict:
    completed_at = STARTED_AT + 60_000
    event = {
        "step_id": 1,
        "step_type": "test-code-change" if with_change else "case-design",
        "step_name": "实现登录测试" if with_change else "设计登录测试用例",
        "attempt": 1,
        "status": "done",
        "started_at": STARTED_AT,
        "completed_at": completed_at,
        "test_summary": {
            "cases_total": 4,
            "cases_passed": 3,
            "cases_failed": 1,
            "cases_blocked": 0,
        },
    }
    if with_change:
        event["change_artifact"] = {
            "file_name": "TP-1-tests.diff",
            "sha256": hashlib.sha256(DIFF).hexdigest(),
            "change_kind": "test_code",
        }
    return {
        "message_id": str(uuid.UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")),
        "workflow_id": str(uuid.UUID("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")),
        "cli_version": "0.1.0",
        "repository": "team/example-service",
        "user": {"email": "tester@example.com", "name": "Tester"},
        "started_at": STARTED_AT,
        "completed_at": completed_at,
        "updated_at": UPDATED_AT,
        "event": event,
    }


def test_testing_api_isolated_from_aaw_dashboard_and_accepts_code_change(client):
    payload = build_testing_message()
    accepted = client.post("/api/v1/testing/telemetry/sync", json=payload)
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["status"] == "accepted"

    # The original dashboard is fixed to AAW data; the testing endpoint sees only testing data.
    assert client.get("/api/v1/dashboard/overview").json()["period"]["workflow_runs"] == 0
    testing_overview = client.get("/api/v1/testing/dashboard/overview").json()["period"]
    assert testing_overview["workflow_runs"] == 1
    assert testing_overview["dev_runs"] == 1

    uploaded = client.put(
        f"/api/v1/testing/objects/code-changes/{payload['message_id']}",
        content=DIFF,
        headers={"Content-Type": "application/octet-stream"},
    )
    assert uploaded.status_code == 200, uploaded.text
    assert client.get("/api/v1/testing/dashboard/overview").json()["period"][
        "dev_effective_lines"
    ] == 2


def test_testing_dashboard_uses_matched_mr_lines_for_adoption_rates(client):
    payload = build_testing_message()
    assert client.post("/api/v1/testing/telemetry/sync", json=payload).status_code == 200
    assert client.put(
        f"/api/v1/testing/objects/code-changes/{payload['message_id']}",
        content=DIFF,
        headers={"Content-Type": "application/octet-stream"},
    ).status_code == 200

    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        period = client.get("/api/v1/testing/dashboard/overview").json()["period"]
        if period["mr_commit_lines"] == 4:
            break
        time.sleep(0.01)
    else:
        raise AssertionError("testing attribution did not expose MR commit lines")

    assert period["dev_effective_lines"] == 2
    assert period["attribution_rate_80"] == 1.0
    assert period["mr_adoption_rate_80"] == 0.5
    assert period["mr_adoption_rate_90"] == 0.5

    project = client.get("/api/v1/testing/dashboard/projects").json()["items"][0]
    user = client.get("/api/v1/testing/dashboard/users").json()["items"][0]
    component = client.get("/api/v1/testing/dashboard/components").json()["items"][0]
    trend = next(
        point
        for point in client.get("/api/v1/testing/dashboard/trends").json()["points"]
        if point["mr_commit_lines"]
    )
    for row in (project, user, component, trend):
        assert row["mr_commit_lines"] == 4
        assert row["mr_adoption_rate_80"] == 0.5

    with Session(client.app.state.engine) as session:
        attribution = session.get(CodeAttribution, uuid.UUID(payload["message_id"]))
        attribution.mr_commit_lines = None
        session.commit()

    legacy_period = client.get("/api/v1/testing/dashboard/overview").json()["period"]
    assert legacy_period["mr_commit_lines"] is None
    assert legacy_period["mr_adoption_rate_80"] is None


def test_testing_object_route_cannot_upload_an_aaw_message(client):
    aaw_payload = message()
    assert sync(client, aaw_payload).status_code == 200
    response = client.put(
        f"/api/v1/testing/objects/code-changes/{aaw_payload['message_id']}",
        content=DIFF,
        headers={"Content-Type": "application/octet-stream"},
    )
    assert response.status_code == 404


def test_testing_contract_rejects_invalid_case_counts(client):
    payload = build_testing_message(with_change=False)
    payload["event"]["test_summary"]["cases_passed"] = 5
    response = client.post("/api/v1/testing/telemetry/sync", json=payload)
    assert response.status_code == 400
    assert response.json()["code"] == "INVALID_REQUEST"
