from __future__ import annotations

import importlib.util
import io
import sys
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory

from aaw_telemetry.config import get_settings

ROOT = Path(__file__).resolve().parents[1]
VERSIONS = ROOT / "migrations" / "versions"


def _load_migration(name: str):
    path = VERSIONS / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _scripts() -> ScriptDirectory:
    return ScriptDirectory.from_config(Config(str(ROOT / "alembic.ini")))


def _render(monkeypatch, *, revision_range: str, direction: str) -> str:
    """离线渲染指定区间的迁移 SQL（不连数据库）。

    env.py 从 settings 取库地址，所以要先把地址顶成 MySQL 再清 settings 缓存，
    才能拿到 MySQL 方言的 DDL——纯 SQLite 的测试库抓不到方言相关的迁移缺陷。
    """
    monkeypatch.setenv(
        "AAW_TELEMETRY_DATABASE_URL", "mysql+pymysql://user:pw@localhost/telemetry"
    )
    get_settings.cache_clear()
    buffer = io.StringIO()
    original, sys.stdout = sys.stdout, buffer
    try:
        run = command.upgrade if direction == "upgrade" else command.downgrade
        run(Config(str(ROOT / "alembic.ini")), revision_range, sql=True)
    finally:
        sys.stdout = original
        get_settings.cache_clear()
    return buffer.getvalue()


def test_migration_graph_has_one_head() -> None:
    assert _scripts().get_heads() == ["0026_anomaly_rule_unique_scope"]


def test_merge_revision_joins_both_schema_branches() -> None:
    revision = _scripts().get_revision("0014_merge_diff_archive_heads")

    assert revision is not None
    assert set(revision._normalized_down_revisions) == {
        "0012_diff_archive",
        "0013_mr_commit_lines",
    }


@pytest.mark.parametrize(
    ("direction", "revision_range"),
    [("upgrade", "0024:0025"), ("downgrade", "0025:0024")],
)
def test_mysql_render_avoids_batch_temp_table(monkeypatch, direction, revision_range) -> None:
    """MySQL 上的迁移不能走 batch 重建：临时表会复制原表外键名而撞唯一性约束。"""
    sql = _render(
        monkeypatch,
        revision_range=revision_range,
        direction=direction,
    )

    assert "_alembic_tmp_" not in sql
    assert "CREATE TABLE" not in sql
    assert "ALTER TABLE anomaly_archive_request" in sql


@pytest.mark.parametrize(
    ("version", "expected"),
    [((5, 7, 44), False), ((8, 0, 15), False), ((8, 0, 16), True), ((8, 0, 36), True)],
)
def test_mysql_check_ddl_guard_tracks_server_version(version, expected) -> None:
    """低版本 MySQL 没有 CHECK 约束对象，drop/create 会被跳过而不是报语法错。"""
    module = _load_migration("0023_anomaly_rule_archive_control")

    class _Dialect:
        name = "mysql"
        server_version_info = version

    class _Bind:
        dialect = _Dialect()

    class _Op:
        @staticmethod
        def get_bind():
            return _Bind()

    original, module.op = module.op, _Op()
    try:
        assert module._mysql_check_ddl_supported() is expected
    finally:
        module.op = original


@pytest.mark.parametrize(
    ("direction", "revision_range", "constraint"),
    [
        ("upgrade", "0022:0023", "ck_anomaly_archive_target"),
        ("downgrade", "0025:0024", "ck_anomaly_archive_source"),
    ],
)
def test_offline_render_keeps_check_ddl_for_modern_mysql(
    monkeypatch, direction, revision_range, constraint
) -> None:
    """离线渲染拿不到服务端版本，按现代版本保留 drop/create，不悄悄改变 SQL。

    低版本 MySQL 由 `_mysql_check_ddl_supported()` 在联机时跳过这些 DDL。
    """
    sql = _render(monkeypatch, revision_range=revision_range, direction=direction)

    assert f"DROP CHECK {constraint}" in sql


def test_downgrade_drops_tables_without_touching_fk_backed_indexes(monkeypatch) -> None:
    """0022 回滚时不能单独 drop_index：MySQL 会因外键仍在用它而报 1553。"""
    sql = _render(monkeypatch, revision_range="0022:0021", direction="downgrade")

    assert "DROP INDEX" not in sql
    assert "DROP TABLE anomaly_action" in sql


def _sqlite_upgrade(url: str, revision: str, monkeypatch) -> None:
    monkeypatch.setenv("AAW_TELEMETRY_DATABASE_URL", url)
    get_settings.cache_clear()
    try:
        command.upgrade(Config(str(ROOT / "alembic.ini")), revision)
    finally:
        get_settings.cache_clear()


