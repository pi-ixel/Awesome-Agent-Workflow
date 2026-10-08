from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from aaw_skill_eval.services.workspace.cleanup import cleanup_expired_workspaces
from aaw_skill_eval.services.workspace.paths import run_workspace


def test_cleanup_removes_only_expired_retained_workspace(client, tmp_path: Path):
    app = client.app
    settings = app.state.settings
    factory = app.state.session_factory

    from aaw_skill_eval.models import Experiment, Run, Skill, SkillRevision, Suite

    snapshot = settings.snapshots_dir / "fixture"
    snapshot.mkdir()
    definition = settings.suites_dir / "fixture.json"
    definition.write_text("{}", encoding="utf-8")
    with factory() as session:
        skill = Skill(name="cleanup-skill", source_path=str(tmp_path))
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
            name="cleanup-suite",
            skill_id=skill.id,
            project_path=str(tmp_path),
            definition_path=str(definition),
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
            status="completed",
        )
        session.add(experiment)
        session.flush()
        run = Run(
            experiment_id=experiment.id,
            case_id="case",
            group_name="current",
            trial_index=1,
            anonymous_id="anon",
            status="infra_error",
            workspace_retained=True,
            completed_at=datetime.now(UTC) - timedelta(days=8),
        )
        session.add(run)
        session.commit()
        run_id, experiment_id = run.id, experiment.id

    run_root = settings.workspaces_dir / experiment_id / "runs" / run_id
    run_root.mkdir(parents=True)
    (run_root / "marker.txt").write_text("retained", encoding="utf-8")
    short_root = run_workspace(settings, experiment_id, run_id)
    short_root.mkdir(parents=True)
    (short_root / "marker.txt").write_text("retained", encoding="utf-8")
    assert len(str(run_root)) - len(str(short_root)) >= 40

    assert cleanup_expired_workspaces(settings, factory) == 1
    assert not run_root.exists()
    assert not short_root.exists()
    with factory() as session:
        assert session.get(Run, run_id).workspace_retained is False
