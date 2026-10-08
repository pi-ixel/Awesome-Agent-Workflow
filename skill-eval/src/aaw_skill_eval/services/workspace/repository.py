from __future__ import annotations

import os
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from ...errors import EvalError, InfrastructureError
from ..observability.logs import LogCallback


@dataclass(frozen=True)
class ProjectSnapshot:
    path: Path
    name: str
    commit: str
    tree: str
    remote: str | None


def _git(path: Path, *args: str, timeout: int = 60) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(path), *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise InfrastructureError("GIT_UNAVAILABLE", f"Git command failed: {exc}") from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()[-2000:]
        raise EvalError("GIT_ERROR", detail or "Git command failed")
    return result.stdout.strip()


def inspect_clean_project(raw_path: str | Path) -> ProjectSnapshot:
    path = Path(raw_path).expanduser().resolve()
    if not path.is_dir():
        raise EvalError("PROJECT_NOT_FOUND", f"Project directory does not exist: {path}")
    try:
        root = Path(_git(path, "rev-parse", "--show-toplevel")).resolve()
    except EvalError as exc:
        raise EvalError("NOT_GIT_REPOSITORY", f"Not a Git repository: {path}") from exc

    status = _git(root, "status", "--porcelain=v1", "--untracked-files=all")
    if status:
        lines = status.splitlines()
        preview = "\n".join(lines[:20])
        suffix = f"\n... and {len(lines) - 20} more" if len(lines) > 20 else ""
        raise EvalError(
            "PROJECT_DIRTY",
            "Project must have a clean working tree before evaluation:\n" + preview + suffix,
        )
    commit = _git(root, "rev-parse", "HEAD")
    tree = _git(root, "rev-parse", "HEAD^{tree}")
    remote_result = subprocess.run(
        ["git", "-C", str(root), "remote", "get-url", "origin"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
        check=False,
    )
    remote = remote_result.stdout.strip() if remote_result.returncode == 0 else None
    return ProjectSnapshot(path=root, name=root.name, commit=commit, tree=tree, remote=remote)


def inspect_project_commit(raw_path: str | Path, commit: str) -> ProjectSnapshot:
    path = Path(raw_path).expanduser().resolve()
    if not path.is_dir():
        raise EvalError("PROJECT_NOT_FOUND", f"Project directory does not exist: {path}")
    try:
        root = Path(_git(path, "rev-parse", "--show-toplevel")).resolve()
    except EvalError as exc:
        raise EvalError("NOT_GIT_REPOSITORY", f"Not a Git repository: {path}") from exc
    try:
        resolved_commit = _git(root, "rev-parse", "--verify", f"{commit}^{{commit}}")
        tree = _git(root, "rev-parse", "--verify", f"{resolved_commit}^{{tree}}")
    except EvalError as exc:
        raise EvalError(
            "PROJECT_COMMIT_MISSING",
            f"The original project commit is no longer available locally: {commit}",
        ) from exc
    remote_result = subprocess.run(
        ["git", "-C", str(root), "remote", "get-url", "origin"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
        check=False,
    )
    remote = remote_result.stdout.strip() if remote_result.returncode == 0 else None
    return ProjectSnapshot(
        path=root,
        name=root.name,
        commit=resolved_commit,
        tree=tree,
        remote=remote,
    )


def clone_at_commit(snapshot: ProjectSnapshot, destination: Path) -> None:
    if destination.exists():
        raise InfrastructureError("WORKSPACE_EXISTS", f"Workspace already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    try:
        clone = subprocess.run(
            [
                "git",
                "clone",
                "--no-hardlinks",
                "--no-checkout",
                "--",
                str(snapshot.path),
                str(destination),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,
            env=env,
            check=False,
        )
        if clone.returncode != 0:
            raise InfrastructureError(
                "CLONE_FAILED", (clone.stderr or clone.stdout).strip()[-3000:]
            )
        checkout = subprocess.run(
            ["git", "-C", str(destination), "checkout", "--detach", snapshot.commit],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
            env=env,
            check=False,
        )
        if checkout.returncode != 0:
            fetch = subprocess.run(
                [
                    "git",
                    "-C",
                    str(destination),
                    "fetch",
                    "--no-tags",
                    str(snapshot.path),
                    snapshot.commit,
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=120,
                env=env,
                check=False,
            )
            if fetch.returncode == 0:
                checkout = subprocess.run(
                    ["git", "-C", str(destination), "checkout", "--detach", snapshot.commit],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=120,
                    env=env,
                    check=False,
                )
        if checkout.returncode != 0:
            raise InfrastructureError(
                "CHECKOUT_FAILED", (checkout.stderr or checkout.stdout).strip()[-3000:]
            )
    except subprocess.TimeoutExpired as exc:
        raise InfrastructureError("CLONE_TIMEOUT", f"Project clone timed out: {exc}") from exc


def run_trusted_command(
    command: str,
    cwd: Path,
    timeout_seconds: int,
    *,
    on_log: LogCallback | None = None,
    source: str = "validator",
    stdout_path: Path | None = None,
    stderr_path: Path | None = None,
) -> dict:
    """Run a local trusted command while forwarding each output line immediately."""

    started = time.monotonic()
    process = subprocess.Popen(
        command,
        cwd=cwd,
        shell=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    stdout_parts: list[str] = []
    stderr_parts: list[str] = []

    def drain(
        stream,
        parts: list[str],
        destination: Path | None,
        channel: str,
    ) -> None:
        output = None
        if destination is not None:
            destination.parent.mkdir(parents=True, exist_ok=True)
            output = destination.open("a", encoding="utf-8")
        try:
            for line in iter(stream.readline, ""):
                parts.append(line)
                if output is not None:
                    output.write(line)
                    output.flush()
                if on_log is not None:
                    on_log(source, channel, line)
        finally:
            if output is not None:
                output.close()
            stream.close()

    stdout_thread = threading.Thread(
        target=drain,
        args=(process.stdout, stdout_parts, stdout_path, "stdout"),
        daemon=True,
    )
    stderr_thread = threading.Thread(
        target=drain,
        args=(process.stderr, stderr_parts, stderr_path, "stderr"),
        daemon=True,
    )
    stdout_thread.start()
    stderr_thread.start()
    timed_out = False
    while process.poll() is None:
        if time.monotonic() - started >= timeout_seconds:
            timed_out = True
            process.kill()
            break
        time.sleep(0.1)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
    stdout_thread.join(timeout=5)
    stderr_thread.join(timeout=5)
    result = {
        "command": command,
        "exit_code": None if timed_out else process.returncode,
        "stdout": "".join(stdout_parts)[-100_000:],
        "stderr": "".join(stderr_parts)[-100_000:],
        "duration_ms": int((time.monotonic() - started) * 1000),
    }
    if timed_out:
        result["timed_out"] = True
    return result


def capture_changes(workspace: Path) -> dict:
    patch = _git(workspace, "diff", "--binary", "HEAD", timeout=120)
    raw_status = subprocess.run(
        ["git", "-C", str(workspace), "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        capture_output=True,
        timeout=120,
        check=False,
    )
    if raw_status.returncode != 0:
        raise InfrastructureError("GIT_STATUS_FAILED", "Unable to capture final Git status")
    entries = [item for item in raw_status.stdout.decode("utf-8", "replace").split("\0") if item]
    changed_files: list[str] = []
    untracked_files: list[str] = []
    for entry in entries:
        if len(entry) < 4:
            continue
        code = entry[:2]
        path = entry[3:].replace("\\", "/")
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        if path.startswith((".aaw-eval/", ".agents/skills/aaw-eval-")):
            continue
        changed_files.append(path)
        if code == "??":
            untracked_files.append(path)
    return {
        "patch": patch,
        "changed_files": sorted(set(changed_files)),
        "untracked_files": sorted(set(untracked_files)),
    }


def file_tree_manifest(workspace: Path) -> list[dict]:
    manifest: list[dict] = []
    for root, directories, files in os.walk(workspace, topdown=True):
        current = Path(root)
        directories[:] = sorted(
            directory
            for directory in directories
            if directory != ".git"
            and not (current == workspace and directory == ".aaw-eval")
            and not (
                current.relative_to(workspace).as_posix() == ".agents/skills"
                and directory.startswith("aaw-eval-")
            )
        )
        for name in sorted(files):
            path = current / name
            relative = path.relative_to(workspace).as_posix()
            try:
                stat_result = path.stat()
            except OSError:
                continue
            manifest.append({"path": relative, "size": stat_result.st_size})
    return manifest
