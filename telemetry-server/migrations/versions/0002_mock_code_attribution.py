"""Add persisted mock code-attribution results.

Revision ID: 0002_mock_code_attribution
Revises: 0001_initial
"""

import sqlalchemy as sa
from alembic import op

revision = "0002_mock_code_attribution"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "code_attribution",
        sa.Column("dev_run_id", sa.Uuid(), nullable=False),
        sa.Column("dev_effective_lines", sa.Integer(), nullable=False),
        sa.Column("attributed_lines_80", sa.Integer(), nullable=False),
        sa.Column("attributed_lines_90", sa.Integer(), nullable=False),
        sa.Column("exact_match_lines", sa.Integer(), nullable=False),
        sa.Column("fuzzy_match_lines", sa.Integer(), nullable=False),
        sa.Column("block_match_lines", sa.Integer(), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.Column("quality_flags", sa.JSON(), nullable=False),
        sa.Column("result_status", sa.String(32), nullable=False),
        sa.Column("matched_mr_iid", sa.String(64), nullable=True),
        sa.Column("matched_mr_url", sa.String(2048), nullable=True),
        sa.Column("mr_diff_version", sa.String(64), nullable=True),
        sa.Column("mr_source_branch", sa.String(512), nullable=True),
        sa.Column("target_branch", sa.String(512), nullable=True),
        sa.Column("merge_commit_sha", sa.String(64), nullable=True),
        sa.Column("mr_merged_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("algorithm_version", sa.String(64), nullable=False),
        sa.Column("diff_rule_version", sa.String(64), nullable=False),
        sa.Column("matched_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("server_updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "result_status IN ('finalized_match', 'finalized_no_match')",
            name="ck_attribution_result_status",
        ),
        sa.CheckConstraint(
            "attributed_lines_90 <= attributed_lines_80",
            name="ck_attribution_threshold_order",
        ),
        sa.CheckConstraint(
            "attributed_lines_80 <= dev_effective_lines",
            name="ck_attribution_not_over_total",
        ),
        sa.ForeignKeyConstraint(["dev_run_id"], ["dev_run.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("dev_run_id"),
    )
    op.create_index(
        "ix_attribution_status_matched",
        "code_attribution",
        ["result_status", "matched_at"],
    )
    if op.get_bind().dialect.name == "postgresql":
        op.execute(
            sa.text(
                """
                WITH source AS (
                    SELECT
                        id,
                        branch,
                        head_sha_end,
                        completed_at,
                        GREATEST(0, (code_statistics->>'total_effective_lines')::integer) AS total
                    FROM dev_run
                    WHERE status = 'completed' AND code_statistics IS NOT NULL
                ), calculated AS (
                    SELECT
                        *,
                        CASE WHEN total = 0 THEN 0
                             ELSE LEAST(total, GREATEST(1, total * 80 / 100))
                        END AS lines80,
                        CASE WHEN total = 0 THEN 0
                             ELSE LEAST(
                                 total * 60 / 100,
                                 LEAST(total, GREATEST(1, total * 80 / 100))
                             )
                        END AS lines90,
                        ((abs(hashtext(id::text))::bigint % 900000) + 100000)::text AS mock_iid
                    FROM source
                )
                INSERT INTO code_attribution (
                    dev_run_id, dev_effective_lines, attributed_lines_80, attributed_lines_90,
                    exact_match_lines, fuzzy_match_lines, block_match_lines, confidence,
                    quality_flags, result_status, matched_mr_iid, matched_mr_url,
                    mr_diff_version, mr_source_branch, target_branch, merge_commit_sha,
                    mr_merged_at, algorithm_version, diff_rule_version, matched_at,
                    server_updated_at
                )
                SELECT
                    id, total, lines80, lines90,
                    lines80 * 60 / 100,
                    lines80 * 30 / 100,
                    lines80 - (lines80 * 60 / 100) - (lines80 * 30 / 100),
                    CASE WHEN lines80 > 0 THEN 0.8 ELSE 0.0 END,
                    '[\"mock_attribution\"]'::json,
                    CASE WHEN lines80 > 0 THEN 'finalized_match' ELSE 'finalized_no_match' END,
                    CASE WHEN lines80 > 0 THEN mock_iid ELSE NULL END,
                    CASE WHEN lines80 > 0
                         THEN 'https://example.invalid/mock/merge_requests/' || mock_iid
                         ELSE NULL
                    END,
                    CASE WHEN lines80 > 0 THEN 'mock-1' ELSE NULL END,
                    CASE WHEN lines80 > 0 THEN branch ELSE NULL END,
                    NULL,
                    CASE WHEN lines80 > 0 THEN head_sha_end ELSE NULL END,
                    CASE WHEN lines80 > 0 THEN completed_at ELSE NULL END,
                    'mock-v1', 'code-statistics-v1', COALESCE(completed_at, CURRENT_TIMESTAMP),
                    CURRENT_TIMESTAMP
                FROM calculated
                """
            )
        )


def downgrade() -> None:
    op.drop_index("ix_attribution_status_matched", table_name="code_attribution")
    op.drop_table("code_attribution")
