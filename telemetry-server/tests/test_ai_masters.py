from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta

import pytest
from conftest import message, sync, upload_diff
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from aaw_telemetry.config import (
    ComponentEntry,
    ComponentsDocument,
    ProjectEntry,
    ProjectRegistry,
)
from aaw_telemetry.database import Base
from aaw_telemetry.errors import ApiError
from aaw_telemetry.models import Component, ComponentRepo
from aaw_telemetry.services.ai_masters import AiMasterService, tier_for
from aaw_telemetry.services.owner_overview import OwnerOverviewService
from aaw_telemetry.services.queries import make_filters


def _multi_project_registry() -> ProjectRegistry:
    return ProjectRegistry(
        ComponentsDocument(
            components={
                "comp-a": ComponentEntry(
                    name="组件A",
                    se="张三",
                    repos={"team/a": ProjectEntry(canonical_url="git@x/team/a.git")},
                ),
                "comp-b": ComponentEntry(
                    name="组件B",
                    se="李四",
                    repos={"team/b": ProjectEntry(canonical_url="git@x/team/b.git")},
                ),
                "comp-c": ComponentEntry(
                    name="组件C",
                    se=None,
                    # 双仓库组件：用来验证"组件下仓库分属不同 AI Master"的混合归属
                    repos={
                        "team/c1": ProjectEntry(canonical_url="git@x/team/c1.git"),
                        "team/c2": ProjectEntry(canonical_url="git@x/team/c2.git"),
                    },
                ),
            }
        )
    )


@pytest.fixture
def session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as sess:
        now = datetime.now(UTC)
        for component_id, name, se, repos in (
            ("comp-a", "组件A", "张三", ["team/a"]),
            ("comp-b", "组件B", "李四", ["team/b"]),
            ("comp-c", "组件C", None, ["team/c1", "team/c2"]),
        ):
            sess.add(
                Component(
                    id=component_id, name=name, se=se, position=0,
                    created_at=now, updated_at=now,
                )
            )
            for repo_key in repos:
                sess.add(
                    ComponentRepo(
                        repo_key=repo_key,
                        component_id=component_id,
                        canonical_url=f"git@x/{repo_key}.git",
                        target_branch="main",
                        enabled=True,
                        created_at=now,
                        updated_at=now,
                    )
                )
        sess.commit()
        yield sess
    engine.dispose()


@pytest.fixture
def service(session: Session) -> AiMasterService:
    return AiMasterService(session, _multi_project_registry())


def _filters():
    today = date.today()
    return make_filters(today - timedelta(days=29), today, [], [], [], [], [], "aaw")


def test_tier_boundaries():
    assert tier_for(0.70) == "none"
    assert tier_for(0.65) == "none"   # >= 0.65 -> none
    assert tier_for(0.64) == "three"
    assert tier_for(0.50) == "three"  # 0.50 <= rate < 0.65 -> three
    assert tier_for(0.49) == "five"
    assert tier_for(0.0) == "five"
    assert tier_for(None) == "no_data"


def test_create_and_rename_and_delete(service: AiMasterService):
    created = service.create_ai_master("运营一")
    assert created["name"] == "运营一"

    renamed = service.rename_ai_master(uuid.UUID(created["id"]), "运营二")
    assert renamed["name"] == "运营二"

    masters = service.list_ai_masters()
    assert len(masters["items"]) == 1
    assert masters["items"][0]["name"] == "运营二"

    deleted = service.delete_ai_master(uuid.UUID(created["id"]))
    assert deleted["deleted"] is True
    assert service.list_ai_masters()["items"] == []


def test_create_duplicate_name_rejected(service: AiMasterService):
    service.create_ai_master("重复名")
    with pytest.raises(ApiError) as exc:
        service.create_ai_master("重复名")
    assert exc.value.status_code == 409


def test_assign_repo_is_the_ownership_unit(service: AiMasterService):
    """责任单位是仓库：认领按 repo_key 记录，组件级归属由它推导。"""
    master = service.create_ai_master("运营一")
    master_id = uuid.UUID(master["id"])

    result = service.assign_repo("team/a", master_id)
    assert result["repo_key"] == "team/a"
    assert result["ai_master_id"] == str(master_id)

    assignments = service.list_assignments()
    # 仓库表是稀疏的（只列已认领），组件表是推导出来的全量映射
    assert assignments["assignments"] == {"team/a": str(master_id)}
    assert assignments["component_assignments"]["comp-a"] == str(master_id)
    assert assignments["component_assignments"]["comp-b"] is None
    assert service.list_ai_masters()["items"][0]["repo_count"] == 1


