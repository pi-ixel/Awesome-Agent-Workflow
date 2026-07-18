"""Transactional self-update from the telemetry server (auto + manual).

Design: docs/auto-update-design.md.  `aaw start` queries the latest release
first thing on entry and auto-updates before any workflow state is touched;
`aaw update` is the explicit manual entry sharing the same download/staging/
swap transaction.  All heavy operations happen inside a transaction directory
next to the skills root; the live install is only ever touched by directory
renames recorded in a write-ahead manifest, so any failure either leaves the
install untouched or is rolled back / recoverable via the generated
recover.py.
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import stat
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .version import FALLBACK_VERSION, is_newer, parse_version

LOCK_NAME = ".aaw-update.lock"
TX_PREFIX = ".aaw-update-"
HANDOFF_PREFIX = ".aaw-update-handoff-"
MANIFEST_NAME = "transaction.json"
QUERY_TIMEOUT = 10
DOWNLOAD_TIMEOUT = 120

HANDOFF_PATH_ENV = "AAW_UPDATE_HANDOFF"
HANDOFF_TOKEN_ENV = "AAW_UPDATE_HANDOFF_TOKEN"


class UpdateError(Exception):
    def __init__(self, message: str, hint: str = "", fatal: bool = False) -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint
        # fatal: the install may be in a bad state (rollback failed) or a
        # re-exec loop must be broken -- callers must not continue `start`.
        self.fatal = fatal


# ---------------------------------------------------------------------------
# location & guards
# ---------------------------------------------------------------------------

def install_paths(install_dir: Path | None = None) -> tuple[Path, Path]:
    """Return (skill_dir, skills_root) for the running CLI.

    Lexical absolutisation only: fold the possibly-relative __file__ against
    the startup CWD without resolving symlinks (docs §4.3).
    """
    if install_dir is not None:
        skill_dir = Path(os.path.abspath(install_dir))
    else:
        skill_dir = Path(os.path.abspath(__file__)).parents[2]
    return skill_dir, skill_dir.parent


def _read_local_version(skill_dir: Path) -> str:
    """VERSION of the install being updated; a corrupted or partially
    recovered install reads as the lowest version so it can be repaired."""
    try:
        text = (skill_dir / "scripts" / "cli" / "VERSION").read_text("utf-8").strip()
    except OSError:
        return FALLBACK_VERSION
    return text or FALLBACK_VERSION


def _is_reparse_point(path: Path) -> bool:
    try:
        st = os.lstat(path)
    except OSError:
        return False
    if stat.S_ISLNK(st.st_mode):
        return True
    if os.name == "nt":
        attributes = getattr(st, "st_file_attributes", 0)
        if attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
            return True
    return False


def _guard_no_reparse(skill_dir: Path, skills_root: Path) -> None:
    """Reject when any level from the cli package up to the skills root is a
    symlink / junction / reparse point: renames would write through to a
    redirected location (e.g. the source repository)."""
    probes = [skill_dir / "scripts" / "cli", skill_dir / "scripts", skill_dir, skills_root]
    for probe in probes:
        if _is_reparse_point(probe):
            raise UpdateError(
                f"安装路径包含链接目录: {probe}",
                "链接式安装请到源仓库执行 git pull 更新",
            )


# ---------------------------------------------------------------------------
# install-level kernel lock
# ---------------------------------------------------------------------------

class _InstallLock:
    """Non-blocking exclusive kernel lock on <skills_root>/.aaw-update.lock.

    The lock file's existence never implies the lock is held; only the kernel
    lock state counts.  The OS releases it automatically when the process
    exits for any reason.
    """

    def __init__(self, skills_root: Path, owner_token: str, tx_id: str) -> None:
        self.path = skills_root / LOCK_NAME
        self.owner_token = owner_token
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o644)
        self._file = os.fdopen(fd, "r+b")
        try:
            if os.name == "nt":
                import msvcrt

                self._file.seek(0)
                msvcrt.locking(self._file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self._file.close()
            raise UpdateError(
                "另一个 aaw 更新/恢复进程正在执行",
                "等待其完成后重试；若确认无进程在跑，锁会随进程退出自动释放",
            )
        payload = {
            "pid": os.getpid(),
            "started_at": datetime.now(timezone.utc).isoformat(),
            "owner_token": owner_token,
            "tx_id": tx_id,
        }
        self._file.seek(0)
        self._file.truncate()
        self._file.write(json.dumps(payload).encode("utf-8"))
        self._file.flush()

    def release(self) -> None:
        try:
            if os.name == "nt":
                import msvcrt

                self._file.seek(0)
                msvcrt.locking(self._file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._file.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        self._file.close()


# ---------------------------------------------------------------------------
# server API
# ---------------------------------------------------------------------------

def _endpoint() -> str:
    from .telemetry import DEFAULT_ENDPOINT

    return (os.environ.get("AAW_TELEMETRY_ENDPOINT") or DEFAULT_ENDPOINT).rstrip("/")


def query_latest(endpoint: str | None = None, timeout: float = QUERY_TIMEOUT) -> dict:
    base = (endpoint or _endpoint()).rstrip("/")
    request = Request(base + "/api/v1/client/release", headers={"Accept": "application/json"})
    try:
        with urlopen(request, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
    except (OSError, URLError, HTTPError, ValueError) as e:
        raise UpdateError(f"查询最新版本失败: {e}", "检查网络与 AAW_TELEMETRY_ENDPOINT 后重试")
    return data if isinstance(data, dict) else {}


def _download(endpoint: str, version: str, file_name: str, target: Path) -> None:
    url = f"{endpoint}/api/v1/client/releases/{version}/download/{file_name}"
    try:
        with urlopen(Request(url), timeout=DOWNLOAD_TIMEOUT) as response, open(target, "wb") as out:
            shutil.copyfileobj(response, out)
    except (OSError, URLError, HTTPError) as e:
        raise UpdateError(f"下载发布包失败: {e}", "检查网络后重试")


# ---------------------------------------------------------------------------
# staging: unzip + sanity
# ---------------------------------------------------------------------------

def _extract_zip(archive: Path, staging: Path) -> list[str]:
    """Extract with zip-slip protection; return sorted top-level skill names."""
    staging.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(archive) as bundle:
            for member in bundle.infolist():
                name = member.filename.replace("\\", "/")
                parts = [p for p in name.split("/") if p not in ("", ".")]
                if not parts:
                    continue
                if ".." in parts or name.startswith("/") or ":" in parts[0]:
                    raise UpdateError(f"发布包含非法路径条目: {member.filename}", "该发布包不可信，已中止")
                destination = staging.joinpath(*parts)
                if member.is_dir():
                    destination.mkdir(parents=True, exist_ok=True)
                    continue
                destination.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(member) as src, open(destination, "wb") as dst:
                    shutil.copyfileobj(src, dst)
    except zipfile.BadZipFile as e:
        raise UpdateError(f"发布包损坏: {e}", "重新执行 aaw update 下载")
    return sorted(p.name for p in staging.iterdir() if p.is_dir())


def _sanity_check(staging: Path, skills: list[str], latest_version: str) -> None:
    if not skills:
        raise UpdateError("发布包为空", "该发布包不可信，已中止")
    if "aaw-workflow" not in skills:
        raise UpdateError("发布包缺少 aaw-workflow 本体", "该发布包不可信，已中止")
    for name in skills:
        if not (staging / name / "SKILL.md").is_file():
            raise UpdateError(f"发布包中 {name} 缺少 SKILL.md", "该发布包不可信，已中止")
    workflow = staging / "aaw-workflow"
    if not (workflow / "scripts" / "aaw.py").is_file():
        raise UpdateError("发布包缺少 scripts/aaw.py 入口", "该发布包不可信，已中止")
    version_file = workflow / "scripts" / "cli" / "VERSION"
    if not version_file.is_file():
        raise UpdateError("发布包缺少 scripts/cli/VERSION", "该发布包不可信，已中止")
    packaged = version_file.read_text("utf-8").strip()
    if parse_version(packaged) is None or parse_version(latest_version) is None:
        raise UpdateError(f"版本号不合法: 包内 {packaged!r} / 服务端 {latest_version!r}", "已中止")
    if packaged != latest_version:
        raise UpdateError(
            f"包内 VERSION ({packaged}) 与服务端版本 ({latest_version}) 不一致",
            "该发布包不可信，已中止",
        )


# ---------------------------------------------------------------------------
# transaction (write-ahead manifest + renames)
# ---------------------------------------------------------------------------

def _write_manifest(tx_dir: Path, manifest: dict) -> None:
    target = tx_dir / MANIFEST_NAME
    tmp = target.with_name(MANIFEST_NAME + ".tmp")
    tmp.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), "utf-8")
    tmp.replace(target)


def _remove_tree(path: Path) -> None:
    def _on_error(func, target, _exc):  # pragma: no cover - windows read-only fallback
        os.chmod(target, stat.S_IWRITE)
        func(target)

    if path.exists():
        shutil.rmtree(path, onerror=_on_error)


def _rename_step(manifest: dict, tx_dir: Path, key: str, source: Path, target: Path) -> None:
    """WAL rename: record intent, rename, record completion."""
    manifest["steps"][key] = "started"
    _write_manifest(tx_dir, manifest)
    source.rename(target)
    manifest["steps"][key] = "done"
    _write_manifest(tx_dir, manifest)


def recover_transaction(tx_dir: Path) -> str:
    """Restore a clean state from a transaction directory.  Reentrant.

    Returns "committed" (new version kept, residue cleaned) or "rolled-back"
    (all old skills restored).  Directory-existence beats manifest step state:
    a rename may have succeeded right before its completion record was lost.
    """
    manifest = json.loads((tx_dir / MANIFEST_NAME).read_text("utf-8"))
    skills_root = Path(manifest["skills_root"])
    committed = manifest.get("phase") == "committed"
    if not committed:
        displaced_root = tx_dir / "displaced"
        for name in manifest["skills"]:
            official = skills_root / name
            backup = tx_dir / "backup" / name
            if not backup.is_dir():
                continue  # never backed up: official copy is still the old one
            if official.exists():
                # official position holds a swapped-in new copy: displace it
                displaced_root.mkdir(parents=True, exist_ok=True)
                slot = displaced_root / name
                while slot.exists():
                    slot = displaced_root / f"{name}-{secrets.token_hex(4)}"
                official.rename(slot)
            backup.rename(official)
    _remove_tree(tx_dir)
    return "committed" if committed else "rolled-back"


def _abort_transaction(tx_dir: Path) -> None:
    """Failure cleanup: roll back via the manifest when it exists, otherwise
    the live install was never touched and the staging residue is dropped."""
    if (tx_dir / MANIFEST_NAME).exists():
        recover_transaction(tx_dir)
    else:
        _remove_tree(tx_dir)


def _clean_residue(skills_root: Path, out) -> None:
    for leftover in skills_root.iterdir():
        if not leftover.name.startswith(TX_PREFIX) or leftover.name.startswith(HANDOFF_PREFIX):
            continue
        if not leftover.is_dir() or not (leftover / MANIFEST_NAME).exists():
            _remove_tree(leftover) if leftover.is_dir() else leftover.unlink(missing_ok=True)
            continue
        state = recover_transaction(leftover)
        out(f"已处理残留更新事务 {leftover.name}: {state}")


_RECOVER_SCRIPT = '''\
"""Standalone recovery for an interrupted aaw update transaction.

