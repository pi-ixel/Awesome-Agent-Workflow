from __future__ import annotations

import time
import uuid

from conftest import (
    SECOND_MESSAGE_ID,
    STEP_COMPLETED_AT,
    UPDATED_AT,
    WORKFLOW_ID,
    message,
    sync,
    upload_diff,
)


def seed(client):
    dev = message(workflow_completed=False)
    review = message(
        message_id=SECOND_MESSAGE_ID,
        user_email="reviewer@example.com",
        user_name="Z30049430",
        step_type="review",
        status="failed",
        with_file=False,
        step_started_at=STEP_COMPLETED_AT + 1,
        step_completed_at=UPDATED_AT + 1_000,
        updated_at=UPDATED_AT + 2_000,
    )
    assert sync(client, dev).status_code == 200
    assert sync(client, review).status_code == 200
    upload_diff(client, dev)
    return dev, review


def test_overview_and_filter_options_use_message_dimensions(client):
    seed(client)
    options = client.get("/api/v1/dashboard/filter-options").json()
    assert options["repositories"][0] == {
        "project_key": "team/example-service",
        "canonical_url": "git@git.company.com:team/example-service.git",
        "target_branch": "main",
        "enabled": True,
    }
    assert {row["user_email"] for row in options["users"]} == {
        "developer@example.com",
        "reviewer@example.com",
    }

    period = client.get("/api/v1/dashboard/overview").json()["period"]
    assert period["workflow_runs"] == 1
    assert period["active_users"] == 2
    assert period["steps"] == 2
    assert period["dev_effective_lines"] == 2


def test_user_and_repository_summaries_are_paginated_and_person_scoped(client):
    seed(client)
    users = client.get("/api/v1/dashboard/users", params={"page_size": 1}).json()
    assert users["total"] == 2
    assert len(users["items"]) == 1

    reviewer = client.get(
        "/api/v1/dashboard/users", params={"user_email": "reviewer@example.com"}
    ).json()["items"][0]
    assert reviewer["steps"] == 1
    assert reviewer["dev_runs"] == 0

    repositories = client.get("/api/v1/dashboard/projects").json()
    assert repositories["items"][0]["project_key"] == "team/example-service"
    assert repositories["items"][0]["canonical_url"] == (
        "git@git.company.com:team/example-service.git"
    )
    assert "display_name" not in repositories["items"][0]
    assert "platform" not in repositories["items"][0]
    assert "platform_project_id" not in repositories["items"][0]
    assert repositories["items"][0]["steps"] == 2


def test_step_summary_reports_terminal_status_and_duration(client):
    seed(client)
    response = client.get("/api/v1/dashboard/steps", params={"page_size": 1}).json()
    assert response["total"] == 2
    assert len(response["items"]) == 1
    all_rows = client.get("/api/v1/dashboard/steps").json()["items"]
    review = next(row for row in all_rows if row["key"] == "review")
    assert review["failed_steps"] == 1
    assert review["duration_seconds"]["p90"] == 1


def test_workflow_list_and_detail_include_participants_steps_and_milliseconds(client):
    seed(client)
    listed = client.get("/api/v1/dashboard/workflows").json()
    assert listed["total"] == 1
    row = listed["items"][0]
    assert isinstance(row["started_at"], int)
    assert len(row["participants"]) == 2
    assert row["furthest_step_type"] == "review"
    assert "project_display_name" not in row

    detail = client.get(f"/api/v1/workflows/{WORKFLOW_ID}").json()
    assert [row["step_type"] for row in detail["steps"]] == ["task-dev", "review"]
    assert detail["steps"][0]["file_status"] == "confirmed"


def test_attribution_list_supports_filters_and_pagination(client):
    seed(client)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        detail = client.get(f"/api/v1/workflows/{WORKFLOW_ID}").json()
        if detail["steps"][0]["attribution_status"] == "finalized_match":
            break
        time.sleep(0.01)
    else:
        raise AssertionError("attribution did not reach 'finalized_match'")

    response = client.get(
        "/api/v1/statistics/code-attribution",
        params={
            "result_status": "finalized_match",
            "repository": "team/example-service",
            "user_email": "developer@example.com",
            "page_size": 1,
        },
    ).json()
    assert response["total"] == 1
    item = response["items"][0]
    assert item["workflow_id"] == str(WORKFLOW_ID)
    assert item["file_name"].endswith(".diff")
    assert item["matched_mr_url"].startswith("https://example.invalid/")


