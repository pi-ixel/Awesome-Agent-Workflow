"""Add immutable single-Step messages and raw Diff uploads.

Revision ID: 0004_single_step_messages
Revises: 0003_dev_patch_uploads
"""

import sqlalchemy as sa
from alembic import op

revision = "0004_single_step_messages"
down_revision = "0003_dev_patch_uploads"
branch_labels = None
depends_on = None


def _replace_upload_constraints(*, new: bool) -> None:
    if op.get_bind().dialect.name == "mysql":
        # MySQL 5.7 does not retain/enforce CHECK constraints.
        return
    object_rule = "object_type = 'step_diff'" if new else "object_type = 'dev_patch'"
    compression_rule = "compression = 'none'" if new else "compression IN ('zstd', 'gzip')"
    if op.get_bind().dialect.name == "sqlite":
        with op.batch_alter_table("object_upload", recreate="always") as batch:
            batch.drop_constraint("ck_upload_object_type", type_="check")
            batch.drop_constraint("ck_upload_compression", type_="check")
            batch.create_check_constraint("ck_upload_object_type", object_rule)
            batch.create_check_constraint("ck_upload_compression", compression_rule)
        return
    op.drop_constraint("ck_upload_object_type", "object_upload", type_="check")
    op.drop_constraint("ck_upload_compression", "object_upload", type_="check")
    op.create_check_constraint("ck_upload_object_type", "object_upload", object_rule)
    op.create_check_constraint("ck_upload_compression", "object_upload", compression_rule)


def upgrade() -> None:
    op.create_table(
        "telemetry_message",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workflow_run_id", sa.Uuid(), nullable=False),
        sa.Column("aaw_version", sa.String(64), nullable=False),
        sa.Column("user_email", sa.String(320), nullable=False),
        sa.Column("user_name", sa.String(200), nullable=False),
        sa.Column("repository", sa.String(128), nullable=False),
        sa.Column("sr", sa.String(128), nullable=False),
        sa.Column("ar", sa.String(128)),
        sa.Column("step_type", sa.String(128), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("workflow_started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("workflow_completed_at", sa.DateTime(timezone=True)),
        sa.Column("step_started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("step_completed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("client_updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload_hash", sa.String(64), nullable=False),
        sa.Column("file_name", sa.String(255)),
        sa.Column("file_sha256", sa.String(64)),
        sa.Column("server_updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("status IN ('done', 'failed', 'blocked')", name="ck_message_status"),
        sa.ForeignKeyConstraint(["workflow_run_id"], ["workflow_run.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_telemetry_message_workflow_run_id", "telemetry_message", ["workflow_run_id"]
    )
    op.create_index(
        "ix_message_user_updated", "telemetry_message", ["user_email", "client_updated_at"]
    )
    op.create_index("ix_message_step_type", "telemetry_message", ["step_type"])
    op.create_index("ix_message_ar", "telemetry_message", ["ar"])
    _replace_upload_constraints(new=True)


def downgrade() -> None:
    _replace_upload_constraints(new=False)
    op.drop_index("ix_message_ar", table_name="telemetry_message")
    op.drop_index("ix_message_step_type", table_name="telemetry_message")
    op.drop_index("ix_message_user_updated", table_name="telemetry_message")
    op.drop_index("ix_telemetry_message_workflow_run_id", table_name="telemetry_message")
    op.drop_table("telemetry_message")