Usage: python recover.py [--assume-locked]
Depends only on the standard library and transaction.json; never imports the
CLI being updated.  Reentrant: rerunning after another interruption is safe.
"""
import json, os, secrets, shutil, stat, sys
from pathlib import Path

TX_DIR = Path(os.path.abspath(__file__)).parent


def _remove_tree(path):
    def _on_error(func, target, _exc):
        os.chmod(target, stat.S_IWRITE)
        func(target)
    if path.exists():
        shutil.rmtree(path, onerror=_on_error)


def main():
    manifest = json.loads((TX_DIR / "transaction.json").read_text("utf-8"))
    skills_root = Path(manifest["skills_root"])
    lock_file = None
    if "--assume-locked" not in sys.argv:
        fd = os.open(skills_root / ".aaw-update.lock", os.O_RDWR | os.O_CREAT, 0o644)
        lock_file = os.fdopen(fd, "r+b")
        try:
            if os.name == "nt":
                import msvcrt
                lock_file.seek(0)
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            print("另一个更新/恢复进程正在执行，稍后重试", file=sys.stderr)
            sys.exit(1)
    committed = manifest.get("phase") == "committed"
    if not committed:
        for name in manifest["skills"]:
            official = skills_root / name
            backup = TX_DIR / "backup" / name
            if not backup.is_dir():
                continue
            if official.exists():
                displaced = TX_DIR / "displaced"
                displaced.mkdir(parents=True, exist_ok=True)
                slot = displaced / name
                while slot.exists():
                    slot = displaced / (name + "-" + secrets.token_hex(4))
                official.rename(slot)
            backup.rename(official)
    _remove_tree(TX_DIR)
    print("已恢复: " + ("保留新版本 (committed)" if committed else "回滚到旧版本"))
    if lock_file is not None:
        lock_file.close()


if __name__ == "__main__":
    main()
'''


# ---------------------------------------------------------------------------
# update flow (shared by `aaw update` and `aaw start` auto-update)
# ---------------------------------------------------------------------------

def _stderr(message: str) -> None:
    print(message, file=sys.stderr)


def _perform_update(
    skill_dir: Path,
    skills_root: Path,
    latest: str,
    file_name: str,
    base: str,
    out,
) -> dict | None:
    """Guards, lock, residue recovery and the swap transaction (docs §4.4 1-7).

    Returns the result dict, or None when residue recovery revealed the
    install is already up to date.  Raises UpdateError; fatal=True means the
    rollback itself failed and the install may be inconsistent.
    """
    _guard_no_reparse(skill_dir, skills_root)

    tx_id = secrets.token_hex(8)
    owner_token = secrets.token_hex(16)
    lock = _InstallLock(skills_root, owner_token, tx_id)
    try:
        _clean_residue(skills_root, out)

        # residue recovery may have restored or completed a previous update
        current = _read_local_version(skill_dir)
        if not is_newer(latest, current):
            return None

        tx_dir = skills_root / f"{TX_PREFIX}{tx_id}"
        staging = tx_dir / "staging"
        backup = tx_dir / "backup"
        tx_dir.mkdir()
        try:
            archive = tx_dir / file_name
            _download(base, latest, file_name, archive)
            skills = _extract_zip(archive, staging)
            _sanity_check(staging, skills, latest)
            archive.unlink(missing_ok=True)

            manifest = {
                "schema": 1,
                "tx_id": tx_id,
                "owner_token": owner_token,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "skills_root": str(skills_root),
                "lock_path": str(skills_root / LOCK_NAME),
                "latest_version": latest,
                "skills": skills,
                "phase": "staged",
                "steps": {},
            }
            _write_manifest(tx_dir, manifest)
            (tx_dir / "recover.py").write_text(_RECOVER_SCRIPT, "utf-8")
            out(f"如更新被中断，运行: python {tx_dir / 'recover.py'} 恢复现场")

            backup.mkdir()
            manifest["phase"] = "backup"
            for name in skills:
                official = skills_root / name
                if official.exists():
                    _rename_step(manifest, tx_dir, f"backup:{name}", official, backup / name)
            manifest["phase"] = "swap"
            for name in skills:
                _rename_step(manifest, tx_dir, f"swap:{name}", staging / name, skills_root / name)

            # pre-commit verification from the official location
            manifest["phase"] = "verify"
            _write_manifest(tx_dir, manifest)
            landed = (skills_root / "aaw-workflow" / "scripts" / "cli" / "VERSION")
            landed_version = landed.read_text("utf-8").strip() if landed.is_file() else None
            if landed_version != latest:
                raise UpdateError(f"换入后版本校验失败: {landed_version!r} != {latest!r}", "已回滚")
            for name in skills:
                if not (skills_root / name / "SKILL.md").is_file():
                    raise UpdateError(f"换入后 {name} 缺少 SKILL.md", "已回滚")

            manifest["phase"] = "committed"
            _write_manifest(tx_dir, manifest)
        except (UpdateError, OSError) as e:
            try:
                _abort_transaction(tx_dir)
            except Exception as rollback_error:  # noqa: BLE001
                raise UpdateError(
                    f"更新失败: {e}；且自动回滚未完成: {rollback_error}",
                    f"安装可能不一致，请运行: python {tx_dir / 'recover.py'} 恢复现场",
                    fatal=True,
                )
            if isinstance(e, UpdateError):
                raise
            raise UpdateError(
                f"更新失败: {e}",
                "可能有进程占用 skill 目录（关闭后重试）；现场已回滚",
            )
        _remove_tree(tx_dir)  # committed: drop backup + staging residue
        return {"updated": True, "old_version": current, "new_version": latest, "skills": skills}
    finally:
        lock.release()


def run_update(install_dir: Path | None = None, endpoint: str | None = None, out=None) -> dict:
    """Manual `aaw update`: real-time query, then the swap transaction.

    Any failure raises UpdateError (docs §4.4: manual mode always errors out).
    """
    out = out or _stderr
    skill_dir, skills_root = install_paths(install_dir)
    if not skills_root.is_dir():
        raise UpdateError(f"未找到 skills 目录: {skills_root}", "请重新安装")
    current = _read_local_version(skill_dir)

    base = (endpoint or _endpoint()).rstrip("/")
    info = query_latest(base)
    latest = info.get("latest_version")
    if not isinstance(latest, str) or not is_newer(latest, current):
        return {"updated": False, "old_version": current, "new_version": current}
    file_name = info.get("file_name")
    if not isinstance(file_name, str) or not file_name:
        raise UpdateError("服务端响应缺少 file_name", "稍后重试")

    result = _perform_update(skill_dir, skills_root, latest, file_name, base, out)
    if result is None:
        current = _read_local_version(skill_dir)
        return {"updated": False, "old_version": current, "new_version": current}
    return result


# ---------------------------------------------------------------------------
# `aaw start` auto-update: query -> update -> handoff -> re-exec
# ---------------------------------------------------------------------------

def auto_update_on_start(
    argv: list[str],
    install_dir: Path | None = None,
    endpoint: str | None = None,
    out=None,
) -> None:
    """First operation of `aaw start` (docs §4.2/§4.4).

    Returns to let `start` continue with the current local version (no newer
    release, or any recoverable failure -- reported as a stderr warning).  On
    a successful update this never returns: it writes a one-shot handoff file
    and re-executes the swapped-in aaw.py with the original argv.  Raises
    UpdateError only for fatal states (rollback failed): `start` must abort
    rather than create workflow state on an inconsistent install.
    """
    out = out or _stderr
    try:
        skill_dir, skills_root = install_paths(install_dir)
        if not skills_root.is_dir():
            raise UpdateError(f"未找到 skills 目录: {skills_root}")
        current = _read_local_version(skill_dir)

        base = (endpoint or _endpoint()).rstrip("/")
        info = query_latest(base)
        latest = info.get("latest_version")
        if not isinstance(latest, str) or not is_newer(latest, current):
            return
        file_name = info.get("file_name")
        if not isinstance(file_name, str) or not file_name:
            raise UpdateError("服务端响应缺少 file_name")

        out(f"发现 AAW 新版本 {latest}（当前 {current}），自动更新中...")
        result = _perform_update(skill_dir, skills_root, latest, file_name, base, out)
        if result is None:
            return
    except UpdateError as e:
        if e.fatal:
            raise
        out(f"aaw update warning: {e.message}，使用当前版本继续")
        return

    out(f"更新完成: {result['old_version']} -> {result['new_version']}，重新执行 start")
    _reexec_start(skills_root, argv, result["new_version"])


def _reexec_start(skills_root: Path, argv: list[str], target_version: str) -> None:
    """Hand off to the swapped-in CLI without running any freshly-imported
    old-version code paths (docs §4.4 step 7).  Never returns on success."""
    token = secrets.token_hex(16)
    handoff = skills_root / f"{HANDOFF_PREFIX}{secrets.token_hex(8)}.json"
    handoff.write_text(
        json.dumps({
            "schema": 1,
            "token": token,
            "target_version": target_version,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }),
        "utf-8",
    )
    entry = skills_root / "aaw-workflow" / "scripts" / "aaw.py"
    args = [sys.executable, str(entry), *argv]
    env = {**os.environ, HANDOFF_PATH_ENV: str(handoff), HANDOFF_TOKEN_ENV: token}
    sys.stdout.flush()
    sys.stderr.flush()
    try:
        if os.name == "nt":
            # Windows execv detaches the console/pipes from the caller's
            # perspective; run the new CLI as a child and mirror its exit code.
            completed = subprocess.run(args, env=env)
            raise SystemExit(completed.returncode)
        os.execve(sys.executable, args, env)
    except OSError as e:
        handoff.unlink(missing_ok=True)
        raise UpdateError(
            f"更新已完成，但 start 未执行: {e}",
            "请直接重跑原 start 命令（无需再次更新）",
            fatal=True,
        )


def consume_handoff(install_dir: Path | None = None) -> bool:
    """Consume the one-shot handoff in a re-executed `start` process.

    Returns True when a valid handoff was consumed (skip the server query and
    run the original start argv directly); False when this is a normal start.
    Raises UpdateError (fatal) on forged/replayed handoffs or when the local
    version did not reach the handoff target -- breaking re-exec loops.
    """
    path_raw = os.environ.pop(HANDOFF_PATH_ENV, None)
    token = os.environ.pop(HANDOFF_TOKEN_ENV, None)
    if not path_raw:
        return False
    path = Path(path_raw)
    claimed = path.with_name(path.name + f".consumed-{os.getpid()}")
    try:
        path.rename(claimed)  # atomic claim: a handoff is consumed exactly once
    except OSError:
        raise UpdateError(
            "更新交接文件缺失或已被消费",
            "请直接重跑原 start 命令",
            fatal=True,
        )
    try:
        data = json.loads(claimed.read_text("utf-8"))
    except (OSError, ValueError):
        data = None
    finally:
        try:
            claimed.unlink()
        except OSError:
            pass
    if not isinstance(data, dict) or not token or data.get("token") != token:
        raise UpdateError("更新交接文件校验失败", "请直接重跑原 start 命令", fatal=True)

    target = data.get("target_version")
    target_parts = parse_version(target) if isinstance(target, str) else None
    skill_dir, _ = install_paths(install_dir)
    current = _read_local_version(skill_dir)
    current_parts = parse_version(current) or (0, 0, 0)
    if target_parts is None or current_parts < target_parts:
        raise UpdateError(
            f"更新后版本校验失败: 本地 {current}，目标 {target}",
            "请运行 aaw update 或重新安装",
            fatal=True,
        )
    return True
