from __future__ import annotations

import hashlib
import logging
import os
import uuid
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import Settings
from ..errors import ApiError
from ..models import CodeAttribution, DevRun, ObjectUpload, TelemetryMessage

logger = logging.getLogger("aaw_telemetry.objects.diff")


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


class ObjectService:
    def __init__(
        self,
        session: Session,
        settings: Settings,
        attribution_notifier: Callable[[], None] | None = None,
    ):
        self.session = session
        self.settings = settings
        self.attribution_notifier = attribution_notifier or (lambda: None)
        self.root = settings.object_storage_dir.resolve()

    async def upload_diff(
        self, message_id: uuid.UUID, stream: AsyncIterator[bytes], *, workflow_kind: str = "aaw"
    ) -> ObjectUpload:
        now = datetime.now(UTC)
        message = self.session.get(TelemetryMessage, message_id)
        if message is None:
            raise ApiError(404, "MESSAGE_NOT_FOUND", "Step message does not exist")
        if message.workflow_kind != workflow_kind:
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
                self.attribution_notifier()
                return existing
            statistics = self._diff_statistics(temporary.read_bytes())
            try:
                os.replace(temporary, target)
            except PermissionError:
                if (
                    not target.is_file()
                    or hashlib.sha256(target.read_bytes()).hexdigest()
                    != message.file_sha256
                ):
                    raise
                temporary.unlink(missing_ok=True)
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
        dev_run.code_statistics = statistics
        dev_run.patch_object_key = upload.object_key
        dev_run.status = "completed"
        dev_run.server_updated_at = now
        self._mark_attribution_pending(dev_run, now)
        try:
            self.session.commit()
        except IntegrityError:
            self.session.rollback()
            concurrent_upload = self.session.scalar(
                select(ObjectUpload).where(ObjectUpload.owner_id == message_id)
            )
            if (
                concurrent_upload is None
                or concurrent_upload.status != "confirmed"
                or concurrent_upload.sha256 != message.file_sha256
            ):
                raise
            logger.info(
                "Concurrent upload was already confirmed; reusing the persisted result",
                extra={
                    "event": "objects.concurrent_upload_reused",
                    "upload_id": str(concurrent_upload.id),
                    "owner_id": str(concurrent_upload.owner_id),
                },
            )
            return concurrent_upload
        self.attribution_notifier()
        logger.info(
            "Dev Patch 上传并校验成功，开发步骤已进入归因处理",
            extra={
                "event": "objects.upload_confirmed",
                "upload_id": str(upload.id),
                "owner_id": str(upload.owner_id),
                "file_name": message.file_name,
                "bytes_received": received,
            },
        )
        return upload

    def _mark_attribution_pending(self, dev_run: DevRun, now: datetime) -> None:
        attribution = self.session.get(CodeAttribution, dev_run.id)
        values = self._pending_attribution_values(dev_run, now)
        if attribution is None:
            self.session.add(CodeAttribution(dev_run_id=dev_run.id, **values))
            return
        for field, value in values.items():
            setattr(attribution, field, value)

    @staticmethod
    def _pending_attribution_values(dev_run: DevRun, now: datetime) -> dict:
        total = int((dev_run.code_statistics or {}).get("total_effective_lines", 0))
        values = {
            "dev_effective_lines": total,
            "attributed_lines_80": 0,
            "attributed_lines_90": 0,
            "mr_commit_lines": None,
            "confidence": 0.0,
            "quality_flags": ["attribution_pending"],
            "result_status": "finalized_no_match",
            "attribution_status": "pending",
            "retry_count": 0,
            "next_retry_at": None,
            "matched_mr_iid": None,
            "matched_mr_url": None,
            "mr_diff_version": None,
            "mr_source_branch": None,
            "target_branch": None,
            "merge_commit_sha": None,
            "mr_merged_at": None,
            "algorithm_version": "pending",
            "diff_rule_version": "pending",
            "matched_at": now,
            "server_updated_at": now,
        }
        return values

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
