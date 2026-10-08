from __future__ import annotations

import os
from pathlib import Path

WORKSPACE_SCAN_INTERVAL_SECONDS = 5.0
WORKSPACE_SCAN_SKIP_DIRS = {".git"}
WORKSPACE_SCAN_MAX_ENTRIES = 50_000


def relative_if_inside(root: Path, target: Path) -> str | None:
    try:
        return target.resolve().relative_to(root.resolve()).as_posix()
    except (ValueError, OSError):
        return None


def scan_workspace(root: Path, *, exclude: set[str]) -> dict[str, tuple[int, int]]:
    """Snapshot {relative posix path: (mtime_ns, size)} under root, bounded by entry count."""
    entries: dict[str, tuple[int, int]] = {}
    stack: list[Path] = [root]
    scanned = 0
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as iterator:
                for entry in iterator:
                    scanned += 1
                    if scanned >= WORKSPACE_SCAN_MAX_ENTRIES:
                        return entries
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            if entry.name in WORKSPACE_SCAN_SKIP_DIRS:
                                continue
                            stack.append(Path(entry.path))
                            continue
                        info = entry.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    name = relative_if_inside(root, Path(entry.path))
                    if name is None or name in exclude:
                        continue
                    entries[name] = (info.st_mtime_ns, info.st_size)
        except OSError:
            continue
    return entries