def test_repo_has_single_master(service: AiMasterService):
    """一个仓库只能有一位 AI Master：改派即覆盖，不会出现两位。"""
    m1 = service.create_ai_master("运营一")
    m2 = service.create_ai_master("运营二")
    service.assign_repo("team/a", uuid.UUID(m1["id"]))
    service.assign_repo("team/a", uuid.UUID(m2["id"]))

    assert service.list_assignments()["assignments"] == {"team/a": str(m2["id"])}
    counts = {item["name"]: item["repo_count"] for item in service.list_ai_masters()["items"]}
    assert counts == {"运营一": 0, "运营二": 1}


def test_assign_component_is_bulk_over_its_repos(service: AiMasterService):
    """组件级认领是便捷入口：把该组件下所有仓库一起认领。"""
    master = service.create_ai_master("运营一")
    result = service.assign_component("comp-c", uuid.UUID(master["id"]))
    assert result["repo_keys"] == ["team/c1", "team/c2"]
    assert set(service.list_assignments()["assignments"]) == {"team/c1", "team/c2"}


def test_split_ownership_component_has_no_single_master(service: AiMasterService):
    """组件下仓库分属不同 AI Master 时，组件级归属为空（前端显示多人分管）。"""
    m1 = service.create_ai_master("运营一")
    m2 = service.create_ai_master("运营二")
    service.assign_repo("team/c1", uuid.UUID(m1["id"]))
    service.assign_repo("team/c2", uuid.UUID(m2["id"]))

    assignments = service.list_assignments()
    assert assignments["component_assignments"]["comp-c"] is None
    assert assignments["assignments"] == {
        "team/c1": str(m1["id"]),
        "team/c2": str(m2["id"]),
    }


def test_assign_unknown_repo_rejected(service: AiMasterService):
    master = service.create_ai_master("运营一")
    with pytest.raises(ApiError) as exc:
        service.assign_repo("does-not-exist", uuid.UUID(master["id"]))
    assert exc.value.status_code == 404


def test_delete_master_unassigns_repos(service: AiMasterService):
    m1 = service.create_ai_master("运营一")
    service.assign_repo("team/a", uuid.UUID(m1["id"]))
    service.assign_repo("team/b", uuid.UUID(m1["id"]))
    service.delete_ai_master(uuid.UUID(m1["id"]))
    assert service.list_assignments()["assignments"] == {}


def test_group_repos_buckets_unassigned(service: AiMasterService):
    m1 = service.create_ai_master("运营一")
    service.create_ai_master("运营二")
    service.assign_repo("team/a", uuid.UUID(m1["id"]))

    def row(repo_key: str, component_id: str) -> dict:
        return {
            "repo_key": repo_key,
            "component_id": component_id,
            "effective_lines": 0,
            "attribution_rate_80": None,
            "workflows_30d": 0,
            "stalled_30d": 0,
            "active_users": 0,
            "pending_attribution": 0,
            "used_aaw": False,
        }

    rows = [row("team/a", "comp-a"), row("team/b", "comp-b")]
    cards = {card["name"]: card for card in service.group_repos(rows)["items"]}
    assert cards["运营一"]["total_repos"] == 1
    assert cards["运营一"]["repo_keys"] == ["team/a"]
    assert cards["运营二"]["total_repos"] == 0
    # 未被认领的仓库落进"未认领"桶
    assert cards["未认领"]["total_repos"] == 1
    assert cards["未认领"]["repo_keys"] == ["team/b"]


# ── API 路由层 ──────────────────────────────────────────


def test_ai_master_api_crud_and_repo_assign(client):
    created = client.post("/api/v1/ai-masters", json={"name": "运营甲"})
    assert created.status_code == 201
    master_id = created.json()["id"]

    dup = client.post("/api/v1/ai-masters", json={"name": "运营甲"})
    assert dup.status_code == 409

    renamed = client.patch(f"/api/v1/ai-masters/{master_id}", json={"name": "运营甲改"})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "运营甲改"

    listed = client.get("/api/v1/ai-masters").json()
    assert listed["items"][0]["name"] == "运营甲改"

    assigned = client.put(
        "/api/v1/ai-masters/repo-assignments/team/example-service",
        json={"ai_master_id": master_id},
    )
    assert assigned.status_code == 200
    assert assigned.json()["repo_key"] == "team/example-service"

    assignments = client.get("/api/v1/ai-masters/assignments").json()
    assert assignments["assignments"]["team/example-service"] == master_id
    assert assignments["component_assignments"]["example-component"] == master_id

    bad = client.put(
        "/api/v1/ai-masters/repo-assignments/no-such-repo",
        json={"ai_master_id": master_id},
    )
    assert bad.status_code == 404


