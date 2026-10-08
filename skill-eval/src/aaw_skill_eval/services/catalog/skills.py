from __future__ import annotations

import hashlib
import os
import re
import shutil
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path

import yaml
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...config import Settings
from ...errors import EvalError
from ...models import Skill, SkillRevision

IGNORED_PARTS = {"__pycache__", ".pytest_cache", ".ruff_cache", ".git"}
IGNORED_SUFFIXES = {".pyc", ".pyo"}
SAFE_NAME = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$")


@dataclass(frozen=True)
class SkillSource:
    root: Path
    name: str
    description: str
    content_hash: str
    total_bytes: int
    files: tuple[Path, ...]


def _is_reparse_point(path: Path) -> bool:
    if path.is_symlink():
        return True
    try:
        attributes = path.stat(follow_symlinks=False).st_file_attributes
        return bool(attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)
    except (AttributeError, OSError):
        return False


def _frontmatter(skill_md: Path) -> dict:
    try:
        text = skill_md.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise EvalError("SKILL_READ_FAILED", f"Cannot read {skill_md}: {exc}") from exc
    if not text.startswith("---"):
        raise EvalError("INVALID_SKILL", "SKILL.md must start with YAML frontmatter")
    parts = text.split("---", 2)
    if len(parts) < 3:
        raise EvalError("INVALID_SKILL", "SKILL.md frontmatter is not closed")
    try:
        metadata = yaml.safe_load(parts[1]) or {}
    except yaml.YAMLError as exc:
        raise EvalError("INVALID_SKILL", f"Invalid SKILL.md frontmatter: {exc}") from exc
    if not isinstance(metadata, dict):
        raise EvalError("INVALID_SKILL", "SKILL.md frontmatter must be an object")
    name = metadata.get("name")
    description = metadata.get("description")
    if not isinstance(name, str) or not SAFE_NAME.fullmatch(name):
        raise EvalError("INVALID_SKILL_NAME", "Skill name must be a safe identifier")
    if not isinstance(description, str) or not description.strip():
        raise EvalError("INVALID_SKILL", "Skill description is required")
    return metadata


def inspect_skill(raw_path: str | Path, max_bytes: int) -> SkillSource:
    path = Path(raw_path).expanduser().resolve()
    root = path.parent if path.is_file() and path.name == "SKILL.md" else path
    skill_md = root / "SKILL.md"
    if not root.is_dir() or not skill_md.is_file():
        raise EvalError("SKILL_NOT_FOUND", f"Skill directory or SKILL.md not found: {root}")
    metadata = _frontmatter(skill_md)

    files: list[Path] = []
    total = 0
    digest = hashlib.sha256()
    for current_root, directories, names in os.walk(root, topdown=True, followlinks=False):
        current = Path(current_root)
        if _is_reparse_point(current):
            raise EvalError("UNSAFE_SKILL_PATH", f"Skill contains a link or junction: {current}")
        directories[:] = sorted(d for d in directories if d not in IGNORED_PARTS)
        for directory in directories:
            candidate = current / directory
            if _is_reparse_point(candidate):
                raise EvalError(
                    "UNSAFE_SKILL_PATH", f"Skill contains a link or junction: {candidate}"
                )
        for name in sorted(names):
            file_path = current / name
            if name in IGNORED_PARTS or file_path.suffix in IGNORED_SUFFIXES:
                continue
            if _is_reparse_point(file_path) or not file_path.is_file():
                raise EvalError("UNSAFE_SKILL_PATH", f"Unsafe Skill file: {file_path}")
            data = file_path.read_bytes()
            total += len(data)
            if total > max_bytes:
                raise EvalError("SKILL_TOO_LARGE", f"Skill exceeds {max_bytes} bytes")
            relative = file_path.relative_to(root)
            relative_bytes = relative.as_posix().encode("utf-8")
            digest.update(len(relative_bytes).to_bytes(4, "big"))
            digest.update(relative_bytes)
            digest.update(len(data).to_bytes(8, "big"))
            digest.update(data)
            files.append(relative)
    return SkillSource(
        root=root,
        name=metadata["name"],
        description=metadata["description"].strip(),
        content_hash=digest.hexdigest(),
        total_bytes=total,
        files=tuple(files),
    )


