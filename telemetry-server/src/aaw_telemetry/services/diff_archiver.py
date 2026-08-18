"""Archive expired Dev Patch diff files instead of deleting them.

Diffs stay in ``data/objects/step-diffs/`` while active. After the retention
window they are moved (never deleted) into ``data/objects/archive/step-diffs/``
bucketed by month. Archiving only happens once attribution has reached a
terminal state, so the attribution scheduler can never observe a missing diff.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from contextlib import suppress
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from ..config import Settings
from ..models import CodeAttribution, ObjectUpload

logger = logging.getLogger("aaw_telemetry.diff_archive")

# Attribution states that will never read the diff again.
_TERMINAL_ATTRIBUTION_STATES = (
    "finalized_match",
    "finalized_no_match",
    "failed",
)


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


class DiffArchiver:
    def __init__(self, factory: sessionmaker[Session], settings: Settings):
        self._factory = factory
        self._settings = settings
        self._stop = asyncio.Event()

    def stop(self) -> None:
        self._stop.set()

    async def run(self) -> None:
        while not self._stop.is_set():
            await asyncio.to_thread(self.archive_once)
            with suppress(TimeoutError):
                await asyncio.wait_for(
                    self._stop.wait(),
                    timeout=self._settings.diff_archive_interval_seconds,
                )

    def archive_once(self) -> int:
        now = datetime.now(UTC)
        with self._factory() as session:
            candidates = session.scalars(
                select(ObjectUpload)
                .join(CodeAttribution, CodeAttribution.dev_run_id == ObjectUpload.owner_id)
                .where(
                    ObjectUpload.status == "confirmed",
                    ObjectUpload.expires_at <= now,
                    CodeAttribution.attribution_status.in_(_TERMINAL_ATTRIBUTION_STATES),
                )
            ).all()

            archived = 0
            for upload in candidates:
                if self._archive_one(session, upload, now):
                    archived += 1
            if candidates:
                session.commit()
            return archived

    def _archive_one(self, session: Session, upload: ObjectUpload, now: datetime) -> bool:
        root = self._settings.object_storage_dir.resolve()
        source = (root / upload.object_key).resolve()
        if not source.is_relative_to(root):
            logger.error(
                "diff 归档路径越界，已跳过",
                extra={"event": "diff_archive.invalid_key", "object_key": upload.object_key},
            )
            return False

        month = _utc(upload.expires_at).strftime("%Y-%m")
        archive_key = f"archive/step-diffs/{month}/{upload.owner_id}.diff"
        destination = (root / archive_key).resolve()

        # Already archived on a previous pass that failed before the DB commit.
        if destination.is_file():
            if hashlib.sha256(destination.read_bytes()).hexdigest() != upload.sha256:
                logger.error(
                    "diff 归档目标与记录摘要不一致，已保留源文件",
                    extra={
                        "event": "diff_archive.hash_conflict",
                        "object_key": upload.object_key,
                        "archive_key": archive_key,
                    },
                )
                return False
            source.unlink(missing_ok=True)
        elif source.is_file():
            if hashlib.sha256(source.read_bytes()).hexdigest() != upload.sha256:
                logger.error(
                    "diff 归档源文件与记录摘要不一致，已跳过",
                    extra={
                        "event": "diff_archive.hash_mismatch",
                        "object_key": upload.object_key,
                    },
                )
                return False
            destination.parent.mkdir(parents=True, exist_ok=True)
            try:
                source.replace(destination)
            except FileNotFoundError:
                # Lost the race with a concurrent archiver; treat as already archived.
                if not destination.is_file():
                    raise
        else:
            logger.error(
                "diff 归档时源文件丢失",
                extra={"event": "diff_archive.missing", "object_key": upload.object_key},
            )
            return False

        upload.status = "archived"
        upload.archive_key = archive_key
        upload.archived_at = now
        upload.server_updated_at = now
        return True