def test_ai_master_api_component_bulk_assign_and_repos_detail(client):
    m1 = client.post("/api/v1/ai-masters", json={"name": "运营一"}).json()
    client.post("/api/v1/ai-masters", json={"name": "运营二"}).json()
    bulk = client.put(
        "/api/v1/ai-masters/assignments/example-component",
        json={"ai_master_id": m1["id"]},
    )
    assert bulk.status_code == 200
    assert bulk.json()["repo_keys"] == ["team/example-service"]

    ops_body = client.get("/api/v1/ai-masters/operations").json()["items"]
    ops = {card["name"]: card for card in ops_body}
    assert ops["运营一"]["total_repos"] == 1
    assert ops["运营二"]["total_repos"] == 0
    assert "未认领" not in ops  # 唯一的仓库已认领

    detail = client.get(f"/api/v1/ai-masters/{m1['id']}/repos").json()
    assert detail["name"] == "运营一"
    assert [row["repo_key"] for row in detail["items"]] == ["team/example-service"]

    deleted = client.delete(f"/api/v1/ai-masters/{m1['id']}")
    assert deleted.json()["deleted"] is True
    assert client.get("/api/v1/ai-masters/assignments").json()["assignments"] == {}


def test_operations_tiers_follow_repo_adoption(client):
    """档位按仓库采纳率判定：真实数据下采纳率 1.0 归"无要求"档。"""
    dev = message(workflow_completed=False)
    sync(client, dev)
    upload_diff(client, dev)  # StubAttributionService -> attributed = total -> rate 1.0
    m1 = client.post("/api/v1/ai-masters", json={"name": "运营一"}).json()
    client.put(
        "/api/v1/ai-masters/assignments/example-component",
        json={"ai_master_id": m1["id"]},
    )
    ops = client.get("/api/v1/ai-masters/operations").json()["items"]
    card = next(c for c in ops if c["name"] == "运营一")
    assert card["tier_counts"]["none"] == 1
    assert card["tier_counts"]["no_data"] == 0
    assert card["lowest_required_rate"] is None


def test_owner_overview_groups_repos_by_master(client):
    """总览的 AI Master 视角按仓库聚合，SE 视角仍按组件聚合。"""
    m1 = client.post("/api/v1/ai-masters", json={"name": "运营一"}).json()
    client.put(
        "/api/v1/ai-masters/assignments/example-component",
        json={"ai_master_id": m1["id"]},
    )
    owners = client.get("/api/v1/admin/overview").json()["owners"]

    master_rows = {row["name"]: row for row in owners["by_master"]}
    assert master_rows["运营一"]["repos"] == 1
    assert master_rows["运营一"]["repo_keys"] == ["team/example-service"]
    assert "未认领" not in master_rows

    component = next(
        c for c in owners["components"] if c["component_id"] == "example-component"
    )
    assert component["ai_master"] == "运营一"
    assert component["ai_masters"] == ["运营一"]
    assert component["split_ownership"] is False
    assert component["repo_keys"] == ["team/example-service"]

    repo = next(r for r in owners["repos"] if r["repo_key"] == "team/example-service")
    assert repo["ai_master"] == "运营一"
    assert repo["component_name"] == "示例组件"
    assert repo["se"] == "张三"


def test_owner_overview_repo_metrics_cover_unassigned(client):
    """未认领的仓库仍要出现在仓库明细与未认领桶里（责任覆盖缺口必须可见）。"""
    sync(client, message())
    owners = client.get("/api/v1/admin/overview").json()["owners"]
    rows = {row["name"]: row for row in owners["by_master"]}
    assert rows["未认领"]["repos"] == 1
    repo = next(r for r in owners["repos"] if r["repo_key"] == "team/example-service")
    assert repo["ai_master"] is None
    assert repo["workflows_30d"] >= 1
    assert OwnerOverviewService.window().workflow_kind == "aaw"
