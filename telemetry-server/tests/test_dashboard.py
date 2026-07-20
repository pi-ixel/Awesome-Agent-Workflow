from __future__ import annotations

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
