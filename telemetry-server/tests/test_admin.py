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


def test_people_summary_lists_individuals_with_version_and_output(client):
    """SE 视角的人员层：到人，带版本、活跃时间、产出与采纳，且可按仓库收窄范围。"""
    payload = message(user_name="张三", user_email="zhangsan@example.com")
    assert sync(client, payload).status_code == 200
    upload_diff(client, payload)
    client.post("/api/v1/admin/attribution/scan")
    _wait_for_status(client, payload["message_id"], "finalized_match")

    body = client.get("/api/v1/admin/people").json()
    assert body["total"] == 1
    person = body["items"][0]
    assert person["user_name"] == "张三"
    assert person["user_email"] == "zhangsan@example.com"
    assert person["repo_keys"] == ["team/example-service"]
    assert person["version"] == "0.1.0"
    assert person["last_report_at"] is not None
    assert person["report_count"] >= 1
    assert person["dev_runs"] >= 1
    assert person["workflow_runs"] >= 1
    assert person["effective_lines"] > 0
    assert person["attribution_rate_80"] == 1.0
    # 窗口内只出现过 0.1.0，因此算"已在最新版"
    assert person["on_latest"] is True
    assert person["behind"] == 0
    assert person["non_release_version"] is False

    scoped = client.get(
        "/api/v1/admin/people", params={"repository": "team/example-service"}
    ).json()
    assert scoped["repositories"] == ["team/example-service"]
    assert scoped["total"] == 1

    outside = client.get("/api/v1/admin/people", params={"repository": "other/repo"}).json()
    assert outside["total"] == 0


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


def test_overview_groups_components_by_owner(client):
    """责任人视角：SE / AI Master / ALL 三视角；未认领兜底；聚合待归因与停滞。"""
    payload = message(
        message_id=uuid.UUID("99999999-9999-4999-8999-999999999901"),
        workflow_id=uuid.UUID("99999999-9999-4999-8999-999999999902"),
        ar="AR-OWNER-1",
    )
    assert sync(client, payload).status_code == 200

    body = client.get("/api/v1/admin/overview").json()
    owners = body["owners"]
    assert owners["window_days"] == 30
    # 注册表组件未建立 AI Master 归属 → AI Master 视角落入「未认领」
    unassigned = next(o for o in owners["by_master"] if o["is_default"])
    assert unassigned["name"] == "未认领"
    assert unassigned["workflows_30d"] >= 1
    assert unassigned["pending_attribution"] >= 1  # 补丁未上传，未完成归因闭环
    # SE 视角：组件的 SE 是「张三」
    se_row = next(o for o in owners["by_se"] if o["name"] == "张三")
    assert se_row["workflows_30d"] >= 1
    # ALL 视角：组件级明细平铺
    comp = next(c for c in owners["components"] if c["component_id"] == "example-component")
    assert comp["workflows_30d"] >= 1
    assert comp["pending_attribution"] >= 1
    assert comp["repo_keys"] == ["team/example-service"]
    assert comp["ai_master"] is None

    # 建 AI Master 并归属组件后，组件换组
    master = client.post("/api/v1/ai-masters", json={"name": "责任人甲"})
    assert master.status_code == 201
    assigned = client.put(
        "/api/v1/ai-masters/assignments/example-component",
        json={"ai_master_id": master.json()["id"]},
    )
    assert assigned.status_code == 200

    body = client.get("/api/v1/admin/overview").json()
    master_row = next(
        o for o in body["owners"]["by_master"] if o["name"] == "责任人甲"
    )
    assert master_row["components"] == 1
    assert master_row["workflows_30d"] >= 1
    # 责任方行要能直接下钻：带上该组名下全部仓库
    assert master_row["repo_keys"] == ["team/example-service"]
    comp = next(
        c for c in body["owners"]["components"] if c["component_id"] == "example-component"
    )
    assert comp["ai_master"] == "责任人甲"


