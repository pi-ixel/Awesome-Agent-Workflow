from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import ProjectRegistry
from ..errors import ApiError
from ..models import AiMaster, ComponentRepo, RepoAiMaster

# Tier thresholds for the AI Master assessment rules (based on the 80% rate).
_RATE_NONE = 0.65  # rate >= 0.65 -> no question requirement
_RATE_FIVE = 0.50  # rate < 0.50 -> need >= 5 questions

UNASSIGNED_MASTER_LABEL = "未认领"


def tier_for(rate: float | None) -> str:
    """Map an 80% adoption rate to an assessment tier.

    - rate >= 0.65            -> "none"   (no question requirement)
    - 0.50 <= rate < 0.65     -> "three"  (need >= 3 questions)
    - rate < 0.50             -> "five"   (need >= 5 questions)
    - rate is None            -> "no_data"
    """
    if rate is None:
        return "no_data"
    if rate >= _RATE_NONE:
        return "none"
    if rate >= _RATE_FIVE:
        return "three"
    return "five"


def _master_payload(master: AiMaster, repo_count: int = 0) -> dict[str, Any]:
    return {
        "id": str(master.id),
        "name": master.name,
        "repo_count": repo_count,
    }


class AiMasterService:
    """AI Master 实体与**仓库级**归属。

    责任单位是仓库：一位 AI Master 覆盖若干仓库，一个仓库只能有一位（repo_key 即
    主键）。组件级归属由仓库归属推导，供注册表/组件页展示；AI Master 的指标
    （工作流使用情况、采纳体质）由 OwnerOverviewService 按仓库汇总后传入。
    """

    def __init__(self, session: Session, projects: ProjectRegistry):
        self.session = session
        self.projects = projects

    # ── AI Master CRUD ────────────────────────────────────────────────

    def list_ai_masters(self) -> dict[str, Any]:
        masters = self.session.scalars(select(AiMaster).order_by(AiMaster.name)).all()
        counts = self._repo_counts_by_master()
        return {
            "items": [_master_payload(master, counts.get(master.id, 0)) for master in masters]
        }

    def create_ai_master(self, name: str) -> dict[str, Any]:
        value = (name or "").strip()
        if not value:
            raise ApiError(400, "INVALID_AI_MASTER_NAME", "name must not be empty")
        existing = self.session.scalar(select(AiMaster).where(AiMaster.name == value))
        if existing is not None:
            raise ApiError(409, "AI_MASTER_EXISTS", "an AI Master with this name exists")
        now = datetime.now(UTC)
        master = AiMaster(id=uuid.uuid4(), name=value, created_at=now, updated_at=now)
        self.session.add(master)
        self.session.commit()
        return _master_payload(master)

    def rename_ai_master(self, master_id: uuid.UUID, name: str) -> dict[str, Any]:
        master = self._get_master(master_id)
        value = (name or "").strip()
        if not value:
            raise ApiError(400, "INVALID_AI_MASTER_NAME", "name must not be empty")
        duplicate = self.session.scalar(
            select(AiMaster).where(AiMaster.name == value, AiMaster.id != master.id)
        )
        if duplicate is not None:
            raise ApiError(409, "AI_MASTER_EXISTS", "an AI Master with this name exists")
        master.name = value
        master.updated_at = datetime.now(UTC)
        self.session.commit()
        return _master_payload(master)

    def delete_ai_master(self, master_id: uuid.UUID) -> dict[str, Any]:
        """删除 AI Master：名下仓库解除认领（退回未认领），仓库本身保留。"""
        master = self._get_master(master_id)
        assignments = self.session.scalars(
            select(RepoAiMaster).where(RepoAiMaster.ai_master_id == master.id)
        ).all()
        for assignment in assignments:
            self.session.delete(assignment)
        self.session.delete(master)
        self.session.commit()
        return {"id": str(master.id), "deleted": True}

    # ── repository assignment ─────────────────────────────────────────

    def list_assignments(self) -> dict[str, Any]:
        return {
            "assignments": self.repo_assignments(),
            "component_assignments": self.component_assignments(),
        }

    def repo_assignments(self) -> dict[str, str]:
        return {
            row.repo_key: str(row.ai_master_id)
            for row in self.session.scalars(select(RepoAiMaster)).all()
        }

    def component_assignments(self) -> dict[str, str | None]:
        """组件级归属由仓库推导：其仓库全部同人 → 该人；混合归属 → None。

        None 表示"组件下仓库分属不同 AI Master"，前端据此显示"多人分管"。
        """
        by_repo = self.repo_assignments()
        result: dict[str, str | None] = {}
        for component_id, repo_keys in self._repos_by_component().items():
            owners = {by_repo.get(repo_key) for repo_key in repo_keys}
            owners.discard(None)
            covered = all(by_repo.get(repo_key) for repo_key in repo_keys)
            result[component_id] = str(next(iter(owners))) if len(owners) == 1 and covered else None
        return result

    def assign_repo(self, repo_key: str, ai_master_id: uuid.UUID | None) -> dict[str, Any]:
        if repo_key not in self._known_repos():
            raise ApiError(404, "REPO_NOT_FOUND", "repository is not registered")
        existing = self.session.get(RepoAiMaster, repo_key)
        if ai_master_id is None:
            if existing is not None:
                self.session.delete(existing)
                self.session.commit()
            return {"repo_key": repo_key, "ai_master_id": None}
        master = self._get_master(ai_master_id)
        now = datetime.now(UTC)
        if existing is None:
            self.session.add(
                RepoAiMaster(
                    repo_key=repo_key,
                    ai_master_id=master.id,
                    created_at=now,
                    updated_at=now,
                )
            )
        elif existing.ai_master_id != master.id:
            existing.ai_master_id = master.id
            existing.updated_at = now
        self.session.commit()
        return {"repo_key": repo_key, "ai_master_id": str(master.id)}

    def assign_component(
        self, component_id: str, ai_master_id: uuid.UUID | None
    ) -> dict[str, Any]:
        """批量入口：把组件下所有仓库一起认领给同一位 AI Master（或一起解除）。"""
        repo_keys = self._repos_by_component().get(component_id)
        if not repo_keys:
            raise ApiError(
                404, "COMPONENT_NOT_FOUND", "component has no registered repository"
            )
        if ai_master_id is not None:
            master = self._get_master(ai_master_id)
            ai_master_id = master.id
        for repo_key in repo_keys:
            self.assign_repo(repo_key, ai_master_id)
        return {
            "component_id": component_id,
            "ai_master_id": None if ai_master_id is None else str(ai_master_id),
            "repo_keys": sorted(repo_keys),
        }

    # ── views over repo metrics ───────────────────────────────────────

    def group_repos(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        """把仓库级指标按归属的 AI Master 分组，产出运营卡片（含未认领兜底）。"""
        by_repo = self.repo_assignments()
        masters = {
            str(master.id): master for master in self.session.scalars(select(AiMaster)).all()
        }
        buckets: dict[str | None, list[dict[str, Any]]] = {}
        for row in rows:
            master_id = by_repo.get(row["repo_key"])
            if master_id is not None and master_id not in masters:
                master_id = None  # 悬空认领按未认领处理
            buckets.setdefault(master_id, []).append(row)

        cards = [
            self._card_payload(
                ai_master_id=master_id, name=masters[master_id].name,
                repos=buckets.get(master_id, []),
            )
            for master_id in sorted(masters, key=lambda mid: masters[mid].name)
        ]
        unassigned = buckets.get(None, [])
        if unassigned:
            cards.append(
                self._card_payload(
                    ai_master_id=None, name=UNASSIGNED_MASTER_LABEL, repos=unassigned
                )
            )
        return {"items": cards}

    def repos_of_master(self, master_id: uuid.UUID | None) -> set[str]:
        if master_id is None:
            return set()
        return {
            row.repo_key
            for row in self.session.scalars(
                select(RepoAiMaster).where(RepoAiMaster.ai_master_id == master_id)
            ).all()
        }

    def master_repos(self, master_id: uuid.UUID, rows: list[dict[str, Any]]) -> dict[str, Any]:
        master = self._get_master(master_id)
        owned = self.repos_of_master(master.id)
        items = [row for row in rows if row["repo_key"] in owned]
        items.sort(key=lambda row: row["repo_key"])
        return {"ai_master_id": str(master.id), "name": master.name, "items": items}

    def master_components(
        self, master_id: uuid.UUID, component_rows: list[dict[str, Any]]
    ) -> dict[str, Any]:
        """某位 AI Master 覆盖到的组件（只统计其名下仓库所在组件）。"""
        master = self._get_master(master_id)
        owned = self.repos_of_master(master.id)
        component_ids = {
            row["component_id"]
            for row in self._component_rows_by_repo(owned)
            if row.get("component_id")
        }
        items = [
            row for row in component_rows if row["component_id"] in component_ids
        ]
        items.sort(key=lambda row: row["name"])
        return {
            "ai_master_id": str(master.id),
            "name": master.name,
            "items": items,
            "repo_keys": sorted(owned),
        }

    # ── helpers ────────────────────────────────────────────────────────

    def _get_master(self, master_id: uuid.UUID) -> AiMaster:
        master = self.session.get(AiMaster, master_id)
        if master is None:
            raise ApiError(404, "AI_MASTER_NOT_FOUND", "AI Master was not found")
        return master

    def _known_repos(self) -> set[str]:
        return {key for keys in self._repos_by_component().values() for key in keys}

    def _repos_by_component(self) -> dict[str, list[str]]:
        result: dict[str, list[str]] = {}
        for row in self.session.scalars(select(ComponentRepo)).all():
            result.setdefault(row.component_id, []).append(row.repo_key)
        return result

    def _component_rows_by_repo(self, repo_keys: set[str]) -> list[dict[str, Any]]:
        return [
            {"repo_key": row.repo_key, "component_id": row.component_id}
            for row in self.session.scalars(select(ComponentRepo)).all()
            if row.repo_key in repo_keys
        ]

    def _repo_counts_by_master(self) -> dict[uuid.UUID, int]:
        counts: dict[uuid.UUID, int] = {}
        for master_id in self.session.scalars(select(RepoAiMaster.ai_master_id)).all():
            counts[master_id] = counts.get(master_id, 0) + 1
        return counts

    def _card_payload(
        self,
        *,
        ai_master_id: str | None,
        name: str,
        repos: list[dict[str, Any]],
    ) -> dict[str, Any]:
        counts = {"none": 0, "three": 0, "five": 0, "no_data": 0}
        required_rates: list[float] = []
        effective = sum(row["effective_lines"] for row in repos)
        attributed = sum(
            row["effective_lines"] * row["attribution_rate_80"]
            for row in repos
            if row["attribution_rate_80"] is not None
        )
        for row in repos:
            tier = tier_for(row["attribution_rate_80"])
            counts[tier] += 1
            if tier in ("three", "five") and row["attribution_rate_80"] is not None:
                required_rates.append(row["attribution_rate_80"])
        component_ids = {row["component_id"] for row in repos if row.get("component_id")}
        return {
            "ai_master_id": ai_master_id,
            "name": name,
            "total_repos": len(repos),
            "total_components": len(component_ids),
            "tier_counts": counts,
            "lowest_required_rate": min(required_rates) if required_rates else None,
            "workflows_30d": sum(row["workflows_30d"] for row in repos),
            "stalled_30d": sum(row["stalled_30d"] for row in repos),
            "active_users": sum(row["active_users"] for row in repos),
            "effective_lines": effective,
            "attribution_rate_80": attributed / effective if effective else None,
            "pending_attribution": sum(row["pending_attribution"] for row in repos),
            "idle_repos": sum(1 for row in repos if not row["used_aaw"]),
            "repo_keys": sorted(row["repo_key"] for row in repos),
        }
