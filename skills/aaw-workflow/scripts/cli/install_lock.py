"""Install-level shared/exclusive lock (docs/auto-update-design.md §4.3).

`.aaw-update.lock` in the skills root is a permanent lock anchor: it is
created once and must never be deleted, renamed or replaced -- otherwise
POSIX processes may lock different inodes (and Windows processes different
file objects) and mutual exclusion silently breaks.

Semantics are identical on every platform: ordinary CLI commands hold a
shared lock for their whole lifetime; update/recovery hold an exclusive
lock while touching the install.  POSIX uses flock(LOCK_SH/LOCK_EX);
Windows uses LockFileEx via ctypes (msvcrt.locking has no shared mode) on
a fixed 1-byte region at offset 0.  Acquisition is a non-blocking try in a
30-second monotonic deadline loop; the OS releases the lock automatically
when the process dies.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

# Kept in sync BY HAND with two stdlib-only copies that cannot import this
# module: scripts/aaw.py (locks before any cli import) and the generated
# recover.py (update.py `_RECOVER_SCRIPT`).  Update all three together.
LOCK_NAME = ".aaw-update.lock"
DEFAULT_TIMEOUT = 30.0
_RETRY_INTERVAL = 0.15


class LockTimeout(Exception):
    pass


def lock_timeout() -> float:
    """Deadline in seconds; AAW_LOCK_TIMEOUT is a test-only override."""
    try:
        return max(0.0, float(os.environ["AAW_LOCK_TIMEOUT"]))
    except (KeyError, ValueError):
        return DEFAULT_TIMEOUT


if os.name == "nt":
    import ctypes
    import msvcrt
    from ctypes import wintypes

    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _LOCKFILE_FAIL_IMMEDIATELY = 0x1
    _LOCKFILE_EXCLUSIVE_LOCK = 0x2

    class _OVERLAPPED(ctypes.Structure):
        _fields_ = [
            ("Internal", ctypes.c_void_p),
            ("InternalHigh", ctypes.c_void_p),
            ("Offset", wintypes.DWORD),
            ("OffsetHigh", wintypes.DWORD),
            ("hEvent", wintypes.HANDLE),
        ]

    def _try_lock(fd: int, exclusive: bool) -> bool:
        handle = msvcrt.get_osfhandle(fd)
        flags = _LOCKFILE_FAIL_IMMEDIATELY | (_LOCKFILE_EXCLUSIVE_LOCK if exclusive else 0)
        overlapped = _OVERLAPPED()
        return bool(
            _kernel32.LockFileEx(
                wintypes.HANDLE(handle), flags, 0, 1, 0, ctypes.byref(overlapped)
            )
        )

    def _unlock(fd: int) -> None:
        handle = msvcrt.get_osfhandle(fd)
        overlapped = _OVERLAPPED()
        _kernel32.UnlockFileEx(wintypes.HANDLE(handle), 0, 1, 0, ctypes.byref(overlapped))

else:
    import fcntl

    def _try_lock(fd: int, exclusive: bool) -> bool:
        try:
            fcntl.flock(fd, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
        except OSError:
            return False
        return True

    def _unlock(fd: int) -> None:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass


class InstallLock:
    """One lock handle per process; acquire/release shared or exclusive."""

    def __init__(self, skills_root: Path) -> None:
        self.path = Path(skills_root) / LOCK_NAME
        self._fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o644)
        self.mode: str | None = None  # None | "shared" | "exclusive"

    @classmethod
    def adopt(cls, skills_root: Path, fd: int, *, mode: str) -> InstallLock:
        """Adopt a descriptor already locked by the stdlib-only launcher.

        ``aaw.py`` must lock before importing this replaceable module, so it
        cannot construct ``InstallLock`` in the usual way.  Ownership of ``fd``
        transfers to the returned object.
        """
        if mode not in {"shared", "exclusive"}:
            raise ValueError(f"invalid adopted lock mode: {mode}")
        obj = cls.__new__(cls)
        obj.path = Path(skills_root) / LOCK_NAME
        obj._fd = fd
        obj.mode = mode
        return obj

    def acquire_shared(self, timeout: float | None = None) -> None:
        self._acquire(exclusive=False, timeout=timeout)

    def acquire_exclusive(self, timeout: float | None = None) -> None:
        self._acquire(exclusive=True, timeout=timeout)

    def _acquire(self, exclusive: bool, timeout: float | None) -> None:
        if self.mode is not None:
            raise RuntimeError(f"lock already held ({self.mode}); release first")
        deadline = time.monotonic() + (timeout if timeout is not None else lock_timeout())
        while True:
            if _try_lock(self._fd, exclusive):
                self.mode = "exclusive" if exclusive else "shared"
                return
            if time.monotonic() >= deadline:
                raise LockTimeout(
                    "另一个 aaw 进程持有安装锁，30 秒内未释放"
                    if timeout is None
                    else "安装锁等待超时"
                )
            time.sleep(_RETRY_INTERVAL)

    def release(self) -> None:
        if self.mode is None:
            return
        _unlock(self._fd)
        self.mode = None

    def close(self) -> None:
        self.release()
        try:
            os.close(self._fd)
        except OSError:
            pass


_active_lock: InstallLock | None = None


def set_active_lock(lock: InstallLock) -> None:
    global _active_lock
    _active_lock = lock


def get_active_lock() -> InstallLock | None:
    return _active_lock
