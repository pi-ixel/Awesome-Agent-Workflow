from __future__ import annotations

import time
import uuid
from datetime import UTC, datetime, timedelta

from aaw_telemetry.models import CodeAttribution, DevRun
from aaw_telemetry.services.attribution_scheduler import AttributionScheduler
from tests.conftest import message, sync, upload_diff


def _db_session(client):
    from sqlalchemy.orm import sessionmaker

    return sessionmaker(bind=client.app.state.engine)()


def _wait_for_status(client, message_id: str, status: str, timeout: float = 5.0):
    """Poll the queue until the item settles; the background scheduler may
    still be mid-flight after the manual scan returns."""
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        items = client.get(
            "/api/v1/admin/attribution/queue", params={"page_size": 100}
        ).json()["items"]
        last = next((i for i in items if i["dev_run_id"] == message_id), None)
        if last is not None and last["attribution_status"] == status:
            return last
        time.sleep(0.05)
    raise AssertionError(
        f"attribution {message_id} did not reach {status}; "
        f"last={last and last['attribution_status']}"
    )


def _make_attribution(client) -> str:
    payload = message()
    assert sync(client, payload).status_code == 200
    upload_diff(client, payload)
    # The upload wakes the background scheduler; a manual scan guarantees
    # processing starts, then we wait out the in-flight pass.
    client.post("/api/v1/admin/attribution/scan")
    _wait_for_status(client, payload["message_id"], "finalized_match")
    return payload["message_id"]


def test_admin_page_is_served(client):
    response = client.get("/admin")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]


def test_overview_reports_scheduler_queue_registry_and_logs(client):
    response = client.get("/api/v1/admin/overview")
    assert response.status_code == 200
    body = response.json()
    assert body["scheduler"]["running"] is True
    assert body["scheduler"]["paused"] is False
    assert body["scheduler"]["last_scan_at"] is not None
    assert body["attribution"]["total"] == 0
    assert body["attribution"]["by_status"]["pending"] == 0
    assert body["registry"] == {"components": 1, "repos": 1}
    assert {item["file"] for item in body["logs"]} == {
        "server.log",
        "error.log",
        "access.log",
    }


def test_queue_lists_attribution_with_workflow_context(client):
    message_id = _make_attribution(client)

    response = client.get("/api/v1/admin/attribution/queue")
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    item = body["items"][0]
    assert item["dev_run_id"] == message_id
    assert item["attribution_status"] == "finalized_match"
    assert item["repository"] == "team/example-service"
    assert item["sr"] == "SR-1001"
    assert item["dev_effective_lines"] > 0
    assert item["retry_window_expired"] is False

    filtered = client.get(
        "/api/v1/admin/attribution/queue", params={"attribution_status": "pending"}
    )
    assert filtered.json()["total"] == 0
    assert (
        client.get(
            "/api/v1/admin/attribution/queue", params={"attribution_status": "bogus"}
        ).status_code
        == 400
    )


def test_retry_resets_finalized_attribution_and_reruns(client):
    message_id = _make_attribution(client)

    response = client.post(f"/api/v1/admin/attribution/{message_id}/retry")
    assert response.status_code == 200
    body = response.json()
    assert body["attribution_status"] == "pending"
    assert body["retry_count"] == 0
    assert body["next_retry_at"] is None
    assert "admin_retry" in body["quality_flags"]

    client.post("/api/v1/admin/attribution/scan")
    _wait_for_status(client, message_id, "finalized_match")
    queue = client.get(
        "/api/v1/admin/attribution/queue", params={"attribution_status": "finalized_match"}
    ).json()
    assert queue["total"] == 1
    assert "admin_retry" in queue["items"][0]["quality_flags"]


