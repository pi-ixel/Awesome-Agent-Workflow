from __future__ import annotations

import hashlib
import uuid
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.pool import StaticPool

from aaw_telemetry.config import ProjectEntry, ProjectRegistry, ProjectsDocument, Settings
from aaw_telemetry.database import Base
from aaw_telemetry.main import create_app
from aaw_telemetry.services.mock_attribution_service import MockAttributionService

WORKFLOW_ID = uuid.UUID("11111111-1111-4111-8111-111111111111")
MESSAGE_ID = uuid.UUID("22222222-2222-4222-8222-222222222222")
SECOND_MESSAGE_ID = uuid.UUID("33333333-3333-4333-8333-333333333333")
STARTED_AT = 1784077200000
STEP_STARTED_AT = STARTED_AT + 60_000
STEP_COMPLETED_AT = STARTED_AT + 1_800_000
UPDATED_AT = STEP_COMPLETED_AT + 1_000
DIFF = (
    b"diff --git a/app.py b/app.py\n"
    b"--- a/app.py\n"
    b"+++ b/app.py\n"
    b"@@ -1 +1,3 @@\n"
    b" old\n"
    b"+new line\n"
    b"+second line\n"
)


@pytest.fixture
def projects() -> ProjectRegistry:
    return ProjectRegistry(
        ProjectsDocument(
            projects={
                "team/example-service": ProjectEntry(
                    canonical_url="git@git.company.com:team/example-service.git",
                    target_branch="main",
                    enabled=True,
                )
            }
        )
    )


@pytest.fixture
def client(projects: ProjectRegistry, tmp_path) -> Iterator[TestClient]:
    engine = create_engine(
        "sqlite+pysqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    @event.listens_for(engine, "connect")
    def enable_foreign_keys(dbapi_connection, _):
        dbapi_connection.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    settings = Settings(
        database_url="sqlite+pysqlite://",
        object_storage_dir=tmp_path / "objects",
        log_directory=tmp_path / "logs",
        log_level="INFO",
        max_request_bytes=1024 * 1024,
        max_patch_bytes=2 * 1024 * 1024,
        upload_session_seconds=3600,
    )
    attribution_service = MockAttributionService()
    app = create_app(
        settings,
        engine=engine,
        projects=projects,
        attribution_service=attribution_service,
    )
    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client
    Base.metadata.drop_all(engine)
    engine.dispose()


def message(
    *,
    message_id: uuid.UUID = MESSAGE_ID,
    workflow_id: uuid.UUID = WORKFLOW_ID,
    user_email: str = "Developer@Example.com",
    user_name: str = "Z30049429",
    repository: str = "team/example-service",
    sr: str = "SR-1001",
    ar: str | None = "AR-2001",
    step_type: str = "task-dev",
    status: str = "done",
    with_file: bool | None = None,
    workflow_completed: bool = True,
    started_at: int = STARTED_AT,
    step_started_at: int = STEP_STARTED_AT,
    step_completed_at: int | None = STEP_COMPLETED_AT,
    updated_at: int = UPDATED_AT,
    step_id: int | None = None,
    step_name: str | None = None,
    attempt: int = 1,
    execution_type: str = "skill",
    skill_names: list[str] | None = None,
    task_id: str | None = None,
    development: dict | None = None,
) -> dict:
    if with_file is None:
        with_file = step_type == "task-dev" and status == "done"
    payload = {
        "message_id": str(message_id),
        "workflow_id": str(workflow_id),
        "aaw_version": "0.1.0",
        "user_email": user_email,
        "user_name": user_name,
        "repository": repository,
        "sr": sr,
        "started_at": started_at,
        "completed_at": updated_at if workflow_completed else None,
        "updated_at": updated_at,
        "data": {
            "ar": ar,
            "step_type": step_type,
            "status": status,
            "started_at": step_started_at,
            "completed_at": step_completed_at,
            "file": (
                {
                    "file_name": f"{sr}-{ar}.diff",
                    "sha256": hashlib.sha256(DIFF).hexdigest(),
                }
                if with_file
                else None
            ),
        },
    }
    if step_id is not None:
        payload["data"].update(
            {
                "step_id": step_id,
                "step_name": step_name or step_type,
                "attempt": attempt,
                "execution_type": execution_type,
                "skill_names": skill_names if skill_names is not None else [step_type],
                "task_id": task_id,
                "development": development,
            }
        )
    return payload


def sync(client: TestClient, payload: dict):
    return client.post("/api/v1/telemetry/sync", json=payload)


def upload_diff(client: TestClient, payload: dict, *, content: bytes = DIFF):
    confirmed = client.put(
        f"/api/v1/objects/step-diffs/{payload['message_id']}",
        content=content,
        headers={"Content-Type": "application/octet-stream"},
    )
    assert confirmed.status_code == 200, confirmed.text
    return confirmed.json()
