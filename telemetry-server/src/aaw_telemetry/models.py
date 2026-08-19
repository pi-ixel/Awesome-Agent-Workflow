from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects import mysql
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base

MILLISECOND_DATETIME = DateTime(timezone=True).with_variant(mysql.DATETIME(fsp=3), "mysql")


class WorkflowRun(Base):
    __tablename__ = "workflow_run"
    __table_args__ = (
        CheckConstraint("status IN ('in_progress', 'completed')", name="ck_workflow_status"),
        Index("ix_workflow_project_started", "project_key", "started_at"),
        Index("ix_workflow_kind_project_started", "workflow_kind", "project_key", "started_at"),
        Index("ix_workflow_entry_started", "entry", "started_at"),
        Index("ix_workflow_user_started", "git_user_email", "started_at"),
        Index("ix_workflow_status_activity", "status", "last_activity_at"),
        Index("ix_workflow_sr_ar", "sr", "ar"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    workflow_kind: Mapped[str] = mapped_column(String(32), nullable=False, default="aaw")
    entry: Mapped[str | None] = mapped_column(String(8))
    project_key: Mapped[str] = mapped_column(String(128), nullable=False)
    git_user_email: Mapped[str] = mapped_column(String(320), nullable=False)
    git_user_name: Mapped[str] = mapped_column(String(200), nullable=False)
    sr: Mapped[str] = mapped_column(String(128), nullable=False)
    ar: Mapped[str | None] = mapped_column(String(128))
    aaw_version: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    started_at: Mapped[datetime] = mapped_column(MILLISECOND_DATETIME, nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(MILLISECOND_DATETIME)
    last_activity_at: Mapped[datetime] = mapped_column(MILLISECOND_DATETIME, nullable=False)
    client_updated_at: Mapped[datetime] = mapped_column(MILLISECOND_DATETIME, nullable=False)
    client_payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    server_updated_at: Mapped[datetime] = mapped_column(MILLISECOND_DATETIME, nullable=False)

    step_executions: Mapped[list[StepExecution]] = relationship(back_populates="workflow")
    dev_runs: Mapped[list[DevRun]] = relationship(back_populates="workflow")
    messages: Mapped[list[TelemetryMessage]] = relationship(back_populates="workflow")


class TelemetryMessage(Base):
    """A single immutable Step status report from the CLI."""

    __tablename__ = "telemetry_message"
    __table_args__ = (
        CheckConstraint(
            "status IN ('start', 'done', 'failed', 'blocked')", name="ck_message_status"
        ),
        Index("ix_message_user_updated", "user_email", "client_updated_at"),
        Index("ix_message_kind_user_updated", "workflow_kind", "user_email", "client_updated_at"),
        Index("ix_message_step_type", "step_type"),
        Index("ix_message_ar", "ar"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    workflow_kind: Mapped[str] = mapped_column(String(32), nullable=False, default="aaw")
    entry: Mapped[str | None] = mapped_column(String(8))
    workflow_run_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workflow_run.id", ondelete="CASCADE"), nullable=False, index=True
    )
    aaw_version: Mapped[str] = mapped_column(String(64), nullable=False)
    user_email: Mapped[str] = mapped_column(String(320), nullable=False)
    user_name: Mapped[str] = mapped_column(String(200), nullable=False)
    repository: Mapped[str] = mapped_column(String(128), nullable=False)
    sr: Mapped[str] = mapped_column(String(128), nullable=False)
    ar: Mapped[str | None] = mapped_column(String(128))
    step_type: Mapped[str] = mapped_column(String(128), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    workflow_started_at: Mapped[datetime] = mapped_column(MILLISECOND_DATETIME, nullable=False)
    workflow_completed_at: Mapped[datetime | None] = mapped_column(MILLISECOND_DATETIME)
    step_started_at: Mapped[datetime] = mapped_column(MILLISECOND_DATETIME, nullable=False)
    step_completed_at: Mapped[datetime | None] = mapped_column(MILLISECOND_DATETIME)
    client_updated_at: Mapped[datetime] = mapped_column(MILLISECOND_DATETIME, nullable=False)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    file_name: Mapped[str | None] = mapped_column(String(255))
    file_sha256: Mapped[str | None] = mapped_column(String(64))
    server_updated_at: Mapped[datetime] = mapped_column(MILLISECOND_DATETIME, nullable=False)

    workflow: Mapped[WorkflowRun] = relationship(back_populates="messages")


class StepExecution(Base):
    __tablename__ = "step_execution"
    __table_args__ = (
        CheckConstraint("step_id >= 1", name="ck_step_id_positive"),
        CheckConstraint("attempt >= 1", name="ck_step_attempt_positive"),
        CheckConstraint(
            "status IN ('ready', 'running', 'completed', 'failed', 'blocked', 'superseded')",
            name="ck_step_status",
        ),
        CheckConstraint(
            "execution_type IN ('skill', 'prompt', 'manual', 'noop')",
            name="ck_step_execution_type",
        ),
        UniqueConstraint("workflow_run_id", "step_id", "attempt", name="uq_step_attempt"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    workflow_run_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workflow_run.id", ondelete="CASCADE"), nullable=False, index=True
    )
    step_id: Mapped[int] = mapped_column(Integer, nullable=False)
    step_type: Mapped[str] = mapped_column(String(128), nullable=False)
    step_name: Mapped[str] = mapped_column(String(256), nullable=False)
    task_id: Mapped[str | None] = mapped_column(String(128))
    skill_names: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    execution_type: Mapped[str] = mapped_column(String(32), nullable=False)
    attempt: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(MILLISECOND_DATETIME)
    ended_at: Mapped[datetime | None] = mapped_column(MILLISECOND_DATETIME)
    client_updated_at: Mapped[datetime] = mapped_column(MILLISECOND_DATETIME, nullable=False)
    client_payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    development: Mapped[dict | None] = mapped_column(JSON)
    server_updated_at: Mapped[datetime] = mapped_column(MILLISECOND_DATETIME, nullable=False)

    workflow: Mapped[WorkflowRun] = relationship(back_populates="step_executions")
    dev_run: Mapped[DevRun | None] = relationship(back_populates="step_execution")


class DevRun(Base):
    __tablename__ = "dev_run"
    __table_args__ = (
        CheckConstraint(
            "status IN ('running', 'waiting_objects', 'completed', 'failed', 'superseded')",
            name="ck_dev_status",
        ),
        Index("ix_dev_workflow_started", "workflow_run_id", "started_at"),
        Index("ix_dev_status_completed", "status", "completed_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    workflow_run_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workflow_run.id", ondelete="CASCADE"), nullable=False
    )
    step_execution_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("step_execution.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    branch: Mapped[str] = mapped_column(String(512), nullable=False)
    head_sha_start: Mapped[str] = mapped_column(String(64), nullable=False)
    head_sha_end: Mapped[str | None] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    started_at: Mapped[datetime] = mapped_column(MILLISECOND_DATETIME, nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(MILLISECOND_DATETIME)
    window_ends_at: Mapped[datetime | None] = mapped_column(MILLISECOND_DATETIME)
    code_statistics: Mapped[dict | None] = mapped_column(JSON)
    patch_object_key: Mapped[str | None] = mapped_column(String(1024))
    client_updated_at: Mapped[datetime] = mapped_column(MILLISECOND_DATETIME, nullable=False)
    client_payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    server_updated_at: Mapped[datetime] = mapped_column(MILLISECOND_DATETIME, nullable=False)

    workflow: Mapped[WorkflowRun] = relationship(back_populates="dev_runs")
    step_execution: Mapped[StepExecution] = relationship(back_populates="dev_run")
    attribution: Mapped[CodeAttribution | None] = relationship(
        back_populates="dev_run", cascade="all, delete-orphan", uselist=False
    )
    object_upload: Mapped[ObjectUpload | None] = relationship(
        back_populates="dev_run", cascade="all, delete-orphan", uselist=False
    )


class ObjectUpload(Base):
    __tablename__ = "object_upload"
    __table_args__ = (
        CheckConstraint("object_type = 'step_diff'", name="ck_upload_object_type"),
        CheckConstraint(
            "status IN ('created', 'uploaded', 'confirmed', 'expired')",
            name="ck_upload_status",
        ),
        CheckConstraint("compressed_size_bytes > 0", name="ck_upload_size_positive"),
        CheckConstraint("compression = 'none'", name="ck_upload_compression"),
        Index("ix_upload_status_expires", "status", "expires_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    object_type: Mapped[str] = mapped_column(String(32), nullable=False)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("dev_run.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    compressed_size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    compression: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    object_key: Mapped[str] = mapped_column(String(512), nullable=False, unique=True)
    expires_at: Mapped[datetime] = mapped_column(MILLISECOND_DATETIME, nullable=False)
    uploaded_at: Mapped[datetime | None] = mapped_column(MILLISECOND_DATETIME)
    confirmed_at: Mapped[datetime | None] = mapped_column(MILLISECOND_DATETIME)
    server_updated_at: Mapped[datetime] = mapped_column(MILLISECOND_DATETIME, nullable=False)

    dev_run: Mapped[DevRun] = relationship(back_populates="object_upload")


class CodeAttribution(Base):
    """Persisted attribution result — real ARMRCounter engine or mock fallback."""

    __tablename__ = "code_attribution"
    __table_args__ = (
        CheckConstraint(
            "result_status IN ('finalized_match', 'finalized_no_match')",
            name="ck_attribution_result_status",
        ),
        CheckConstraint(
            "attribution_status IN "
            "('pending', 'running', 'finalized_match', 'finalized_no_match', "
            "'failed', 'retry_pending')",
            name="ck_attribution_status",
        ),
        CheckConstraint(
            "attributed_lines_90 <= attributed_lines_80",
            name="ck_attribution_threshold_order",
        ),
        CheckConstraint(
            "attributed_lines_80 <= dev_effective_lines",
            name="ck_attribution_not_over_total",
        ),
        Index("ix_attribution_status_matched", "result_status", "matched_at"),
        Index("ix_attribution_attribution_status", "attribution_status"),
    )

    dev_run_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("dev_run.id", ondelete="CASCADE"), primary_key=True
    )
    dev_effective_lines: Mapped[int] = mapped_column(Integer, nullable=False)
    attributed_lines_80: Mapped[int] = mapped_column(Integer, nullable=False)
    attributed_lines_90: Mapped[int] = mapped_column(Integer, nullable=False)
    mr_commit_lines: Mapped[int | None] = mapped_column(Integer)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    attribution_status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="pending"
    )
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_retry_at: Mapped[datetime | None] = mapped_column(MILLISECOND_DATETIME)
    quality_flags: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    result_status: Mapped[str] = mapped_column(String(32), nullable=False)
    matched_mr_iid: Mapped[str | None] = mapped_column(String(64))
    matched_mr_url: Mapped[str | None] = mapped_column(String(2048))
    mr_diff_version: Mapped[str | None] = mapped_column(String(64))
    mr_source_branch: Mapped[str | None] = mapped_column(String(512))
    target_branch: Mapped[str | None] = mapped_column(String(512))
    merge_commit_sha: Mapped[str | None] = mapped_column(String(64))
    mr_merged_at: Mapped[datetime | None] = mapped_column(MILLISECOND_DATETIME)
    algorithm_version: Mapped[str] = mapped_column(String(64), nullable=False)
    diff_rule_version: Mapped[str] = mapped_column(String(64), nullable=False)
    matched_at: Mapped[datetime] = mapped_column(MILLISECOND_DATETIME, nullable=False)
    server_updated_at: Mapped[datetime] = mapped_column(MILLISECOND_DATETIME, nullable=False)

    dev_run: Mapped[DevRun] = relationship(back_populates="attribution")


class Issue(Base):
    """A manually recorded issue from the portal wish board."""

    __tablename__ = "issue"
    __table_args__ = (
        CheckConstraint(
            "assignee IN ('张轶勃', '徐哲威', '宋东方', '张立肖', '孙杨宇鑫')",
            name="ck_issue_assignee",
        ),
        CheckConstraint(
            "status IN ('todo', 'in_progress', 'resolved')", name="ck_issue_status"
        ),
        CheckConstraint("priority IN ('low', 'medium', 'high')", name="ck_issue_priority"),
        Index("ix_issue_status_updated", "status", "updated_at"),
        Index("ix_issue_assignee_updated", "assignee", "updated_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    description_doc: Mapped[dict | None] = mapped_column(JSON)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    reporter: Mapped[str] = mapped_column(String(100), nullable=False)
    assignee: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="todo")
    priority: Mapped[str] = mapped_column(String(16), nullable=False, default="medium")
    component: Mapped[str | None] = mapped_column(String(128))
    workflow_run_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("workflow_run.id", ondelete="SET NULL"), nullable=True
    )
    sr: Mapped[str | None] = mapped_column(String(128))
    ar: Mapped[str | None] = mapped_column(String(128))
    created_at: Mapped[datetime] = mapped_column(MILLISECOND_DATETIME, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(MILLISECOND_DATETIME, nullable=False)
    resolved_at: Mapped[datetime | None] = mapped_column(MILLISECOND_DATETIME)

    activities: Mapped[list[IssueActivity]] = relationship(
        back_populates="issue", cascade="all, delete-orphan", order_by="IssueActivity.created_at"
    )
    images: Mapped[list[IssueImage]] = relationship(back_populates="issue")


class IssueActivity(Base):
    __tablename__ = "issue_activity"
    __table_args__ = (Index("ix_issue_activity_issue_created", "issue_id", "created_at"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    issue_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("issue.id", ondelete="CASCADE"), nullable=False
    )
    action: Mapped[str] = mapped_column(String(32), nullable=False)
    details: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(MILLISECOND_DATETIME, nullable=False)

    issue: Mapped[Issue] = relationship(back_populates="activities")


class IssueImage(Base):
    """A normalized raster image temporarily uploaded or bound to one issue."""

    __tablename__ = "issue_image"
    __table_args__ = (
        CheckConstraint(
            "status IN ('temporary', 'bound', 'pending_delete')",
            name="ck_issue_image_status",
        ),
        CheckConstraint("size_bytes > 0", name="ck_issue_image_size_positive"),
        CheckConstraint("width > 0 AND height > 0", name="ck_issue_image_dimensions_positive"),
        Index("ix_issue_image_status_created", "status", "created_at"),
        Index("ix_issue_image_delete_after", "delete_after"),
        Index("ix_issue_image_issue", "issue_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    issue_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("issue.id", ondelete="SET NULL")
    )
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="temporary")
    media_type: Mapped[str] = mapped_column(String(32), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    preview_size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    width: Mapped[int] = mapped_column(Integer, nullable=False)
    height: Mapped[int] = mapped_column(Integer, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    full_object_key: Mapped[str] = mapped_column(String(512), nullable=False, unique=True)
    preview_object_key: Mapped[str] = mapped_column(String(512), nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(MILLISECOND_DATETIME, nullable=False)
    bound_at: Mapped[datetime | None] = mapped_column(MILLISECOND_DATETIME)
    delete_after: Mapped[datetime | None] = mapped_column(MILLISECOND_DATETIME)

    issue: Mapped[Issue | None] = relationship(back_populates="images")
