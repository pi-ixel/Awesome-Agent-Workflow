"""Add indexes used by dashboard filters and grouping.

Revision ID: 0015_dashboard_perf_indexes
Revises: 0014_merge_diff_archive_heads
"""

from alembic import op

revision = "0015_dashboard_perf_indexes"
down_revision = "0014_merge_diff_archive_heads"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_workflow_kind_started",
        "workflow_run",
        ["workflow_kind", "started_at"],
        unique=False,
    )
    op.create_index(
        "ix_message_kind_repository",
        "telemetry_message",
        ["workflow_kind", "repository"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_message_kind_repository", table_name="telemetry_message")
    op.drop_index("ix_workflow_kind_started", table_name="workflow_run")
