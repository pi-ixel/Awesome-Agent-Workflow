"""Add registry component tables (database source of truth for projects).

Revision ID: 0018_registry_tables
Revises: 0017_attributed_lines_60
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

revision = "0018_registry_tables"
down_revision = "0017_attributed_lines_60"
branch_labels = None
depends_on = None

_DATETIME = sa.DateTime(timezone=True).with_variant(mysql.DATETIME(fsp=3), "mysql")


def upgrade() -> None:
    op.create_table(
        "component",
        sa.Column("id", sa.String(128), nullable=False),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("se", sa.String(64), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("created_at", _DATETIME, nullable=False),
        sa.Column("updated_at", _DATETIME, nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_component_position", "component", ["position"])
    op.create_table(
        "component_repo",
        sa.Column("repo_key", sa.String(256), nullable=False),
        sa.Column("component_id", sa.String(128), nullable=False),
        sa.Column("canonical_url", sa.String(2048), nullable=False),
        sa.Column("target_branch", sa.String(512), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("created_at", _DATETIME, nullable=False),
        sa.Column("updated_at", _DATETIME, nullable=False),
        sa.ForeignKeyConstraint(
            ["component_id"], ["component.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("repo_key"),
    )
    op.create_index(
        "ix_component_repo_component", "component_repo", ["component_id"]
    )
    op.create_index(
        "uq_component_repo_canonical_url",
        "component_repo",
        ["canonical_url"],
        unique=True,
        mysql_length={"canonical_url": 700},
    )


def downgrade() -> None:
    op.drop_index("ix_component_repo_component", table_name="component_repo")
    op.drop_table("component_repo")
    op.drop_index("ix_component_position", table_name="component")
    op.drop_table("component")
