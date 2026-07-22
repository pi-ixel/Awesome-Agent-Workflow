"""Persist task identity and development summaries on step executions.

Revision ID: 0008_task_execution_identity
Revises: 0007_real_attribution_status
"""

import sqlalchemy as sa
from alembic import op

revision = "0008_task_execution_identity"
down_revision = "0007_real_attribution_status"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("step_execution", sa.Column("task_id", sa.String(128), nullable=True))
    op.add_column("step_execution", sa.Column("development", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("step_execution", "development")
    op.drop_column("step_execution", "task_id")
