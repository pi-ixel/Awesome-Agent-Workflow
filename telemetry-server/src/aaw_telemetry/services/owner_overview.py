"""管理台总览：三个并列视角（SE / AI Master / ALL）的组件健康聚合。

总览本身即责任人视角：选定某个视角后以平铺表格占据整个视图，不做总分展开。
- SE 视角：按 SE 分组聚合；
- AI Master 视角：按 AI Master 分组聚合（未认领单列）；
- ALL 视角：全部组件平铺（组件级明细）。
"""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..config import ProjectRegistry
from ..models import (
    AiMaster,
    CodeAttribution,
    Component,
    ComponentAiMaster,
    ComponentRepo,
    DevRun,
    TelemetryMessage,
    WorkflowRun,
)
from .queries import QueryService, make_filters

STALLED_HOURS = 24
WINDOW_DAYS = 30
UNASSIGNED_OWNER = "未认领"
UNSPECIFIED_SE = "未指定"


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


class OwnerOverviewService:
    """组件健康的三视角聚合。"""

    def __init__(self, session: Session, projects: ProjectRegistry):
        self.session = session
        self.projects = projects

    def overview(self) -> dict:
        window = make_filters(None, None, [], [], [], [], [], "aaw")
        now = datetime.now(UTC)
        stalled_before = now - timedelta(hours=STALLED_HOURS)

        masters = {m.id: m.name for m in self.session.scalars(select(AiMaster)).all()}
        assignments = {
            row.component_id: row.ai_master_id
            for row in self.session.scalars(select(ComponentAiMaster)).all()
        }

        # 近 30 天工作流状态（按仓库聚合）
        wf_rows = self.session.execute(
            select(
                WorkflowRun.project_key,
                WorkflowRun.status,
                WorkflowRun.last_activity_at,
            ).where(
                WorkflowRun.workflow_kind == "aaw",
                WorkflowRun.deleted.is_(False),
                WorkflowRun.last_activity_at >= window.start,
                WorkflowRun.last_activity_at < window.end_exclusive,
            )
        ).all()
        wf_by_repo: dict[str, dict[str, int]] = defaultdict(
            lambda: {"workflows": 0, "stalled": 0}
        )
        for project_key, status, last_activity in wf_rows:
            bucket = wf_by_repo[project_key]
            bucket["workflows"] += 1
            bucket["stalled"] += (
                status == "in_progress" and _aware(last_activity) < stalled_before
            )

        # 未完成归因闭环的产出（按仓库）：无归因记录、已删除归因，或仍在非终态/失败
        pending_rows = self.session.execute(
            select(TelemetryMessage.repository, func.count())
            .select_from(TelemetryMessage)
            .join(DevRun, DevRun.id == TelemetryMessage.id)
            .join(WorkflowRun, DevRun.workflow_run_id == WorkflowRun.id)
            .outerjoin(CodeAttribution, CodeAttribution.dev_run_id == DevRun.id)
            .where(
                TelemetryMessage.workflow_kind == "aaw",
                DevRun.admin_excluded.is_(False),
                WorkflowRun.deleted.is_(False),
                or_(
                    CodeAttribution.dev_run_id.is_(None),
                    CodeAttribution.deleted.is_(True),
                    CodeAttribution.attribution_status.in_(
                        ("pending", "running", "retry_pending", "failed")
                    ),
                ),
            )
            .group_by(TelemetryMessage.repository)
        ).all()
        pending_by_repo = {repo: count for repo, count in pending_rows}

        # 组件使用统计（近 30 天）：生成行数 / 采纳率
        summary = QueryService(self.session, self.projects).components_summary(window)
        usage = {item["component_id"]: item for item in summary.get("items", [])}

        repos_by_component: dict[str, list[str]] = defaultdict(list)
        for repo in self.session.scalars(select(ComponentRepo)).all():
            repos_by_component[repo.component_id].append(repo.repo_key)

        components: list[dict] = []
        for comp in self.session.scalars(
            select(Component).order_by(Component.position, Component.name)
        ).all():
            usage_item = usage.get(comp.id, {})
            repo_keys = repos_by_component.get(comp.id, [])
            master_id = assignments.get(comp.id)
            if master_id not in masters:  # 悬空归属按未认领处理
                master_id = None
            wf = {
                key: sum(wf_by_repo[repo][key] for repo in repo_keys)
                for key in ("workflows", "stalled")
            }
            components.append(
                {
                    "component_id": comp.id,
                    "name": comp.name,
                    "se": comp.se,
                    "ai_master": masters.get(master_id) if master_id else None,
                    "repos": len(repo_keys),
                    "repo_keys": repo_keys,
                    "included": bool(repo_keys),
                    "used_aaw": bool(usage_item.get("used_aaw")),
                    "workflows_30d": wf["workflows"],
                    "stalled_30d": wf["stalled"],
                    "effective_lines": usage_item.get("effective_lines") or 0,
                    "attribution_rate_80": usage_item.get("attribution_rate_80"),
                    "pending_attribution": sum(
                        pending_by_repo.get(repo, 0) for repo in repo_keys
                    ),
                }
            )
        components.sort(
            key=lambda c: (-(c["pending_attribution"] + c["stalled_30d"]), c["name"])
        )

        return {
            "window_days": WINDOW_DAYS,
            "stalled_hours": STALLED_HOURS,
            "components": components,
            "by_master": self._group_rows(
                components,
                key=lambda c: c["ai_master"] or UNASSIGNED_OWNER,
                is_default=lambda c: c["ai_master"] is None,
                extra=lambda comps: {
                    "se_list": sorted({c["se"] for c in comps if c["se"]}),
                },
            ),
            "by_se": self._group_rows(
                components,
                key=lambda c: c["se"] or UNSPECIFIED_SE,
                is_default=lambda c: c["se"] is None,
                extra=lambda comps: {
                    "master_list": sorted(
                        {c["ai_master"] for c in comps if c["ai_master"]}
                    ),
                },
            ),
        }

    @staticmethod
    def _group_rows(components, *, key, is_default, extra) -> list[dict]:
        """按 key 分组聚合；默认组（未认领/未指定）排在最后，其余按问题量降序。"""
        buckets: dict[str, list[dict]] = defaultdict(list)
        for comp in components:
            buckets[key(comp)].append(comp)
        rows = []
        for name, comps in buckets.items():
            effective = sum(c["effective_lines"] for c in comps)
            attributed = sum(
                c["effective_lines"] * c["attribution_rate_80"]
                for c in comps
                if c["attribution_rate_80"] is not None
            )
            rows.append(
                {
                    "name": name,
                    "is_default": all(is_default(c) for c in comps),
                    "components": len(comps),
                    "used_components": sum(c["used_aaw"] for c in comps),
                    "components_not_included": sum(not c["included"] for c in comps),
                    "workflows_30d": sum(c["workflows_30d"] for c in comps),
                    "effective_lines": effective,
                    "attribution_rate_80": attributed / effective if effective else None,
                    "pending_attribution": sum(c["pending_attribution"] for c in comps),
                    "stalled_30d": sum(c["stalled_30d"] for c in comps),
                    # 责任方下钻用：该组名下所有仓库（前端传给工作流/归因的仓库筛选）
                    "repo_keys": sorted({r for c in comps for r in c["repo_keys"]}),
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
