"""Add status fields for the real attribution pipeline.

Revision ID: 0007_real_attribution_status
Revises: 0006_mysql_millisecond_timestamps
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

revision = "0007_real_attribution_status"
down_revision = "0006_mysql_millisecond_timestamps"
branch_labels = None
depends_on = None

_STATUS_RULE = (
    "attribution_status IN "
    "('pending', 'running', 'finalized_match', 'finalized_no_match', "
    "'failed', 'retry_pending')"
)
_MILLISECOND_DATETIME = sa.DateTime(timezone=True).with_variant(
    mysql.DATETIME(fsp=3), "mysql"
)


def upgrade() -> None:
    op.add_column(
        "code_attribution",
        sa.Column(
            "attribution_status",
            sa.String(32),
            nullable=False,
            server_default="pending",
        ),
    )
    op.add_column(
        "code_attribution",
        sa.Column("retry_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "code_attribution",
        sa.Column("next_retry_at", _MILLISECOND_DATETIME, nullable=True),
    )
    op.execute(
        sa.text(
            "UPDATE code_attribution SET attribution_status = result_status "
            "WHERE attribution_status = 'pending'"
        )
    )
    dialect = op.get_bind().dialect.name
    if dialect == "sqlite":
        with op.batch_alter_table("code_attribution", recreate="always") as batch:
            batch.create_check_constraint("ck_attribution_status", _STATUS_RULE)
            batch.drop_column("exact_match_lines")
            batch.drop_column("fuzzy_match_lines")
            batch.drop_column("block_match_lines")
    else:
        if dialect != "mysql":
            op.create_check_constraint(
                "ck_attribution_status",
                "code_attribution",
                _STATUS_RULE,
            )
        op.drop_column("code_attribution", "exact_match_lines")
        op.drop_column("code_attribution", "fuzzy_match_lines")
        op.drop_column("code_attribution", "block_match_lines")
    op.create_index(
        "ix_attribution_attribution_status",
        "code_attribution",
        ["attribution_status"],
    )
    op.create_index(
        "ix_attribution_next_retry",
        "code_attribution",
        ["next_retry_at", "retry_count"],
    )


def downgrade() -> None:
    op.drop_index("ix_attribution_next_retry", table_name="code_attribution")
    op.drop_index("ix_attribution_attribution_status", table_name="code_attribution")
    restored_columns = [
        sa.Column(
            "exact_match_lines",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "fuzzy_match_lines",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "block_match_lines",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    ]
    dialect = op.get_bind().dialect.name
    if dialect == "sqlite":
        with op.batch_alter_table("code_attribution", recreate="always") as batch:
            batch.drop_constraint("ck_attribution_status", type_="check")
            for column in restored_columns:
                batch.add_column(column)
            batch.drop_column("next_retry_at")
            batch.drop_column("retry_count")
            batch.drop_column("attribution_status")
    else:
        if dialect != "mysql":
            op.drop_constraint("ck_attribution_status", "code_attribution", type_="check")
        for column in restored_columns:
            op.add_column("code_attribution", column)
        op.drop_column("code_attribution", "next_retry_at")
        op.drop_column("code_attribution", "retry_count")
        op.drop_column("code_attribution", "attribution_status")
