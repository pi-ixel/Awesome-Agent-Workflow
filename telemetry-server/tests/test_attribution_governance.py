from __future__ import annotations

import time
import uuid
from datetime import UTC, datetime, timedelta

from aaw_telemetry.models import CodeAttribution, DevRun
from tests.conftest import message, sync, upload_diff


def _db_session(client):
    from sqlalchemy.orm import sessionmaker

    return sessionmaker(bind=client.app.state.engine)()


def _wait_for_status(client, message_id: str, status: str, timeout: float = 5.0):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        items = client.get(
            "/api/v1/admin/attribution/records", params={"page_size": 100}
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
    client.post("/api/v1/admin/attribution/scan")
    _wait_for_status(client, payload["message_id"], "finalized_match")
    return payload["message_id"]


def _sync_dev_without_upload(client, *, suffix: str) -> str:
    payload = message(
        message_id=uuid.UUID(f"44444444-4444-4444-8444-44444444444{suffix}"),
        workflow_id=uuid.UUID(f"55555555-5555-4555-8555-55555555555{suffix}"),
        ar=f"AR-300{suffix}",
    )
    assert sync(client, payload).status_code == 200
    return payload["message_id"]


# ----------------------------------------------------------------------
# C2.1 / C2.3 combined search and not-queued presentation


def test_records_surface_not_queued_and_support_filters(client):
    matched_id = _make_attribution(client)
    not_queued_id = _sync_dev_without_upload(client, suffix="1")

    body = client.get("/api/v1/admin/attribution/records").json()
    statuses = {item["dev_run_id"]: item["record_status"] for item in body["items"]}
    assert statuses[matched_id] == "finalized_match"
    assert statuses[not_queued_id] == "not_queued"

    only_queued = client.get(
        "/api/v1/admin/attribution/records", params={"record_kind": "queued"}
    ).json()
    assert only_queued["total"] == 1
    only_not_queued = client.get(
        "/api/v1/admin/attribution/records", params={"attribution_status": "not_queued"}
    ).json()
    assert only_not_queued["total"] == 1
    assert only_not_queued["items"][0]["dev_run_id"] == not_queued_id

    by_user = client.get(
        "/api/v1/admin/attribution/records", params={"user": "nobody@x"}
    ).json()
    assert by_user["total"] == 0
    invalid = client.get(
        "/api/v1/admin/attribution/records",
        params={"attribution_status": "bogus"},
    )
    assert invalid.status_code == 400


def test_record_detail_exposes_evidence_and_governance(client):
    message_id = _make_attribution(client)
    body = client.get(
        f"/api/v1/admin/attribution/records/{message_id}/detail"
    ).json()
    assert body["record_status"] == "finalized_match"
    assert body["attribution_detail"]["attributed_lines_80"] > 0
    assert body["attribution_detail"]["algorithm_version"]
    assert body["attribution_detail"]["diff_rule_version"]
    assert body["matched_mr_iid"]
    assert body["upload"]["status"] in ("confirmed", "archived")
    assert body["workflow"]["workflow_kind"] == "aaw"
    assert body["dev_run"]["code_statistics"]["total_effective_lines"] > 0
    assert body["governance"]["admin_excluded"] is False


# ----------------------------------------------------------------------
# C2.4 exclusion & restore


def test_exclude_not_queued_and_restore(client):
    dev_id = _sync_dev_without_upload(client, suffix="2")

    missing_reason = client.post(
        f"/api/v1/admin/attribution/records/{dev_id}/exclude", json={"reason": "  "}
    )
    assert missing_reason.status_code == 400

    excluded = client.post(
        f"/api/v1/admin/attribution/records/{dev_id}/exclude",
        json={"reason": "实验性生成，非合入目的", "operator": "张三"},
    )
    assert excluded.status_code == 200

    hidden = client.get("/api/v1/admin/attribution/records").json()
    assert hidden["total"] == 0
    only_excluded = client.get(
        "/api/v1/admin/attribution/records", params={"excluded": "only"}
    ).json()
    assert only_excluded["total"] == 1
    assert only_excluded["items"][0]["admin_excluded_reason"] == "实验性生成，非合入目的"
    assert only_excluded["items"][0]["admin_excluded_by"] == "张三"

    duplicate = client.post(
        f"/api/v1/admin/attribution/records/{dev_id}/exclude",
        json={"reason": "重复"},
    )
    assert duplicate.status_code == 409

    restored = client.post(
        f"/api/v1/admin/attribution/records/{dev_id}/restore", json={}
    )
    assert restored.status_code == 200
    visible = client.get("/api/v1/admin/attribution/records").json()
    assert visible["total"] == 1
    assert visible["items"][0]["admin_excluded"] is False


def test_exclude_allows_matched_with_reason_code(client):
    # 语义升级（设计说明书 §3.3）：删除面向全部产出，已匹配的同样可按理由删除
    # （如重复生成 superseded）；删除后该产出整体退出统计。
    message_id = _make_attribution(client)
    bad_code = client.post(
        f"/api/v1/admin/attribution/records/{message_id}/exclude",
        json={"reason": "重复生成", "reason_code": "bogus"},
    )
    assert bad_code.status_code == 400
    assert bad_code.json()["code"] == "INVALID_REASON_CODE"

    response = client.post(
        f"/api/v1/admin/attribution/records/{message_id}/exclude",
        json={"reason": "重复生成", "reason_code": "superseded", "operator": "王五"},
    )
    assert response.status_code == 200

    overview = client.get("/api/v1/dashboard/overview").json()["period"]
    assert overview["dev_effective_lines"] == 0
    assert overview["attributed_lines_80"] == 0
    assert overview["governance"]["deleted_dev_runs"] == 1


def test_exclude_allowed_for_finalized_no_match_and_restores_caliber(client):
    # Build a record with real code statistics, then downgrade its result to
    # no_match so it models "generated for merge, but never matched".
    dev_id = _make_attribution(client)
    with _db_session(client) as session:
        attribution = session.get(CodeAttribution, uuid.UUID(dev_id))
        attribution.result_status = "finalized_no_match"
        attribution.attribution_status = "finalized_no_match"
        attribution.attributed_lines_80 = 0
        attribution.attributed_lines_90 = 0
        attribution.matched_mr_iid = None
        attribution.matched_mr_url = None
        session.commit()

    overview = client.get("/api/v1/dashboard/overview").json()["period"]
    assert overview["excluded_lines"] == 0
    assert overview["attribution_rate_80_merge_intent"] == overview["attribution_rate_80"]

    excluded = client.post(
        f"/api/v1/admin/attribution/records/{dev_id}/exclude",
        json={"reason": "非合入目的"},
    )
    assert excluded.status_code == 200

    # 删除全口径生效（设计说明书 §5）：分母与分子同时出清；
    # merge_intent 字段组语义升级为"删除前对照"，把删除的数据加回供审计。
    overview = client.get("/api/v1/dashboard/overview").json()["period"]
    lines = overview["excluded_lines"]
    assert lines > 0
    assert overview["dev_effective_lines"] == 0
    assert overview["attribution_rate_80"] is None
    assert overview["dev_effective_lines_merge_intent"] == lines
    assert overview["attribution_rate_80_merge_intent"] == 0.0
    assert overview["experimental_share"] == 1.0


# ----------------------------------------------------------------------
# C2.5 manual retry vs forced rerun


def test_force_retry_bypasses_window_and_leaves_mark(client):
    message_id = _make_attribution(client)
    with _db_session(client) as session:
        attribution = session.get(CodeAttribution, uuid.UUID(message_id))
        attribution.attribution_status = "failed"
        attribution.next_retry_at = None
        dev_run = session.get(DevRun, uuid.UUID(message_id))
        dev_run.completed_at = datetime.now(UTC) - timedelta(days=91)
        session.commit()

    normal = client.post(f"/api/v1/admin/attribution/records/{message_id}/retry")
    assert normal.status_code == 409
    assert normal.json()["code"] == "RETRY_WINDOW_EXPIRED"

    forced = client.post(
        f"/api/v1/admin/attribution/records/{message_id}/force-retry"
    )
    assert forced.status_code == 200
    assert forced.json()["attribution_status"] == "pending"
    assert "admin_retry_expired" in forced.json()["quality_flags"]

    client.post("/api/v1/admin/attribution/scan")
    item = _wait_for_status(client, message_id, "finalized_match")
    assert "admin_retry_expired" in item["quality_flags"]

    records = client.get(
        "/api/v1/admin/attribution/records", params={"quality_flag": "admin_retry_expired"}
    ).json()
    assert records["total"] == 1


def test_force_retry_rejects_not_queued(client):
    dev_id = _sync_dev_without_upload(client, suffix="3")
    response = client.post(
        f"/api/v1/admin/attribution/records/{dev_id}/force-retry"
    )
    assert response.status_code == 409
    assert response.json()["code"] == "RECORD_NOT_QUEUED"


# ----------------------------------------------------------------------
# C2.6 batch processing


def test_bulk_exclude_with_preview_and_restore(client):
    first = _sync_dev_without_upload(client, suffix="4")
    second = _sync_dev_without_upload(client, suffix="5")

    preview = client.post(
        "/api/v1/admin/attribution/bulk",
        json={"action": "exclude", "dry_run": True, "record_kind": "not_queued"},
    ).json()
    assert preview["matched"] == 2
    assert preview["applicable"] == 2
    assert preview["processed"] == 0

    missing_reason = client.post(
        "/api/v1/admin/attribution/bulk",
        json={"action": "exclude", "dry_run": False, "record_kind": "not_queued"},
    )
    assert missing_reason.status_code == 400

    result = client.post(
        "/api/v1/admin/attribution/bulk",
        json={
            "action": "exclude",
            "dry_run": False,
            "reason": "实验性生成",
            "operator": "李四",
            "record_kind": "not_queued",
        },
    ).json()
    assert result["processed"] == 2
    assert result["failed"] == 0

    excluded = client.get(
        "/api/v1/admin/attribution/records", params={"excluded": "only"}
    ).json()
    assert excluded["total"] == 2
    assert {item["dev_run_id"] for item in excluded["items"]} == {first, second}

    restored = client.post(
        "/api/v1/admin/attribution/bulk",
        json={"action": "restore", "dry_run": False, "excluded": "only"},
    ).json()
    assert restored["processed"] == 2


# ----------------------------------------------------------------------
# C2.8 / C2.9 backlog health


def test_health_backlog_categories(client):
    not_queued = _sync_dev_without_upload(client, suffix="6")
    expired_id = _make_attribution(client)
    with _db_session(client) as session:
        attribution = session.get(CodeAttribution, uuid.UUID(expired_id))
        attribution.attribution_status = "failed"
        dev_run = session.get(DevRun, uuid.UUID(expired_id))
        dev_run.completed_at = datetime.now(UTC) - timedelta(days=91)
        session.commit()

    body = client.get("/api/v1/admin/attribution/health").json()
    backlog = body["backlog"]
    assert backlog["waiting_patch"] >= 1
    assert backlog["window_expired_failed"] == 1
    assert "suspected_stuck" in backlog
    assert body["scheduler"]["running"] is True
    assert isinstance(body["failures"], list)
    assert isinstance(body["trend"], list) and len(body["trend"]) == 14
    assert any(a["algorithm_version"] for a in body["algorithms"])

    records = client.get(
        "/api/v1/admin/attribution/records"
    ).json()["items"]
    by_id = {item["dev_run_id"]: item for item in records}
    assert by_id[not_queued]["record_status"] == "not_queued"
    assert by_id[expired_id]["retry_window_expired"] is True


# ----------------------------------------------------------------------
# F1 version operations view


def _version(client, *, email, name, version, days_ago, index):
    when = datetime.now(UTC) - timedelta(days=days_ago)
    when_ms = int(when.timestamp() * 1000)
    payload = message(
        message_id=uuid.UUID(f"66666666-6666-4666-8666-66666666666{index}"),
        workflow_id=uuid.UUID(f"77777777-7777-4777-8777-77777777777{index}"),
        user_email=email,
        user_name=name,
        started_at=when_ms - 1_800_000,
        step_started_at=when_ms - 1_740_000,
        step_completed_at=when_ms - 60_000,
        updated_at=when_ms,
    )
    payload["aaw_version"] = version
    assert sync(client, payload).status_code == 200


def test_version_roster_who_is_on_old_versions(client):
    # alice: on an old version right now (the person to chase)
    _version(client, email="alice@x.com", name="Alice", version="1.1.1", days_ago=1, index=1)
    # bob: upgraded recently — history contains an old version but current is latest
    _version(client, email="bob@x.com", name="Bob", version="1.1.1", days_ago=10, index=2)
    _version(client, email="bob@x.com", name="Bob", version="2.3.2", days_ago=1, index=3)
    # eve: three versions over time, now on latest
    _version(client, email="eve@x.com", name="Eve", version="0.1.0", days_ago=40, index=4)
    _version(client, email="eve@x.com", name="Eve", version="1.1.1", days_ago=20, index=5)
    _version(client, email="eve@x.com", name="Eve", version="2.3.2", days_ago=2, index=6)
    # carol: smoke account, non-release version string
    _version(client, email="carol@x.com", name="Carol", version="remote-smoke", days_ago=1, index=7)
    # dave: only reported long ago — outside the window, must not appear
    _version(client, email="dave@x.com", name="Dave", version="0.1.0", days_ago=60, index=8)

    roster = client.get("/api/v1/admin/versions/roster").json()
    # No release dir configured → baseline falls back to the highest semantic
    # version visible in the data.
    assert roster["latest_version"] == "2.3.2"
    assert roster["active_users"] == 4  # alice, bob, eve, carol (dave out of window)
    assert roster["on_old"] == 1
    assert roster["on_latest"] == 2
    assert roster["non_release_users"] == 1
    assert [row["user_email"] for row in roster["items"]] == ["alice@x.com"]
    assert roster["items"][0]["behind"] == 1
    assert [row["user_email"] for row in roster["non_release"]] == ["carol@x.com"]

    timeline = client.get(
        "/api/v1/admin/versions/timeline",
        params={"user_email": "eve@x.com"},
    ).json()
    assert [span["version"] for span in timeline["items"]] == ["0.1.0", "1.1.1", "2.3.2"]
    assert all(span["report_count"] == 1 for span in timeline["items"])

    distribution = client.get("/api/v1/admin/versions/distribution").json()
    users_by_version = {item["version"]: item["users"] for item in distribution["items"]}
    assert users_by_version["2.3.2"] == 2  # bob + eve (current version caliber)
    assert users_by_version["remote-smoke"] == 1


def test_version_roster_honors_release_dir_baseline(client, tmp_path):
    release_dir = tmp_path / "releases"
    release_dir.mkdir()
    (release_dir / "aaw-skills-9.9.9.zip").write_bytes(b"zip")
    settings = client.app.state.settings
    original = settings.release_dir
    settings.release_dir = release_dir
    try:
        _version(client, email="alice@x.com", name="Alice", version="2.3.2", days_ago=1, index=9)
        roster = client.get("/api/v1/admin/versions/roster").json()
        assert roster["release_source"] == "release_dir"
        assert roster["latest_version"] == "9.9.9"
        assert roster["items"][0]["behind"] >= 1
    finally:
        settings.release_dir = original
