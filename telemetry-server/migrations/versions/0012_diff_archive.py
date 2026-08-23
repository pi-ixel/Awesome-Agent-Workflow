"""Add diff archive fields and archived status for object_upload.

Revision ID: 0012_diff_archive
Revises: 0011_issue_images
"""

import sqlalchemy as sa
from alembic import op

revision = "0012_diff_archive"
down_revision = "0011_issue_images"
branch_labels = None
depends_on = None

_NEW_STATUS = "status IN ('created', 'uploaded', 'confirmed', 'expired', 'archived')"
_OLD_STATUS = "status IN ('created', 'uploaded', 'confirmed', 'expired')"


def _replace_upload_status_constraint(*, new: bool) -> None:
    if op.get_bind().dialect.name == "mysql":
        # MySQL 5.7 parses but does not retain/enforce CHECK constraints.
        return
    rule = _NEW_STATUS if new else _OLD_STATUS
    if op.get_bind().dialect.name == "sqlite":
        with op.batch_alter_table("object_upload", recreate="always") as batch:
            batch.drop_constraint("ck_upload_status", type_="check")
            batch.create_check_constraint("ck_upload_status", rule)
        return
    op.drop_constraint("ck_upload_status", "object_upload", type_="check")
    op.create_check_constraint("ck_upload_status", "object_upload", rule)


def upgrade() -> None:
    op.add_column(
        "object_upload", sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "object_upload", sa.Column("archive_key", sa.String(1024), nullable=True)
    )
    _replace_upload_status_constraint(new=True)


def downgrade() -> None:
    _replace_upload_status_constraint(new=False)
    op.drop_column("object_upload", "archive_key")
    op.drop_column("object_upload", "archived_at")
