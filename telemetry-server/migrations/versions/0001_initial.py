"""Create telemetry MVP tables."""

import sqlalchemy as sa
from alembic import op

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "workflow_run",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_key", sa.String(128), nullable=False),
        sa.Column("git_user_email", sa.String(320), nullable=False),
        sa.Column("git_user_name", sa.String(200), nullable=False),
        sa.Column("sr", sa.String(128), nullable=False),
        sa.Column("ar", sa.String(128), nullable=True),
        sa.Column("aaw_version", sa.String(64), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_activity_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("client_updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("client_payload_hash", sa.String(64), nullable=False),
        sa.Column("server_updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("status IN ('in_progress', 'completed')", name="ck_workflow_status"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_workflow_project_started", "workflow_run", ["project_key", "started_at"])
    op.create_index("ix_workflow_user_started", "workflow_run", ["git_user_email", "started_at"])
    op.create_index("ix_workflow_status_activity", "workflow_run", ["status", "last_activity_at"])
    op.create_index("ix_workflow_sr_ar", "workflow_run", ["sr", "ar"])
    op.create_table(
        "step_execution",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workflow_run_id", sa.Uuid(), nullable=False),
        sa.Column("step_id", sa.Integer(), nullable=False),
        sa.Column("step_type", sa.String(128), nullable=False),
        sa.Column("step_name", sa.String(256), nullable=False),
        sa.Column("skill_names", sa.JSON(), nullable=False),
        sa.Column("execution_type", sa.String(32), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("client_updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("client_payload_hash", sa.String(64), nullable=False),
        sa.Column("server_updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("step_id >= 1", name="ck_step_id_positive"),
        sa.CheckConstraint("attempt >= 1", name="ck_step_attempt_positive"),
        sa.CheckConstraint(
            "status IN ('ready', 'running', 'completed', 'failed', 'blocked', 'superseded')",
            name="ck_step_status",
        ),
        sa.CheckConstraint(
            "execution_type IN ('skill', 'prompt', 'manual', 'noop')",
            name="ck_step_execution_type",
        ),
        sa.ForeignKeyConstraint(["workflow_run_id"], ["workflow_run.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("workflow_run_id", "step_id", "attempt", name="uq_step_attempt"),
    )
    op.create_index("ix_step_execution_workflow_run_id", "step_execution", ["workflow_run_id"])
    op.create_table(
        "dev_run",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workflow_run_id", sa.Uuid(), nullable=False),
        sa.Column("step_execution_id", sa.Uuid(), nullable=False),
        sa.Column("branch", sa.String(512), nullable=False),
        sa.Column("head_sha_start", sa.String(64), nullable=False),
        sa.Column("head_sha_end", sa.String(64), nullable=True),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("code_statistics", sa.JSON(), nullable=True),
        sa.Column("client_updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("client_payload_hash", sa.String(64), nullable=False),
        sa.Column("server_updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "status IN ('running', 'completed', 'failed', 'superseded')", name="ck_dev_status"
        ),
        sa.ForeignKeyConstraint(["workflow_run_id"], ["workflow_run.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["step_execution_id"], ["step_execution.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("step_execution_id"),
    )
    op.create_index("ix_dev_workflow_started", "dev_run", ["workflow_run_id", "started_at"])
    op.create_index("ix_dev_status_completed", "dev_run", ["status", "completed_at"])


def downgrade() -> None:
    op.drop_table("dev_run")
    op.drop_table("step_execution")
    op.drop_table("workflow_run")
