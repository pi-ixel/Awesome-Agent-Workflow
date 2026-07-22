from __future__ import annotations

import copy
import uuid

import pytest
from conftest import (
    MESSAGE_ID,
    SECOND_MESSAGE_ID,
    STARTED_AT,
    STEP_COMPLETED_AT,
    UPDATED_AT,
    WORKFLOW_ID,
    message,
    sync,
)
from sqlalchemy import select
from sqlalchemy.orm import Session

from aaw_telemetry.models import DevRun, StepExecution


def test_accepts_single_step_and_exposes_detail(client):
    payload = message()
    response = sync(client, payload)

    assert response.status_code == 200
    body = response.json()
    assert body["message_id"] == str(MESSAGE_ID)
    assert body["status"] == "accepted"
    assert isinstance(body["server_updated_at"], int)
    assert response.headers["X-Request-ID"] == body["request_id"]

    detail = client.get(f"/api/v1/workflows/{WORKFLOW_ID}").json()
    assert detail["steps"][0]["user_email"] == "developer@example.com"
    assert detail["steps"][0]["file_status"] == "pending"
    assert detail["workflow"]["status"] == "completed"


def test_accepts_start_with_null_completed_at(client):
    payload = message(
        status="start",
        step_type="review",
        step_completed_at=None,
        workflow_completed=False,
        with_file=False,
    )

    response = sync(client, payload)

    assert response.status_code == 200
    assert response.json()["status"] == "accepted"
    detail = client.get(f"/api/v1/workflows/{WORKFLOW_ID}").json()
    assert detail["workflow"]["status"] == "in_progress"
    assert detail["steps"][0]["status"] == "start"
    assert detail["steps"][0]["completed_at"] is None


def test_v2_start_and_done_share_one_task_attempt(client):
    start = message(
        status="start",
        step_completed_at=None,
        workflow_completed=False,
        with_file=False,
        step_id=12,
        step_name="T2-task-dev",
        task_id="T2",
    )
    done = message(
        message_id=SECOND_MESSAGE_ID,
        step_id=12,
        step_name="T2-task-dev",
        task_id="T2",
        development={
            "implementation": "completed",
            "tests": "passed",
            "review_and_optimization": "completed",
            "revalidation": "passed",
        },
    )

    assert sync(client, start).status_code == 200
    assert sync(client, done).status_code == 200

    with Session(client.app.state.engine) as session:
        steps = list(session.scalars(select(StepExecution)).all())
        dev_runs = list(session.scalars(select(DevRun)).all())
        assert len(steps) == 1
        assert steps[0].step_id == 12
        assert steps[0].attempt == 1
        assert steps[0].task_id == "T2"
        assert steps[0].status == "completed"
        assert steps[0].development["tests"] == "passed"
        assert len(dev_runs) == 1
        assert dev_runs[0].step_execution_id == steps[0].id


@pytest.mark.parametrize("status", ["failed", "blocked"])
def test_accepts_non_done_terminal_status_with_null_completed_at(client, status):
    payload = message(
        status=status,
        step_type="review",
        step_completed_at=None,
        workflow_completed=False,
        with_file=False,
    )

    assert sync(client, payload).status_code == 200


def test_done_requires_completed_at(client):
    payload = message(step_completed_at=None)

    response = sync(client, payload)

    assert response.status_code == 400
    assert response.json()["code"] == "INVALID_REQUEST"


def test_duplicate_normalizes_email_but_message_conflict_is_http_409(client):
    payload = message(user_email=" Developer@Example.com ")
    assert sync(client, payload).json()["status"] == "accepted"
    duplicate = message(user_email="developer@example.com")
    assert sync(client, duplicate).json()["status"] == "duplicate"

    conflict = copy.deepcopy(duplicate)
    conflict["data"]["ar"] = "AR-DIFFERENT"
    response = sync(client, conflict)
    assert response.status_code == 409
    assert response.json()["code"] == "MESSAGE_CONFLICT"


