from __future__ import annotations

import logging
import re
from bisect import bisect_right
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import Settings
from ..models import TelemetryMessage

logger = logging.getLogger("aaw_telemetry.admin.versions")

RELEASE_FILE_PATTERN = re.compile(
    r"^aaw-skills-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\.zip$"
)
SEMANTIC_VERSION_PATTERN = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")

DEFAULT_WINDOW_DAYS = 30


def is_semantic_version(version: str) -> bool:
    return SEMANTIC_VERSION_PATTERN.fullmatch(version) is not None


def _version_key(version: str) -> tuple[int, int, int]:
    return tuple(int(part) for part in version.split("."))


def find_latest_release(release_dir: Path | None) -> tuple[str, Path] | None:
    if release_dir is None or not release_dir.is_dir():
        return None
    latest: tuple[tuple[int, int, int], str, Path] | None = None
    for path in release_dir.iterdir():
        if not path.is_file():
            continue
        match = RELEASE_FILE_PATTERN.fullmatch(path.name)
        if match is None:
            continue
        version = match.group(1)
        key = _version_key(version)
        if latest is None or key > latest[0]:
            latest = (key, version, path)
    if latest is None:
        return None
    return latest[1], latest[2]


class VersionOpsService:
    """Answers "who is still on an old CLI version" for the version ops view.

    Caliber (per the functional design §3.3): a user's current version is the
    version of their most recent aaw-kind telemetry message; identities are
    user emails; non-release version strings (smoke/联调 tags) are counted in
    a separate bucket instead of polluting the old-version roster.
    """

    def __init__(self, session: Session, settings: Settings):
        self.session = session
        self.settings = settings

    # ------------------------------------------------------------------
    # baselines

    def _release_baseline(self) -> tuple[str | None, list[str]]:
        """Return (latest version, ascending ladder of known release versions)."""
        found = find_latest_release(self.settings.release_dir)
        release_version = found[0] if found else None
        seen = [
            row[0]
            for row in self.session.execute(
                select(TelemetryMessage.aaw_version)
                .where(TelemetryMessage.workflow_kind == "aaw")
                .distinct()
            ).all()
        ]
        ladder = sorted(
            {_version_key(v) for v in seen if is_semantic_version(v)}
        )
        if release_version is not None:
            key = _version_key(release_version)
            if key not in ladder:
                ladder = sorted({*ladder, key})
        elif ladder:
            release_version = ".".join(str(part) for part in ladder[-1])
        return release_version, ladder

    def _window_rows(self, window_days: int, repositories: list[str] | None = None):
        cutoff = datetime.now(UTC) - timedelta(days=window_days)
        statement = (
            select(
                TelemetryMessage.user_email,
                TelemetryMessage.user_name,
                TelemetryMessage.aaw_version,
                TelemetryMessage.client_updated_at,
            )
            .where(
                TelemetryMessage.workflow_kind == "aaw",
                TelemetryMessage.client_updated_at >= cutoff,
            )
            .order_by(TelemetryMessage.client_updated_at.asc())
        )
        if repositories:
            statement = statement.where(
                TelemetryMessage.repository.in_(list(repositories))
            )
        return self.session.execute(statement).all()

    # ------------------------------------------------------------------
    # roster (C1.2)

    def roster(
        self, window_days: int = DEFAULT_WINDOW_DAYS, repositories: list[str] | None = None
    ) -> dict:
        """窗口内的版本名单；repositories 非空时只统计这批仓库上的人（责任人 scope）。"""
        latest, ladder = self._release_baseline()
        latest_key = _version_key(latest) if latest else None
        per_user: dict[str, dict] = {}
        for email, name, version, updated_at in self._window_rows(
            window_days, repositories
        ):
            entry = per_user.setdefault(
                email,
                {
                    "user_name": name,
                    "version": version,
                    "last_report_at": updated_at,
                    "report_count": 0,
                    "versions_used": set(),
                },
            )
            # Rows arrive time-ordered, so the final assignment is the latest.
            entry["user_name"] = name
            entry["version"] = version
            entry["last_report_at"] = updated_at
            entry["report_count"] += 1
            entry["versions_used"].add(version)

        # 每人一行（含已在最新版的人），items / non_release 是它的两个切片视图
        users: list[dict] = []
        for email, entry in per_user.items():
            version = entry["version"]
            base = {
                "user_name": entry["user_name"],
                "user_email": email,
                "version": version,
                "last_report_at": _iso(entry["last_report_at"]),
                "report_count": entry["report_count"],
                "versions_used": len(entry["versions_used"]),
            }
            if not is_semantic_version(version):
                users.append({**base, "behind": None, "on_latest": False, "non_release": True})
                continue
            if latest_key is None:
                behind = 0
            else:
                position = _ladder_position(ladder, _version_key(version))
                behind = max(0, _ladder_position(ladder, latest_key) - position)
            users.append(
                {**base, "behind": behind, "on_latest": behind == 0, "non_release": False}
            )

        old_rows = [row for row in users if row["behind"] and row["behind"] > 0]
        non_release = [row for row in users if row["non_release"]]
        # Stable sorts: recency first, then behind-count wins — the people to
        # chase for upgrades float to the top, most recently active first.
        old_rows.sort(key=lambda row: row["last_report_at"], reverse=True)
        old_rows.sort(key=lambda row: row["behind"], reverse=True)
        non_release.sort(key=lambda row: row["last_report_at"], reverse=True)
        return {
            "window_days": window_days,
            "latest_version": latest,
            "release_source": (
                "release_dir" if self._release_dir_has_packages() else "data"
            ),
            "active_users": len(per_user),
            "on_latest": sum(1 for row in users if row["on_latest"]),
            "on_old": len(old_rows),
            "non_release_users": len(non_release),
            "users": sorted(users, key=lambda row: row["user_email"]),
            "items": old_rows,
            "non_release": non_release,
        }

    def _release_dir_has_packages(self) -> bool:
        return find_latest_release(self.settings.release_dir) is not None

    # ------------------------------------------------------------------
    # per-user version timeline (C1.3)

    def timeline(self, user_email: str) -> dict:
        rows = self.session.execute(
            select(
                TelemetryMessage.aaw_version,
                func.min(TelemetryMessage.client_updated_at),
                func.max(TelemetryMessage.client_updated_at),
                func.count(),
            )
            .where(
                TelemetryMessage.workflow_kind == "aaw",
                TelemetryMessage.user_email == user_email,
            )
            .group_by(TelemetryMessage.aaw_version)
        ).all()
        spans = [
            {
                "version": version,
                "first_report_at": _iso(first),
                "last_report_at": _iso(last),
                "report_count": count,
            }
            for version, first, last, count in rows
        ]
        spans.sort(key=lambda span: span["first_report_at"])
        latest, _ = self._release_baseline()
        return {
            "user_email": user_email,
            "latest_version": latest,
            "items": spans,
        }

    # ------------------------------------------------------------------
    # version distribution

    def distribution(self, window_days: int = DEFAULT_WINDOW_DAYS) -> dict:
        latest, _ = self._release_baseline()
        cutoff = datetime.now(UTC) - timedelta(days=window_days)
        rows = self.session.execute(
            select(
                TelemetryMessage.aaw_version,
                func.count(func.distinct(TelemetryMessage.user_email)),
                func.count(),
            )
            .where(
                TelemetryMessage.workflow_kind == "aaw",
                TelemetryMessage.client_updated_at >= cutoff,
            )
            .group_by(TelemetryMessage.aaw_version)
        ).all()
        items = [
            {
                "version": version,
                "users": users,
                "reports": reports,
                "is_release": is_semantic_version(version),
                "is_latest": version == latest,
            }
            for version, users, reports in rows
        ]
        semantic = [item for item in items if item["is_release"]]
        others = [item for item in items if not item["is_release"]]
        semantic.sort(key=lambda item: _version_key(item["version"]), reverse=True)
        others.sort(key=lambda item: item["version"])
        return {
            "window_days": window_days,
            "latest_version": latest,
            "items": semantic + others,
        }


def _ladder_position(ladder: list[tuple[int, int, int]], key: tuple[int, int, int]) -> int:
    return max(0, bisect_right(ladder, key) - 1)


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.isoformat()
