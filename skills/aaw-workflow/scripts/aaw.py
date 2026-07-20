"""Entry point for aaw CLI — invoked by aaw-workflow skill.

This file deliberately acquires the install shared lock using only the Python
standard library before importing *any* module from the replaceable ``cli``
package.  The locked descriptor is then adopted by ``cli.install_lock``.
"""
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "typer>=0.12",
#     "pyyaml>=6.0",
# ]
# ///

import json
import os
import time
import sys
from pathlib import Path


# Mirrors cli/install_lock.py (LOCK_NAME / DEFAULT_TIMEOUT / _RETRY_INTERVAL):
# this launcher must stay stdlib-only, so the constants cannot be imported.
_LOCK_NAME = ".aaw-update.lock"
_LOCK_TIMEOUT = 30.0
_LOCK_RETRY_INTERVAL = 0.15


def _wants_update_json(argv: list[str]) -> bool:
    if not argv or argv[0] != "update":
        return False
    enabled = False
    for item in argv[1:]:
        if item == "--json":
            enabled = True
        elif item == "--no-json":
            enabled = False
    return enabled


def _die(message: str, *, status: str = "failed", code: int = 1) -> None:
    if _wants_update_json(sys.argv[1:]):
        print(json.dumps({"status": status, "error": message}, ensure_ascii=False))
    print(f"aaw: {message}", file=sys.stderr)
    raise SystemExit(code)


def _timeout() -> float:
    """AAW_LOCK_TIMEOUT is a test-only override, matching cli.install_lock."""
    try:
        return max(0.0, float(os.environ["AAW_LOCK_TIMEOUT"]))
    except (KeyError, ValueError):
        return _LOCK_TIMEOUT


if os.name == "nt":
    import ctypes
    import msvcrt
    from ctypes import wintypes

    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _LOCKFILE_FAIL_IMMEDIATELY = 0x1

    class _OVERLAPPED(ctypes.Structure):
        _fields_ = [
            ("Internal", ctypes.c_void_p),
            ("InternalHigh", ctypes.c_void_p),
            ("Offset", wintypes.DWORD),
            ("OffsetHigh", wintypes.DWORD),
            ("hEvent", wintypes.HANDLE),
        ]

    def _try_shared_lock(fd: int) -> bool:
        handle = msvcrt.get_osfhandle(fd)
        return bool(
            _kernel32.LockFileEx(
                wintypes.HANDLE(handle),
                _LOCKFILE_FAIL_IMMEDIATELY,
                0,
                1,
                0,
                ctypes.byref(_OVERLAPPED()),
            )
        )

else:
    import fcntl

    def _try_shared_lock(fd: int) -> bool:
        try:
            fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except OSError:
            return False
        return True


def _acquire_bootstrap_lock(skills_root: Path) -> int:
    path = skills_root / _LOCK_NAME
    try:
        fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
    except OSError as exc:
        _die(f"无法打开安装锁 {path}: {exc}")
    deadline = time.monotonic() + _timeout()
    while True:
        if _try_shared_lock(fd):
            return fd
        if time.monotonic() >= deadline:
            os.close(fd)
            _die("另一个更新/恢复进程正在执行，30 秒内未完成；稍后重试")
        time.sleep(_LOCK_RETRY_INTERVAL)


_entry_file = Path(os.path.abspath(__file__))
_skills_root = _entry_file.parents[2]
_locked_fd = _acquire_bootstrap_lock(_skills_root)

# From this point onward every import from the managed skill tree is protected.
sys.path.insert(0, str(_entry_file.parent))

from cli.install_lock import InstallLock, set_active_lock  # noqa: E402

_lock = InstallLock.adopt(_skills_root, _locked_fd, mode="shared")
set_active_lock(_lock)

from cli import bootstrap  # noqa: E402

bootstrap.startup(__file__, _lock)

import cli.main  # noqa: E402

cli.main.app()