def test_same_workflow_accepts_multiple_people_and_tracks_participants(client):
    first = message(workflow_completed=False, step_type="planning", with_file=False)
    second = message(
        message_id=SECOND_MESSAGE_ID,
        user_email="other@example.com",
        user_name="Z30049430",
        step_type="review",
        with_file=False,
        step_started_at=STEP_COMPLETED_AT + 1,
        step_completed_at=UPDATED_AT + 1_000,
        updated_at=UPDATED_AT + 2_000,
    )
    assert sync(client, first).status_code == 200
    assert sync(client, second).status_code == 200

    item = client.get("/api/v1/dashboard/workflows").json()["items"][0]
    assert {row["user_email"] for row in item["participants"]} == {
        "developer@example.com",
        "other@example.com",
    }


@pytest.mark.parametrize("field,value", [("repository", "team/other"), ("sr", "SR-2")])
def test_workflow_consistent_fields_cannot_change(client, field, value):
    first = message(workflow_completed=False, step_type="planning", with_file=False)
    assert sync(client, first).status_code == 200
    second = message(
        message_id=SECOND_MESSAGE_ID,
        step_type="review",
        with_file=False,
        workflow_completed=False,
    )
    second[field] = value
    response = sync(client, second)
    assert response.status_code == 400
    assert field in response.json()["message"]


def test_workflow_started_at_is_consistent(client):
    assert sync(client, message(step_type="planning", with_file=False)).status_code == 200
    changed = message(
        message_id=SECOND_MESSAGE_ID,
        started_at=STARTED_AT + 1,
        step_type="review",
        with_file=False,
    )
    response = sync(client, changed)
    assert response.status_code == 400
    assert "started_at" in response.json()["message"]


def test_same_workflow_preserves_nonzero_milliseconds(client):
    started_at = STARTED_AT + 123
    first = message(
        started_at=started_at,
        step_started_at=started_at,
        step_type="planning",
        status="start",
        with_file=False,
        workflow_completed=False,
        step_completed_at=None,
        updated_at=started_at + 10,
    )
    second = message(
        message_id=SECOND_MESSAGE_ID,
        started_at=started_at,
        step_started_at=started_at + 1,
        step_type="review",
        status="start",
        with_file=False,
        workflow_completed=False,
        step_completed_at=None,
        updated_at=started_at + 20,
    )

    assert sync(client, first).status_code == 200
    assert sync(client, second).status_code == 200

    detail = client.get(f"/api/v1/workflows/{WORKFLOW_ID}").json()
    assert detail["workflow"]["started_at"] == started_at


@pytest.mark.parametrize(
    "mutator",
    [
        lambda body: body.update({"updated_at": str(body["updated_at"])}),
        lambda body: body.update({"unknown": True}),
        lambda body: body["data"].update({"completed_at": body["data"]["started_at"] - 1}),
        lambda body: body["data"].update({"started_at": body["started_at"] - 1}),
        lambda body: body["data"].update({"file": None}),
    ],
)
def test_invalid_message_shapes_are_rejected_at_request_level(client, mutator):
    payload = message()
    mutator(payload)
    response = sync(client, payload)
    assert response.status_code == 400
    assert response.json()["code"] == "INVALID_REQUEST"


def test_file_is_forbidden_for_non_dev_or_non_done_steps(client):
    for index, payload in enumerate(
        [
            message(step_type="review", with_file=True),
            message(status="failed", with_file=True),
        ]
    ):
        payload["message_id"] = str(uuid.UUID(int=100 + index))
        assert sync(client, payload).status_code == 400


@pytest.mark.parametrize("user_name", ["Alice", "张三", "", "arbitrary display name"])
def test_user_name_has_no_format_validation(client, user_name):
    payload = message(user_name=user_name, step_type="review", with_file=False)
    response = sync(client, payload)
    assert response.status_code == 200
    assert response.json()["status"] == "accepted"


@pytest.mark.parametrize(
    "repository",
    [
        "single",
        "group/subgroup/example-service",
        "https://git.example.com/team/example-service.git",
        "repository with spaces",
    ],
)
def test_repository_has_no_format_validation(client, repository):
    payload = message(repository=repository, step_type="review", with_file=False)
    response = sync(client, payload)
    assert response.status_code == 200
    assert response.json()["status"] == "accepted"


def test_old_batch_route_is_removed(client):
    response = client.post("/api/v1/telemetry/sync:batch", json={"records": []})
    assert response.status_code == 404
