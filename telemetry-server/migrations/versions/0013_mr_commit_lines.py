"""Store the matched MR added-line count returned by attribution."""

import sqlalchemy as sa
from alembic import op

revision = "0013_mr_commit_lines"
down_revision = "0012_workflow_entry"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "code_attribution",
        sa.Column("mr_commit_lines", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("code_attribution", "mr_commit_lines")
