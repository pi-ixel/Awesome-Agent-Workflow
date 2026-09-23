from __future__ import annotations

import time
import uuid
from datetime import UTC, datetime, timedelta

from conftest import WORKFLOW_ID, message, sync, upload_diff
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from aaw_telemetry.models import (
    AnomalyArchiveRequest,
    AnomalyEvent,
    AnomalyRule,
    CodeAttribution,
    DevRun,
    WorkflowRun,
)
from aaw_telemetry.services.anomalies import DETECTOR_SPECS, AnomalyService


def _admin(client) -> dict[str, str]:
    response = client.post("/api/v1/anomalies/admin/login", json={"password": "123456"})
    assert response.status_code == 200, response.text
    return {"X-CSRF-Token": response.json()["csrf_token"]}


def _owner(client) -> str:
    created = client.post("/api/v1/ai-masters", json={"name": "异常值守"})
    assert created.status_code == 201, created.text
    master_id = created.json()["id"]
    assigned = client.put(
        "/api/v1/ai-masters/repo-assignments/team/example-service",
        json={"ai_master_id": master_id},
    )
    assert assigned.status_code == 200, assigned.text
    return master_id


def _stalled_workflow(client) -> dict:
    stale = datetime.now(UTC) - timedelta(days=3)
    payload = message(
        workflow_completed=False,
        status="start",
        with_file=False,
        started_at=int(stale.timestamp() * 1000),
        step_started_at=int(stale.timestamp() * 1000),
        step_completed_at=None,
        updated_at=int((stale + timedelta(minutes=5)).timestamp() * 1000),
    )
    response = sync(client, payload)
    assert response.status_code == 200, response.text
    return payload


def _create_stalled_rule(client, headers) -> dict:
    # 启动时已为全部检测类型预置停用规则；测试复用预置规则并启用它。
    items = client.get("/api/v1/anomalies/rules", headers=headers).json()["items"]
    rule = next(item for item in items if item["detector_type"] == "workflow_stalled")
    updated = client.put(
        f"/api/v1/anomalies/rules/{rule['id']}",
        headers=headers,
        json={
            "name": "工作流超过一小时无活动",
            "category": "workflow",
            "detector_type": "workflow_stalled",
            "scope_type": "platform",
            "params": {"max_idle_hours": 1},
            "status": "enabled",
            "change_reason": "测试异常周期",
        },
    )
    assert updated.status_code == 200, updated.text
    return updated.json()


