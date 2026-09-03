"""Add the 60-percent attribution bucket used by the testing dashboard."""

import sqlalchemy as sa
from alembic import op

revision = "0017_attributed_lines_60"
down_revision = "0016_ai_master"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "code_attribution",
        sa.Column("attributed_lines_60", sa.Integer(), nullable=True),
    )
    op.create_check_constraint(
        "ck_attribution_60_threshold_order",
        "code_attribution",
        "attributed_lines_60 IS NULL OR attributed_lines_80 <= attributed_lines_60",
    )
    op.create_check_constraint(
        "ck_attribution_60_not_over_total",
        "code_attribution",
        "attributed_lines_60 IS NULL OR attributed_lines_60 <= dev_effective_lines",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_attribution_60_not_over_total",
        "code_attribution",
        type_="check",
    )
    op.drop_constraint(
        "ck_attribution_60_threshold_order",
        "code_attribution",
        type_="check",
    )
    op.drop_column("code_attribution", "attributed_lines_60")
