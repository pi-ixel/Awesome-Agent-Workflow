"""Preserve millisecond precision in MySQL timestamp columns.

Revision ID: 0006_mysql_millisecond_timestamps
Revises: 0005_start_step_messages
"""

from alembic import op
from sqlalchemy.dialects import mysql

revision = "0006_mysql_millisecond_timestamps"
down_revision = "0005_start_step_messages"
branch_labels = None
depends_on = None

_TIMESTAMP_COLUMNS = {
    "workflow_run": {
        "started_at": False,
        "completed_at": True,
        "last_activity_at": False,
        "client_updated_at": False,
        "server_updated_at": False,
    },
    "telemetry_message": {
        "workflow_started_at": False,
        "workflow_completed_at": True,
        "step_started_at": False,
        "step_completed_at": True,
        "client_updated_at": False,
        "server_updated_at": False,
    },
    "step_execution": {
        "started_at": True,
        "ended_at": True,
        "client_updated_at": False,
        "server_updated_at": False,
    },
    "dev_run": {
        "started_at": False,
        "completed_at": True,
        "window_ends_at": True,
        "client_updated_at": False,
        "server_updated_at": False,
    },
    "object_upload": {
        "expires_at": False,
        "uploaded_at": True,
        "confirmed_at": True,
        "server_updated_at": False,
    },
    "code_attribution": {
        "mr_merged_at": True,
        "matched_at": False,
        "server_updated_at": False,
    },
}


def _alter_precision(fsp: int) -> None:
    if op.get_bind().dialect.name != "mysql":
        return

    current_type = mysql.DATETIME(fsp=0 if fsp == 3 else 3)
    target_type = mysql.DATETIME(fsp=fsp)
    for table_name, columns in _TIMESTAMP_COLUMNS.items():
        for column_name, nullable in columns.items():
            op.alter_column(
                table_name,
                column_name,
                existing_type=current_type,
                type_=target_type,
                existing_nullable=nullable,
            )


def upgrade() -> None:
    _alter_precision(3)


def downgrade() -> None:
    _alter_precision(0)