def _evaluate(client, headers):
    response = client.post("/api/v1/anomalies/rules/evaluate", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def _pin_zero_adoption(
    client, message_ids: list[str] | str, *, settle: float = 0.8, timeout: float = 10.0
) -> None:
    """把产出的采纳率置零，并等后台归因的写回沉寂后再返回。

    桩归因完成后偶发会再写一次结果（约 1 秒内落地），晚到的写回会把置零
    盖回去，检测就不命中。置零后静置观察一小段，发现被盖掉就重置，
    直到数值稳定为 0——之后立刻检测才是确定性的。
    """
    if isinstance(message_ids, str):
        message_ids = [message_ids]
    ids = [uuid.UUID(value) for value in message_ids]
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with Session(client.app.state.engine) as session:
            session.execute(
                update(CodeAttribution)
                .where(CodeAttribution.dev_run_id.in_(ids))
                .values(attributed_lines_90=0, attributed_lines_80=0, attributed_lines_60=0)
            )
            session.commit()
        time.sleep(settle)
        with Session(client.app.state.engine) as session:
            rows = session.scalars(
                select(CodeAttribution).where(CodeAttribution.dev_run_id.in_(ids))
            ).all()
            if len(rows) == len(ids) and all((row.attributed_lines_80 or 0) == 0 for row in rows):
                return
    raise AssertionError("采纳率置零被后台归因写回反复覆盖，无法稳定")


def test_anomaly_ui_is_part_of_existing_admin_console(client):
    response = client.get("/admin")
    assert response.status_code == 200
    assert 'data-tab="anomalies"' in response.text
    assert 'id="tab-anomalies"' in response.text
    assert client.get("/anomalies").status_code == 404


def test_detector_catalog_is_public_but_rules_stay_admin_only(client):
    """检测类型目录随按-master 的异常查看一起公开，规则管理仍需管理员。

    目录只是内置检测器的静态元数据（判定句、默认参数），非管理员使用者看自己
    异常时的"?"提示要用它；若它也要密码，非管理员一进页面就取不到目录、整页空白。
    """
    catalog = client.get("/api/v1/anomalies/detector-types")
    assert catalog.status_code == 200, catalog.text
    items = catalog.json()["items"]
    assert {item["code"] for item in items} == set(DETECTOR_SPECS)
    # 公开的是静态目录，不是带启停状态与审计的规则
    assert all("status" not in item for item in items)
    assert client.get("/api/v1/anomalies/rules").status_code == 401


def test_admin_session_requires_password_and_csrf(client):
    assert client.get("/api/v1/anomalies/rules").status_code == 401
    assert client.get("/api/v1/anomalies/events?admin_view=true").status_code == 401
    assert (
        client.post("/api/v1/anomalies/admin/login", json={"password": "wrong"}).status_code == 401
    )
    _admin(client)
    response = client.post(
        "/api/v1/anomalies/rules",
        json={
            "name": "缺少 CSRF",
            "category": "workflow",
            "detector_type": "workflow_stalled",
            "params": {},
        },
    )
    assert response.status_code == 403


def test_rule_edit_keeps_identity_and_new_occurrence_after_recovery(client):
    master_id = _owner(client)
    _stalled_workflow(client)
    headers = _admin(client)
    rule = _create_stalled_rule(client, headers)

    preview_payload = {
        "name": "试算工作流停滞",
        "category": "workflow",
        "detector_type": "workflow_stalled",
        "scope_type": "platform",
        "params": {"max_idle_hours": 1},
        "status": "draft",
        "change_reason": "只试算不保存",
    }
    rules_before = client.get("/api/v1/anomalies/rules", headers=headers).json()["items"]
    preview = client.post("/api/v1/anomalies/rules/preview", headers=headers, json=preview_payload)
    assert preview.status_code == 200, preview.text
    assert preview.json()["matches"] == 1
    assert len(preview.json()["samples"]) == 1
    saved_rules = client.get("/api/v1/anomalies/rules", headers=headers).json()["items"]
    assert len(saved_rules) == len(rules_before)
    assert next(item for item in saved_rules if item["id"] == rule["id"])["version"] == 2

    first_scan = _evaluate(client, headers)
    assert first_scan["matches"] == 1
    first = client.get(f"/api/v1/anomalies/events?ai_master_id={master_id}").json()["items"][0]
    assert first["occurrence"] == 1

    _evaluate(client, headers)
    repeated = client.get(f"/api/v1/anomalies/events?ai_master_id={master_id}").json()["items"][0]
    assert repeated["id"] == first["id"]
    assert repeated["hit_count"] == 2

    updated = {
        "name": rule["name"],
        "category": rule["category"],
        "detector_type": rule["detector_type"],
        "scope_type": rule["scope_type"],
        "scope_value": rule["scope_value"],
        "params": {"max_idle_hours": 1000},
        "status": "enabled",
        "change_reason": "提高阈值验证恢复",
    }
    response = client.put(f"/api/v1/anomalies/rules/{rule['id']}", headers=headers, json=updated)
    assert response.status_code == 200, response.text
    assert response.json()["id"] == rule["id"]
    assert response.json()["version"] == 3
    detail = client.get(f"/api/v1/anomalies/rules/{rule['id']}", headers=headers)
    assert detail.status_code == 200, detail.text
    assert [audit["action"] for audit in detail.json()["audits"]] == [
        "updated",
        "updated",
        "created",
    ]
    _evaluate(client, headers)
    assert client.get(f"/api/v1/anomalies/events?ai_master_id={master_id}").json()["total"] == 0

    updated["params"] = {"max_idle_hours": 1}
    updated["change_reason"] = "恢复阈值验证新周期"
    assert (
        client.put(
            f"/api/v1/anomalies/rules/{rule['id']}", headers=headers, json=updated
        ).status_code
        == 200
    )
    _evaluate(client, headers)
    second = client.get(f"/api/v1/anomalies/events?ai_master_id={master_id}").json()["items"][0]
    assert second["id"] != first["id"]
    assert second["occurrence"] == 2

    global_view = client.get("/api/v1/anomalies/events?admin_view=true", headers=headers)
    assert global_view.status_code == 200, global_view.text
    assert global_view.json()["total"] == 1


def test_archive_review_is_atomic_and_issue_creation_is_idempotent(client):
    master_id = _owner(client)
    _stalled_workflow(client)
    headers = _admin(client)
    _create_stalled_rule(client, headers)
    _evaluate(client, headers)
    event = client.get(f"/api/v1/anomalies/events?ai_master_id={master_id}").json()["items"][0]

    requested = client.post(
        f"/api/v1/anomalies/events/{event['id']}/archive-requests",
        json={"reason": "测试工作流不应进入统计", "requested_by": "异常值守"},
    )
    assert requested.status_code == 201, requested.text
    request_id = uuid.UUID(requested.json()["id"])

    with Session(client.app.state.engine) as session:
        row = session.get(AnomalyArchiveRequest, request_id)
        row.target_id = "00000000-0000-0000-0000-000000000099"
        session.commit()
    failed = client.post(
        f"/api/v1/anomalies/archive-requests/{request_id}/review",
        headers=headers,
        json={"approved": True, "note": "验证事务回滚"},
    )
    assert failed.status_code == 404
    with Session(client.app.state.engine) as session:
        request_row = session.get(AnomalyArchiveRequest, request_id)
        event_row = session.get(AnomalyEvent, uuid.UUID(event["id"]))
        workflow = session.scalar(select(WorkflowRun))
        assert request_row.status == "pending"
        assert event_row.disposition == "archive_pending"
        assert workflow.deleted is False

    rejected = client.post(
        f"/api/v1/anomalies/archive-requests/{request_id}/review",
        headers=headers,
        json={"approved": False, "note": "目标范围有误"},
    )
    assert rejected.status_code == 200, rejected.text

    issue = client.post(
        f"/api/v1/anomalies/events/{event['id']}/issues",
        json={"suggestion": "改进工作流停滞提示", "reporter": "异常值守", "assignee": "张轶勃"},
    )
    assert issue.status_code == 201, issue.text
    duplicate = client.post(
        f"/api/v1/anomalies/events/{event['id']}/issues",
        json={"suggestion": "重复创建", "reporter": "异常值守", "assignee": "张轶勃"},
    )
    assert duplicate.status_code == 409
    assert client.get(f"/api/v1/issues/{issue.json()['issue_id']}").status_code == 200


def test_disabling_rule_closes_open_event_with_explicit_reason(client):
    master_id = _owner(client)
    _stalled_workflow(client)
    headers = _admin(client)
    rule = _create_stalled_rule(client, headers)
    _evaluate(client, headers)

    response = client.post(
        f"/api/v1/anomalies/rules/{rule['id']}/status",
        headers=headers,
        json={"status": "disabled", "reason": "临时停用验证"},
    )
    assert response.status_code == 200, response.text
    assert client.get(f"/api/v1/anomalies/events?ai_master_id={master_id}").json()["total"] == 0
    history = client.get(
        f"/api/v1/anomalies/events?ai_master_id={master_id}&include_closed=true",
        headers=headers,
    ).json()["items"]
    assert history[0]["detection_status"] == "recovered"
    assert history[0]["closed_reason"] == "rule_disabled"


def test_archive_approval_updates_data_and_event_together(client):
    master_id = _owner(client)
    _stalled_workflow(client)
    headers = _admin(client)
    _create_stalled_rule(client, headers)
    _evaluate(client, headers)
    event = client.get(f"/api/v1/anomalies/events?ai_master_id={master_id}").json()["items"][0]
    requested = client.post(
        f"/api/v1/anomalies/events/{event['id']}/archive-requests",
        json={"reason": "确认是测试工作流", "requested_by": "异常值守"},
    ).json()
    approved = client.post(
        f"/api/v1/anomalies/archive-requests/{requested['id']}/review",
        headers=headers,
        json={"approved": True, "note": "同意归档"},
    )
    assert approved.status_code == 200, approved.text
    detail = client.get(f"/api/v1/anomalies/events/{event['id']}").json()
    assert detail["detection_status"] == "recovered"
    assert detail["disposition"] == "archived"
    assert detail["closed_reason"] == "data_archived"
    with Session(client.app.state.engine) as session:
        workflow = session.scalar(select(WorkflowRun))
        assert workflow.deleted is True
        assert workflow.deleted_reason_code == "anomaly_archive"


def test_every_detector_supports_default_dry_run(client):
    headers = _admin(client)
    # 启动时已经为全部内置检测类型预置规则，重复创建应被拒绝而不是产生第二条规则。
    first = client.post(
        "/api/v1/anomalies/rules",
        headers=headers,
        json={
            "name": "重复的工作流停滞",
            "category": "workflow",
            "detector_type": "workflow_stalled",
            "scope_type": "platform",
            "params": {},
            "status": "enabled",
            "change_reason": "验证检测类型唯一",
        },
    )
    assert first.status_code == 409, first.text
    assert first.json()["code"] == "RULE_DETECTOR_ALREADY_CONFIGURED"
    # 预置规则默认停用；启用全部后逐一试算，确保每个检测器都能跑默认参数。
    items = client.get("/api/v1/anomalies/rules", headers=headers).json()["items"]
    for item in items:
        toggled = client.post(
            f"/api/v1/anomalies/rules/{item['id']}/status",
            headers=headers,
            json={"status": "enabled", "reason": "试算默认参数"},
        )
        assert toggled.status_code == 200, toggled.text
    result = client.post("/api/v1/anomalies/rules/evaluate?dry_run=true", headers=headers)
    assert result.status_code == 200, result.text
    assert result.json()["rules"] == len(DETECTOR_SPECS)


def test_startup_seeds_every_builtin_rule_once(client):
    headers = _admin(client)
    items = client.get("/api/v1/anomalies/rules", headers=headers).json()["items"]
    assert {item["detector_type"] for item in items} == set(DETECTOR_SPECS)
    assert all(item["allow_archive"] is True for item in items)
    # 新补齐的规则保持停用，管理员确认后才启用。
    assert all(item["status"] == "disabled" for item in items)

    # 再次执行幂等补齐（等价于服务重启），既不重建也不改动已有配置。
    with Session(client.app.state.engine) as session:
        created = AnomalyService(session, client.app.state.projects).ensure_builtin_rules()
    assert created == 0
    again = client.get("/api/v1/anomalies/rules", headers=headers).json()["items"]
    assert {item["id"] for item in again} == {item["id"] for item in items}


def test_builtin_rule_names_follow_copy_upgrades(client):
    """内置文案改名后，仍停在旧文案上的已种规则自动换新名；自定义名不动。"""
    headers = _admin(client)
    items = client.get("/api/v1/anomalies/rules", headers=headers).json()["items"]
    target = next(item for item in items if item["detector_type"] == "unassigned_data")
    other = next(item for item in items if item["detector_type"] == "telemetry_gap")
    with Session(client.app.state.engine) as session:
        rule = session.get(AnomalyRule, uuid.UUID(target["id"]))
        rule.name = "数据无法归属"  # 历史内置文案
        session.get(AnomalyRule, uuid.UUID(other["id"])).name = "我的自定义规则"
        session.commit()

    with Session(client.app.state.engine) as session:
        AnomalyService(session, client.app.state.projects).ensure_builtin_rules()
    after = {
        item["detector_type"]: item["name"]
        for item in client.get("/api/v1/anomalies/rules", headers=headers).json()["items"]
    }
    assert after["unassigned_data"] == "上报了未登记的仓库"
    assert after["telemetry_gap"] == "我的自定义规则"


def test_archive_request_is_rejected_when_rule_disallows_it(client):
    master_id = _owner(client)
    _stalled_workflow(client)
    headers = _admin(client)
    rule = _create_stalled_rule(client, headers)
    _evaluate(client, headers)
    event = client.get(f"/api/v1/anomalies/events?ai_master_id={master_id}").json()["items"][0]
    assert event["archive_supported"] is True

    closed = client.put(
        f"/api/v1/anomalies/rules/{rule['id']}",
        headers=headers,
        json={
            "name": rule["name"],
            "category": rule["category"],
            "detector_type": rule["detector_type"],
            "scope_type": rule["scope_type"],
            "scope_value": rule["scope_value"],
            "params": rule["params"],
            "allow_archive": False,
            "status": "enabled",
            "change_reason": "关闭该类异常的屏蔽入口",
        },
    )
    assert closed.status_code == 200, closed.text
    assert closed.json()["allow_archive"] is False

    listing = client.get(f"/api/v1/anomalies/events?ai_master_id={master_id}").json()["items"]
    assert listing[0]["id"] == event["id"]
    assert listing[0]["archive_supported"] is False

    denied = client.post(
        f"/api/v1/anomalies/events/{event['id']}/archive-requests",
        json={"reason": "规则已关闭屏蔽", "requested_by": "异常值守"},
    )
    assert denied.status_code == 409, denied.text
    assert denied.json()["code"] == "ARCHIVE_NOT_ALLOWED"
    detail = client.get(f"/api/v1/anomalies/events/{event['id']}").json()
    assert detail["disposition"] == "open"


def test_admin_console_can_request_archive_without_event(client):
    """业务页（工作流/归因）对数据对象直接申请屏蔽：无事件、申请不需管理员密码
    （master 就该提得出），审核后出清；审核仍需管理员会话。"""
    _stalled_workflow(client)
    workflow = client.get("/api/v1/admin/workflows").json()["items"][0]
    workflow_id = workflow["workflow_run_id"]

    headers = _admin(client)
    created = client.post(
        f"/api/v1/anomalies/targets/workflow/{workflow_id}/archive-requests",
        json={"reason": "验证数据不应计入统计", "requested_by": "运营管理员"},
    )
    # 申请与事件页同权：不带管理员会话也能提交。
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["source"] == "admin_console"
    assert body["event_id"] is None
    assert body["target_type"] == "workflow"
    assert body["status"] == "pending"

    duplicate = client.post(
        f"/api/v1/anomalies/targets/workflow/{workflow_id}/archive-requests",
        headers=headers,
        json={"reason": "重复申请", "requested_by": "运营管理员"},
    )
    assert duplicate.status_code == 409, duplicate.text
    assert duplicate.json()["code"] == "ARCHIVE_REQUEST_EXISTS"

    invalid_type = client.post(
        f"/api/v1/anomalies/targets/component/{workflow_id}/archive-requests",
        json={"reason": "不支持的对象", "requested_by": "运营管理员"},
    )
    assert invalid_type.status_code == 400, invalid_type.text
    assert invalid_type.json()["code"] == "ARCHIVE_NOT_SUPPORTED"

    listing = client.get("/api/v1/anomalies/archive-requests", headers=headers).json()
    assert listing["items"][0]["id"] == body["id"]
    assert listing["items"][0]["source"] == "admin_console"

    # 审核是管理员动作：不带会话要被拦住。
    unauthenticated_review = client.post(
        f"/api/v1/anomalies/archive-requests/{body['id']}/review",
        json={"approved": True, "note": "未授权的审核"},
    )
    assert unauthenticated_review.status_code in (401, 403), unauthenticated_review.text

    approved = client.post(
        f"/api/v1/anomalies/archive-requests/{body['id']}/review",
        headers=headers,
        json={"approved": True, "note": "同意屏蔽"},
    )
    assert approved.status_code == 200, approved.text
    archived = client.get("/api/v1/admin/workflows?lifecycle=deleted").json()
    assert any(row["workflow_run_id"] == workflow_id for row in archived["items"])


def test_event_archive_review_still_marks_event_disposition(client):
    """事件发起的屏蔽申请走老路径：审核结果同时落到事件上，回归保护。"""
    master_id = _owner(client)
    _stalled_workflow(client)
    headers = _admin(client)
    _create_stalled_rule(client, headers)
    _evaluate(client, headers)
    event = client.get(f"/api/v1/anomalies/events?ai_master_id={master_id}").json()["items"][0]
    request = client.post(
        f"/api/v1/anomalies/events/{event['id']}/archive-requests",
        json={"reason": "事件屏蔽路径回归", "requested_by": "异常值守"},
    ).json()
    assert request["source"] == "event"

    rejected = client.post(
        f"/api/v1/anomalies/archive-requests/{request['id']}/review",
        headers=headers,
        json={"approved": False, "note": "先保留观察"},
    )
    assert rejected.status_code == 200, rejected.text
    detail = client.get(f"/api/v1/anomalies/events/{event['id']}").json()
    assert detail["disposition"] == "open"


def test_startup_retires_removed_builtin_rules_and_closes_events(client):
    """下架的内置检测类型：规则行标记删除、开放事件收尾、后续补齐幂等。"""
    headers = _admin(client)
    from aaw_telemetry.services.anomalies import _RETIRED_DETECTORS

    # 手工把一条下架检测的规则种回去（等价于旧库升级场景）。走 ORM：
    # 创建接口和检测器都不再接受下架的检测类型，直接让它产生一条历史事件。
    master_id = _owner(client)
    _stalled_workflow(client)
    legacy = AnomalyRule(
        id=uuid.uuid4(),
        name="旧库遗留的统计突变",
        category="component",
        detector_type="core_stats_shift",
        scope_type="platform",
        scope_value=None,
        params={"baseline_days": 28, "deviation_ratio": 0.5, "min_sample": 10},
        allow_archive=True,
        status="enabled",
        version=1,
        change_reason="模拟升级前已启用",
        created_by="系统初始化",
        updated_by="系统初始化",
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
    )
    stale_event = AnomalyEvent(
        id=uuid.uuid4(),
        rule_id=legacy.id,
        rule_version=1,
        rule_snapshot={},
        category="component",
        detector_type="core_stats_shift",
        object_type="repository",
        object_key="team/example-service",
        occurrence=1,
        active_key="legacy-active",
        detection_status="active",
        disposition="open",
        first_detected_at=datetime.now(UTC),
        last_detected_at=datetime.now(UTC),
        hit_count=1,
        updated_at=datetime.now(UTC),
        title="旧库遗留的上报量突变",
        summary="升级前命中，等待下架收尾",
        repository="team/example-service",
        evidence={},
        detail_target={},
    )
    with Session(client.app.state.engine) as session:
        session.add(legacy)
        session.flush()
        stale_event.rule_id = legacy.id
        session.add(stale_event)
        session.commit()
    listing = client.get(
        "/api/v1/anomalies/events?admin_view=true&include_closed=true",
        headers=headers,
    )
    assert any(row["detector_type"] == "core_stats_shift" for row in listing.json()["items"])

    with Session(client.app.state.engine) as session:
        AnomalyService(session, client.app.state.projects).ensure_builtin_rules()

    items = client.get("/api/v1/anomalies/rules", headers=headers).json()["items"]
    assert {item["detector_type"] for item in items} == set(DETECTOR_SPECS)
    assert not ({item["detector_type"] for item in items} & set(_RETIRED_DETECTORS))
    # 事件随规则下架收尾，不再出现在开放列表里。
    assert client.get(f"/api/v1/anomalies/events?ai_master_id={master_id}").json()["total"] == 0
    history = client.get(
        f"/api/v1/anomalies/events?ai_master_id={master_id}&include_closed=true",
        headers=headers,
    ).json()["items"]
    assert all(row["closed_reason"] == "rule_deleted" for row in history if row["detector_type"] == "core_stats_shift")
    # 幂等：再跑一次不会报错或复活规则。
    with Session(client.app.state.engine) as session:
        AnomalyService(session, client.app.state.projects).ensure_builtin_rules()
    again = client.get("/api/v1/anomalies/rules", headers=headers).json()["items"]
    assert {item["detector_type"] for item in again} == set(DETECTOR_SPECS)


def test_anomaly_datetimes_carry_timezone_offset(client):
    """异常模块的时间字段必须带时区：裸 UTC 会被浏览器当本地时间，整整差一个时区。"""
    _stalled_workflow(client)
    headers = _admin(client)
    _create_stalled_rule(client, headers)
    _evaluate(client, headers)

    event = client.get("/api/v1/anomalies/events?admin_view=true").json()["items"][0]

    def aware(value: str) -> bool:
        return value.endswith("+00:00") or value.endswith("Z")

    assert aware(event["first_detected_at"]), event["first_detected_at"]
    assert aware(event["last_detected_at"])
    rule = client.get("/api/v1/anomalies/rules", headers=headers).json()["items"][0]
    assert aware(rule["created_at"])
    assert aware(rule["updated_at"])
    detail = client.get(f"/api/v1/anomalies/rules/{rule['id']}", headers=headers).json()
    audits = detail["audits"]
    assert audits and aware(audits[0]["created_at"])
    request = client.post(
        f"/api/v1/anomalies/events/{event['id']}/archive-requests",
        json={"reason": "测试", "requested_by": "测试"},
    )
    assert request.status_code == 201, request.text
    pending = client.get("/api/v1/anomalies/archive-requests", headers=headers).json()["items"]
    assert pending and aware(pending[0]["created_at"])


def test_event_payload_carries_display_name_and_archive_target_context(client):
    """异常列表按"姓名 + 邮箱"显示；审核列表的屏蔽对象要带仓库/SR，不能只有裸 UUID。"""
    _stalled_workflow(client)
    headers = _admin(client)
    _create_stalled_rule(client, headers)
    _evaluate(client, headers)

    event = client.get("/api/v1/anomalies/events?admin_view=true").json()["items"][0]
    assert event["user_email"] == "developer@example.com"
    assert event["user_name"] == "Z30049429"

    created = client.post(
        f"/api/v1/anomalies/events/{event['id']}/archive-requests",
        json={"reason": "演示屏蔽", "requested_by": "测试"},
    )
    assert created.status_code == 201, created.text
    request = client.get("/api/v1/anomalies/archive-requests", headers=headers).json()["items"][0]
    assert request["target_context"] == {"repository": "team/example-service", "sr": "SR-1001"}


def test_target_archive_request_is_visible_to_its_anomaly_events(client):
    """业务页对有异常事件的数据发起屏蔽：总览要感知得到（屏蔽待审），
    通过后事件关闭、拒绝后事件回到 open 继续等 master 处理。"""
    headers = _admin(client)
    _stalled_workflow(client)
    _create_stalled_rule(client, headers)
    _evaluate(client, headers)
    event = client.get("/api/v1/anomalies/events?admin_view=true").json()["items"][0]
    workflow_id = event["object_key"]
    assert event["disposition"] == "open"
    assert event["archive_request"] is None

    created = client.post(
        f"/api/v1/anomalies/targets/workflow/{workflow_id}/archive-requests",
        headers=headers,
        json={"reason": "测试数据不入统计", "requested_by": "周宁"},
    )
    assert created.status_code == 201, created.text

    # 同一事件的列表与详情都能看到待审申请：不再显示「申请屏蔽」按钮的条件。
    pending = client.get("/api/v1/anomalies/events?admin_view=true").json()["items"][0]
    assert pending["disposition"] == "archive_pending"
    assert pending["archive_request"]["status"] == "pending"
    assert pending["archive_request"]["requested_by"] == "周宁"
    detail = client.get(f"/api/v1/anomalies/events/{event['id']}").json()
    assert detail["archive_request"]["status"] == "pending"
    # 事件时间线留痕，master 能查到申请是谁在业务页提的
    actions = [row["action"] for row in detail["actions"]]
    assert "archive_requested" in actions

    # 拒绝 → 事件回到 open（按钮恢复），master 知道还得处理
    rejected = client.post(
        f"/api/v1/anomalies/archive-requests/{created.json()['id']}/review",
        headers=headers,
        json={"approved": False, "note": "数据仍需保留"},
    )
    assert rejected.status_code == 200, rejected.text
    reopened = client.get("/api/v1/anomalies/events?admin_view=true").json()["items"][0]
    assert reopened["disposition"] == "open"
    assert reopened["archive_request"] is None

    # 再申请并通过 → 事件随数据出清关闭
    again = client.post(
        f"/api/v1/anomalies/targets/workflow/{workflow_id}/archive-requests",
        headers=headers,
        json={"reason": "再次申请", "requested_by": "周宁"},
    )
    assert again.status_code == 201, again.text
    approved = client.post(
        f"/api/v1/anomalies/archive-requests/{again.json()['id']}/review",
        headers=headers,
        json={"approved": True, "note": "同意"},
    )
    assert approved.status_code == 200, approved.text
    closed = client.get(
        "/api/v1/anomalies/events?admin_view=true&include_closed=true"
    ).json()["items"]
    row = next(item for item in closed if item["id"] == event["id"])
    assert row["disposition"] == "archived"
    assert row["detection_status"] == "recovered"
    assert row["closed_reason"] == "data_archived"


def test_workflow_level_request_covers_its_dev_run_events(client):
    """业务页屏蔽整条工作流：名下产出的归因事件一并转「屏蔽待审」，
    徽标查询要按工作流覆盖，不能只认同类型同 id。"""
    headers = _admin(client)
    now = datetime.now(UTC)
    completed = int((now - timedelta(days=2)).timestamp() * 1000)
    payload = message(
        message_id=uuid.uuid4(),
        workflow_id=uuid.uuid4(),
        sr="SR-9600",
        ar="AR-8600",
        status="done",
        with_file=True,
        workflow_completed=True,
        started_at=completed - 3_600_000,
        step_started_at=completed - 3_600_000,
        step_completed_at=completed - 1_000,
        updated_at=completed,
    )
    assert sync(client, payload).status_code == 200, payload
    upload_diff(client, payload)
    _pin_zero_adoption(client, payload["message_id"])

    items = client.get("/api/v1/anomalies/rules", headers=headers).json()["items"]
    rule = next(item for item in items if item["detector_type"] == "low_adoption")
    updated = client.put(
        f"/api/v1/anomalies/rules/{rule['id']}",
        headers=headers,
        json={
            "name": rule["name"], "category": rule["category"],
            "detector_type": "low_adoption", "scope_type": "platform",
            "params": {"threshold_percent": 50, "window_days": 30},
            "status": "enabled", "change_reason": "验证工作流级屏蔽覆盖",
        },
    )
    assert updated.status_code == 200, updated.text
    _evaluate(client, headers)
    event = client.get("/api/v1/anomalies/events?admin_view=true").json()["items"][0]
    assert event["object_type"] == "attribution"

    # 在工作流页对整条工作流申请屏蔽（与事件对象不同类型、不同 id）
    workflow_id = payload["workflow_id"]
    created = client.post(
        f"/api/v1/anomalies/targets/workflow/{workflow_id}/archive-requests",
        headers=headers,
        json={"reason": "整条工作流为演示数据", "requested_by": "李航"},
    )
    assert created.status_code == 201, created.text

    pending = client.get("/api/v1/anomalies/events?admin_view=true").json()["items"][0]
    assert pending["disposition"] == "archive_pending"
    assert pending["archive_request"]["target_type"] == "workflow"
    assert pending["archive_request"]["requested_by"] == "李航"


def test_stalled_workflow_waiting_on_human_gate_is_called_out(client):
    """人工门禁超时并入工作流停滞：等确认的停滞直接说明在等谁，不再单开一条事件。"""
    master_id = _owner(client)
    stale = datetime.now(UTC) - timedelta(days=3)
    payload = message(
        workflow_completed=False,
        step_type="user-confirm",
        status="start",
        with_file=False,
        started_at=int(stale.timestamp() * 1000),
        step_started_at=int(stale.timestamp() * 1000),
        step_completed_at=None,
        updated_at=int((stale + timedelta(minutes=5)).timestamp() * 1000),
    )
    assert sync(client, payload).status_code == 200
    headers = _admin(client)
    _create_stalled_rule(client, headers)
    _evaluate(client, headers)
    events = client.get(f"/api/v1/anomalies/events?ai_master_id={master_id}").json()["items"]
    assert len(events) == 1
    assert events[0]["detector_type"] == "workflow_stalled"
    assert "人工确认" in events[0]["summary"]


def test_adoption_drop_detects_rate_decline_not_noise(client):
    """采纳率大幅下降：百分点差 + 双侧样本下限；样本不足时不触发。"""
    headers = _admin(client)
    now = datetime.now(UTC)
    # 8 条独立产出（SR/AR 不同才会各自建工作流），每条 2 行有效代码。
    # 基线 4 条采纳 100%，近期 4 条压到 0%：下降 100 个百分点。
    synced_ids = []
    for index, days_ago in enumerate([20, 19, 18, 17, 3, 2, 1, 1]):
        completed = int((now - timedelta(days=days_ago)).timestamp() * 1000)
        started = completed - 3_600_000
        payload = message(
            message_id=uuid.uuid4(),
            workflow_id=uuid.uuid4(),
            sr=f"SR-{9000 + index}",
            ar=f"AR-{8000 + index}",
            status="done",
            with_file=True,
            workflow_completed=True,
            started_at=started,
            step_started_at=started,
            step_completed_at=completed - 1_000,
            updated_at=completed,
        )
        assert sync(client, payload).status_code == 200, payload
        upload_diff(client, payload)
        synced_ids.append(payload["message_id"])
    # 归因引擎的桩实现总是 100% 采纳；直接把近期产出压到 0（阈值有序：90 ≤ 80 ≤ 60）
    _pin_zero_adoption(client, synced_ids[4:])

    items = client.get("/api/v1/anomalies/rules", headers=headers).json()["items"]
    rule = next(item for item in items if item["detector_type"] == "adoption_drop")
    from aaw_telemetry.services.anomalies import AnomalyService as Service

    relaxed = {
        "name": rule["name"],
        "category": rule["category"],
        "detector_type": "adoption_drop",
        "scope_type": "platform",
        "params": {"recent_days": 7, "baseline_days": 28, "drop_pp": 25, "min_runs": 3, "min_lines": 5},
        "status": "enabled",
        "change_reason": "验证采纳率下降检测",
    }
    updated = client.put(
        f"/api/v1/anomalies/rules/{rule['id']}", headers=headers, json=relaxed
    )
    assert updated.status_code == 200, updated.text
    with Session(client.app.state.engine) as session:
        result = Service(session, client.app.state.projects).evaluate(dry_run=True)
        by_rule = {row["rule_id"]: row for row in result["items"]}
        adoption = by_rule[rule["id"]]
    assert adoption["matches"] == 1, adoption
    assert "采纳率" in adoption["samples"][0]

    # 样本下限：两侧各 8 行 < 60，默认下限下不判定——小基数不产生异常。
    strict = {**relaxed, "params": {**relaxed["params"], "min_lines": 60},
              "change_reason": "提高样本下限验证不误报"}
    assert (
        client.put(
            f"/api/v1/anomalies/rules/{rule['id']}", headers=headers, json=strict
        ).status_code
        == 200
    )
    with Session(client.app.state.engine) as session:
        result = Service(session, client.app.state.projects).evaluate(dry_run=True)
        by_rule = {row["rule_id"]: row for row in result["items"]}
        assert by_rule[rule["id"]]["matches"] == 0


def test_seed_survives_concurrent_insert_without_rolling_back_batch(tmp_path):
    """多 worker 并发补齐：撞唯一约束只作废冲突那一条，本轮其他规则必须留下。

    复现路径：A 读到空表 → B 抢先插入同一检测类型并提交 → A flush 撞约束。
    用 before_flush 钩子在 A 第一次写库前插入竞争行，把竞态变成确定的时序。
    """
    from sqlalchemy import create_engine, event

    from aaw_telemetry.database import Base

    engine = create_engine(f"sqlite+pysqlite:///{(tmp_path / 'race.db').as_posix()}")
    Base.metadata.create_all(engine)
    competitor = sorted(DETECTOR_SPECS)[-1]

    with Session(engine) as session:
        service = AnomalyService(session, _race_registry())
        fired = {"done": False}

        def insert_competitor(_session, _ctx, _instances):
            if fired["done"]:
                return
            fired["done"] = True
            with Session(engine) as rival:
                rival.add(_rule_row(competitor))
                rival.commit()

        event.listen(session, "before_flush", insert_competitor)
        created = service.ensure_builtin_rules()

    with Session(engine) as session:
        rows = session.scalars(select(AnomalyRule).where(AnomalyRule.status != "deleted")).all()
    codes = [row.detector_type for row in rows]
    assert sorted(codes) == sorted(DETECTOR_SPECS)
    assert len(codes) == len(set(codes))
    # 10 条里有一条是竞争者插的，A 只认领它自己成功的部分。
    assert created == len(DETECTOR_SPECS) - 1


def _race_registry():
    from aaw_telemetry.config import ComponentsDocument, ProjectRegistry

    return ProjectRegistry(ComponentsDocument.model_validate({"components": {}}))


def _rule_row(detector_type: str) -> AnomalyRule:
    spec = DETECTOR_SPECS[detector_type]
    now = datetime.now(UTC)
    return AnomalyRule(
        id=uuid.uuid4(),
        name=spec.name,
        category=spec.category,
        detector_type=spec.code,
        scope_type="platform",
        scope_value=None,
        params=dict(spec.defaults),
        allow_archive=True,
        status="disabled",
        version=1,
        change_reason="并发竞争者写入",
        created_by="rival",
        updated_by="rival",
        created_at=now,
        updated_at=now,
    )


class _RecordingConnection:
    """记录执行过的语句，并在执行时做一次 commit 模拟 session 归还连接。"""

    def __init__(self, *, acquired: int = 1) -> None:
        self.statements: list[str] = []
        self.acquired = acquired

    def execute(self, statement, parameters=None):
        self.statements.append(str(statement))
        return _ScalarResult(self.acquired)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class _ScalarResult:
    def __init__(self, value):
        self._value = value

    def scalar(self):
        return self._value


class _FakeMySQL:
    name = "mysql"


class _FakeEngine:
    """最小替身：只暴露 startup_lock 用到的 dialect 与 connect。"""

    def __init__(self, *, acquired: int = 1) -> None:
        self.dialect = _FakeMySQL()
        self.connection = _RecordingConnection(acquired=acquired)
        self.connect_calls = 0

    def connect(self):
        self.connect_calls += 1
        return self.connection


def test_startup_lock_releases_on_the_same_connection_it_acquired(client):
    """GET_LOCK / RELEASE_LOCK 必须落在同一条连接上，否则锁根本放不掉。"""
    from aaw_telemetry.services.anomalies import startup_lock

    engine = _FakeEngine()
    with startup_lock(engine, "aaw_ensure_builtin_rules") as acquired:
        assert acquired is True
        # 被包住的补种子会自己 commit，模拟此后连接被归还连接池。
        engine.connection.statements.append("-- commit")

    assert engine.connect_calls == 1
    joined = " | ".join(engine.connection.statements)
    assert "GET_LOCK" in joined
    assert "RELEASE_LOCK" in joined
    # 取锁与放锁之间没有换过连接（只 connect 一次即证明）。


def test_startup_lock_skips_work_when_lock_is_taken(client):
    from aaw_telemetry.services.anomalies import startup_lock

    engine = _FakeEngine(acquired=0)
    with startup_lock(engine, "aaw_ensure_builtin_rules") as acquired:
        assert acquired is False
    joined = " | ".join(engine.connection.statements)
    assert "GET_LOCK" in joined
    # 没拿到锁就不该去放锁。
    assert "RELEASE_LOCK" not in joined


def test_startup_lock_is_a_noop_on_sqlite(client):
    from aaw_telemetry.services.anomalies import startup_lock

    with startup_lock(client.app.state.engine, "aaw_ensure_builtin_rules") as acquired:
        assert acquired is True


def test_low_adoption_flags_single_dev_run_without_minimum_lines(client):
    """单条产出采纳率偏低：按任务定位到具体产出，不设最小行数。

    任务粒度下改动可能很少，哪怕只有一行也要能被看到，所以没有样本下限；
    只有分母为 0（没有可统计的有效行）才跳过。
    """
    headers = _admin(client)
    now = datetime.now(UTC)
    # 两条产出：一条采纳率 0%（会被报），一条 100%（不报）
    ids = {}
    for index, days_ago in enumerate([2, 1]):
        completed = int((now - timedelta(days=days_ago)).timestamp() * 1000)
        started = completed - 3_600_000
        payload = message(
            message_id=uuid.uuid4(),
            workflow_id=uuid.uuid4(),
            sr=f"SR-{9500 + index}",
            ar=f"AR-{8500 + index}",
            status="done",
            with_file=True,
            workflow_completed=True,
            started_at=started,
            step_started_at=started,
            step_completed_at=completed - 1_000,
            updated_at=completed,
        )
        assert sync(client, payload).status_code == 200, payload
        upload_diff(client, payload)
        ids[payload["message_id"]] = index

    # 桩归因总是 100% 采纳；把第一条压到 0（阈值有序：90 ≤ 80 ≤ 60）
    from aaw_telemetry.services.anomalies import AnomalyService as Service

    victim = [k for k, v in ids.items() if v == 0][0]
    _pin_zero_adoption(client, victim)

    items = client.get("/api/v1/anomalies/rules", headers=headers).json()["items"]
    rule = next(item for item in items if item["detector_type"] == "low_adoption")
    updated = client.put(
        f"/api/v1/anomalies/rules/{rule['id']}",
        headers=headers,
        json={
            "name": rule["name"], "category": rule["category"],
            "detector_type": "low_adoption", "scope_type": "platform",
            "params": {"threshold_percent": 50, "window_days": 30},
            "status": "enabled", "change_reason": "验证低采纳检测",
        },
    )
    assert updated.status_code == 200, updated.text

    with Session(client.app.state.engine) as session:
        service = Service(session, client.app.state.projects)
        result = service.evaluate(dry_run=True)
        by_rule = {row["rule_id"]: row for row in result["items"]}
        hit = by_rule[rule["id"]]
    assert hit["matches"] == 1, hit
    assert "采纳" in hit["samples"][0]

    # 真实执行一次，确认事件落在被压到 0 的那条产出上
    with Session(client.app.state.engine) as session:
        Service(session, client.app.state.projects).evaluate()
    events = client.get(
        "/api/v1/anomalies/events?admin_view=true", headers=headers
    ).json()["items"]
    low = [e for e in events if e["detector_type"] == "low_adoption"]
    assert len(low) == 1, low
    assert low[0]["object_key"] == victim
    assert low[0]["category"] == "attribution"
    assert low[0]["evidence"]["adoption_rate"] == 0.0
    assert low[0]["actual_value"] == "0%"

    # 采纳率回到 100% 后不再命中：阈值以上不判定
    with Session(client.app.state.engine) as session:
        session.execute(
            update(CodeAttribution)
            .where(CodeAttribution.dev_run_id == uuid.UUID(victim))
            .values(attributed_lines_90=2, attributed_lines_80=2, attributed_lines_60=2)
        )
        session.commit()
    with Session(client.app.state.engine) as session:
        result = Service(session, client.app.state.projects).evaluate(dry_run=True)
        by_rule = {row["rule_id"]: row for row in result["items"]}
        assert by_rule[rule["id"]]["matches"] == 0


def _hit_event(client) -> tuple[str, dict, dict]:
    """工作流 + 启用停滞规则 + 检测命中。

    返回 (master_id, 事件 payload, 停滞上报 payload)；未申请屏蔽。
    同一条 message_id 的内容含时间戳，重复上报会判定为冲突，
    所以停滞上报的原始 payload 要一并带出去复用。
    """
    master_id = _owner(client)
    stale_payload = _stalled_workflow(client)
    headers = _admin(client)
    _create_stalled_rule(client, headers)
    _evaluate(client, headers)
    event = client.get(f"/api/v1/anomalies/events?ai_master_id={master_id}").json()["items"][0]
    return master_id, event, stale_payload


def _approve_archive(client, headers: dict, event: dict) -> str:
    requested = client.post(
        f"/api/v1/anomalies/events/{event['id']}/archive-requests",
        json={"reason": "确认是测试工作流", "requested_by": "异常值守"},
    )
    assert requested.status_code == 201, requested.text
    approved = client.post(
        f"/api/v1/anomalies/archive-requests/{requested.json()['id']}/review",
        headers=headers,
        json={"approved": True, "note": "同意屏蔽"},
    )
    assert approved.status_code == 200, approved.text
    return requested.json()["id"]


def test_duplicate_target_requests_are_refused_at_the_door(client):
    """同一条数据只留一张待审申请：重复申请在入口被拒，而不是通过时撞 409 卡死。"""
    _, event, _ = _hit_event(client)
    headers = _admin(client)
    first = client.post(
        f"/api/v1/anomalies/events/{event['id']}/archive-requests",
        json={"reason": "事件页发起", "requested_by": "异常值守"},
    )
    assert first.status_code == 201, first.text
    # 业务页对同一数据再发起：入口直接拒绝，而不是留下第二张待审
    duplicate = client.post(
        f"/api/v1/anomalies/targets/workflow/{WORKFLOW_ID}/archive-requests",
        json={"reason": "业务页重复发起", "requested_by": "运营管理员"},
    )
    assert duplicate.status_code == 409, duplicate.text
    assert duplicate.json()["code"] == "ARCHIVE_REQUEST_EXISTS"

    # 通过之后数据已屏蔽：再申请明确告知"已经屏蔽"，而不是造出一张过不去的申请
    approved = client.post(
        f"/api/v1/anomalies/archive-requests/{first.json()['id']}/review",
        headers=headers,
        json={"approved": True, "note": "同意屏蔽"},
    )
    assert approved.status_code == 200, approved.text
    again = client.post(
        f"/api/v1/anomalies/targets/workflow/{WORKFLOW_ID}/archive-requests",
        json={"reason": "屏蔽后再申请", "requested_by": "运营管理员"},
    )
    assert again.status_code == 409, again.text
    assert again.json()["code"] == "DATA_ALREADY_ARCHIVED"


def test_approving_one_request_settles_sibling_requests_and_events(client):
    """历史遗留/并发产生的同对象双待审：通过一张，另一张自动关闭而不是卡死。"""
    _, event, _ = _hit_event(client)
    headers = _admin(client)
    first = client.post(
        f"/api/v1/anomalies/events/{event['id']}/archive-requests",
        json={"reason": "事件页发起", "requested_by": "异常值守"},
    )
    assert first.status_code == 201, first.text
    # 直接插入一张同对象待审申请，模拟历史遗留/并发产生的双待审
    with Session(client.app.state.engine) as session:
        session.add(
            AnomalyArchiveRequest(
                id=uuid.uuid4(),
                event_id=None,
                source="admin_console",
                target_type="workflow",
                target_id=str(WORKFLOW_ID),
                reason="另一入口的重复申请",
                impact_preview={},
                status="pending",
                requested_by="运营管理员",
                created_at=datetime.now(UTC),
            )
        )
        session.commit()
    approved = client.post(
        f"/api/v1/anomalies/archive-requests/{first.json()['id']}/review",
        headers=headers,
        json={"approved": True, "note": "通过"},
    )
    assert approved.status_code == 200, approved.text
    with Session(client.app.state.engine) as session:
        rows = session.scalars(select(AnomalyArchiveRequest)).all()
        assert {row.status for row in rows} == {"approved", "cancelled"}
        cancelled = next(row for row in rows if row.status == "cancelled")
        assert "已通过" in cancelled.review_note
        assert cancelled.reviewed_at is not None
        event_row = session.get(AnomalyEvent, uuid.UUID(event["id"]))
        assert event_row.disposition == "archived"
        assert session.scalar(select(WorkflowRun)).deleted is True
    pending = client.get("/api/v1/anomalies/archive-requests?status=pending", headers=headers)
    assert pending.json()["items"] == []


def test_reject_does_not_reopen_archived_event(client):
    """已被其他申请屏蔽掉的事件，不能被一张迟到的重复拒绝翻回 open。"""
    _, event, _ = _hit_event(client)
    headers = _admin(client)
    _approve_archive(client, headers, event)
    # 直接插一张挂在已归档事件上的历史遗留待审申请
    with Session(client.app.state.engine) as session:
        legacy = AnomalyArchiveRequest(
            id=uuid.uuid4(),
            event_id=uuid.UUID(event["id"]),
            source="event",
            target_type="workflow",
            target_id=str(WORKFLOW_ID),
            reason="迟到的重复申请",
            impact_preview={},
            status="pending",
            requested_by="异常值守",
            created_at=datetime.now(UTC),
        )
        session.add(legacy)
        session.commit()
        legacy_id = legacy.id
    rejected = client.post(
        f"/api/v1/anomalies/archive-requests/{legacy_id}/review",
        headers=headers,
        json={"approved": False, "note": "重复申请，拒绝"},
    )
    assert rejected.status_code == 200, rejected.text
    with Session(client.app.state.engine) as session:
        event_row = session.get(AnomalyEvent, uuid.UUID(event["id"]))
        assert event_row.disposition == "archived"
        assert session.scalar(select(WorkflowRun)).deleted is True


def test_new_report_reactivates_archived_workflow(client):
    """屏蔽过的工作流又收到新上报：自动解除屏蔽回到统计，再检测能重新命中。"""
    master_id, event, stale_payload = _hit_event(client)
    headers = _admin(client)
    _approve_archive(client, headers, event)
    with Session(client.app.state.engine) as session:
        assert session.scalar(select(WorkflowRun)).deleted is True

    # 同一条工作流的新步骤上报（新 message_id，时间晚于屏蔽决定）
    resumed = message(
        message_id=uuid.uuid4(),
        workflow_completed=False,
        status="start",
        with_file=False,
        started_at=stale_payload["started_at"],
        step_started_at=stale_payload["data"]["started_at"],
        step_completed_at=None,
        updated_at=int(datetime.now(UTC).timestamp() * 1000),
    )
    response = sync(client, resumed)
    assert response.status_code == 200, response.text
    with Session(client.app.state.engine) as session:
        workflow = session.scalar(select(WorkflowRun))
        assert workflow.deleted is False
        assert workflow.deleted_reason_code is None
        assert workflow.deleted_reason is None
        assert workflow.deleted_by is None
        assert workflow.deleted_at is None

    # 数据回到统计后，停滞条件不再成立（用户回来了）——下一次检测不再报这条工作流
    _evaluate(client, headers)
    items = client.get(f"/api/v1/anomalies/events?ai_master_id={master_id}").json()["items"]
    assert not any(
        item["object_type"] == "workflow" and item["object_key"] == str(WORKFLOW_ID)
        for item in items
    )


def test_backfilled_report_older_than_archive_keeps_workflow_hidden(client):
    """迟到的旧步骤补报不算「还在活动」：不解除屏蔽。"""
    _owner(client)
    stale_payload = _stalled_workflow(client)
    headers = _admin(client)
    _create_stalled_rule(client, headers)
    _evaluate(client, headers)
    event = client.get(
        "/api/v1/anomalies/events?admin_view=true", headers=headers
    ).json()["items"][0]
    _approve_archive(client, headers, event)
    with Session(client.app.state.engine) as session:
        archived_at = session.scalar(select(WorkflowRun)).deleted_at
        assert archived_at is not None

    backfill = message(
        message_id=uuid.uuid4(),
        workflow_completed=False,
        status="start",
        with_file=False,
        started_at=stale_payload["started_at"],
        step_started_at=stale_payload["data"]["started_at"],
        step_completed_at=None,
        updated_at=int((archived_at.replace(tzinfo=UTC) - timedelta(hours=1)).timestamp() * 1000),
    )
    response = sync(client, backfill)
    assert response.status_code == 200, response.text
    with Session(client.app.state.engine) as session:
        assert session.scalar(select(WorkflowRun)).deleted is True


def test_admin_manual_deletion_is_not_auto_reactivated(client):
    """管理员手工删除（非异常屏蔽）不因新上报自动恢复。"""
    _owner(client)
    stale_payload = _stalled_workflow(client)
    with Session(client.app.state.engine) as session:
        workflow = session.scalar(select(WorkflowRun))
        workflow.deleted = True
        workflow.deleted_reason_code = "manual"
        workflow.deleted_reason = "管理员手工删除"
        workflow.deleted_at = datetime.now(UTC).replace(tzinfo=None)
        session.commit()
    resumed = message(
        message_id=uuid.uuid4(),
        workflow_completed=False,
        status="start",
        with_file=False,
        started_at=stale_payload["started_at"],
        step_started_at=stale_payload["data"]["started_at"],
        step_completed_at=None,
        updated_at=int(datetime.now(UTC).timestamp() * 1000),
    )
    response = sync(client, resumed)
    assert response.status_code == 200, response.text
    with Session(client.app.state.engine) as session:
        workflow = session.scalar(select(WorkflowRun))
        assert workflow.deleted is True
        assert workflow.deleted_reason_code == "manual"