def test_retry_rejects_running_and_expired_and_unknown(client):
    message_id = _make_attribution(client)

    with _db_session(client) as session:
        attribution = session.get(CodeAttribution, uuid.UUID(message_id))
        attribution.attribution_status = "running"
        session.commit()
    running = client.post(f"/api/v1/admin/attribution/{message_id}/retry")
    assert running.status_code == 409
    assert running.json()["code"] == "ATTRIBUTION_RUNNING"

    with _db_session(client) as session:
        attribution = session.get(CodeAttribution, uuid.UUID(message_id))
        attribution.attribution_status = "retry_pending"
        attribution.next_retry_at = datetime.now(UTC) + timedelta(hours=4)
        dev_run = session.get(DevRun, uuid.UUID(message_id))
        dev_run.completed_at = datetime.now(UTC) - timedelta(days=91)
        session.commit()
    expired = client.post(f"/api/v1/admin/attribution/{message_id}/retry")
    assert expired.status_code == 409
    assert expired.json()["code"] == "RETRY_WINDOW_EXPIRED"

    unknown = str(uuid.uuid4())
    assert (
        client.post(f"/api/v1/admin/attribution/{unknown}/retry").status_code == 404
    )
    assert client.post("/api/v1/admin/attribution/not-a-uuid/retry").status_code == 400


def test_manual_scan_returns_processed_count(client):
    body = client.post("/api/v1/admin/attribution/scan").json()
    assert body["already_running"] is False
    assert body["processed"] == 0


def test_scheduler_status_reports_pause_and_revive():
    import types

    scheduler = AttributionScheduler.__new__(AttributionScheduler)
    scheduler._settings = types.SimpleNamespace(
        attribution_scan_interval_seconds=10, attribution_retry_window_seconds=100
    )
    scheduler._task = None
    scheduler._stopping = False
    scheduler._paused = True
    scheduler._loop = None
    scheduler._last_scan_at = None
    scheduler._last_scan_processed = None
    scheduler._last_scan_error = None
    scheduler._consecutive_failures = 3
    assert scheduler.revive() is False
    status = scheduler.status()
    assert status["paused"] is True
    assert status["consecutive_failures"] == 3


# ----------------------------------------------------------------------
# Registry CRUD


def test_registry_lists_seeded_content(client):
    body = client.get("/api/v1/admin/registry").json()
    assert len(body["components"]) == 1
    component = body["components"][0]
    assert component["id"] == "example-component"
    assert component["name"] == "示例组件"
    assert component["se"] == "张三"
    assert component["ai_master"] is None
    assert component["repos"][0]["repo_key"] == "team/example-service"


def test_registry_crud_cycle_updates_live_registry(client):
    created = client.post(
        "/api/v1/admin/registry/components",
        json={"component_id": "new-service", "name": "新服务", "se": "李四"},
    )
    assert created.status_code == 201
    assert client.app.state.projects.component_of("anything") is None

    repo = client.post(
        "/api/v1/admin/registry/components/new-service/repos",
        json={
            "repo_key": "example-service",
            "canonical_url": "git@git.company.com:team/example-service-2.git",
        },
    )
    assert repo.status_code == 201

    # Hot reload: the running registry resolves the new repo immediately.
    projects = client.app.state.projects
    assert projects.get("example-service") is not None
    assert projects.component_of("example-service") == "new-service"

    patched = client.patch(
        "/api/v1/admin/registry/components/new-service/repos/example-service",
        json={"enabled": False, "target_branch": "develop"},
    )
    assert patched.status_code == 200
    assert projects.get("example-service").enabled is False
    assert projects.get("example-service").target_branch == "develop"

    renamed = client.patch(
        "/api/v1/admin/registry/components/new-service",
        json={"name": "新服务二", "se": "王五"},
    )
    assert renamed.status_code == 200
    view = next(c for c in projects.components() if c.component_id == "new-service")
    assert (view.name, view.se) == ("新服务二", "王五")

    deleted = client.delete(
        "/api/v1/admin/registry/components/new-service/repos/example-service"
    )
    assert deleted.status_code == 200
    assert projects.get("example-service") is None

    assert (
        client.delete("/api/v1/admin/registry/components/new-service").status_code == 200
    )
    assert all(
        c.component_id != "new-service" for c in projects.components()
    )