def test_trends_fill_empty_days_and_invalid_queries_are_stable(client):
    seed(client)
    trends = client.get(
        "/api/v1/dashboard/trends",
        params={"from": "2026-07-14", "to": "2026-07-16", "granularity": "day"},
    ).json()
    assert len(trends["points"]) == 3
    assert sum(row["workflow_runs"] for row in trends["points"]) == 1

    invalid = client.get(
        "/api/v1/dashboard/overview",
        params={"from": "2026-07-16", "to": "2026-07-14"},
    )
    assert invalid.status_code == 400
    assert invalid.json()["code"] == "INVALID_FILTER"
    missing = client.get("/api/v1/workflows/99999999-9999-4999-8999-999999999999")
    assert missing.status_code == 404
    assert missing.json()["code"] == "WORKFLOW_NOT_FOUND"


def test_completed_state_filter(client):
    payload = message()
    sync(client, payload)
    completed = client.get("/api/v1/dashboard/workflows", params={"state": "completed"})
    active = client.get("/api/v1/dashboard/workflows", params={"state": "active"})
    assert completed.json()["total"] == 1
    assert active.json()["total"] == 0


def test_deployed_portal_read_aliases_remain_compatible(client):
    seed(client)
    options = client.get("/api/v1/dashboard/filter-options").json()
    assert options["projects"] == options["repositories"]
    assert options["git_users"][0]["git_user_email"]
    users = client.get(
        "/api/v1/dashboard/users", params={"git_user_email": "developer@example.com"}
    ).json()
    assert users["total"] == 1
    assert users["items"][0]["git_user_email"] == "developer@example.com"


def await_attribution(client, workflow_id=WORKFLOW_ID):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        detail = client.get(f"/api/v1/workflows/{workflow_id}").json()
        if detail["steps"][0]["attribution_status"] == "finalized_match":
            return
        time.sleep(0.01)
    raise AssertionError("attribution did not reach 'finalized_match'")


def test_components_summary_returns_all_configured_components(client):
    seed(client)
    response = client.get("/api/v1/dashboard/components").json()
    assert response["unassigned_component_id"] == "__unassigned__"
    assert response["total_components"] == 1
    assert response["used_components"] == 1
    item = response["items"][0]
    assert item["component_id"] == "example-component"
    assert item["name"] == "示例组件"
    assert item["se"] == "张三"
    assert item["used_aaw"] is True
    assert item["effective_lines"] == 2
    assert item["repos"] == ["team/example-service"]


def test_components_summary_sums_match_overview_effective_lines(client):
    seed(client)
    components = client.get("/api/v1/dashboard/components").json()
    period = client.get("/api/v1/dashboard/overview").json()["period"]
    assert sum(row["effective_lines"] for row in components["items"]) == (
        period["dev_effective_lines"]
    )


def test_components_summary_buckets_unregistered_repository(client):
    seed(client)
    orphan = message(
        message_id=uuid.UUID("44444444-4444-4144-8444-444444444444"),
        workflow_id=uuid.UUID("55555555-5555-4555-8555-555555555555"),
        repository="team/unregistered",
        step_type="review",
        with_file=False,
    )
    assert sync(client, orphan).status_code == 200

    response = client.get("/api/v1/dashboard/components").json()
    assert response["total_components"] == 2
    unassigned = response["items"][-1]
    assert unassigned["component_id"] == "__unassigned__"
    assert unassigned["name"] == "未归类组件"
    assert unassigned["se"] is None
    assert unassigned["used_aaw"] is True
    assert unassigned["effective_lines"] == 0
    assert unassigned["repos"] == ["team/unregistered"]


def test_used_aaw_ignores_time_filter(client):
    seed(client)
    response = client.get(
        "/api/v1/dashboard/components",
        params={"from": "2099-01-01", "to": "2099-01-31"},
    ).json()
    item = response["items"][0]
    assert item["effective_lines"] == 0
    assert item["attribution_rate_80"] is None
    assert item["used_aaw"] is True
    assert response["used_components"] == 1


def test_attribution_rate_80_is_weighted_and_null_when_no_lines(client):
    empty = client.get("/api/v1/dashboard/components").json()["items"][0]
    assert empty["effective_lines"] == 0
    assert empty["attribution_rate_80"] is None
    assert empty["used_aaw"] is False

    seed(client)
    await_attribution(client)
    item = client.get("/api/v1/dashboard/components").json()["items"][0]
    # The stub attributes every effective line, so the weighted rate is exactly 1.0.
    assert item["effective_lines"] == 2
    assert item["attribution_rate_80"] == 1.0


def test_testing_dashboard_exposes_components_endpoint(client):
    seed(client)
    response = client.get("/api/v1/testing/dashboard/components")
    assert response.status_code == 200
    payload = response.json()
    assert payload["total_components"] == 1
    item = payload["items"][0]
    assert item["component_id"] == "example-component"
    # AAW telemetry must not mark the component as used on the testing dashboard.
    assert item["used_aaw"] is False
    assert payload["used_components"] == 0
