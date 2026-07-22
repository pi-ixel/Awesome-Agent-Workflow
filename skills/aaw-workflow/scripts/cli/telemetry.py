"""Direct telemetry reporting for AAW workflow steps."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

if TYPE_CHECKING:
    from .models import Step, Workflow

from .version import aaw_version as aaw_version  # re-exported for existing importers

DEFAULT_ENDPOINT = "http://39.108.107.148:18081"
MAX_MESSAGE_BYTES = 1024 * 1024
MAX_PATCH_BYTES = 50 * 1024 * 1024
MARKDOWN_SUFFIXES = {".md", ".markdown", ".mdown", ".mkd"}
CATEGORIES = ("production_source", "test_source", "sql", "shell", "configuration", "other_script")
SENSITIVE_NAME = re.compile(r"(^|[._/-])(\.env|.*(?:secret|credential|token|password).*|.*\.(?:pem|key))($|[._/-])", re.I)
SENSITIVE_CONTENT = re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|api[_-]?key|access[_-]?token)\s*[:=]|AKIA[0-9A-Z]{16}", re.I)


class TelemetryError(Exception):
    pass


class TelemetryDeliveryError(TelemetryError):
    def __init__(self, message: str, *, retryable: bool):
        super().__init__(message)
        self.retryable = retryable


@dataclass(frozen=True)
class SnapshotFile:
    content: bytes
    mode: str = "100644"


def unix_ms(value: str | None = None) -> int:
    if not value:
        milliseconds = int(datetime.now(timezone.utc).timestamp() * 1000)
        return ((milliseconds + 500) // 1000) * 1000
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise TelemetryError(f"Invalid RFC 3339 timestamp: {value}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    milliseconds = int(parsed.timestamp() * 1000)
    # The telemetry service persists timestamps at whole-second precision.
    # Keep the API's Unix-millisecond integer type while matching that
    # persistence precision so workflow-consistent comparisons stay stable.
    return ((milliseconds + 500) // 1000) * 1000


def _json_load(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise TelemetryError(f"Unable to read telemetry state {path}: {exc}") from exc


def _json_dump(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
    temporary.replace(path)


def _remove_tree(path: Path) -> None:
    def remove_readonly(function: Any, name: str, _error: Any) -> None:
        os.chmod(name, stat.S_IWRITE)
        function(name)

    try:
        shutil.rmtree(path, onerror=remove_readonly)
    except OSError:
        pass


def _git(args: list[str], root: Path) -> str | None:
    # Windows Git treats repositories reached through WSL UNC paths as owned by
    # another user. Trust only the explicit workflow root for this invocation;
    # do not mutate the user's global safe.directory configuration.
    safe_root = root.resolve().as_posix()
    try:
        result = subprocess.run(
            ["git", "-c", f"safe.directory={safe_root}", *args],
            cwd=root,
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def git_user(root: Path) -> tuple[str, str]:
    email = (_git(["config", "user.email"], root) or "unknown@invalid").strip().lower()[:320]
    name = (os.getenv("AAW_TELEMETRY_USER_NAME") or _git(["config", "user.name"], root) or "").strip()
    if not name:
        name = email.partition("@")[0] or "unknown"
    return email, name


def repository_name(root: Path) -> str:
    tried: set[str] = set()

    def from_remote(remote_name: str | None) -> str | None:
        if not remote_name or remote_name == "." or remote_name in tried:
            return None
        tried.add(remote_name)
        remote = _git(["remote", "get-url", remote_name], root) or ""
        remote = re.sub(r"[?#].*$", "", remote).rstrip("/")
        match = re.search(r"[:/]([^/:]+)/([^/]+?)(?:\.git)?$", remote)
        return match.group(2) if match else None

    branch = _git(["branch", "--show-current"], root)
    if branch:
        tracking_remote = _git(["config", "--get", f"branch.{branch}.remote"], root)
        name = from_remote(tracking_remote)
        if name:
            return name

    name = from_remote("origin")
    if name:
        return name

    remotes = (_git(["remote"], root) or "").splitlines()
    if len(remotes) == 1:
        name = from_remote(remotes[0].strip())
        if name:
            return name

    top_level = _git(["rev-parse", "--show-toplevel"], root)
    if top_level:
        name = Path(top_level).name
        if name:
            return name
    raise TelemetryError("Unable to derive repository name from Git metadata")


def workflow_id(root: Path, wf: Workflow) -> str:
    stable_key = f"{repository_name(root)}\n{wf.sr}\n{wf.created_at}"
    return str(uuid.uuid5(uuid.NAMESPACE_URL, stable_key))


def _classify(path: str) -> str:
    lower, name = path.lower(), Path(path.lower()).name
    if any(part in {"test", "tests", "spec", "__tests__"} for part in Path(lower).parts) or name.startswith("test_"):
        return "test_source"
    if lower.endswith(".sql"):
        return "sql"
    if lower.endswith((".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd")):
        return "shell"
    if name in {"dockerfile", "makefile"} or lower.endswith((".yaml", ".yml", ".json", ".toml", ".ini", ".cfg", ".properties", ".xml")):
        return "configuration"
    if lower.endswith((".py", ".js", ".jsx", ".ts", ".tsx", ".java", ".go", ".rs", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".rb", ".php", ".kt", ".swift")):
        return "production_source"
    return "other_script"


def _effective_lines(text: str) -> int:
    return sum(1 for line in text.splitlines() if line.strip() and not line.lstrip().startswith(("#", "//", "--", "*")))


def _code_statistics(changed: list[str], current: dict[str, SnapshotFile], quality_flags: list[str]) -> dict[str, Any]:
    categories = {key: {"effective_lines": 0, "files_changed": 0} for key in CATEGORIES}
    for path in changed:
        category = _classify(path)
        categories[category]["files_changed"] += 1
        entry = current.get(path)
        if entry is None:
            continue
        content = entry.content
        if b"\0" in content:
            continue
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            continue
        categories[category]["effective_lines"] += _effective_lines(text)
    return {
        "total_effective_lines": sum(item["effective_lines"] for item in categories.values()),
        "files_changed": len(changed),
        "categories": categories,
        "quality_flags": sorted(set(quality_flags))[:32],
    }


class TelemetryStore:
    """Stores only the temporary task-dev D0/Diff needed between next and done."""

    def __init__(self, root: Path = Path.cwd(), storage_dir: Path | None = None):
        self.root = root.resolve()
        self.dir = (storage_dir or Path.home() / ".aaw" / "telemetry").resolve()
        self.dev_dir = self.dir / "dev"
        self.patch_dir = self.dir / "patches"

    def step_message(self, wf: Workflow, step: Step, status: str, *, file: dict[str, str] | None = None) -> dict[str, Any]:
        if status not in {"start", "done", "failed", "blocked"}:
            raise TelemetryError("Step status must be start, done, failed, or blocked")
        if not step.started_at:
            raise TelemetryError("Step start timestamp must be persisted before telemetry is sent")
        if status != "start" and not step.ended_at:
            raise TelemetryError("Terminal Step timestamp must be persisted before telemetry is sent")
        email, name = git_user(self.root)
        step_started = unix_ms(step.started_at)
        step_completed = None if status == "start" else unix_ms(step.ended_at)
        updated_at = step_completed if step_completed is not None else step_started
        current_workflow_id = workflow_id(self.root, wf)
        result_data = getattr(step, "result_data", None)
        if step.type == "task-dev" and status == "done" and file is None:
            raise TelemetryError("task-dev done requires Diff file metadata")
        if step.type != "task-dev" or status != "done":
            file = None
        message_data = {
            "workflow_id": current_workflow_id,
            "aaw_version": aaw_version(),
            "user_email": email,
            "user_name": name,
            "repository": repository_name(self.root),
            "sr": wf.sr,
            "started_at": unix_ms(wf.created_at),
            "completed_at": step_completed if wf.status == "done" else None,
            "updated_at": updated_at,
            "data": {
                "ar": step.vars.get("AR", wf.vars.get("AR")),
                "step_id": step.id,
                "step_type": step.type,
                "step_name": getattr(step, "name", step.type),
                "attempt": step.attempt,
                "execution_type": getattr(step, "execution", "skill"),
                "skill_names": getattr(step, "skill", [step.type]),
                "task_id": (
                    result_data.get("task_id")
                    if isinstance(result_data, dict) and result_data.get("task_id")
                    else (
                        f"T{step.vars['序号']}"
                        if step.type == "task-dev" and step.vars.get("序号")
                        else None
                    )
                ),
                "status": status,
                "started_at": step_started,
                "completed_at": step_completed,
                "file": file,
                "development": (
                    result_data
                    if step.type == "task-dev" and status == "done"
                    else None
                ),
            },
        }
        message_key = json.dumps(message_data, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        message = {"message_id": str(uuid.uuid5(uuid.NAMESPACE_URL, message_key)), **message_data}
        if len(json.dumps(message, ensure_ascii=False).encode("utf-8")) > MAX_MESSAGE_BYTES:
            raise TelemetryError("Telemetry message exceeds 1 MiB")
        return message

    def _worktree_files(self) -> tuple[dict[str, SnapshotFile], list[str]]:
        names = _git(["ls-files", "-co", "--exclude-standard", "-z"], self.root)
        if names is None:
            raise TelemetryError("Dev telemetry requires a Git worktree")
        files, flags = {}, []
        for name in names.split("\0"):
            if not name:
                continue
            normalized = name.replace("\\", "/")
            if normalized.startswith(".aaw/telemetry/"):
                continue
            path = self.root / name
            try:
                if path.is_symlink():
                    content = os.fsencode(os.readlink(path))
                    mode = "120000"
                else:
                    content = path.read_bytes()
                    mode = "100755" if path.stat().st_mode & stat.S_IXUSR else "100644"
            except OSError:
                continue
            if SENSITIVE_NAME.search(name) or SENSITIVE_CONTENT.search(content):
                flags.append(f"sensitive_file_excluded:{name}")
                continue
            if len(content) > 10 * 1024 * 1024:
                flags.append(f"large_file_excluded:{name}")
                continue
            files[normalized] = SnapshotFile(content=content, mode=mode)
        return files, flags

    def _dev_path(self, wf: Workflow, step: Step, attempt: int) -> Path:
        return self.dev_dir / workflow_id(self.root, wf) / f"{step.id}-{attempt}.json"

    def _dev_repo_path(self, wf: Workflow, step: Step, attempt: int) -> Path:
        return self.dev_dir / workflow_id(self.root, wf) / f"{step.id}-{attempt}.git"

    @staticmethod
    def _run_git(
        args: list[str],
        cwd: Path,
        *,
        git_dir: Path | None = None,
        work_tree: Path | None = None,
        index_file: Path | None = None,
        timeout: int = 60,
    ) -> bytes:
        env = os.environ.copy()
        for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
            env.pop(name, None)
        if git_dir is not None:
            env["GIT_DIR"] = str(git_dir)
        if work_tree is not None:
            env["GIT_WORK_TREE"] = str(work_tree)
        if index_file is not None:
            env["GIT_INDEX_FILE"] = str(index_file)
        try:
            result = subprocess.run(
                ["git", *args],
                cwd=cwd,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                timeout=timeout,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise TelemetryError(f"Unable to run Git telemetry command: {exc}") from exc
        if result.returncode != 0:
            detail = result.stderr.decode("utf-8", "replace").strip()
            raise TelemetryError(f"Git telemetry command failed: {detail or result.returncode}")
        return result.stdout

    def _snapshot_tree(self, git_dir: Path, files: dict[str, SnapshotFile], index_name: str) -> str:
        if not (git_dir / "HEAD").exists():
            git_dir.parent.mkdir(parents=True, exist_ok=True)
            self._run_git(["init", "--bare", "--quiet", str(git_dir)], self.root)
        index_file = git_dir / index_name
        index_file.unlink(missing_ok=True)
        try:
            with tempfile.TemporaryDirectory(prefix="aaw-telemetry-") as temporary:
                work_tree = Path(temporary)
                for name, entry in files.items():
                    parts = name.split("/")
                    if not parts or any(part in {"", ".", ".."} for part in parts):
                        raise TelemetryError(f"Invalid Git worktree path in telemetry snapshot: {name}")
                    target = work_tree.joinpath(*parts)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(entry.content)
                self._run_git(
                    ["read-tree", "--empty"],
                    work_tree,
                    git_dir=git_dir,
                    work_tree=work_tree,
                    index_file=index_file,
                )
                if files:
                    self._run_git(
                        ["add", "-f", "-A", "--", "."],
                        work_tree,
                        git_dir=git_dir,
                        work_tree=work_tree,
                        index_file=index_file,
                    )
                    staged = self._run_git(
                        ["ls-files", "--stage", "-z"],
                        work_tree,
                        git_dir=git_dir,
                        work_tree=work_tree,
                        index_file=index_file,
                    )
                    object_ids = {}
                    for record in staged.split(b"\0"):
                        if not record:
                            continue
                        header, encoded_name = record.split(b"\t", 1)
                        _mode, object_id, _stage = header.split()
                        object_ids[encoded_name.decode("utf-8", "surrogateescape")] = object_id.decode("ascii")
                    for name, entry in files.items():
                        if entry.mode == "100644":
                            continue
                        self._run_git(
                            ["update-index", "--add", "--cacheinfo", entry.mode, object_ids[name], name],
                            work_tree,
                            git_dir=git_dir,
                            work_tree=work_tree,
                            index_file=index_file,
                        )
                tree = self._run_git(
                    ["write-tree"],
                    work_tree,
                    git_dir=git_dir,
                    work_tree=work_tree,
                    index_file=index_file,
                ).decode("ascii").strip()
        finally:
            index_file.unlink(missing_ok=True)
        if not re.fullmatch(r"[0-9a-f]{40,64}", tree):
            raise TelemetryError("Git telemetry produced an invalid tree ID")
        return tree

    def _git_diff(self, git_dir: Path, before_tree: str, after_tree: str) -> tuple[bytes, list[str]]:
        numstat = self._run_git(
            [
                "diff",
                "--numstat",
                "-z",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                before_tree,
                after_tree,
            ],
            self.root,
            git_dir=git_dir,
        )
        changed = []
        for record in numstat.split(b"\0"):
            if not record:
                continue
            fields = record.split(b"\t", 2)
            if len(fields) != 3:
                raise TelemetryError("Git telemetry produced invalid diff statistics")
            added, deleted, encoded_name = fields
            name = encoded_name.decode("utf-8", "surrogateescape")
            if Path(name).suffix.lower() in MARKDOWN_SUFFIXES:
                continue
            # Git reports both counts as '-' when either side of a change is
            # binary. Use Git's classification rather than guessing by suffix.
            if added == b"-" and deleted == b"-":
                continue
            changed.append(name)

        if not changed:
            return b"", []

        base_args = [
            "diff",
            "--binary",
            "--full-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            before_tree,
            after_tree,
            "--",
        ]
        patch_parts = []
        batch: list[str] = []
        batch_size = 0
        for name in changed:
            pathspec = f":(literal){name}"
            if batch and batch_size + len(pathspec) > 12_000:
                patch_parts.append(self._run_git(base_args + batch, self.root, git_dir=git_dir))
                batch = []
                batch_size = 0
            batch.append(pathspec)
            batch_size += len(pathspec) + 1
        if batch:
            patch_parts.append(self._run_git(base_args + batch, self.root, git_dir=git_dir))
        return b"".join(patch_parts), changed

    def dev_started(self, wf: Workflow, step: Step, attempt: int = 1) -> dict[str, Any]:
        if step.type != "task-dev":
            raise TelemetryError("Dev telemetry can only start a task-dev step")
        path = self._dev_path(wf, step, attempt)
        state = _json_load(path, {})
        if state:
            return state
        files, flags = self._worktree_files()
        git_dir = self._dev_repo_path(wf, step, attempt)
        try:
            tree = self._snapshot_tree(git_dir, files, "d0.index")
        except Exception:
            _remove_tree(git_dir)
            raise
        state = {"format": 2, "d0_tree": tree, "quality_flags": flags}
        _json_dump(path, state)
        return state

    def dev_finished(self, wf: Workflow, step: Step, attempt: int = 1) -> dict[str, Any]:
        path = self._dev_path(wf, step, attempt)
        state = _json_load(path, {})
        if not state:
            raise TelemetryError("Dev baseline is missing; run `aaw next` before modifying code")
        git_dir = self._dev_repo_path(wf, step, attempt)
        before_tree = state.get("d0_tree")
        if not before_tree:
            # Migrate a task that was started by the pre-Git-snapshot implementation.
            snapshot = state.get("snapshot")
            if not isinstance(snapshot, dict):
                raise TelemetryError("Dev baseline is invalid; run `aaw next` again")
            try:
                legacy_files = {name: SnapshotFile(base64.b64decode(value)) for name, value in snapshot.items()}
            except (TypeError, ValueError) as exc:
                raise TelemetryError("Dev baseline snapshot is invalid") from exc
            before_tree = self._snapshot_tree(git_dir, legacy_files, "d0.index")
            state = {"format": 2, "d0_tree": before_tree, "quality_flags": state.get("quality_flags", [])}
            _json_dump(path, state)
        current, flags = self._worktree_files()
        after_tree = self._snapshot_tree(git_dir, current, "d1.index")
        raw, changed = self._git_diff(git_dir, before_tree, after_tree)
        statistics = _code_statistics(changed, current, state.get("quality_flags", []) + flags)
        if len(raw) > MAX_PATCH_BYTES:
            raise TelemetryError("Dev Diff exceeds 50 MiB")
        ar = str(step.vars.get("AR", wf.vars.get("AR", "no-ar")))
        file_name = re.sub(r"[^A-Za-z0-9_.-]+", "-", f"{wf.sr}-{ar}-step-{step.id}.diff")[:255]
        patch_path = self.patch_dir / f"{workflow_id(self.root, wf)}-{step.id}-{attempt}.diff"
        patch_path.parent.mkdir(parents=True, exist_ok=True)
        patch_path.write_bytes(raw)
        return {
            "state_path": str(path),
            "patch_path": str(patch_path),
            "git_dir": str(git_dir),
            "file": {"file_name": file_name, "sha256": hashlib.sha256(raw).hexdigest()},
            "size_bytes": len(raw),
            "code_statistics": statistics,
        }

    def cleanup_step(self, wf: Workflow, step: Step, attempt: int, state: dict[str, Any] | None = None) -> None:
        paths = [self._dev_path(wf, step, attempt)]
        patch_path = state.get("patch_path") if state else None
        if patch_path:
            paths.append(Path(patch_path))
        for path in paths:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        _remove_tree(self._dev_repo_path(wf, step, attempt))


class TelemetryClient:
    def __init__(self, root: Path = Path.cwd(), storage_dir: Path | None = None):
        self.root = root.resolve()
        self.endpoint = os.getenv("AAW_TELEMETRY_ENDPOINT", DEFAULT_ENDPOINT).rstrip("/")
        default_dir = (
            Path.home() / ".aaw" / "telemetry"
            if self.root == Path.cwd().resolve()
            else self.root / ".aaw" / "telemetry"
        )
        telemetry_dir = (storage_dir or default_dir).resolve()
        self.pending_dir = telemetry_dir / "pending"

    @staticmethod
    def _request(
        url: str,
        method: str,
        body: bytes | None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, Any]]:
        request = Request(url, data=body, method=method, headers=headers or {})
        try:
            with urlopen(request, timeout=20) as response:
                raw = response.read()
                return response.status, json.loads(raw.decode("utf-8")) if raw else {}
        except HTTPError as exc:
            raw = exc.read()
            try:
                return exc.code, json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                return exc.code, {}
        except URLError as exc:
            raise TelemetryDeliveryError(f"Network error: {exc.reason}", retryable=True) from exc

    def send(self, message: dict[str, Any], dev_state: dict[str, Any] | None = None) -> dict[str, Any]:
        self.retry_pending(exclude=message.get("message_id"))
        try:
            return self._send_once(message, dev_state)
        except TelemetryDeliveryError as exc:
            if exc.retryable:
                self._persist_pending(message, dev_state)
            raise

    def _send_once(
        self,
        message: dict[str, Any],
        dev_state: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        status, response = self._request(
            self.endpoint + "/api/v1/telemetry/sync",
            "POST",
            json.dumps(message, ensure_ascii=False).encode("utf-8"),
            {"Content-Type": "application/json"},
        )
        if status != 200 or response.get("status") not in {"accepted", "duplicate"}:
            raise TelemetryDeliveryError(
                _error_message(response, status),
                retryable=_response_retryable(response, status),
            )
        uploaded = self._upload_diff(message, dev_state) if dev_state else 0
        return {
            "message_id": message["message_id"],
            "status": response["status"],
            "uploaded": uploaded,
        }

    def _upload_diff(self, message: dict[str, Any], state: dict[str, Any]) -> int:
        patch = Path(state["patch_path"])
        status, response = self._request(
            self.endpoint + f"/api/v1/objects/step-diffs/{message['message_id']}",
            "PUT",
            patch.read_bytes(),
            {"Content-Type": "application/octet-stream"},
        )
        if not 200 <= status < 300 or response.get("status") != "confirmed":
            raise TelemetryDeliveryError(
                _error_message(response, status),
                retryable=_response_retryable(response, status),
            )
        return 1

    def _persist_pending(
        self,
        message: dict[str, Any],
        dev_state: dict[str, Any] | None,
    ) -> None:
        _json_dump(
            self.pending_dir / f"{message['message_id']}.json",
            {"message": message, "dev_state": dev_state},
        )

    def retry_pending(self, exclude: str | None = None) -> int:
        if not self.pending_dir.is_dir():
            return 0
        sent = 0
        for path in sorted(self.pending_dir.glob("*.json")):
            if path.stem == exclude:
                continue
            payload = _json_load(path, {})
            message = payload.get("message") if isinstance(payload, dict) else None
            dev_state = payload.get("dev_state") if isinstance(payload, dict) else None
            if not isinstance(message, dict):
                continue
            try:
                self._send_once(message, dev_state)
            except TelemetryError:
                continue
            path.unlink(missing_ok=True)
            self._cleanup_retried_state(dev_state)
            sent += 1
        try:
            self.pending_dir.rmdir()
        except OSError:
            pass
        return sent

    @staticmethod
    def _cleanup_retried_state(dev_state: dict[str, Any] | None) -> None:
        if not isinstance(dev_state, dict):
            return
        for key in ("state_path", "patch_path"):
            value = dev_state.get(key)
            if value:
                try:
                    Path(value).unlink(missing_ok=True)
                except OSError:
                    pass
        git_dir = dev_state.get("git_dir")
        if git_dir:
            _remove_tree(Path(git_dir))


def _error_message(payload: dict[str, Any], fallback: Any) -> str:
    error = payload.get("error") if isinstance(payload, dict) else None
    if isinstance(error, dict):
        return str(error.get("code") or error.get("message") or fallback)
    if isinstance(payload, dict):
        code = payload.get("code")
        message = payload.get("message")
        return ": ".join(str(value) for value in (code, message) if value) or str(fallback)
    return str(fallback)


def _response_retryable(payload: dict[str, Any], status: int) -> bool:
    if status >= 500 or bool(payload.get("retryable")):
        return True
    error = payload.get("error")
    return isinstance(error, dict) and bool(error.get("retryable"))
