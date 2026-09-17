"""Workflow data management: three-level deletion (workflow / dev run / attribution).

Revision ID: 0020_workflow_deletion
Revises: 0019_dev_run_admin_exclusion
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

revision = "0020_workflow_deletion"
down_revision = "0019_dev_run_admin_exclusion"
branch_labels = None
depends_on = None

_DATETIME = sa.DateTime(timezone=True).with_variant(mysql.DATETIME(fsp=3), "mysql")


def _deletion_columns() -> list[sa.Column]:
    return [
        sa.Column("deleted", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("deleted_reason_code", sa.String(32), nullable=True),
        sa.Column("deleted_reason", sa.String(512), nullable=True),
        sa.Column("deleted_by", sa.String(128), nullable=True),
        sa.Column("deleted_at", _DATETIME, nullable=True),
    ]


def upgrade() -> None:
    for table, index in (
        ("workflow_run", "ix_workflow_deleted"),
        ("code_attribution", "ix_attribution_deleted"),
    ):
        for column in _deletion_columns():
            op.add_column(table, column)
        op.create_index(index, table, ["deleted"])
    # dev_run 复用 0019 的 admin_excluded 字段组（语义升级为"删除"），只补理由码
    op.add_column(
        "dev_run", sa.Column("deleted_reason_code", sa.String(32), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("dev_run", "deleted_reason_code")
    op.drop_index("ix_attribution_deleted", table_name="code_attribution")
    for column in reversed(_deletion_columns()):
        op.drop_column("code_attribution", column.name)
    op.drop_index("ix_workflow_deleted", table_name="workflow_run")
    for column in reversed(_deletion_columns()):
        op.drop_column("workflow_run", column.name)