def import_skill(session: Session, settings: Settings, raw_path: str | Path) -> SkillRevision:
    source = inspect_skill(raw_path, settings.max_skill_bytes)
    skill = session.scalar(select(Skill).where(Skill.name == source.name))
    if skill is None:
        skill = Skill(name=source.name, source_path=str(source.root))
        session.add(skill)
        session.flush()
    else:
        skill.source_path = str(source.root)
    existing = session.scalar(
        select(SkillRevision).where(
            SkillRevision.skill_id == skill.id,
            SkillRevision.content_hash == source.content_hash,
        )
    )
    if existing is not None:
        session.commit()
        return existing

    destination = settings.snapshots_dir / source.name / source.content_hash
    if not destination.exists():
        destination.parent.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix="snapshot-", dir=destination.parent))
        try:
            for relative in source.files:
                target = staging / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source.root / relative, target)
            staging.replace(destination)
        except Exception:
            shutil.rmtree(staging, ignore_errors=True)
            raise
    revision = SkillRevision(
        skill_id=skill.id,
        content_hash=source.content_hash,
        snapshot_path=str(destination),
        source_path=str(source.root),
    )
    session.add(revision)
    session.commit()
    session.refresh(revision)
    return revision


def prepare_eval_workspace(workspace: Path) -> Path:
    runtime_root = workspace / ".aaw-eval"
    if runtime_root.exists():
        raise EvalError(
            "EVAL_DIR_CONFLICT",
            f"Project already contains the reserved evaluation directory: {runtime_root}",
        )
    skill_root = runtime_root / "skills"
    skill_root.mkdir(parents=True)
    exclude = workspace / ".git" / "info" / "exclude"
    exclude.parent.mkdir(parents=True, exist_ok=True)
    existing = exclude.read_text(encoding="utf-8") if exclude.exists() else ""
    rules = ("/.aaw-eval/", "/.agents/skills/aaw-eval-*/")
    additions = [rule for rule in rules if rule not in existing.splitlines()]
    if additions:
        with exclude.open("a", encoding="utf-8", newline="\n") as stream:
            if existing and not existing.endswith("\n"):
                stream.write("\n")
            stream.write("\n".join(additions) + "\n")
    return skill_root


def install_snapshot(
    snapshot_path: Path,
    workspace: Path,
    skill_name: str,
    *,
    provider: str,
) -> Path:
    skill_root = workspace / ".aaw-eval" / "skills"
    if not skill_root.is_dir():
        raise EvalError("EVAL_DIR_MISSING", "Evaluation workspace was not prepared")
    for skill_md in skill_root.glob("*/SKILL.md"):
        try:
            if _frontmatter(skill_md).get("name") == skill_name:
                raise EvalError(
                    "SKILL_NAME_CONFLICT",
                    f"Project already contains a Skill named {skill_name}: {skill_md.parent}",
                )
        except EvalError:
            raise
    destination = skill_root / skill_name
    shutil.copytree(snapshot_path, destination)
    if provider == "codex":
        codex_root = workspace / ".agents" / "skills"
        codex_root.mkdir(parents=True, exist_ok=True)
        for skill_md in codex_root.glob("*/SKILL.md"):
            if _frontmatter(skill_md).get("name") == skill_name:
                raise EvalError(
                    "SKILL_NAME_CONFLICT",
                    f"Project already contains a Skill named {skill_name}: {skill_md.parent}",
                )
        shutil.copytree(destination, codex_root / f"aaw-eval-{skill_name}")
    return destination
