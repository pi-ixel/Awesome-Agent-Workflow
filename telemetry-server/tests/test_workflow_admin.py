"""工作流数据管理与删除（设计说明书 §7 验收）。

覆盖：工作流 tab 列表/详情、三级删除各自生效于对应口径、工作流删除连带出清、
归档恢复后重新计入、理由码必选校验、未删除数据统计不受影响。
"""

from __future__ import annotations

import hashlib
import time
import uuid

from tests.conftest import WORKFLOW_ID, message, sync, upload_diff


def _wait_for_match(client, message_id: str, timeout: float = 5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        detail = client.get(f"/api/v1/workflows/{WORKFLOW_ID}").json()
        steps = detail.get("steps") or []
        if steps and steps[0].get("attribution_status") == "finalized_match":
            return
        time.sleep(0.02)
    raise AssertionError("attribution did not reach 'finalized_match'")


def _seed_matched_workflow(client) -> str:
    """一条带产出与已匹配归因的工作流；返回 dev_run_id。"""
    payload = message()
    assert sync(client, payload).status_code == 200
    upload_diff(client, payload)
    client.post("/api/v1/admin/attribution/scan")
    _wait_for_match(client, payload["message_id"])
    return payload["message_id"]


def _overview(client):
    return client.get("/api/v1/dashboard/overview").json()["period"]


# ----------------------------------------------------------------------
# 列表与详情


def test_workflow_list_and_filters(client):
    _seed_matched_workflow(client)
    body = client.get("/api/v1/admin/workflows").json()
    assert body["total"] == 1
    item = body["items"][0]
    assert item["workflow_run_id"] == str(WORKFLOW_ID)
    assert item["dev_runs"] == 1
    assert item["dev_effective_lines"] > 0
    assert item["attribution_matched"] == 1
    assert item["deleted"] is False

    by_user = client.get("/api/v1/admin/workflows", params={"user": "nobody"}).json()
    assert by_user["total"] == 0
    by_repo = client.get(
        "/api/v1/admin/workflows", params={"repository": "example-service"}
    ).json()
    assert by_repo["total"] == 1
    invalid = client.get("/api/v1/admin/workflows", params={"state": "bogus"})
    assert invalid.status_code == 400
    assert invalid.json()["code"] == "INVALID_FILTER"


def test_workflow_list_repository_filter_accepts_multiple_values(client):
    """责任方下钻：一个责任方覆盖多个仓库时，一次传入逗号分隔的仓库列表。"""
    assert sync(client, message()).status_code == 200
    second = message(
        message_id=uuid.UUID("22222222-2222-4222-8222-222222222201"),
        workflow_id=uuid.UUID("33333333-3333-4333-8333-333333333301"),
        repository="team/other-service",
        sr="SR-2002",
    )
    assert sync(client, second).status_code == 200

    single = client.get(
        "/api/v1/admin/workflows", params={"repository": "other-service"}
    ).json()
    assert single["total"] == 1

    both = client.get(
        "/api/v1/admin/workflows",
        params={"repository": "example-service, other-service"},
    ).json()
    assert both["total"] == 2

    blank = client.get("/api/v1/admin/workflows", params={"repository": " , "}).json()
    assert blank["total"] == 2  # 全空白视为未筛选


def test_workflow_detail_shows_three_levels(client):
    dev_id = _seed_matched_workflow(client)
    body = client.get(f"/api/v1/admin/workflows/{WORKFLOW_ID}/detail").json()
    assert body["workflow"]["workflow_run_id"] == str(WORKFLOW_ID)
    step = next(row for row in body["steps"] if row["step_type"] == "task-dev")
    assert step["dev_run"]["dev_run_id"] == dev_id
    assert step["dev_run"]["dev_effective_lines"] > 0
    attribution = step["dev_run"]["attribution"]
    assert attribution["result_status"] == "finalized_match"
    assert attribution["matched_mr_iid"]
    assert attribution["deleted"] is False


# ----------------------------------------------------------------------
# 理由码校验


def test_reason_code_validation(client):
    _seed_matched_workflow(client)

    missing = client.post(
        f"/api/v1/admin/workflows/{WORKFLOW_ID}/delete", json={}
    )
    assert missing.status_code == 400

    unknown = client.post(
        f"/api/v1/admin/workflows/{WORKFLOW_ID}/delete",
        json={"reason_code": "because"},
    )
    assert unknown.status_code == 400
    assert unknown.json()["code"] == "INVALID_REASON_CODE"

    other_without_note = client.post(
        f"/api/v1/admin/workflows/{WORKFLOW_ID}/delete",
        json={"reason_code": "other"},
    )
    assert other_without_note.status_code == 400
    assert other_without_note.json()["code"] == "REASON_NOTE_REQUIRED"


# ----------------------------------------------------------------------
# 一级删除：工作流连带出清 + 归档恢复


def test_workflow_delete_cascades_and_restore(client):
    _seed_matched_workflow(client)
    before = _overview(client)
    assert before["workflow_runs"] == 1
    assert before["dev_effective_lines"] > 0

    deleted = client.post(
        f"/api/v1/admin/workflows/{WORKFLOW_ID}/delete",
        json={"reason_code": "trial", "operator": "张三"},
    )
    assert deleted.status_code == 200

    # 全口径出清：总览、工作流列表、归因记录同时消失
    after = _overview(client)
    assert after["workflow_runs"] == 0
    assert after["dev_effective_lines"] == 0
    assert after["attributed_lines_80"] == 0
    assert after["governance"]["deleted_workflows"] == 1
    # 删除前对照口径把数据加回
    assert after["excluded_lines"] == before["dev_effective_lines"]

    visible = client.get("/api/v1/admin/workflows").json()
    assert visible["total"] == 0
    archive = client.get(
        "/api/v1/admin/workflows", params={"lifecycle": "deleted"}
    ).json()
    assert archive["total"] == 1
    row = archive["items"][0]
    assert row["deleted"] is True
    assert row["deleted_reason_code"] == "trial"
    assert row["deleted_by"] == "张三"
    assert row["deleted_at"]

    records = client.get("/api/v1/admin/attribution/records").json()
    assert records["total"] == 0

    # 恢复后重新计入
    restored = client.post(f"/api/v1/admin/workflows/{WORKFLOW_ID}/restore", json={})
    assert restored.status_code == 200
    again = _overview(client)
    assert again["workflow_runs"] == 1
    assert again["dev_effective_lines"] == before["dev_effective_lines"]
    assert again["attributed_lines_80"] == before["attributed_lines_80"]


# ----------------------------------------------------------------------
# 二级/三级删除：DevRun 与归因各自生效


def test_attribution_delete_keeps_denominator(client):
    dev_id = _seed_matched_workflow(client)
    before = _overview(client)

    deleted = client.post(
        f"/api/v1/admin/attributions/{dev_id}/delete",
        json={"reason_code": "no_match_unresolvable", "reason": "匹配结果错误"},
    )
    assert deleted.status_code == 200

    # 分母在、分子无：产出退回未归因
    after = _overview(client)
    assert after["dev_effective_lines"] == before["dev_effective_lines"]
    assert after["attributed_lines_80"] == 0
    assert after["attribution_rate_80"] == 0.0
    assert after["governance"]["deleted_attributions"] == 1

    listing = client.get("/api/v1/statistics/code-attribution").json()
    assert listing["total"] == 0

    # 已删除的归因不会被调度器重扫（删除即终态）
    client.post("/api/v1/admin/attribution/scan")
    detail = client.get(f"/api/v1/admin/workflows/{WORKFLOW_ID}/detail").json()
    step = next(row for row in detail["steps"] if row["step_type"] == "task-dev")
    assert step["dev_run"]["attribution"]["deleted"] is True

    restored = client.post(f"/api/v1/admin/attributions/{dev_id}/restore", json={})
    assert restored.status_code == 200
    again = _overview(client)
    assert again["attributed_lines_80"] == before["attributed_lines_80"]


def test_dev_run_delete_removes_denominator(client):
    dev_id = _seed_matched_workflow(client)

    deleted = client.post(
        f"/api/v1/admin/dev-runs/{dev_id}/delete",
        json={"reason_code": "unsatisfied"},
    )
    assert deleted.status_code == 200

    after = _overview(client)
    assert after["dev_runs"] == 0
    assert after["dev_effective_lines"] == 0
    assert after["attributed_lines_80"] == 0

    detail = client.get(f"/api/v1/admin/workflows/{WORKFLOW_ID}/detail").json()
    step = next(row for row in detail["steps"] if row["step_type"] == "task-dev")
    assert step["dev_run"]["deleted"] is True
    assert step["dev_run"]["deleted_reason_code"] == "unsatisfied"

    restored = client.post(f"/api/v1/admin/dev-runs/{dev_id}/restore", json={})
    assert restored.status_code == 200
    assert _overview(client)["dev_effective_lines"] > 0


def test_untouched_data_statistics_unaffected(client):
    """未删除数据的统计不受治理能力上线影响。"""
    _seed_matched_workflow(client)
    period = _overview(client)
    assert period["workflow_runs"] == 1
    assert period["governance"] == {
        "deleted_workflows": 0,
        "deleted_dev_runs": 0,
        "deleted_attributions": 0,
        "deleted_lines": 0,
    }
    # 无删除时对照口径与全量口径一致
    assert period["excluded_lines"] == 0
    assert period["attribution_rate_80_merge_intent"] == period["attribution_rate_80"]


def test_workflow_tab_survives_non_uuid_id(client):
    bad = client.get("/api/v1/admin/workflows/not-a-uuid/detail")
    assert bad.status_code == 400
    assert bad.json()["code"] == "INVALID_ID"


# ----------------------------------------------------------------------
# 补丁文件内容预览与下载


def test_patch_preview_and_download(client):
    payload = message()
    assert sync(client, payload).status_code == 200
    upload_diff(client, payload)
    client.post("/api/v1/admin/attribution/scan")
    _wait_for_match(client, payload["message_id"])
    dev_id = payload["message_id"]

    preview = client.get(f"/api/v1/admin/dev-runs/{dev_id}/patch").json()
    assert preview["missing"] is False
    assert preview["source"] == "live"
    assert preview["content"].startswith("diff --git a/app.py")
    assert preview["truncated"] is False
    assert preview["size_bytes"] > 0

    downloaded = client.get(
        f"/api/v1/admin/dev-runs/{dev_id}/patch", params={"download": "true"}
    )
    assert downloaded.status_code == 200
    assert "attachment" in downloaded.headers["content-disposition"]
    assert downloaded.text.startswith("diff --git a/app.py")


def test_patch_missing_when_never_uploaded(client):
    payload = message(
        message_id=uuid.UUID("88888888-8888-4888-8888-888888888801"),
        workflow_id=uuid.UUID("88888888-8888-4888-8888-888888888802"),
        ar="AR-PATCH-MISSING",
    )
    assert sync(client, payload).status_code == 200
    dev_id = payload["message_id"]

    preview = client.get(f"/api/v1/admin/dev-runs/{dev_id}/patch").json()
    assert preview["missing"] is True
    assert preview["reason"]

    downloaded = client.get(
        f"/api/v1/admin/dev-runs/{dev_id}/patch", params={"download": "true"}
    )
    assert downloaded.status_code == 404
    assert downloaded.json()["code"] == "PATCH_NOT_FOUND"


def test_patch_summary_lists_files_with_add_del(client):
    multi = (
        b"diff --git a/app.py b/app.py\n"
        b"--- a/app.py\n+++ b/app.py\n"
        b"@@ -1 +1,3 @@\n old\n+new\n+new2\n"
        b"diff --git a/lib/util.py b/lib/util.py\n"
        b"--- a/lib/util.py\n+++ b/lib/util.py\n"
        b"@@ -1,2 +1 @@\n-dead\n alive\n"
    )
    payload = message(
        message_id=uuid.UUID("88888888-8888-4888-8888-888888888811"),
        workflow_id=uuid.UUID("88888888-8888-4888-8888-888888888812"),
        ar="AR-PATCH-MULTI",
    )
    payload["data"]["file"]["sha256"] = hashlib.sha256(multi).hexdigest()
    assert sync(client, payload).status_code == 200
    upload_diff(client, payload, content=multi)
    dev_id = payload["message_id"]

    preview = client.get(f"/api/v1/admin/dev-runs/{dev_id}/patch").json()
    assert preview["missing"] is False
    assert preview["file_count"] == 2
    assert preview["total_additions"] == 2
    assert preview["total_deletions"] == 1
    # 变更量大的文件排前面
    assert preview["files"][0] == {
        "file": "app.py", "additions": 2, "deletions": 0, "binary": False,
    }
    assert preview["files"][1]["file"] == "lib/util.py"
    assert preview["files"][1]["deletions"] == 1
