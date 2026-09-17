"""管理台总览：三个并列视角（SE / AI Master / ALL）的组件与仓库健康聚合。

两条责任线的责任单位不同，因此是两个交叉的视角：
- SE 视角按**组件**聚合（SE 是组件上的字段，一个组件一个 SE），可下钻到组件与人员；
- AI Master 视角按**仓库**聚合（一线辅助按仓覆盖，一个仓库一位 AI Master）；
- ALL 视角是组件级明细平铺。

组件级 AI Master 归属由仓库归属推导：组件下所有仓库同属一人时算该人的组件，
混合归属时组件级显示为空（前端展示"多人分管"）。
"""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import ProjectRegistry
from ..models import (
    AiMaster,
    Component,
    ComponentRepo,
    RepoAiMaster,
    TelemetryMessage,
    WorkflowRun,
)
from .queries import Filters, QueryService, make_filters

STALLED_HOURS = 24
WINDOW_DAYS = 30
UNASSIGNED_OWNER = "未认领"
UNSPECIFIED_SE = "未指定"


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


class OwnerOverviewService:
    """组件（SE）与仓库（AI Master）两条责任线的健康聚合。"""

    def __init__(self, session: Session, projects: ProjectRegistry):
        self.session = session
        self.projects = projects
        self._query = QueryService(session, projects)

    @staticmethod
    def window() -> Filters:
        return make_filters(None, None, [], [], [], [], [], "aaw")

    # ------------------------------------------------------------------
    # 仓库级指标（AI Master 视角与责任人 scope 的基本单位）

    def repo_metrics(self, window: Filters) -> list[dict]:
        """仓库级使用情况。

        产出/采纳/待归因来自统计口径（projects_summary，含"未纳入统计"标记）；
        工作流数、停滞数、活跃人数来自工作流表。
        """
        summary = self._query.projects_summary(window, 1, 2000, statistics_only=False)
        metrics = {row["project_key"]: row for row in summary.get("items", [])}

        stalled_before = datetime.now(UTC) - timedelta(hours=STALLED_HOURS)
        wf_rows = self.session.execute(
            select(
                WorkflowRun.project_key,
                WorkflowRun.status,
                WorkflowRun.last_activity_at,
                WorkflowRun.git_user_email,
            ).where(
                WorkflowRun.workflow_kind == window.workflow_kind,
                WorkflowRun.deleted.is_(False),
                WorkflowRun.last_activity_at >= window.start,
                WorkflowRun.last_activity_at < window.end_exclusive,
            )
        ).all()
        flow: dict[str, dict] = defaultdict(
            lambda: {"workflows": 0, "stalled": 0, "users": set()}
        )
        for project_key, status, last_activity, user_email in wf_rows:
            bucket = flow[project_key]
            bucket["workflows"] += 1
            bucket["stalled"] += int(
                status == "in_progress" and _aware(last_activity) < stalled_before
            )
            bucket["users"].add(user_email)

        # used_aaw 看的是全历史（与组件口径一致）：只要该仓库上报过 AAW 就算用过
        used_repos = set(
            self.session.scalars(
                select(TelemetryMessage.repository)
                .where(TelemetryMessage.workflow_kind == window.workflow_kind)
                .distinct()
            ).all()
        )
        repo_component = {
            row.repo_key: row.component_id
            for row in self.session.scalars(select(ComponentRepo)).all()
        }
        component_rows = {
            row.id: row for row in self.session.scalars(select(Component)).all()
        }
        master_names = {
            master.id: master.name for master in self.session.scalars(select(AiMaster)).all()
        }
        master_by_repo = {
            row.repo_key: row.ai_master_id
            for row in self.session.scalars(select(RepoAiMaster)).all()
        }

        # 责任范围要包含"窗口内没有任何活动"的仓库（闲置仓库正是要暴露的问题），
        # 所以遍历集合 = 已登记仓库 ∪ 有统计的仓库 ∪ 有工作流的仓库
        rows: list[dict] = []
        for repo_key in sorted(set(repo_component) | set(metrics) | set(flow)):
            metric = metrics.get(repo_key, {})
            counts = flow.get(repo_key) or {"workflows": 0, "stalled": 0, "users": set()}
            component_id = repo_component.get(repo_key)
            component = component_rows.get(component_id) if component_id else None
            master_id = master_by_repo.get(repo_key)
            if master_id not in master_names:  # 悬空归属按未认领处理
                master_id = None
            rows.append(
                {
                    "repo_key": repo_key,
                    "component_id": component_id,
                    "component_name": component.name if component else None,
                    "se": component.se if component else None,
                    "ai_master": master_names.get(master_id) if master_id else None,
                    "included": bool(metric.get("included_in_statistics")),
                    "used_aaw": repo_key in used_repos,
                    "workflows_30d": counts["workflows"],
                    "stalled_30d": counts["stalled"],
                    "active_users": len(counts["users"]),
                    "effective_lines": metric.get("dev_effective_lines") or 0,
                    "attribution_rate_80": metric.get("attribution_rate_80"),
                    "pending_attribution": metric.get("pending_attribution_dev_runs") or 0,
                }
            )
        rows.sort(
            key=lambda row: (-(row["pending_attribution"] + row["stalled_30d"]), row["repo_key"])
        )
        return rows

    # ------------------------------------------------------------------
    # 组件级指标（SE 视角与 ALL 视角的基本单位）

    def _components(self, repos: list[dict]) -> list[dict]:
        by_component: dict[str, list[dict]] = defaultdict(list)
        for row in repos:
            if row["component_id"]:
                by_component[row["component_id"]].append(row)

        components: list[dict] = []
        for comp in self.session.scalars(
            select(Component).order_by(Component.position, Component.name)
        ).all():
            children = by_component.get(comp.id, [])
            effective = sum(row["effective_lines"] for row in children)
            attributed = sum(
                row["effective_lines"] * row["attribution_rate_80"]
                for row in children
                if row["attribution_rate_80"] is not None
            )
            masters = sorted({row["ai_master"] for row in children if row["ai_master"]})
            components.append(
                {
                    "component_id": comp.id,
                    "name": comp.name,
                    "se": comp.se,
                    # 组件级归属由仓库推导：唯一时给名字，混合/未认领给 None
                    "ai_master": masters[0] if len(masters) == 1 else None,
                    "ai_masters": masters,
                    "split_ownership": len(masters) > 1,
                    "repos": len(children),
                    "repo_keys": [row["repo_key"] for row in children],
                    "included": bool(children),
                    "used_aaw": any(row["used_aaw"] for row in children),
                    "workflows_30d": sum(row["workflows_30d"] for row in children),
                    "stalled_30d": sum(row["stalled_30d"] for row in children),
                    "active_users": sum(row["active_users"] for row in children),
                    "effective_lines": effective,
                    "attribution_rate_80": attributed / effective if effective else None,
                    "pending_attribution": sum(
                        row["pending_attribution"] for row in children
                    ),
                }
            )
        components.sort(
            key=lambda c: (-(c["pending_attribution"] + c["stalled_30d"]), c["name"])
        )
        return components

    # ------------------------------------------------------------------
    # 视角聚合

    def overview(self) -> dict:
        window = self.window()
        repos = self.repo_metrics(window)
        components = self._components(repos)
        return {
            "window_days": WINDOW_DAYS,
            "stalled_hours": STALLED_HOURS,
            "components": components,
            "repos": repos,
            "by_se": self._group_components(
                components,
                key=lambda c: c["se"] or UNSPECIFIED_SE,
                is_default=lambda c: c["se"] is None,
                extra=lambda comps: {
                    # 该 SE 责任田里覆盖到的 AI Master（可能多位，因为按仓划分）
                    "master_list": sorted(
                        {name for c in comps for name in c["ai_masters"]}
                    ),
                },
            ),
            "by_master": self._group_repos(
                repos,
                key=lambda r: r["ai_master"] or UNASSIGNED_OWNER,
                is_default=lambda r: r["ai_master"] is None,
                extra=lambda rows: {
                    "se_list": sorted({row["se"] for row in rows if row["se"]}),
                    "component_list": sorted(
                        {row["component_name"] for row in rows if row["component_name"]}
                    ),
                },
            ),
        }

    @staticmethod
    def _aggregate(items: list[dict]) -> dict:
        effective = sum(item["effective_lines"] for item in items)
        attributed = sum(
            item["effective_lines"] * item["attribution_rate_80"]
            for item in items
            if item["attribution_rate_80"] is not None
        )
        return {
            "workflows_30d": sum(item["workflows_30d"] for item in items),
            "stalled_30d": sum(item["stalled_30d"] for item in items),
            "active_users": sum(item["active_users"] for item in items),
            "effective_lines": effective,
            "attribution_rate_80": attributed / effective if effective else None,
            "pending_attribution": sum(item["pending_attribution"] for item in items),
            "used_repos": sum(1 for item in items if item["used_aaw"]),
            "not_included": sum(1 for item in items if not item["included"]),
        }

    @classmethod
    def _group_components(cls, components, *, key, is_default, extra) -> list[dict]:
        """按 SE 分组件聚合；默认组（未指定）排在最后，其余按问题量降序。"""
        buckets: dict[str, list[dict]] = defaultdict(list)
        for comp in components:
            buckets[key(comp)].append(comp)
        rows = []
        for name, comps in buckets.items():
            rows.append(
                {
                    "name": name,
                    "is_default": all(is_default(c) for c in comps),
                    "components": len(comps),
                    "used_components": sum(1 for c in comps if c["used_aaw"]),
                    "components_not_included": sum(1 for c in comps if not c["included"]),
                    "repos": sum(c["repos"] for c in comps),
                    "repo_keys": sorted({r for c in comps for r in c["repo_keys"]}),
                    **cls._aggregate(comps),
                    **extra(comps),
                }
            )
        rows.sort(
            key=lambda row: (
                row["is_default"],
                -(row["pending_attribution"] + row["stalled_30d"]),
                row["name"],
            )
        )
        return rows

    @classmethod
    def _group_repos(cls, repos, *, key, is_default, extra) -> list[dict]:
        """按 AI Master 分仓库聚合；默认组（未认领）排在最后。"""
        buckets: dict[str, list[dict]] = defaultdict(list)
        for row in repos:
            buckets[key(row)].append(row)
        rows = []
        for name, group in buckets.items():
            rows.append(
                {
                    "name": name,
                    "is_default": all(is_default(r) for r in group),
                    "repos": len(group),
                    "components": len({r["component_id"] for r in group if r["component_id"]}),
                    "idle_repos": sum(1 for r in group if not r["used_aaw"]),
                    "repo_keys": sorted(r["repo_key"] for r in group),
                    **cls._aggregate(group),
                    **extra(group),
                }
            )
        rows.sort(
            key=lambda row: (
                row["is_default"],
                -(row["pending_attribution"] + row["stalled_30d"]),
                row["name"],
            )
        )
        return rows
