from __future__ import annotations

import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest

from aaw_skill_eval.models import Experiment, Run
from aaw_skill_eval.services.orchestration.execution import finish_experiment, prepare_retry
from aaw_skill_eval.services.workspace import cleanup as cleanup_module
from aaw_skill_eval.services.workspace.cleanup import (
    cleanup_orphan_workspaces,
    cleanup_run_workspace,
    mark_workspace_retained,
    remove_run_workspace_dirs,
    workspace_usage,
)
from aaw_skill_eval.services.workspace.paths import run_workspace


def _create_experiment_with_run(
    factory,
    tmp_path: Path,
    *,
    run_status: str = "completed",
    retained: bool = True,
    error_kind: str | None = None,
    cancel_requested: bool = False,
) -> tuple[str, str]:
    from aaw_skill_eval.models import Skill, SkillRevision, Suite

    snapshot = tmp_path / "snapshot-fixture"
    snapshot.mkdir(exist_ok=True)
    with factory() as session:
        skill = Skill(name=f"cleanup-skill-{uuid.uuid4().hex[:12]}", source_path=str(tmp_path))
        session.add(skill)
        session.flush()
        revision = SkillRevision(
            skill_id=skill.id,
            content_hash="a" * 64,
            snapshot_path=str(snapshot),
            source_path=str(tmp_path),
        )
        session.add(revision)
        session.flush()
        suite = Suite(
            name=f"cleanup-suite-{uuid.uuid4().hex[:12]}",
            skill_id=skill.id,
            project_path=str(tmp_path),
            definition_path=str(tmp_path / "fixture.json"),
            definition_hash="b" * 64,
            definition_json="{}",
        )
        session.add(suite)
        session.flush()
        experiment = Experiment(
            suite_id=suite.id,
            current_revision_id=revision.id,
            project_commit="c" * 40,
            suite_hash="d" * 64,
            profile_hash="e" * 64,
            profile_json="{}",
            suite_snapshot_json="{}",
            mode="quick",
            trials=1,
            seed=1,
            status="running" if run_status in {"queued", "running"} else "completed",
            cancel_requested_at=datetime.now(UTC) if cancel_requested else None,
        )
        session.add(experiment)
        session.flush()
        run = Run(
            experiment_id=experiment.id,
            case_id="case",
            group_name="current",
            trial_index=1,
            anonymous_id="anon",
            status=run_status,
            error_kind=error_kind,
            workspace_retained=retained,
            completed_at=None if run_status in {"queued", "running"} else datetime.now(UTC),
        )
        session.add(run)
        session.commit()
        return experiment.id, run.id


def _write_workspace(settings, experiment_id: str, run_id: str, marker: str = "x") -> Path:
    root = run_workspace(settings, experiment_id, run_id)
    root.mkdir(parents=True, exist_ok=True)
    (root / "marker.txt").write_text(marker, encoding="utf-8")
    return root


def test_cleanup_run_workspace_removes_retained_dir(client, tmp_path: Path):
    settings = client.app.state.settings
    factory = client.app.state.session_factory
    experiment_id, run_id = _create_experiment_with_run(factory, tmp_path)
    root = _write_workspace(settings, experiment_id, run_id)

    result = cleanup_run_workspace(settings, factory, run_id)

    assert result["removed"] and result["failed"] == [] and "skipped" not in result
    assert not root.exists()
    with factory() as session:
        assert session.get(Run, run_id).workspace_retained is False


def test_cleanup_run_workspace_refuses_active_run(client, tmp_path: Path):
    settings = client.app.state.settings
    factory = client.app.state.session_factory
    experiment_id, run_id = _create_experiment_with_run(factory, tmp_path, run_status="running")
    root = _write_workspace(settings, experiment_id, run_id)

    result = cleanup_run_workspace(settings, factory, run_id)

    assert result["skipped"] and result["removed"] == []
    assert root.exists()  # 运行中的现场绝不触碰


