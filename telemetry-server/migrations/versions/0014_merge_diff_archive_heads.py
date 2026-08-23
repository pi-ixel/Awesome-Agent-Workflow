"""Merge the diff-archive and workflow-entry migration branches.

Revision ID: 0014_merge_diff_archive_heads
Revises: 0012_diff_archive, 0013_mr_commit_lines
"""

revision = "0014_merge_diff_archive_heads"
down_revision = ("0012_diff_archive", "0013_mr_commit_lines")
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Join the two existing schema branches without additional changes."""


def downgrade() -> None:
    """Split the version graph back into its two parent branches."""