def test_dedupe_collapses_concurrent_rules_and_closes_their_events(tmp_path, monkeypatch):
    """0026 建唯一索引前先收敛存量重复行，且不静默丢事件。"""
    import uuid
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import create_engine, text

    url = f"sqlite+pysqlite:///{(tmp_path / 'dup.db').as_posix()}"
    _sqlite_upgrade(url, "0025_archive_request_source", monkeypatch)
    engine = create_engine(url)
    now = datetime.now(UTC).replace(microsecond=0)
    # 两条重复规则拉开 1 秒：保留最早那条，避免同秒下靠 id 排序变得不确定。
    stamps = [
        (now + timedelta(seconds=index)).strftime("%Y-%m-%d %H:%M:%S.%f")
        for index in range(2)
    ]
    events: list[str] = []
    with engine.begin() as conn:
        for index in range(2):
            rule_id = uuid.uuid4().hex
            stamp = stamps[index]
            conn.execute(
                text(
                    "INSERT INTO anomaly_rule (id, name, category, detector_type, scope_type,"
                    " scope_value, params, allow_archive, status, version, change_reason,"
                    " created_by, updated_by, created_at, updated_at)"
                    " VALUES (:id, :name, 'component', 'telemetry_gap', 'platform', NULL,"
                    " '{}', 1, :status, 1, '并发创建', 'rival', 'rival', :ts, :ts)"
                ),
                {
                    "id": rule_id,
                    "name": "数据上报中断",
                    "status": "enabled" if index == 1 else "disabled",
                    "ts": stamp,
                },
            )
            if index == 1:
                event_id = uuid.uuid4().hex
                conn.execute(
                    text(
                        "INSERT INTO anomaly_event (id, rule_id, rule_version, rule_snapshot,"
                        " category, detector_type, object_type, object_key, occurrence,"
                        " active_key, title, summary, evidence, detail_target,"
                        " detection_status, disposition, hit_count,"
                        " first_detected_at, last_detected_at, updated_at)"
                        " VALUES (:id, :rule, 1, '{}', 'component', 'telemetry_gap',"
                        " 'platform', 'k', 1, 'live-key', 't', 's', '{}', '{}',"
                        " 'active', 'open', 1, :ts, :ts, :ts)"
                    ),
                    {"id": event_id, "rule": rule_id, "ts": stamp},
                )
                events.append(event_id)

    _sqlite_upgrade(url, "head", monkeypatch)

    with engine.connect() as conn:
        active = conn.execute(
            text(
                "SELECT id, status FROM anomaly_rule"
                " WHERE detector_type = 'telemetry_gap' AND status <> 'deleted'"
            )
        ).all()
        assert len(active) == 1
        # 保留最早一条，但重复行里的启用状态要带过来，检测不能静默关掉。
        assert active[0].status == "enabled"
        deleted = conn.execute(
            text(
                "SELECT id FROM anomaly_rule"
                " WHERE detector_type = 'telemetry_gap' AND status = 'deleted'"
            )
        ).all()
        assert len(deleted) == 1
        event = conn.execute(
            text(
                "SELECT detection_status, closed_reason, active_key, disposition"
                " FROM anomaly_event WHERE id = :id"
            ),
            {"id": events[0]},
        ).one()
        assert tuple(event) == ("recovered", "rule_deleted", None, "open")
        audited = conn.execute(
            text(
                "SELECT COUNT(*) FROM anomaly_rule_audit"
                " WHERE rule_id = :id AND action = 'deleted'"
            ),
            {"id": deleted[0].id},
        ).scalar()
        assert audited == 1
        # 保留行的启用状态变更同样留痕，与删除行对称。
        promoted = conn.execute(
            text(
                "SELECT version, reason FROM anomaly_rule_audit"
                " WHERE rule_id = :id AND action = 'enabled'"
            ),
            {"id": active[0].id},
        ).one()
        assert promoted.version == 2
        assert "启用状态" in promoted.reason

    # 唯一性已生效：再插一条同检测类型的活跃规则必须被拒。
    with engine.begin() as conn:
        try:
            conn.execute(
                text(
                    "INSERT INTO anomaly_rule (id, name, category, detector_type, scope_type,"
                    " scope_value, params, allow_archive, status, version, created_by,"
                    " updated_by, created_at, updated_at)"
                    " VALUES (:id, 'x', 'component', 'telemetry_gap', 'platform', NULL, '{}',"
                    " 1, 'disabled', 1, 'r', 'r', :ts, :ts)"
                ),
                {"id": uuid.uuid4().hex, "ts": stamps[-1]},
            )
        except Exception as exc:  # noqa: BLE001 - 只关心它是完整性错误
            assert "UNIQUE" in str(exc).upper()
        else:  # pragma: no cover - 约束失效才会走到这里
            raise AssertionError("重复规则未被唯一索引拦住")
