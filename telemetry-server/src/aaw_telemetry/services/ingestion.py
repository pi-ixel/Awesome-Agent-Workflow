from __future__ import annotations

import hashlib
import json
import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import ProjectRegistry, Settings
from ..errors import ApiError
from ..models import (
    CodeAttribution,
    DevRun,
    StepExecution,
    TelemetryMessage,
    WorkflowRun,
)
from ..schemas import TelemetrySyncRequest, TelemetrySyncResponse

logger = logging.getLogger("aaw_telemetry.telemetry.sync")


def _datetime(milliseconds: int) -> datetime:
    return datetime.fromtimestamp(milliseconds / 1000, tz=UTC)


def _milliseconds(value: datetime) -> int:
    aware = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    return int(aware.timestamp() * 1000)


def _payload_hash(payload: TelemetrySyncRequest) -> str:
    canonical = payload.model_dump(mode="json")
    encoded = json.dumps(canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def upsert_mock_attribution(
    session: Session, projects: ProjectRegistry, dev_run: DevRun, now: datetime
) -> None:
    """Persist deterministic MVP attribution after the Diff has been confirmed."""
    total = int(dev_run.code_statistics["total_effective_lines"])
    attributed_80 = min(total, max(1, (total * 80) // 100)) if total else 0
    attributed_90 = min(attributed_80, (total * 60) // 100)
    has_match = attributed_80 > 0
    mock_iid = str((dev_run.id.int % 900_000) + 100_000) if has_match else None
    workflow = session.get(WorkflowRun, dev_run.workflow_run_id)
    project_entry = projects.get(workflow.project_key) if workflow is not None else None
    values = {
        "dev_effective_lines": total,
        "attributed_lines_80": attributed_80,
        "attributed_lines_90": attributed_90,
        "confidence": 0.8 if has_match else 0.0,
        "quality_flags": ["mock_attribution"],
        "result_status": "finalized_match" if has_match else "finalized_no_match",
        "attribution_status": "finalized_match" if has_match else "finalized_no_match",
        "matched_mr_iid": mock_iid,
        "matched_mr_url": (
            f"https://example.invalid/mock/merge_requests/{mock_iid}" if mock_iid else None
        ),
        "mr_diff_version": "mock-1" if has_match else None,
        "mr_source_branch": None,
        "target_branch": project_entry.target_branch if project_entry and has_match else None,
        "merge_commit_sha": None,
        "mr_merged_at": dev_run.completed_at if has_match else None,
        "algorithm_version": "mock-v1",
        "diff_rule_version": "unified-diff-additions-v1",
        "matched_at": now,
        "server_updated_at": now,
    }
    if dev_run.attribution is None:
        dev_run.attribution = CodeAttribution(dev_run_id=dev_run.id, **values)
    else:
        for field, value in values.items():
            setattr(dev_run.attribution, field, value)


class IngestionService:
    def __init__(
        self,
        session: Session,
        projects: ProjectRegistry,
        settings: Settings,
    ):
        self.session = session
        self.projects = projects
        self.settings = settings

    def process(self, payload: TelemetrySyncRequest, request_id: str) -> TelemetrySyncResponse:
        now = datetime.now(UTC)
        payload_hash = _payload_hash(payload)
        existing = self.session.get(TelemetryMessage, payload.message_id)
        if existing is not None:
            if existing.payload_hash != payload_hash:
                logger.warning(
                    "上报消息与已有消息内容冲突，已拒绝写入",
                    extra={
                        "event": "telemetry.message_rejected",
                        "message_id": str(payload.message_id),
                        "workflow_id": str(payload.workflow_id),
                        "sr": payload.sr,
                        "user_email": payload.user_email,
                        "user_name": payload.user_name,
                        "error_code": "MESSAGE_CONFLICT",
                        "retryable": False,
                    },
                )
                raise ApiError(
                    409,
                    "MESSAGE_CONFLICT",
                    "message_id already exists with different normalized content",
                )
            logger.info(
                "收到重复的步骤上报，已按幂等规则返回已有结果",
                extra={
                    "event": "telemetry.message_processed",
                    "message_id": str(payload.message_id),
                    "workflow_id": str(payload.workflow_id),
                    "sr": payload.sr,
                    "user_email": payload.user_email,
                    "user_name": payload.user_name,
                    "step_type": payload.data.step_type,
                    "outcome": "duplicate",
                },
            )
            return TelemetrySyncResponse(
                request_id=request_id,
                message_id=payload.message_id,
                status="duplicate",
            )

        workflow_created = False
        try:
            workflow = self._lock_workflow(payload.workflow_id)
            if workflow is None:
                workflow = self._create_workflow(payload, payload_hash, now)
                self.session.add(workflow)
                self.session.flush()
                workflow_created = True
            else:
                self._validate_and_update_workflow(workflow, payload, payload_hash, now)

            message = self._create_message(payload, payload_hash, now)
            self.session.add(message)
            step_execution, step_created = self._upsert_step(payload, payload_hash, now)
            if step_created:
                self.session.add(step_execution)
            self.session.flush()
            if payload.data.step_type == "task-dev" and payload.data.status == "done":
                self.session.add(
                    self._create_dev_run(payload, payload_hash, now, step_execution.id)
                )
            self.session.commit()
        except ApiError as exc:
            self.session.rollback()
            logger.warning(
                "步骤上报未通过业务约束校验，事务已回滚",
                extra={
                    "event": "telemetry.message_rejected",
                    "message_id": str(payload.message_id),
                    "workflow_id": str(payload.workflow_id),
                    "sr": payload.sr,
                    "user_email": payload.user_email,
                    "user_name": payload.user_name,
                    "error_code": exc.code,
                    "retryable": exc.retryable,
                },
            )
            raise
        except IntegrityError as exc:
            self.session.rollback()
            logger.warning(
                "步骤上报违反数据关系或唯一性约束，事务已回滚",
                extra={
                    "event": "telemetry.message_rejected",
                    "message_id": str(payload.message_id),
                    "workflow_id": str(payload.workflow_id),
                    "sr": payload.sr,
                    "user_email": payload.user_email,
                    "user_name": payload.user_name,
                    "error_code": "INVALID_REQUEST",
                    "retryable": False,
                },
            )
            raise ApiError(
                400,
                "INVALID_REQUEST",
                "message violates a relationship or uniqueness constraint",
            ) from exc

        logger.info(
            (
                "新的步骤上报已保存，并创建了对应工作流"
                if workflow_created
                else "新的步骤上报已保存，工作流状态已更新"
            ),
            extra={
                "event": "telemetry.message_processed",
                "message_id": str(payload.message_id),
                "workflow_id": str(payload.workflow_id),
                "sr": payload.sr,
                "repository": payload.repository,
                "user_email": payload.user_email,
                "user_name": payload.user_name,
                "step_type": payload.data.step_type,
                "step_status": payload.data.status,
                "has_file": payload.data.file is not None,
                "workflow_created": workflow_created,
                "outcome": "accepted",
            },
        )
        return TelemetrySyncResponse(
            request_id=request_id,
            message_id=payload.message_id,
            status="accepted",
            server_updated_at=_milliseconds(now),
        )

    def _lock_workflow(self, workflow_id):
        return self.session.scalar(
            select(WorkflowRun).where(WorkflowRun.id == workflow_id).with_for_update()
        )

    @staticmethod
    def _create_workflow(
        payload: TelemetrySyncRequest, payload_hash: str, now: datetime
    ) -> WorkflowRun:
        return WorkflowRun(
            id=payload.workflow_id,
            project_key=payload.repository,
            git_user_email=payload.user_email,
            git_user_name=payload.user_name,
            sr=payload.sr,
            ar=payload.data.ar,
            aaw_version=payload.aaw_version,
            status="completed" if payload.completed_at is not None else "in_progress",
            started_at=_datetime(payload.started_at),
            completed_at=(
                _datetime(payload.completed_at) if payload.completed_at is not None else None
            ),
            last_activity_at=_datetime(payload.updated_at),
            client_updated_at=_datetime(payload.updated_at),
            client_payload_hash=payload_hash,
            server_updated_at=now,
        )

    @staticmethod
    def _validate_and_update_workflow(
        workflow: WorkflowRun,
        payload: TelemetrySyncRequest,
        payload_hash: str,
        now: datetime,
    ) -> None:
        existing_started = _milliseconds(workflow.started_at)
        mismatches = []
        if workflow.project_key != payload.repository:
            mismatches.append("repository")
        if workflow.sr != payload.sr:
            mismatches.append("sr")
        if existing_started != payload.started_at:
            mismatches.append("started_at")
        if mismatches:
            raise ApiError(
                400,
                "INVALID_REQUEST",
                "workflow-consistent fields differ: " + ", ".join(mismatches),
            )
        incoming_updated = _datetime(payload.updated_at)
        current_updated = (
            workflow.client_updated_at.replace(tzinfo=UTC)
            if workflow.client_updated_at.tzinfo is None
            else workflow.client_updated_at.astimezone(UTC)
        )
        if incoming_updated >= current_updated:
            workflow.git_user_email = payload.user_email
            workflow.git_user_name = payload.user_name
            workflow.ar = payload.data.ar
            workflow.aaw_version = payload.aaw_version
            workflow.client_updated_at = incoming_updated
            workflow.client_payload_hash = payload_hash
        if incoming_updated > workflow.last_activity_at.replace(tzinfo=UTC):
            workflow.last_activity_at = incoming_updated
        if payload.completed_at is not None:
            completed = _datetime(payload.completed_at)
            if workflow.completed_at is None or completed > workflow.completed_at.replace(
                tzinfo=UTC
            ):
                workflow.completed_at = completed
            workflow.status = "completed"
        workflow.server_updated_at = now

    @staticmethod
    def _create_message(
        payload: TelemetrySyncRequest, payload_hash: str, now: datetime
    ) -> TelemetryMessage:
        file = payload.data.file
        return TelemetryMessage(
            id=payload.message_id,
            workflow_run_id=payload.workflow_id,
            aaw_version=payload.aaw_version,
            user_email=payload.user_email,
            user_name=payload.user_name,
            repository=payload.repository,
            sr=payload.sr,
            ar=payload.data.ar,
            step_type=payload.data.step_type,
            status=payload.data.status,
            workflow_started_at=_datetime(payload.started_at),
            workflow_completed_at=(
                _datetime(payload.completed_at) if payload.completed_at is not None else None
            ),
            step_started_at=_datetime(payload.data.started_at),
            step_completed_at=(
                _datetime(payload.data.completed_at)
                if payload.data.completed_at is not None
                else None
            ),
            client_updated_at=_datetime(payload.updated_at),
            payload_hash=payload_hash,
            file_name=file.file_name if file else None,
            file_sha256=file.sha256 if file else None,
            server_updated_at=now,
        )

    def _upsert_step(
        self, payload: TelemetrySyncRequest, payload_hash: str, now: datetime
    ) -> tuple[StepExecution, bool]:
        if payload.data.step_id is None:
            return self._create_legacy_step(payload, payload_hash, now), True

        execution_id = uuid.uuid5(
            payload.workflow_id,
            f"step:{payload.data.step_id}:attempt:{payload.data.attempt}",
        )
        step = self.session.scalar(
            select(StepExecution).where(
                StepExecution.workflow_run_id == payload.workflow_id,
                StepExecution.step_id == payload.data.step_id,
                StepExecution.attempt == payload.data.attempt,
            )
        )
        incoming_status = {
            "start": "running",
            "done": "completed",
            "failed": "failed",
            "blocked": "blocked",
        }[payload.data.status]
        started_at = _datetime(payload.data.started_at)
        ended_at = (
            _datetime(payload.data.completed_at)
            if payload.data.completed_at is not None
            else None
        )
        development = (
            dict(payload.data.development)
            if payload.data.development is not None
            else None
        )
        if step is None:
            return (
                StepExecution(
                    id=execution_id,
                    workflow_run_id=payload.workflow_id,
                    step_id=payload.data.step_id,
                    step_type=payload.data.step_type,
                    step_name=payload.data.step_name,
                    task_id=payload.data.task_id,
                    skill_names=payload.data.skill_names,
                    execution_type=payload.data.execution_type,
                    attempt=payload.data.attempt,
                    status=incoming_status,
                    started_at=started_at,
                    ended_at=ended_at,
                    client_updated_at=_datetime(payload.updated_at),
                    client_payload_hash=payload_hash,
                    development=development,
                    server_updated_at=now,
                ),
                True,
            )

        if step.workflow_run_id != payload.workflow_id:
            raise ApiError(409, "STEP_CONFLICT", "step execution belongs to another workflow")
        if step.started_at is None or started_at < step.started_at.replace(tzinfo=UTC):
            step.started_at = started_at
        if payload.data.status != "start" or step.status not in {
            "completed",
            "failed",
            "blocked",
            "superseded",
        }:
            step.status = incoming_status
        if ended_at is not None:
            step.ended_at = ended_at
        step.step_type = payload.data.step_type
        step.step_name = payload.data.step_name
        step.task_id = payload.data.task_id or step.task_id
        step.skill_names = payload.data.skill_names
        step.execution_type = payload.data.execution_type
        if development is not None:
            step.development = development
        step.client_updated_at = _datetime(payload.updated_at)
        step.client_payload_hash = payload_hash
        step.server_updated_at = now
        return step, False

    def _create_legacy_step(
        self, payload: TelemetrySyncRequest, payload_hash: str, now: datetime
    ) -> StepExecution:
        latest = self.session.scalar(
            select(func.max(StepExecution.step_id)).where(
                StepExecution.workflow_run_id == payload.workflow_id
            )
        )
        return StepExecution(
            id=payload.message_id,
            workflow_run_id=payload.workflow_id,
            step_id=(latest or 0) + 1,
            step_type=payload.data.step_type,
            step_name=payload.data.step_type,
            task_id=None,
            skill_names=[],
            execution_type="manual",
            attempt=1,
            status={
                "start": "running",
                "done": "completed",
                "failed": "failed",
                "blocked": "blocked",
            }[payload.data.status],
            started_at=_datetime(payload.data.started_at),
            ended_at=(
                _datetime(payload.data.completed_at)
                if payload.data.completed_at is not None
                else None
            ),
            client_updated_at=_datetime(payload.updated_at),
            client_payload_hash=payload_hash,
            development=None,
            server_updated_at=now,
        )

    def _create_dev_run(
        self,
        payload: TelemetrySyncRequest,
        payload_hash: str,
        now: datetime,
        step_execution_id: uuid.UUID,
    ) -> DevRun:
        return DevRun(
            id=payload.message_id,
            workflow_run_id=payload.workflow_id,
            step_execution_id=step_execution_id,
            branch="",
            head_sha_start="0" * 40,
            status="waiting_objects",
            started_at=_datetime(payload.data.started_at),
            completed_at=_datetime(payload.data.completed_at),
            window_ends_at=now + timedelta(seconds=self.settings.upload_session_seconds),
            code_statistics=None,
            patch_object_key=None,
            client_updated_at=_datetime(payload.updated_at),
            client_payload_hash=payload_hash,
            server_updated_at=now,
        )
