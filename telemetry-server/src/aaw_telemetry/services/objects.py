from __future__ import annotations

import hashlib
import logging
import os
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import ProjectRegistry, Settings
from ..errors import ApiError
from ..models import DevRun, ObjectUpload, TelemetryMessage
from .ingestion import upsert_mock_attribution

logger = logging.getLogger("aaw_telemetry.audit")


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


class ObjectService:
    def __init__(
        self,
        session: Session,
        settings: Settings,
        projects: ProjectRegistry,
    ):
        self.session = session
        self.settings = settings
        self.projects = projects
        self.root = settings.object_storage_dir.resolve()

    async def upload_diff(
        self, message_id: uuid.UUID, stream: AsyncIterator[bytes]
    ) -> ObjectUpload:
        now = datetime.now(UTC)
        message = self.session.get(TelemetryMessage, message_id)
        if message is None:
            raise ApiError(404, "MESSAGE_NOT_FOUND", "Step message does not exist")
        dev_run = self.session.get(DevRun, message_id)
        if dev_run is None or message.file_sha256 is None:
            raise ApiError(
                409,
                "FILE_CONFLICT",
                "Step message is not a completed task-dev message with a Diff",
            )
        existing = self.session.scalar(
            select(ObjectUpload).where(ObjectUpload.owner_id == message_id)
        )
        is_confirmed_retry = existing is not None and existing.status == "confirmed"
        if not is_confirmed_retry and (
            dev_run.status != "waiting_objects" or dev_run.window_ends_at is None
        ):
            raise ApiError(
                409,
                "FILE_CONFLICT",
                "Dev run is not waiting for a Diff upload",
            )
        if (
            not is_confirmed_retry
            and dev_run.window_ends_at is not None
            and now >= _utc(dev_run.window_ends_at)
        ):
            raise ApiError(409, "UPLOAD_WINDOW_EXPIRED", "Dev Patch upload window has expired")

        object_key = existing.object_key if existing else f"step-diffs/{message_id}.diff"
        target = self._object_path(object_key)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix + f".{uuid.uuid4().hex}.part")
        digest = hashlib.sha256()
        received = 0
        try:
            with temporary.open("wb") as output:
                async for chunk in stream:
                    if not chunk:
                        continue
                    received += len(chunk)
                    if received > self.settings.max_patch_bytes:
                        raise ApiError(
                            413,
                            "PAYLOAD_TOO_LARGE",
                            "Diff exceeds configured limit",
                        )
                    digest.update(chunk)
                    output.write(chunk)
            if received == 0:
                raise ApiError(400, "INVALID_REQUEST", "Diff must not be empty")
            if digest.hexdigest() != message.file_sha256:
                raise ApiError(
                    422,
                    "FILE_HASH_MISMATCH",
                    "uploaded Diff SHA-256 does not match the Step declaration",
                )
            if is_confirmed_retry and target.is_file():
                temporary.unlink(missing_ok=True)
                return existing
            os.replace(temporary, target)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise

        upload = existing or ObjectUpload(
            id=uuid.uuid4(),
            object_type="step_diff",
            owner_id=message_id,
            sha256=message.file_sha256,
            compressed_size_bytes=received,
            compression="none",
            status="confirmed",
            object_key=object_key,
            expires_at=_utc(dev_run.window_ends_at),
            uploaded_at=now,
            confirmed_at=now,
            server_updated_at=now,
        )
        if existing is None:
            self.session.add(upload)
        else:
            upload.sha256 = message.file_sha256
            upload.compressed_size_bytes = received
            upload.compression = "none"
            upload.status = "confirmed"
            upload.object_key = object_key
            upload.uploaded_at = now
            upload.confirmed_at = now
        upload.server_updated_at = now
        statistics = self._diff_statistics(target.read_bytes())
        dev_run.code_statistics = statistics
        dev_run.patch_object_key = upload.object_key
        dev_run.status = "completed"
        dev_run.server_updated_at = now
        upsert_mock_attribution(self.session, self.projects, dev_run, now)
        self.session.commit()
        logger.info(
            "objects.upload_confirmed",
            extra={
                "upload_id": str(upload.id),
                "owner_id": str(upload.owner_id),
                "bytes_received": received,
            },
        )
        return upload

    @staticmethod
    def _diff_statistics(content: bytes) -> dict:
        """Count effective added lines in a unified Diff for MVP data-path verification."""
        text = content.decode("utf-8", errors="replace")
        effective_lines = sum(
            1
            for line in text.splitlines()
            if line.startswith("+") and not line.startswith("+++") and line[1:].strip()
        )
        files_changed = sum(1 for line in text.splitlines() if line.startswith("+++ b/"))
        return {
            "total_effective_lines": effective_lines,
            "files_changed": files_changed,
            "categories": {
                "production_source": {
                    "effective_lines": effective_lines,
                    "files_changed": files_changed,
                },
                "test_source": {"effective_lines": 0, "files_changed": 0},
                "sql": {"effective_lines": 0, "files_changed": 0},
                "shell": {"effective_lines": 0, "files_changed": 0},
                "configuration": {"effective_lines": 0, "files_changed": 0},
                "other_script": {"effective_lines": 0, "files_changed": 0},
            },
            "quality_flags": ["mock_diff_classification"],
        }

    def _object_path(self, object_key: str) -> Path:
        path = (self.root / object_key).resolve()
        if not path.is_relative_to(self.root):
            raise ApiError(500, "INTERNAL_ERROR", "invalid object storage path")
        return path
