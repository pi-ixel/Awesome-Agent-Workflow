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
import subprocess
import time
import sys
import threading
import uuid
from datetime import datetime
from pathlib import Path


def _configure_stdio() -> None:
    """Keep CLI text deterministic across Windows shells and agent hosts."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="replace")


_configure_stdio()


# Mirrors cli/install_lock.py (LOCK_NAME / DEFAULT_TIMEOUT / _RETRY_INTERVAL):
# this launcher must stay stdlib-only, so the constants cannot be imported.
_LOCK_NAME = ".aaw-update.lock"
_LOCK_TIMEOUT = 30.0
_LOCK_RETRY_INTERVAL = 0.15
_INVOCATION_ID = os.environ.setdefault("AAW_INVOCATION_ID", str(uuid.uuid4()))


def _early_failure_log(message: str) -> None:
    """Best-effort fallback for failures before the managed CLI can import."""
    if os.environ.get("AAW_LOGGING", "on").strip().lower() in {
        "0", "false", "no", "off", "disabled",
    }:
        return
    try:
        now = datetime.now().astimezone()
        offset = now.strftime("%z")
        offset = f"{offset[:3]}:{offset[3:]}" if offset else "+00:00"
        stamp = now.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3] + f" {offset}"
        root = Path.cwd()
        try:
            result = subprocess.run(
                ["git", "rev-parse", "--show-toplevel"],
                cwd=root,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                check=False,
                text=True,
                encoding="utf-8",
                timeout=5,
            )
            if result.returncode == 0 and result.stdout.strip():
                root = Path(result.stdout.strip())
        except (OSError, subprocess.TimeoutExpired):
            pass
        logs = root / ".aaw" / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        line = (
            f"{stamp} ERROR [pid={os.getpid()} thread={threading.current_thread().name} "
            f"workflow=- sr=- ar=- invocation={_INVOCATION_ID} seq=1] "
            f"aaw.launcher - {message}\n"
        )
        payload = line.encode("utf-8", "replace")
        fd = os.open(logs / "system.log", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(fd, payload)
            os.fsync(fd)
        finally:
            os.close(fd)
    except Exception:
        pass


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
    _early_failure_log(message)
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
        _die(f"cannot open the installation lock {path}: {exc}")
    deadline = time.monotonic() + _timeout()
    while True:
        if _try_shared_lock(fd):
            return fd
        if time.monotonic() >= deadline:
            os.close(fd)
            _die("another update or recovery process is still running after 30 seconds; retry later")
        time.sleep(_LOCK_RETRY_INTERVAL)


_entry_file = Path(os.path.abspath(__file__))
_skills_root = _entry_file.parents[2]
_locked_fd = _acquire_bootstrap_lock(_skills_root)

# From this point onward every import from the managed skill tree is protected.
sys.path.insert(0, str(_entry_file.parent))

from cli.install_lock import InstallLock, set_active_lock  # noqa: E402

_lock = InstallLock.adopt(_skills_root, _locked_fd, mode="shared")
set_active_lock(_lock)

from cli import runtime_logging  # noqa: E402

runtime_logging.initialize(sys.argv[1:])

from cli import bootstrap  # noqa: E402

try:
    bootstrap.startup(__file__, _lock)

    import cli.main  # noqa: E402

    cli.main.app()
except BaseException as exc:
    runtime_logging.log_exception(exc)
    code = exc.code if isinstance(exc, SystemExit) else 130 if isinstance(exc, KeyboardInterrupt) else 1
    runtime_logging.finish(code)
    raise
else:
    runtime_logging.finish(0)
