from __future__ import annotations

import hashlib
import json
import os
import tempfile
import zipfile
from pathlib import Path
from typing import Any


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def content_hash(value: Any) -> str:
    raw = value if isinstance(value, bytes) else canonical_json(value).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def write_json(path: Path, value: Any) -> None:
    atomic_write_text(path, json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True))


def archive_untracked(workspace: Path, paths: list[str], destination: Path) -> list[str]:
    included: list[str] = []
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for raw in sorted(set(paths)):
            normalized = raw.replace("\\", "/").lstrip("/")
            if not normalized or normalized.startswith(
                (".git/", ".aaw-eval/", ".agents/skills/aaw-eval-")
            ):
                continue
            source = (workspace / normalized).resolve()
            try:
                source.relative_to(workspace.resolve())
            except ValueError:
                continue
            if source.is_file() and not source.is_symlink():
                archive.write(source, normalized)
                included.append(normalized)
    return included