def test_cleanup_run_workspace_without_dir_marks_not_retained(client, tmp_path: Path):
    settings = client.app.state.settings
    factory = client.app.state.session_factory
    _, run_id = _create_experiment_with_run(factory, tmp_path)

    result = cleanup_run_workspace(settings, factory, run_id)

    assert result["removed"] == [] and result["failed"] == []
    with factory() as session:
        assert session.get(Run, run_id).workspace_retained is False


def test_remove_run_workspace_dirs_retries_through_file_locks(client, tmp_path: Path, monkeypatch):
    settings = client.app.state.settings
    factory = client.app.state.session_factory
    experiment_id, run_id = _create_experiment_with_run(factory, tmp_path)
    root = _write_workspace(settings, experiment_id, run_id)

    real_rmtree = cleanup_module.shutil.rmtree
    failures = {"count": 0}

    def flaky_rmtree(path, *args, **kwargs):
        if failures["count"] < 2:  # 前两次模拟 Windows 文件锁
            failures["count"] += 1
            raise OSError("being used by another process")
        return real_rmtree(path, *args, **kwargs)

    monkeypatch.setattr(cleanup_module.shutil, "rmtree", flaky_rmtree)
    result = remove_run_workspace_dirs(settings, experiment_id, run_id, 1)
    assert result["removed"] and result["failed"] == [] and failures["count"] == 2
    assert not root.exists()


def test_prepare_retry_deletes_old_attempt_workspace(client, tmp_path: Path):
    settings = client.app.state.settings
    factory = client.app.state.session_factory
    experiment_id, run_id = _create_experiment_with_run(
        factory, tmp_path, run_status="failed", error_kind="timeout"
    )
    old_root = _write_workspace(settings, experiment_id, run_id)

    run = prepare_retry(settings, factory, run_id)

    assert run.current_attempt == 2 and run.status == "queued"
    assert not old_root.exists()  # 重试入队即废弃旧现场


def test_mark_service_restart_discards_interrupted_workspaces(client, tmp_path: Path):
    from aaw_skill_eval.jobs import mark_service_restart

    settings = client.app.state.settings
    factory = client.app.state.session_factory
    experiment_id, run_id = _create_experiment_with_run(factory, tmp_path, run_status="running")
    with factory() as session:
        session.get(Experiment, experiment_id).status = "running"
        session.commit()
    root = _write_workspace(settings, experiment_id, run_id)

    mark_service_restart(settings, factory)

    with factory() as session:
        run = session.get(Run, run_id)
        assert run.status == "infra_error"
        assert run.workspace_retained is False  # 中断现场已废弃并删除
    assert not root.exists()


def test_finish_experiment_cancel_discards_all_workspaces(client, tmp_path: Path):
    settings = client.app.state.settings
    factory = client.app.state.session_factory
    experiment_id, failed_run_id = _create_experiment_with_run(
        factory, tmp_path, run_status="failed", error_kind="infra_error", cancel_requested=True
    )
    failed_root = _write_workspace(settings, experiment_id, failed_run_id)

    finish_experiment(settings, factory, experiment_id)

    with factory() as session:
        experiment = session.get(Experiment, experiment_id)
        assert experiment.status == "cancelled"
        # 已终态的 run 保留原状态记录（清理只删目录，不改记录）
        assert experiment.runs[0].status == "failed"
    assert not failed_root.exists()  # 取消的实验整体废弃，现场随收尾删除


def test_cleanup_orphan_workspaces_removes_only_unrecorded_dirs(client, tmp_path: Path):
    settings = client.app.state.settings
    factory = client.app.state.session_factory
    experiment_id, run_id = _create_experiment_with_run(factory, tmp_path)
    recorded_root = _write_workspace(settings, experiment_id, run_id)
    orphan_experiment = settings.workspaces_dir / "deadbeefdeadbeef"
    orphan_experiment.mkdir(parents=True)
    (orphan_experiment / "junk.txt").write_text("orphan", encoding="utf-8")
    orphan_run = settings.workspaces_dir / experiment_id / "runs" / "ghost12345678"
    orphan_run.mkdir(parents=True)
    # base 克隆源无查看价值：即便实验有记录也一律启动即删
    base_dir = settings.workspaces_dir / experiment_id / "base"
    base_dir.mkdir(parents=True)
    (base_dir / "marker.txt").write_text("base", encoding="utf-8")

    removed = cleanup_orphan_workspaces(settings, factory)

    assert removed == 3
    assert recorded_root.exists()  # 数据库有记录的现场一律保留
    assert not orphan_experiment.exists()
    assert not orphan_run.exists()
    assert not base_dir.exists()


