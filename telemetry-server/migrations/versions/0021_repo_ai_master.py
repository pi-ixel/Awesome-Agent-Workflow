"""Move AI Master ownership from component to repository.

业务口径：AI Master 是一线辅助人员，按**仓库**划分责任范围（一个仓库只能有一位
AI Master），而 SE 按**组件**划分。两条责任线因此是交叉的两套集合，组件级归属
由仓库级归属推导。

升级时把已有组件级认领下沉到该组件下所有仓库，避免认领关系丢失。
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

revision = "0021_repo_ai_master"
down_revision = "0020_workflow_deletion"
branch_labels = None
depends_on = None

_DATETIME = sa.DateTime(timezone=True).with_variant(mysql.DATETIME(fsp=3), "mysql")


def upgrade() -> None:
    op.create_table(
        "repo_ai_master",
        sa.Column("repo_key", sa.String(256), nullable=False),
        sa.Column("ai_master_id", sa.Uuid(), nullable=False),
        sa.Column("created_at", _DATETIME, nullable=False),
        sa.Column("updated_at", _DATETIME, nullable=False),
        sa.ForeignKeyConstraint(["ai_master_id"], ["ai_master.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("repo_key"),
    )
    op.create_index("ix_repo_ai_master_master", "repo_ai_master", ["ai_master_id"])

    # 组件级认领下沉到该组件下所有仓库；组件下暂无仓库时无处可落，直接丢弃
    op.execute(
        sa.text(
            """
            INSERT INTO repo_ai_master (repo_key, ai_master_id, created_at, updated_at)
            SELECT repo.repo_key, assignment.ai_master_id,
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            FROM component_ai_master AS assignment
            JOIN component_repo AS repo ON repo.component_id = assignment.component_id
            """
        )
    )

    # 直接删表：MySQL 把该索引用作外键的支撑索引，显式 drop_index 会被拒绝
    op.drop_table("component_ai_master")


def downgrade() -> None:
    op.create_table(
        "component_ai_master",
        sa.Column("component_id", sa.String(128), nullable=False),
        sa.Column("ai_master_id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(["ai_master_id"], ["ai_master.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("component_id"),
        sa.UniqueConstraint("component_id", name="uq_component_ai_master_component"),
    )
    op.create_index(
        "ix_component_ai_master_master", "component_ai_master", ["ai_master_id"]
    )
    # 回退时按"组件下多数仓库的归属"还原（并列取字典序最小者），无法一一还原时丢细节
    op.execute(
        sa.text(
            """
            INSERT INTO component_ai_master (component_id, ai_master_id)
            SELECT repo.component_id, MIN(CAST(owner.ai_master_id AS CHAR(36)))
            FROM repo_ai_master AS owner
            JOIN component_repo AS repo ON repo.repo_key = owner.repo_key
            GROUP BY repo.component_id
            """
        )
    )
    op.drop_index("ix_repo_ai_master_master", table_name="repo_ai_master")
    op.drop_table("repo_ai_master")
