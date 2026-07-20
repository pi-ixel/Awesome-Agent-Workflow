"""Process bootstrap: install-level shared lock + residue recovery.

Runs from aaw.py BEFORE cli.main (and typer/business modules) are imported,
so module import, definitions reads and workflow writes can never overlap
with another process's directory swap (docs/auto-update-design.md §4.3).
This module only depends on the update infrastructure (install_lock/update),
never on CLI business modules.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from .install_lock import InstallLock, LockTimeout
from .update import preflight_recover, UpdateError


def _wants_update_json() -> bool:
    argv = sys.argv[1:]
    if not argv or argv[0] != "update":
        return False
    enabled = False
    for item in argv[1:]:
        if item == "--json":
            enabled = True
        elif item == "--no-json":
            enabled = False
    return enabled


def _die(message: str, code: int, status: str = "failed") -> None:
    if _wants_update_json():
        print(json.dumps({"status": status, "error": message}, ensure_ascii=False))
    print(message, file=sys.stderr)
    raise SystemExit(code)


def startup(entry_file: str, lock: InstallLock) -> None:
    """Recover local transaction residue under an already-held shared lock.

    ``aaw.py`` acquires and adopts the lock before importing this module, so a
    directory swap cannot race any import from the managed skill tree.
    """
    # Same normalisation as aaw.py (os.path.abspath): the two must produce a
    # textually identical skills_root for the lock-path sanity check below.
    skills_root = Path(os.path.abspath(entry_file)).parents[2]
    if lock.mode != "shared" or lock.path.parent != skills_root:
        _die("aaw: 启动锁状态非法", 2, "recovery_required")
    try:
        preflight_recover(skills_root, lock, lambda m: print(m, file=sys.stderr))
    except LockTimeout:
        _die("aaw: 等待独占安装锁恢复残留事务超时；稍后重试", 1)
    except UpdateError as e:
        hint = f"\n  {e.hint}" if e.hint else ""
        _die(f"aaw: {e.message}{hint}", 2, "recovery_required")
