"""责任人视角的人员层：把"谁在用、什么版本、产出多少、采纳如何"落到人。

面向 SE：他管的是组件（及其仓库），需要知道这批仓库上都有谁在活动、谁还停在旧
版本、谁的产出没有闭环。数据来源分两半，语义不同，不能互相替代：
- 产出与采纳：统计口径（按人聚合，受窗口与统计范围约束）；
- 版本与活跃：上报口径（窗口内最近一次上报的 aaw_version 与上报时间）。

人员名单是"在这批仓库上报过的人"，不是组织架构：系统里没有人员编制关系。
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import ProjectRegistry, Settings
from ..models import TelemetryMessage
from .queries import Filters, QueryService, make_filters
from .version_ops import VersionOpsService

DEFAULT_WINDOW_DAYS = 30


class PeopleService:
    def __init__(self, session: Session, projects: ProjectRegistry, settings: Settings):
        self.session = session
        self.projects = projects
        self.settings = settings
        self._query = QueryService(session, projects)
        self._versions = VersionOpsService(session, settings)

    def summary(
        self,
        repositories: list[str] | None = None,
        *,
        window_days: int = DEFAULT_WINDOW_DAYS,
    ) -> dict:
        """按人聚合产出/采纳/版本，可选限定到一组仓库（责任人 scope）。"""
        window = make_filters(
            None, None, list(repositories or []), [], [], [], [], "aaw"
        )
        stats = {
            row["user_email"]: row
            for row in self._query.users_summary(window, 1, 2000).get("items", [])
        }
        roster = self._versions.roster(window_days, repositories=repositories)
        # users 覆盖窗口内所有人（含已在最新版的人），items/non_release 只是切片
        versions = {row["user_email"]: row for row in roster["users"]}

        repos_by_user, activity = self._activity_by_user(window, window_days)
        items = []
        for email in sorted(set(stats) | set(versions) | set(activity)):
            stat = stats.get(email, {})
            version_row = versions.get(email, {})
            meta = activity.get(email, {})
            items.append(
                {
                    "user_email": email,
                    "user_name": meta.get("user_name") or stat.get("user_name"),
                    "repo_keys": sorted(repos_by_user.get(email, set())),
                    "last_report_at": meta.get("last_report_at"),
                    "report_count": meta.get("report_count", 0),
                    "version": version_row.get("version") or meta.get("version"),
                    "behind": version_row.get("behind"),
                    "on_latest": bool(version_row.get("on_latest")),
                    "non_release_version": bool(version_row.get("non_release")),
                    "workflow_runs": stat.get("workflow_runs", 0),
                    "dev_runs": stat.get("dev_runs", 0),
                    "effective_lines": stat.get("dev_effective_lines", 0),
                    "attribution_rate_80": stat.get("attribution_rate_80"),
                    "pending_attribution": stat.get("pending_attribution_dev_runs", 0),
                }
            )
        # 排序：先按活跃度（窗口内是否上报、最近时间），再按产出，便于"谁没动"一眼看出
        items.sort(
            key=lambda row: (
                row["last_report_at"] is None,
                -(row["behind"] or 0),
                row["user_name"] or "",
            )
        )
        return {
            "window_days": window_days,
            "repositories": sorted(repositories or []),
            "total": len(items),
            "items": items,
        }

    def _activity_by_user(
        self, window: Filters, window_days: int
    ) -> tuple[dict[str, set[str]], dict[str, dict]]:
        """窗口内上报过的人 → 其仓库集合与最近一次上报信息。"""
        cutoff = datetime.now(UTC) - timedelta(days=window_days)
        statement = select(
            TelemetryMessage.user_email,
            TelemetryMessage.user_name,
            TelemetryMessage.repository,
            TelemetryMessage.aaw_version,
            TelemetryMessage.client_updated_at,
        ).where(
            TelemetryMessage.workflow_kind == window.workflow_kind,
            TelemetryMessage.client_updated_at >= cutoff,
        )
        if window.repositories:
            statement = statement.where(
                TelemetryMessage.repository.in_(window.repositories)
            )
        rows = self.session.execute(statement).all()
        repos_by_user: dict[str, set[str]] = {}
        activity: dict[str, dict] = {}
        for email, name, repository, version, updated_at in rows:
            repos_by_user.setdefault(email, set()).add(repository)
            entry = activity.setdefault(
                email, {"user_name": name, "report_count": 0, "version": version}
            )
            entry["user_name"] = name
            entry["version"] = version
            entry["report_count"] += 1
            last = entry.get("last_report_at")
            if last is None or updated_at > last:
                entry["last_report_at"] = updated_at
        return repos_by_user, activity
