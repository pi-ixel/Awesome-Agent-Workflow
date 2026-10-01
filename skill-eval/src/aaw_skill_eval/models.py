from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def new_id() -> str:
    return str(uuid.uuid4())


def utc_now() -> datetime:
    return datetime.now(UTC)


class Skill(Base):
    __tablename__ = "skills"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    source_path: Mapped[str] = mapped_column(Text)
    baseline_revision_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("skill_revisions.id", use_alter=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )

    revisions: Mapped[list[SkillRevision]] = relationship(
        back_populates="skill",
        foreign_keys="SkillRevision.skill_id",
        cascade="all, delete-orphan",
    )
    baseline_revision: Mapped[SkillRevision | None] = relationship(
        foreign_keys=[baseline_revision_id], post_update=True
    )


class SkillRevision(Base):
    __tablename__ = "skill_revisions"
    __table_args__ = (UniqueConstraint("skill_id", "content_hash"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    skill_id: Mapped[str] = mapped_column(String(36), ForeignKey("skills.id"), index=True)
    content_hash: Mapped[str] = mapped_column(String(64), index=True)
    label: Mapped[str | None] = mapped_column(String(128), nullable=True)
    snapshot_path: Mapped[str] = mapped_column(Text)
    source_path: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    skill: Mapped[Skill] = relationship(back_populates="revisions", foreign_keys=[skill_id])


class Suite(Base):
    __tablename__ = "suites"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(160), index=True)
    skill_id: Mapped[str] = mapped_column(String(36), ForeignKey("skills.id"), index=True)
    project_path: Mapped[str] = mapped_column(Text)
    definition_path: Mapped[str] = mapped_column(Text)
    definition_hash: Mapped[str] = mapped_column(String(64))
    definition_json: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )

    skill: Mapped[Skill] = relationship()


class Experiment(Base):
    __tablename__ = "experiments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    suite_id: Mapped[str] = mapped_column(String(36), ForeignKey("suites.id"), index=True)
    current_revision_id: Mapped[str] = mapped_column(String(36), ForeignKey("skill_revisions.id"))
    baseline_revision_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("skill_revisions.id"), nullable=True
    )
    project_commit: Mapped[str] = mapped_column(String(64))
    suite_hash: Mapped[str] = mapped_column(String(64))
    profile_hash: Mapped[str] = mapped_column(String(64))
    profile_json: Mapped[str] = mapped_column(Text)
    suite_snapshot_json: Mapped[str] = mapped_column(Text)
    mode: Mapped[str] = mapped_column(String(16))
    trials: Mapped[int] = mapped_column(Integer)
    seed: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(32), default="queued", index=True)
    # pair_parallel_v1 for experiments executed by the pair-parallel
    # scheduler; NULL for legacy experiments created before it (exposed as-is,
    # never backfilled).
    execution_mode: Mapped[str | None] = mapped_column(String(32), nullable=True)
    concurrency_limit: Mapped[int | None] = mapped_column(Integer, nullable=True)
    retry_of_experiment_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("experiments.id"), nullable=True, index=True
    )
    error_kind: Mapped[str | None] = mapped_column(String(32), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cancel_requested_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    suite: Mapped[Suite] = relationship()
    retry_of: Mapped[Experiment | None] = relationship(
        remote_side="Experiment.id",
        foreign_keys=[retry_of_experiment_id],
        back_populates="retries",
    )
    retries: Mapped[list[Experiment]] = relationship(
        foreign_keys=[retry_of_experiment_id],
        back_populates="retry_of",
        order_by="Experiment.created_at",
    )
    current_revision: Mapped[SkillRevision] = relationship(foreign_keys=[current_revision_id])
    baseline_revision: Mapped[SkillRevision | None] = relationship(
        foreign_keys=[baseline_revision_id]
    )
    runs: Mapped[list[Run]] = relationship(
        back_populates="experiment", cascade="all, delete-orphan"
    )


class Run(Base):
    __tablename__ = "runs"
    __table_args__ = (UniqueConstraint("experiment_id", "case_id", "group_name", "trial_index"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    experiment_id: Mapped[str] = mapped_column(String(36), ForeignKey("experiments.id"), index=True)
    case_id: Mapped[str] = mapped_column(String(160), index=True)
    group_name: Mapped[str] = mapped_column(String(32), index=True)
    trial_index: Mapped[int] = mapped_column(Integer)
    anonymous_id: Mapped[str] = mapped_column(String(32), index=True)
    status: Mapped[str] = mapped_column(String(32), default="queued")
    quality_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    hard_gates_passed: Mapped[int] = mapped_column(Integer, default=0)
    hard_gates_total: Mapped[int] = mapped_column(Integer, default=0)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    exit_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    artifact_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    score_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_kind: Mapped[str | None] = mapped_column(String(32), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    workspace_retained: Mapped[bool] = mapped_column(Boolean, default=False)
    current_stage: Mapped[str | None] = mapped_column(String(64), nullable=True)
    stage_started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_heartbeat_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_activity_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    cancel_requested_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    current_attempt: Mapped[int] = mapped_column(Integer, default=1)
    # Pair-parallel scheduling: every run of one (case_id, trial_index) block
    # shares a pair_id; the two runs launched together also record the skew
    # between their actual start times. NULL on legacy runs.
    pair_id: Mapped[str | None] = mapped_column(String(160), nullable=True, index=True)
    pair_launch_skew_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    experiment: Mapped[Experiment] = relationship(back_populates="runs")
    progress_events: Mapped[list[RunProgressEvent]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )
    attempts: Mapped[list[RunAttempt]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )


class RunProgressEvent(Base):
    __tablename__ = "run_progress_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("runs.id"), index=True)
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    kind: Mapped[str] = mapped_column(String(32), index=True)
    stage: Mapped[str | None] = mapped_column(String(64), nullable=True)
    message: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    run: Mapped[Run] = relationship(back_populates="progress_events")


class RunAttempt(Base):
    __tablename__ = "run_attempts"
    __table_args__ = (UniqueConstraint("run_id", "attempt_index"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("runs.id"), index=True)
    attempt_index: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(32))
    stage: Mapped[str | None] = mapped_column(String(64), nullable=True)
    artifact_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_kind: Mapped[str | None] = mapped_column(String(32), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    run: Mapped[Run] = relationship(back_populates="attempts")


class HumanReview(Base):
    __tablename__ = "human_reviews"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("runs.id"), index=True)
    score: Mapped[float] = mapped_column(Float)
    note: Mapped[str] = mapped_column(Text, default="")
    reviewer: Mapped[str] = mapped_column(String(128), default="local-user")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    run: Mapped[Run] = relationship()
