from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory

ROOT = Path(__file__).resolve().parents[1]


def _scripts() -> ScriptDirectory:
    return ScriptDirectory.from_config(Config(str(ROOT / "alembic.ini")))


def test_migration_graph_has_one_head() -> None:
    assert _scripts().get_heads() == ["0015_dashboard_perf_indexes"]


def test_merge_revision_joins_both_schema_branches() -> None:
    revision = _scripts().get_revision("0014_merge_diff_archive_heads")

    assert revision is not None
    assert set(revision._normalized_down_revisions) == {
        "0012_diff_archive",
        "0013_mr_commit_lines",
    }