def test_registry_rejects_duplicates_and_reserved_ids(client):
    assert (
        client.post(
            "/api/v1/admin/registry/components",
            json={"component_id": "example-component", "name": "重复"},
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/v1/admin/registry/components",
            json={"component_id": "__unassigned__", "name": "保留字"},
        ).status_code
        == 400
    )
    client.post(
        "/api/v1/admin/registry/components",
        json={"component_id": "second", "name": "第二组件"},
    )
    # Duplicate repo key across components is a direct conflict.
    duplicate_key = client.post(
        "/api/v1/admin/registry/components/second/repos",
        json={
            "repo_key": "team/example-service",
            "canonical_url": "git@git.company.com:team/other.git",
        },
    )
    assert duplicate_key.status_code == 409
    assert duplicate_key.json()["code"] == "REPO_EXISTS"
    # Duplicate canonical url is caught by document validation.
    duplicate_url = client.post(
        "/api/v1/admin/registry/components/second/repos",
        json={
            "repo_key": "team/other",
            "canonical_url": "git@git.company.com:team/example-service.git",
        },
    )
    assert duplicate_url.status_code == 400
    assert duplicate_url.json()["code"] == "REGISTRY_INVALID"
    assert (
        client.delete("/api/v1/admin/registry/components/missing").status_code == 404
    )


def test_component_delete_blocked_while_assigned_to_ai_master(client):
    master = client.post("/api/v1/ai-masters", json={"name": "大师"}).json()
    assigned = client.put(
        "/api/v1/ai-masters/assignments/example-component",
        json={"ai_master_id": master["id"]},
    )
    assert assigned.status_code == 200

    blocked = client.delete("/api/v1/admin/registry/components/example-component")
    assert blocked.status_code == 409
    assert blocked.json()["code"] == "COMPONENT_ASSIGNED"
    assert "大师" in blocked.json()["message"]

    client.put(
        "/api/v1/ai-masters/assignments/example-component",
        json={"ai_master_id": None},
    )
    assert (
        client.delete("/api/v1/admin/registry/components/example-component").status_code
        == 200
    )
    assert client.get("/api/v1/admin/registry").json()["components"] == []


# ----------------------------------------------------------------------
# Logs


def test_logs_tail_returns_recent_lines_with_filters(client):
    log_directory = client.app.state.log_directory
    marker_line = (
        "2026-09-03 08:00:00.000 [WARNING] [admin.test] 过滤标记行 "
        "| event=log_marker dev_run_id=abc\n"
    )
    noise_line = "2026-09-03 08:00:01.000 [INFO] [admin.test] 普通行\n"
    with (log_directory / "error.log").open("a", encoding="utf-8") as stream:
        stream.write(marker_line)
        stream.write(noise_line)

    body = client.get(
        "/api/v1/admin/logs", params={"file": "error.log", "lines": 10}
    ).json()
    assert body["file"] == "error.log"
    assert any("过滤标记行" in line for line in body["lines"])

    by_level = client.get(
        "/api/v1/admin/logs",
        params={"file": "error.log", "lines": 10, "level": "warning"},
    ).json()
    assert any("过滤标记行" in line for line in by_level["lines"])
    assert not any("普通行" in line for line in by_level["lines"])

    by_event = client.get(
        "/api/v1/admin/logs",
        params={"file": "error.log", "lines": 10, "event": "log_marker"},
    ).json()
    assert len(by_event["lines"]) == 1
    assert "过滤标记行" in by_event["lines"][0]

    by_text = client.get(
        "/api/v1/admin/logs",
        params={"file": "error.log", "lines": 10, "q": "不存在的内容"},
    ).json()
    assert by_text["lines"] == []


def test_logs_reject_unknown_files_and_caps(client):
    assert client.get("/api/v1/admin/logs", params={"file": "server.log.1"}).status_code == 404
    assert (
        client.get("/api/v1/admin/logs", params={"file": "../projects.yaml"}).status_code
        == 404
    )
    # Validation failures are normalized to 400 by the global handler.
    assert (
        client.get(
            "/api/v1/admin/logs", params={"file": "server.log", "lines": 501}
        ).status_code
        == 400
    )