def test_workspace_usage_reports_per_run_sizes(client, tmp_path: Path):
    settings = client.app.state.settings
    factory = client.app.state.session_factory
    experiment_id, run_id = _create_experiment_with_run(factory, tmp_path)
    root = _write_workspace(settings, experiment_id, run_id, marker="12345678")

    usage = workspace_usage(settings, factory, experiment_id)

    assert usage["runs"][run_id] == len("12345678")
    assert usage["total_bytes"] == len("12345678")
    assert root.exists()


def test_mark_workspace_retained_roundtrip(client, tmp_path: Path):
    factory = client.app.state.session_factory
    _, run_id = _create_experiment_with_run(factory, tmp_path, retained=False)

    mark_workspace_retained(factory, run_id, retained=True)
    with factory() as session:
        assert session.get(Run, run_id).workspace_retained is True
    mark_workspace_retained(factory, run_id, retained=False)
    with factory() as session:
        assert session.get(Run, run_id).workspace_retained is False


def test_workspace_cleanup_api_endpoints(client, tmp_path: Path):
    settings = client.app.state.settings
    factory = client.app.state.session_factory
    experiment_id, run_id = _create_experiment_with_run(factory, tmp_path)
    root = _write_workspace(settings, experiment_id, run_id)

    # 未知 run → 404
    assert client.post("/api/v1/runs/nonexistent/workspace-cleanup").status_code == 404

    # 单 run 清理
    response = client.post(f"/api/v1/runs/{run_id}/workspace-cleanup")
    assert response.status_code == 200
    assert response.json()["removed"]
    assert not root.exists()

    # 重建现场后：实验级清理
    root = _write_workspace(settings, experiment_id, run_id)
    response = client.post(f"/api/v1/experiments/{experiment_id}/workspace-cleanup")
    assert response.status_code == 200
    assert response.json()["removed"] and response.json()["skipped"] == []
    assert not root.exists()

    # 占用查询
    _write_workspace(settings, experiment_id, run_id)
    response = client.get(f"/api/v1/experiments/{experiment_id}/workspace-usage")
    assert response.status_code == 200
    body = response.json()
    assert body["runs"][run_id] > 0 and body["total_bytes"] > 0


def test_workspace_cleanup_api_skips_running(client, tmp_path: Path):
    factory = client.app.state.session_factory
    experiment_id, run_id = _create_experiment_with_run(factory, tmp_path, run_status="running")

    response = client.post(f"/api/v1/runs/{run_id}/workspace-cleanup")

    assert response.status_code == 200
    assert "不能清理现场" in response.json()["skipped"]


@pytest.mark.parametrize(
    "scenario,status,expected_button",
    [
        ("retained-terminal", "completed", True),
        ("running", "running", False),
    ],
)
def test_run_actions_show_workspace_cleanup_button(
    scenario, status, expected_button, tmp_path: Path
):
    """前端：终态且现场在盘的 run 显示"清理现场"，运行中的不显示。"""
    from test_detail_page_structure import _node_available, _run_scenario

    if not _node_available():
        pytest.skip("node is required to load app.js")
    scenario_js = f"""
    const run = {{
      id: "run-1", status: {status!r}, error_kind: null, current_attempt: 1,
      artifact_available: true, reviews: [], workspace_retained: true,
    }};
    const markup = runActions({{runs: []}}, run);
    console.log(JSON.stringify({{
      hasCleanButton: markup.includes('data-clean-workspace="run-1"')
    }}));
    """
    result = _run_scenario(tmp_path, scenario_js)
    assert result["hasCleanButton"] is expected_button
