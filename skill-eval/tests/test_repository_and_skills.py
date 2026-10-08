from __future__ import annotations

from pathlib import Path

import pytest

from aaw_skill_eval.errors import EvalError
from aaw_skill_eval.services.catalog.skills import (
    inspect_skill,
    install_snapshot,
    prepare_eval_workspace,
)
from aaw_skill_eval.services.workspace.repository import (
    capture_changes,
    clone_at_commit,
    file_tree_manifest,
    inspect_clean_project,
)


def test_clean_project_returns_immutable_git_identity(project: Path):
    snapshot = inspect_clean_project(project)
    assert snapshot.path == project.resolve()
    assert len(snapshot.commit) == 40
    assert len(snapshot.tree) == 40


def test_dirty_project_is_rejected(project: Path):
    (project / "untracked.txt").write_text("dirty", encoding="utf-8")
    with pytest.raises(EvalError, match="clean working tree") as error:
        inspect_clean_project(project)
    assert error.value.code == "PROJECT_DIRTY"


def test_skill_hash_covers_references(skill: Path):
    first = inspect_skill(skill, 1024 * 1024)
    (skill / "references" / "guide.md").write_text("Changed.\n", encoding="utf-8")
    second = inspect_skill(skill, 1024 * 1024)
    assert first.name == "example-skill"
    assert first.content_hash != second.content_hash


def test_invalid_skill_name_is_rejected(skill: Path):
    skill_md = skill / "SKILL.md"
    skill_md.write_text(
        "---\nname: ../escape\ndescription: bad\n---\n",
        encoding="utf-8",
    )
    with pytest.raises(EvalError) as error:
        inspect_skill(skill, 1024 * 1024)
    assert error.value.code == "INVALID_SKILL_NAME"


def test_injected_eval_skill_is_excluded_from_candidate_evidence(
    project: Path,
    skill: Path,
    tmp_path: Path,
):
    workspace = tmp_path / "workspace"
    clone_at_commit(inspect_clean_project(project), workspace)
    prepare_eval_workspace(workspace)
    install_snapshot(skill, workspace, "example-skill", provider="codex")
    changes = capture_changes(workspace)
    paths = [item["path"] for item in file_tree_manifest(workspace)]
    assert changes["changed_files"] == []
    assert not any(path.startswith((".aaw-eval/", ".agents/skills/aaw-eval-")) for path in paths)