def test_owner_rows_carry_repo_keys_for_drilldown(client):
    """SE 视角一行覆盖该 SE 名下所有组件的仓库并集，供「查工作流」预置筛选。"""
    payload = message(
        message_id=uuid.UUID("99999999-9999-4999-8999-999999999903"),
        workflow_id=uuid.UUID("99999999-9999-4999-8999-999999999904"),
        repository="team/example-service",
        ar="AR-OWNER-2",
    )
    assert sync(client, payload).status_code == 200

    body = client.get("/api/v1/admin/overview").json()
    se_row = next(o for o in body["owners"]["by_se"] if o["name"] == "张三")
    assert se_row["repo_keys"] == ["team/example-service"]

    # 未指定 SE 的兜底行同样带仓库（下钻不因缺归属而失效）
    default_row = next(o for o in body["owners"]["by_master"] if o["is_default"])
    assert default_row["repo_keys"] == ["team/example-service"]


def test_record_repository_filter_accepts_multiple_values(client):
    """归因记录按仓库筛选支持逗号分隔多值（责任方下钻一次传多个仓库）。"""
    _make_attribution(client)
    other = message(
        message_id=uuid.UUID("99999999-9999-4999-8999-999999999905"),
        workflow_id=uuid.UUID("99999999-9999-4999-8999-999999999906"),
        repository="team/other-service",
        sr="SR-3001",
        ar="AR-3001",
    )
    assert sync(client, other).status_code == 200

    single = client.get(
        "/api/v1/admin/attribution/records", params={"repository": "other-service"}
    ).json()
    assert single["total"] == 1

    both = client.get(
        "/api/v1/admin/attribution/records",
        params={"repository": "example-service, other-service"},
    ).json()
    assert both["total"] == 2

    blank = client.get(
        "/api/v1/admin/attribution/records", params={"repository": " , "}
    ).json()
    assert blank["total"] == 2  # 全空白视为未筛选，不会误筛成 0 条


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


def test_registry_rejects_junk_input(client):
    # canonical url 必须是 git 地址形态
    junk_url = client.post(
        "/api/v1/admin/registry/components/example-component/repos",
        json={"repo_key": "junk-repo", "canonical_url": "12"},
    )
    assert junk_url.status_code == 400
    assert junk_url.json()["code"] == "INVALID_FIELD"
    # repo key 仅允许字母数字开头，含 . / _ -（全局校验处理器统一返回 400）
    junk_key = client.post(
        "/api/v1/admin/registry/components/example-component/repos",
        json={
            "repo_key": "bad key!",
            "canonical_url": "git@git.company.com:team/x.git",
        },
    )
    assert junk_key.status_code == 400
    assert junk_key.json()["code"] == "INVALID_REQUEST"
    # component id 必须是 slug 形态
    junk_component = client.post(
        "/api/v1/admin/registry/components",
        json={"component_id": "bad id!", "name": "非法 ID"},
    )
    assert junk_component.status_code == 400
    # 合法的组路径 repo key 不受影响
    ok = client.post(
        "/api/v1/admin/registry/components/example-component/repos",
        json={
            "repo_key": "team/with_under.ts",
            "canonical_url": "https://git.company.com/team/with_under.ts.git",
        },
    )
    assert ok.status_code == 201


def test_logs_support_time_window_filter(client):
    # 先产生一条已知日志
    client.post("/api/v1/admin/attribution/scan")

    ok = client.get(
        "/api/v1/admin/logs",
        params={"file": "server.log", "lines": 500, "q": "service.started"},
    )
    assert ok.status_code == 200
    body = ok.json()
    assert body["lines"], "server.log 里应有启动日志"

    # 日期粒度的起点在启动日志之后 → 过滤为空
    future = client.get(
        "/api/v1/admin/logs",
        params={"file": "server.log", "lines": 500, "since": "2099-01-01"},
    )
    assert future.status_code == 200
    assert future.json()["lines"] == []

    # 分钟粒度：以启动日志当分钟为起点应能取到（边界含该分钟头）
    started_line = next(line for line in body["lines"] if "event=service.started" in line)
    minute_prefix = started_line[:16]  # "YYYY-MM-DD HH:MM"
    windowed = client.get(
        "/api/v1/admin/logs",
        params={"file": "server.log", "lines": 500, "since": minute_prefix},
    )
    assert windowed.status_code == 200
    assert any(
        "event=service.started" in line for line in windowed.json()["lines"]
    )

    # 非法时间窗 → 400 INVALID_FILTER
    bad = client.get(
        "/api/v1/admin/logs",
        params={"file": "server.log", "since": "昨天"},
    )
    assert bad.status_code == 400
    assert bad.json()["code"] == "INVALID_FILTER"


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
