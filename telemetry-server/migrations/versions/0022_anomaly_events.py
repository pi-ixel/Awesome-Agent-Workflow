"""Add configurable anomaly rules, occurrences, actions and archive review.

Revision ID: 0022_anomaly_events
Revises: 0021_repo_ai_master
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

revision = "0022_anomaly_events"
down_revision = "0021_repo_ai_master"
branch_labels = None
depends_on = None

_DATETIME = sa.DateTime(timezone=True).with_variant(mysql.DATETIME(fsp=3), "mysql")


def upgrade() -> None:
    op.create_table(
        "anomaly_rule",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("category", sa.String(32), nullable=False),
        sa.Column("detector_type", sa.String(64), nullable=False),
        sa.Column("scope_type", sa.String(32), nullable=False),
        sa.Column("scope_value", sa.String(256), nullable=True),
        sa.Column("params", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("change_reason", sa.String(512), nullable=True),
        sa.Column("created_by", sa.String(128), nullable=False),
        sa.Column("updated_by", sa.String(128), nullable=False),
        sa.Column("created_at", _DATETIME, nullable=False),
        sa.Column("updated_at", _DATETIME, nullable=False),
        sa.Column("last_evaluated_at", _DATETIME, nullable=True),
        sa.Column("last_match_count", sa.Integer(), nullable=True),
        sa.CheckConstraint(
            "category IN ('component', 'workflow', 'attribution', 'version')",
            name="ck_anomaly_rule_category",
        ),
        sa.CheckConstraint(
            "scope_type IN ('platform', 'component', 'repository')",
            name="ck_anomaly_rule_scope",
        ),
        sa.CheckConstraint(
            "status IN ('draft', 'enabled', 'disabled', 'deleted')",
            name="ck_anomaly_rule_status",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_anomaly_rule_status_type", "anomaly_rule", ["status", "detector_type"])

    op.create_table(
        "anomaly_rule_audit",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("rule_id", sa.Uuid(), nullable=False),
        sa.Column("action", sa.String(32), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("before", sa.JSON(), nullable=True),
        sa.Column("after", sa.JSON(), nullable=True),
        sa.Column("reason", sa.String(512), nullable=True),
        sa.Column("operator", sa.String(128), nullable=False),
        sa.Column("created_at", _DATETIME, nullable=False),
        sa.ForeignKeyConstraint(["rule_id"], ["anomaly_rule.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_anomaly_rule_audit_rule_time", "anomaly_rule_audit", ["rule_id", "created_at"]
    )

    op.create_table(
        "anomaly_event",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("rule_id", sa.Uuid(), nullable=False),
        sa.Column("rule_version", sa.Integer(), nullable=False),
        sa.Column("rule_snapshot", sa.JSON(), nullable=False),
        sa.Column("category", sa.String(32), nullable=False),
        sa.Column("detector_type", sa.String(64), nullable=False),
        sa.Column("object_type", sa.String(32), nullable=False),
        sa.Column("object_key", sa.String(256), nullable=False),
        sa.Column("occurrence", sa.Integer(), nullable=False),
        sa.Column("active_key", sa.String(64), nullable=True),
        sa.Column("component_id", sa.String(128), nullable=True),
        sa.Column("repository", sa.String(256), nullable=True),
        sa.Column("user_email", sa.String(320), nullable=True),
        sa.Column("ai_master_id", sa.Uuid(), nullable=True),
        sa.Column("title", sa.String(256), nullable=False),
        sa.Column("summary", sa.String(1000), nullable=False),
        sa.Column("actual_value", sa.String(256), nullable=True),
        sa.Column("threshold_value", sa.String(256), nullable=True),
        sa.Column("evidence", sa.JSON(), nullable=False),
        sa.Column("detail_target", sa.JSON(), nullable=False),
        sa.Column("detection_status", sa.String(16), nullable=False),
        sa.Column("disposition", sa.String(24), nullable=False),
        sa.Column("closed_reason", sa.String(64), nullable=True),
        sa.Column("first_detected_at", _DATETIME, nullable=False),
        sa.Column("last_detected_at", _DATETIME, nullable=False),
        sa.Column("recovered_at", _DATETIME, nullable=True),
        sa.Column("hit_count", sa.Integer(), nullable=False),
        sa.Column("updated_at", _DATETIME, nullable=False),
        sa.CheckConstraint(
            "detection_status IN ('active', 'recovered')",
            name="ck_anomaly_event_detection",
        ),
        sa.CheckConstraint(
            "disposition IN ('open', 'archive_pending', 'archived', 'issue_created')",
            name="ck_anomaly_event_disposition",
        ),
        sa.ForeignKeyConstraint(["ai_master_id"], ["ai_master.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["rule_id"], ["anomaly_rule.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("active_key", name="uq_anomaly_event_active_key"),
        sa.UniqueConstraint(
            "rule_id",
            "object_type",
            "object_key",
            "occurrence",
            name="uq_anomaly_event_occurrence",
        ),
    )
    op.create_index(
        "ix_anomaly_event_owner_open",
        "anomaly_event",
        ["ai_master_id", "detection_status", "disposition"],
    )
    op.create_index(
        "ix_anomaly_event_rule_object",
        "anomaly_event",
        ["rule_id", "object_type", "object_key"],
    )

    op.create_table(
        "anomaly_archive_request",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("event_id", sa.Uuid(), nullable=False),
        sa.Column("target_type", sa.String(32), nullable=False),
        sa.Column("target_id", sa.String(256), nullable=False),
        sa.Column("reason", sa.String(1000), nullable=False),
        sa.Column("impact_preview", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("requested_by", sa.String(128), nullable=False),
        sa.Column("reviewed_by", sa.String(128), nullable=True),
        sa.Column("review_note", sa.String(1000), nullable=True),
        sa.Column("created_at", _DATETIME, nullable=False),
        sa.Column("reviewed_at", _DATETIME, nullable=True),
        sa.CheckConstraint(
            "target_type IN ('workflow', 'dev_run', 'attribution')",
            name="ck_anomaly_archive_target",
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'approved', 'rejected', 'cancelled')",
            name="ck_anomaly_archive_status",
        ),
        sa.ForeignKeyConstraint(["event_id"], ["anomaly_event.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_anomaly_archive_status_time",
        "anomaly_archive_request",
        ["status", "created_at"],
    )

    op.create_table(
        "anomaly_issue_link",
        sa.Column("event_id", sa.Uuid(), nullable=False),
        sa.Column("issue_id", sa.Uuid(), nullable=False),
        sa.Column("created_by", sa.String(128), nullable=False),
        sa.Column("created_at", _DATETIME, nullable=False),
        sa.ForeignKeyConstraint(["event_id"], ["anomaly_event.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["issue_id"], ["issue.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("event_id"),
        sa.UniqueConstraint("issue_id"),
    )

    op.create_table(
        "anomaly_action",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("event_id", sa.Uuid(), nullable=False),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("actor", sa.String(128), nullable=False),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.Column("created_at", _DATETIME, nullable=False),
        sa.ForeignKeyConstraint(["event_id"], ["anomaly_event.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_anomaly_action_event_time", "anomaly_action", ["event_id", "created_at"])


def downgrade() -> None:
    # 只按依赖顺序删表，不单独 drop_index：MySQL 会复用外键所需的索引，
    # 显式删掉这些索引会报 "needed in a foreign key constraint"（1553）。
    # drop_table 会连同索引一起清掉，其余方言同样如此。
    op.drop_table("anomaly_action")
    op.drop_table("anomaly_issue_link")
    op.drop_table("anomaly_archive_request")
    op.drop_table("anomaly_event")
    op.drop_table("anomaly_rule_audit")
    op.drop_table("anomaly_rule")
