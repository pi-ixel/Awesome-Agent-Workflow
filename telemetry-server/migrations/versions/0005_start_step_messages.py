"""Allow Step start messages without a completion timestamp.

Revision ID: 0005_start_step_messages
Revises: 0004_single_step_messages
"""

import sqlalchemy as sa
from alembic import op

revision = "0005_start_step_messages"
down_revision = "0004_single_step_messages"
branch_labels = None
depends_on = None

_OLD_STATUS = "status IN ('done', 'failed', 'blocked')"
_NEW_STATUS = "status IN ('start', 'done', 'failed', 'blocked')"


def _has_status_constraint() -> bool:
    constraints = sa.inspect(op.get_bind()).get_check_constraints("telemetry_message")
    return any(row.get("name") == "ck_message_status" for row in constraints)


def _alter_message(*, nullable: bool, status_rule: str) -> None:
    dialect = op.get_bind().dialect.name
    if dialect == "sqlite":
        with op.batch_alter_table("telemetry_message", recreate="always") as batch:
            batch.drop_constraint("ck_message_status", type_="check")
            batch.alter_column(
                "step_completed_at",
                existing_type=sa.DateTime(timezone=True),
                nullable=nullable,
            )
            batch.create_check_constraint("ck_message_status", status_rule)
        return

    if _has_status_constraint():
        op.drop_constraint("ck_message_status", "telemetry_message", type_="check")
    op.alter_column(
        "telemetry_message",
        "step_completed_at",
        existing_type=sa.DateTime(timezone=True),
        nullable=nullable,
    )
    op.create_check_constraint("ck_message_status", "telemetry_message", status_rule)


def upgrade() -> None:
    _alter_message(nullable=True, status_rule=_NEW_STATUS)


def downgrade() -> None:
    op.execute(sa.text("DELETE FROM telemetry_message WHERE status = 'start'"))
    op.execute(
        sa.text(
            "UPDATE telemetry_message "
            "SET step_completed_at = step_started_at "
            "WHERE step_completed_at IS NULL"
        )
    )
    _alter_message(nullable=False, status_rule=_OLD_STATUS)
