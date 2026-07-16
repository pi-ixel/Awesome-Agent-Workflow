"""Add Dev Patch upload sessions and waiting state.

Revision ID: 0003_dev_patch_uploads
Revises: 0002_mock_code_attribution
"""

import sqlalchemy as sa
from alembic import op

revision = "0003_dev_patch_uploads"
down_revision = "0002_mock_code_attribution"
branch_labels = None
depends_on = None

_OLD_STATUS = "status IN ('running', 'completed', 'failed', 'superseded')"
_NEW_STATUS = (
    "status IN ('running', 'waiting_objects', 'completed', 'failed', 'superseded')"
)


def _upgrade_dev_run() -> None:
    dialect = op.get_bind().dialect.name
    if dialect == "sqlite":
        with op.batch_alter_table("dev_run", recreate="always") as batch:
            batch.drop_constraint("ck_dev_status", type_="check")
            batch.add_column(sa.Column("window_ends_at", sa.DateTime(timezone=True)))
            batch.add_column(sa.Column("patch_object_key", sa.String(1024)))
            batch.create_check_constraint("ck_dev_status", _NEW_STATUS)
        return
    if dialect == "mysql":
        # MySQL 5.7 parses but does not retain/enforce CHECK constraints.
        op.add_column("dev_run", sa.Column("window_ends_at", sa.DateTime(timezone=True)))
        op.add_column("dev_run", sa.Column("patch_object_key", sa.String(1024)))
        return
    op.drop_constraint("ck_dev_status", "dev_run", type_="check")
    op.add_column("dev_run", sa.Column("window_ends_at", sa.DateTime(timezone=True)))
    op.add_column("dev_run", sa.Column("patch_object_key", sa.String(1024)))
    op.create_check_constraint("ck_dev_status", "dev_run", _NEW_STATUS)


def _downgrade_dev_run() -> None:
    dialect = op.get_bind().dialect.name
    if dialect == "sqlite":
        with op.batch_alter_table("dev_run", recreate="always") as batch:
            batch.drop_constraint("ck_dev_status", type_="check")
            batch.drop_column("patch_object_key")
            batch.drop_column("window_ends_at")
            batch.create_check_constraint("ck_dev_status", _OLD_STATUS)
        return
    if dialect == "mysql":
        op.drop_column("dev_run", "patch_object_key")
        op.drop_column("dev_run", "window_ends_at")
        return
    op.drop_constraint("ck_dev_status", "dev_run", type_="check")
    op.drop_column("dev_run", "patch_object_key")
    op.drop_column("dev_run", "window_ends_at")
    op.create_check_constraint("ck_dev_status", "dev_run", _OLD_STATUS)


def upgrade() -> None:
    _upgrade_dev_run()
    op.create_table(
        "object_upload",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("object_type", sa.String(32), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("compressed_size_bytes", sa.Integer(), nullable=False),
        sa.Column("compression", sa.String(16), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        # 512 utf8mb4 characters stay below MySQL's 3072-byte index limit.
        sa.Column("object_key", sa.String(512), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("uploaded_at", sa.DateTime(timezone=True)),
        sa.Column("confirmed_at", sa.DateTime(timezone=True)),
        sa.Column("server_updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("object_type = 'dev_patch'", name="ck_upload_object_type"),
        sa.CheckConstraint(
            "status IN ('created', 'uploaded', 'confirmed', 'expired')",
            name="ck_upload_status",
        ),
        sa.CheckConstraint("compressed_size_bytes > 0", name="ck_upload_size_positive"),
        sa.CheckConstraint(
            "compression IN ('zstd', 'gzip')", name="ck_upload_compression"
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["dev_run.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("object_key"),
        sa.UniqueConstraint("owner_id"),
    )
    op.create_index(
        "ix_upload_status_expires", "object_upload", ["status", "expires_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_upload_status_expires", table_name="object_upload")
    op.drop_table("object_upload")
    _downgrade_dev_run()
