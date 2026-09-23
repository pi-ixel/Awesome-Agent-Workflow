"""Archive requests can originate from the admin console without an event.

Revision ID: 0025_archive_request_source
Revises: 0024_telemetry_filter_config
"""

import sqlalchemy as sa
from alembic import op

revision = "0025_archive_request_source"
down_revision = "0024_telemetry_filter_config"
branch_labels = None
depends_on = None

_SOURCE_CHECK = "source IN ('event', 'admin_console')"


def _mysql_check_ddl_supported() -> bool:
    """MySQL 8.0.16 之前没有独立的 CHECK 约束对象，也没有 `DROP CHECK` 语法。

    低版本在 ADD 时解析并忽略 CHECK，库里取不到对应约束；回滚时跳过
    drop 才不会语法报错（约束本来也不存在）。离线渲染按现代版本处理。
    """
    bind = op.get_bind()
    if bind.dialect.name != "mysql":
        return True
    version = getattr(bind.dialect, "server_version_info", None)
    if version is None:
        return True
    return tuple(version[:3]) >= (8, 0, 16)


def upgrade() -> None:
    # event_id 放开为可空：业务页（工作流/归因）直接发起的申请没有异常事件。
    # source 标记发起入口：event=异常事件页，admin_console=业务运营页。
    if op.get_bind().dialect.name == "sqlite":
        # SQLite 改列与约束只能重建表；重建后列上的 server_default 一并消失。
        with op.batch_alter_table("anomaly_archive_request", recreate="always") as batch:
            batch.alter_column("event_id", existing_type=sa.Uuid(), nullable=True)
            batch.add_column(
                sa.Column("source", sa.String(32), nullable=False, server_default="event")
            )
            batch.create_check_constraint("ck_anomaly_archive_source", _SOURCE_CHECK)
        return
    # MySQL / PostgreSQL 走原生 DDL：batch 重建会把原表的外键约束名复制到临时
    # 表上，而 MySQL 要求约束名全库唯一，于是 `_alembic_tmp_*` 建表直接报
    # duplicate key。加列、改可空、建 CHECK 原生都支持，不需要重建表。
    # CHECK 约束需要 MySQL 8.0.16+，更低版本会被解析后忽略。
    op.alter_column(
        "anomaly_archive_request",
        "event_id",
        existing_type=sa.Uuid(),
        existing_nullable=False,
        nullable=True,
    )
    op.add_column(
        "anomaly_archive_request",
        sa.Column("source", sa.String(32), nullable=False, server_default="event"),
    )
    op.create_check_constraint(
        "ck_anomaly_archive_source", "anomaly_archive_request", _SOURCE_CHECK
    )
    # server_default 只为让存量行拿到取值，之后撤掉，避免遗漏写入时静默兜底。
    op.alter_column("anomaly_archive_request", "source", server_default=None)


def downgrade() -> None:
    op.execute("DELETE FROM anomaly_archive_request WHERE event_id IS NULL")
    if op.get_bind().dialect.name == "sqlite":
        with op.batch_alter_table("anomaly_archive_request", recreate="always") as batch:
            batch.drop_constraint("ck_anomaly_archive_source", type_="check")
            batch.drop_column("source")
            batch.alter_column("event_id", existing_type=sa.Uuid(), nullable=False)
        return
    if _mysql_check_ddl_supported():
        op.drop_constraint(
            "ck_anomaly_archive_source", "anomaly_archive_request", type_="check"
        )
    op.drop_column("anomaly_archive_request", "source")
    op.alter_column(
        "anomaly_archive_request",
        "event_id",
        existing_type=sa.Uuid(),
        existing_nullable=True,
        nullable=False,
    )
