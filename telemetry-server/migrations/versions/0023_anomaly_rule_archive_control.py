"""Add rule-level screening control and event-only screening targets.

Revision ID: 0023_anomaly_rule_archive_control
Revises: 0022_anomaly_events
"""

import sqlalchemy as sa
from alembic import op

revision = "0023_anomaly_rule_archive_control"
down_revision = "0022_anomaly_events"
branch_labels = None
depends_on = None


def _mysql_check_ddl_supported() -> bool:
    """MySQL 8.0.16 之前没有独立的 CHECK 约束对象。

    这些版本在 CREATE / ADD 时解析并忽略 CHECK，也没有 `DROP CHECK` 语法，
    所以库里根本不存在可改写的 `ck_anomaly_archive_target`。跳过相关的
    drop/create，语义上没有区别；照搬 DDL 反而会直接语法报错。

    离线渲染（`--sql`）拿不到服务端版本，按现代版本处理，保留原有输出。
    """
    bind = op.get_bind()
    if bind.dialect.name != "mysql":
        return True
    version = getattr(bind.dialect, "server_version_info", None)
    if version is None:
        return True
    return tuple(version[:3]) >= (8, 0, 16)


def upgrade() -> None:
    dialect = op.get_bind().dialect.name
    if dialect == "sqlite":
        # SQLite 没有独立约束对象，两条 CHECK 都在表定义里；batch 重建同时完成
        # 加列和放宽 target_type 约束（允许 'event'），不需要单独的 ALTER。
        with op.batch_alter_table("anomaly_rule") as batch:
            batch.add_column(
                sa.Column("allow_archive", sa.Boolean(), nullable=False, server_default=sa.true())
            )
        with op.batch_alter_table("anomaly_archive_request", recreate="always") as batch:
            batch.drop_constraint("ck_anomaly_archive_target", type_="check")
            batch.create_check_constraint(
                "ck_anomaly_archive_target",
                "target_type IN ('workflow', 'dev_run', 'attribution', 'event')",
            )
    elif dialect == "mysql":
        op.add_column(
            "anomaly_rule",
            sa.Column("allow_archive", sa.Boolean(), nullable=False, server_default=sa.true()),
        )
        if _mysql_check_ddl_supported():
            op.drop_constraint(
                "ck_anomaly_archive_target", "anomaly_archive_request", type_="check"
            )
            op.create_check_constraint(
                "ck_anomaly_archive_target",
                "anomaly_archive_request",
                "target_type IN ('workflow', 'dev_run', 'attribution', 'event')",
            )
        op.alter_column("anomaly_rule", "allow_archive", server_default=None)
    else:
        op.add_column(
            "anomaly_rule",
            sa.Column("allow_archive", sa.Boolean(), nullable=False, server_default=sa.true()),
        )
        op.drop_constraint(
            "ck_anomaly_archive_target", "anomaly_archive_request", type_="check"
        )
        op.create_check_constraint(
            "ck_anomaly_archive_target",
            "anomaly_archive_request",
            "target_type IN ('workflow', 'dev_run', 'attribution', 'event')",
        )


def downgrade() -> None:
    dialect = op.get_bind().dialect.name
    op.execute("DELETE FROM anomaly_archive_request WHERE target_type = 'event'")
    if dialect == "sqlite":
        with op.batch_alter_table("anomaly_archive_request", recreate="always") as batch:
            batch.drop_constraint("ck_anomaly_archive_target", type_="check")
            batch.create_check_constraint(
                "ck_anomaly_archive_target",
                "target_type IN ('workflow', 'dev_run', 'attribution')",
            )
    elif dialect != "mysql":
        op.drop_constraint(
            "ck_anomaly_archive_target", "anomaly_archive_request", type_="check"
        )
        op.create_check_constraint(
            "ck_anomaly_archive_target",
            "anomaly_archive_request",
            "target_type IN ('workflow', 'dev_run', 'attribution')",
        )
    op.drop_column("anomaly_rule", "allow_archive")
