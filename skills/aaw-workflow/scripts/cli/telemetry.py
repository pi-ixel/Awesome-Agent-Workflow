"""Offline-first telemetry support for the AAW workflow CLI.

The module deliberately uses only the standard library.  Workflow commands write
durable JSON records locally; network work happens only when ``flush`` is called
(or explicitly enabled by an embedding application).
"""

from __future__ import annotations

import base64
import difflib
import gzip
import hashlib
import json
import os
import re
import subprocess
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

if TYPE_CHECKING:
    from .models import Step, Workflow

SCHEMA_VERSION = 1
MAX_BATCH_RECORDS = 100
MAX_BATCH_BYTES = 1024 * 1024
MAX_PATCH_BYTES = 50 * 1024 * 1024
CATEGORIES = (
    "production_source", "test_source", "sql", "shell", "configuration", "other_script"
)
SENSITIVE_NAME = re.compile(r"(^|[._/-])(\.env|.*(?:secret|credential|token|password).*|.*\.(?:pem|key))($|[._/-])", re.I)
SENSITIVE_CONTENT = re.compile(
    rb"-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|api[_-]?key|access[_-]?token)\s*[:=]|AKIA[0-9A-Z]{16}",
    re.I,
)


class TelemetryError(Exception):
    """An actionable telemetry error."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _json_dump(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True), "utf-8")
    temp.replace(path)


def _json_load(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise TelemetryError(f"Unable to read telemetry state {path}: {exc}") from exc


def _git(args: list[str], cwd: Path) -> str | None:
    try:
        result = subprocess.run(
            ["git", *args], cwd=cwd, text=True, encoding="utf-8", errors="replace",
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False, timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def _sanitize_remote(remote: str) -> str:
    # Handles both URLs and scp-like git@host:path remotes without leaking query data.
    remote = re.sub(r"(://)[^/@]+@", r"\1", remote)
    remote = re.sub(r"^[^@\s/:]+@", "", remote)
    return re.sub(r"[?#].*$", "", remote)


def repository_identity(root: Path) -> tuple[dict[str, Any], str]:
    branch = _git(["branch", "--show-current"], root) or "detached"
    target = _git(["config", "--get", "branch." + branch + ".merge"], root)
    target = target.rsplit("/", 1)[-1] if target else None
    names = (_git(["remote"], root) or "").splitlines()
    remotes = []
    for name in names[:6]:
        value = _git(["remote", "get-url", name], root)
        if value:
            remotes.append({"name": name[:128], "url": _sanitize_remote(value)[:2048]})
    if not remotes:
        remotes = [{"name": "local", "url": "unknown"}]
    return {"remotes": remotes, "branch": branch[:128], "target_branch_hint": target}, branch


def git_user(root: Path) -> tuple[str, str]:
    return (
        (_git(["config", "user.email"], root) or "unknown@invalid").strip().lower()[:320],
        (_git(["config", "user.name"], root) or "unknown")[:100],
    )


def head_sha(root: Path) -> str:
    value = _git(["rev-parse", "HEAD"], root)
    return value if value and re.fullmatch(r"[0-9a-f]{40,64}", value) else "0" * 40


def _classify(path: str) -> str:
    lower = path.lower()
    name = Path(lower).name
    if any(part in {"test", "tests", "spec", "__tests__"} for part in Path(lower).parts) or name.startswith("test_") or name.endswith(("_test.py", ".test.js", ".spec.ts")):
        return "test_source"
    if lower.endswith(".sql"):
        return "sql"
    if lower.endswith((".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd")):
        return "shell"
    if name in {"dockerfile", "makefile"} or lower.endswith((".yaml", ".yml", ".json", ".toml", ".ini", ".cfg", ".properties", ".xml")):
        return "configuration"
    if lower.endswith((".py", ".js", ".jsx", ".ts", ".tsx", ".java", ".go", ".rs", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".rb", ".php", ".kt", ".swift")):
        return "production_source"
    if lower.endswith((".lua", ".pl", ".r", ".groovy", ".gradle")):
        return "other_script"
    return "production_source"


def _effective_lines(text: str) -> int:
    return sum(1 for line in text.splitlines() if line.strip() and not line.lstrip().startswith(("#", "//", "--", "*")))


class TelemetryStore:
    """Durable local queue and Dev snapshot store for one checkout."""

    def __init__(self, root: Path = Path.cwd()):
        self.root = root.resolve()
        self.dir = self.root / ".aaw" / "telemetry"
        self.queue_path = self.dir / "queue.json"
        self.config_path = self.dir / "config.json"
        self.dev_dir = self.dir / "dev"
        self.patch_dir = self.dir / "patches"

    def config(self) -> dict[str, Any]:
        stored = _json_load(self.config_path, {})
        return {
            "endpoint": os.getenv("AAW_TELEMETRY_ENDPOINT", stored.get("endpoint", "")).rstrip("/"),
            "token_present": bool(os.getenv("AAW_TELEMETRY_TOKEN")),
        }

    def configure(self, endpoint: str) -> None:
        if not endpoint.startswith(("https://", "http://")):
            raise TelemetryError("Telemetry endpoint must start with http:// or https://")
        _json_dump(self.config_path, {"endpoint": endpoint.rstrip("/")})

    def _queue(self) -> list[dict[str, Any]]:
        data = _json_load(self.queue_path, [])
        if not isinstance(data, list):
            raise TelemetryError("Telemetry queue is not a JSON list")
        return data

    def _save_queue(self, records: list[dict[str, Any]]) -> None:
        _json_dump(self.queue_path, records)

    def enqueue(self, record_type: str, record_id: str, data: dict[str, Any], *, occurred_at: str | None = None, deferred: bool = False) -> str:
        occurred_at = occurred_at or utc_now()
        entry = {
            "queue_id": str(uuid.uuid4()), "record_type": record_type, "record_id": record_id,
            "occurred_at": occurred_at, "data": data, "deferred": deferred, "attempts": 0,
            "last_error": None, "terminal": False,
        }
        queue = self._queue()
        # A repeat command must preserve the first generated payload and timestamp.
        for old in queue:
            if old["record_type"] == record_type and old["record_id"] == record_id and old["occurred_at"] == occurred_at and old["data"] == data:
                return old["queue_id"]
        queue.append(entry)
        self._save_queue(queue)
        return entry["queue_id"]

    def workflow_state_path(self, sr: str) -> Path:
        return self.dir / "workflows" / f"{sr}.json"

    def workflow_id(self, sr: str) -> str | None:
        return _json_load(self.workflow_state_path(sr), {}).get("workflow_run_id")

    def workflow_started(self, wf: Workflow) -> str:
        path = self.workflow_state_path(wf.sr)
        state = _json_load(path, {})
        if state.get("workflow_run_id"):
            return state["workflow_run_id"]
        record_id = str(uuid.uuid4())
        email, name = git_user(self.root)
        identity, _ = repository_identity(self.root)
        occurred_at = utc_now()
        data = {
            "repository_identity": identity, "git_user_email": email, "git_user_name": name,
            "sr": wf.sr, "ar": str(wf.vars.get("AR")) if wf.vars.get("AR") else None,
            "aaw_version": aaw_version(), "status": "in_progress", "started_at": occurred_at,
            "last_activity_at": occurred_at,
        }
        self.enqueue("workflow_run", record_id, data, occurred_at=occurred_at)
        _json_dump(path, {"workflow_run_id": record_id, "started_at": occurred_at})
        return record_id

    def workflow_updated(self, wf: Workflow, status: str) -> None:
        workflow_id = self.workflow_started(wf)
        occurred_at = utc_now()
        data: dict[str, Any] = {"status": status, "last_activity_at": occurred_at}
        if status == "completed":
            data["completed_at"] = occurred_at
        self.enqueue("workflow_run", workflow_id, data, occurred_at=occurred_at)

    def _step_state_path(self, workflow_id: str, step: Step, attempt: int) -> Path:
        return self.dir / "steps" / workflow_id / f"{step.id}-{attempt}.json"

    def step_started(self, wf: Workflow, step: Step, attempt: int = 1) -> str:
        workflow_id = self.workflow_started(wf)
        path = self._step_state_path(workflow_id, step, attempt)
        state = _json_load(path, {})
        if state.get("step_execution_id"):
            return state["step_execution_id"]
        record_id, occurred_at = str(uuid.uuid4()), utc_now()
        data = {
            "workflow_run_id": workflow_id, "step_id": step.id, "step_type": step.type[:128],
            "step_name": step.name[:256], "skill_names": step.skill[:32], "execution_type": step.execution,
            "attempt": attempt, "status": "running", "started_at": occurred_at,
        }
        self.enqueue("step_execution", record_id, data, occurred_at=occurred_at)
        _json_dump(path, {"step_execution_id": record_id, "started_at": occurred_at})
        return record_id

    def step_finished(self, wf: Workflow, step: Step, status: str, attempt: int = 1) -> None:
        if status not in {"completed", "failed", "blocked", "superseded"}:
            raise TelemetryError("Step finish status must be completed, failed, blocked, or superseded")
        record_id = self.step_started(wf, step, attempt)
        occurred_at = utc_now()
        self.enqueue("step_execution", record_id, {"status": status, "ended_at": occurred_at}, occurred_at=occurred_at)

    def _dev_state_path(self, workflow_id: str, step_execution_id: str) -> Path:
        return self.dev_dir / workflow_id / f"{step_execution_id}.json"

    def _worktree_files(self) -> tuple[dict[str, bytes], list[str]]:
        names = _git(["ls-files", "-co", "--exclude-standard", "-z"], self.root)
        if names is None:
            raise TelemetryError("Dev telemetry requires a Git worktree")
        files: dict[str, bytes] = {}
        flags: list[str] = []
        for name in names.split("\0"):
            if not name or name.startswith(".git/"):
                continue
            path = self.root / name
            try:
                content = path.read_bytes()
            except OSError:
                continue
            if SENSITIVE_NAME.search(name) or SENSITIVE_CONTENT.search(content):
                flags.append(f"sensitive_file_excluded:{name}")
                continue
            if len(content) > 10 * 1024 * 1024:
                flags.append(f"large_file_excluded:{name}")
                continue
            files[name.replace("\\", "/")] = content
        return files, flags

    @staticmethod
    def _encode_snapshot(files: dict[str, bytes]) -> dict[str, str]:
        return {path: base64.b64encode(content).decode("ascii") for path, content in files.items()}

    @staticmethod
    def _decode_snapshot(raw: dict[str, str]) -> dict[str, bytes]:
        return {path: base64.b64decode(content) for path, content in raw.items()}

    def dev_started(self, wf: Workflow, step: Step, attempt: int = 1) -> dict[str, Any]:
        if step.type != "task-dev":
            raise TelemetryError("Dev telemetry can only start a task-dev step")
        step_execution_id = self.step_started(wf, step, attempt)
        workflow_id = self.workflow_started(wf)
        path = self._dev_state_path(workflow_id, step_execution_id)
        state = _json_load(path, {})
        if state.get("dev_run_id"):
            return state
        files, flags = self._worktree_files()
        identity, branch = repository_identity(self.root)
        occurred_at = utc_now()
        dev_id = str(uuid.uuid4())
        data = {
            "workflow_run_id": workflow_id, "step_execution_id": step_execution_id, "branch": branch,
            "head_sha_start": head_sha(self.root), "status": "running", "started_at": occurred_at,
        }
        self.enqueue("dev_run", dev_id, data, occurred_at=occurred_at)
        state = {
            "dev_run_id": dev_id, "workflow_run_id": workflow_id, "step_execution_id": step_execution_id,
            "step_id": step.id, "attempt": attempt, "started_at": occurred_at, "branch": branch,
            "snapshot": self._encode_snapshot(files), "quality_flags": flags,
        }
        _json_dump(path, state)
        return state

    def dev_finished(self, wf: Workflow, step: Step, attempt: int = 1, status: str = "completed") -> dict[str, Any]:
        workflow_id = self.workflow_started(wf)
        step_execution_id = self.step_started(wf, step, attempt)
        path = self._dev_state_path(workflow_id, step_execution_id)
        state = _json_load(path, {})
        if not state.get("dev_run_id"):
            raise TelemetryError("Dev baseline is missing; run `aaw telemetry dev-start` before modifying code")
        if state.get("finished_at"):
            return state
        current, flags = self._worktree_files()
        before = self._decode_snapshot(state["snapshot"])
        patch, statistics = build_patch(before, current, state.get("quality_flags", []) + flags)
        occurred_at = utc_now()
        state["finished_at"] = occurred_at
        state["status"] = status
        state["head_sha_end"] = head_sha(self.root)
        state["code_statistics"] = statistics
        if status != "completed":
            self.enqueue("dev_run", state["dev_run_id"], {"status": status, "completed_at": occurred_at}, occurred_at=occurred_at)
            _json_dump(path, state)
            return state
        patch_name = f"{state['dev_run_id']}.patch.gz"
        patch_path = self.patch_dir / patch_name
        compressed = gzip.compress(patch.encode("utf-8"), mtime=0)
        if len(compressed) > MAX_PATCH_BYTES:
            raise TelemetryError("Compressed Dev Patch exceeds 50 MiB")
        patch_path.parent.mkdir(parents=True, exist_ok=True)
        patch_path.write_bytes(compressed)
        state.update({"patch_path": str(patch_path), "sha256": hashlib.sha256(compressed).hexdigest(), "compressed_size_bytes": len(compressed), "compression": "gzip"})
        waiting = {
            "status": "waiting_objects", "head_sha_end": state["head_sha_end"], "completed_at": occurred_at,
            "window_ends_at": (datetime.now(timezone.utc) + timedelta(days=30)).isoformat().replace("+00:00", "Z"),
            "code_statistics": statistics,
        }
        self.enqueue("dev_run", state["dev_run_id"], waiting, occurred_at=occurred_at)
        _json_dump(path, state)
        return state

    def pending(self) -> list[dict[str, Any]]:
        return self._queue()

    def completed_dev_states(self) -> list[tuple[Path, dict[str, Any]]]:
        return [(path, _json_load(path, {})) for path in self.dev_dir.glob("**/*.json")]


def build_patch(before: dict[str, bytes], after: dict[str, bytes], quality_flags: list[str]) -> tuple[str, dict[str, Any]]:
    pieces: list[str] = []
    changed: dict[str, list[str]] = {}
    for path in sorted(set(before) | set(after)):
        old, new = before.get(path), after.get(path)
        if old == new:
            continue
        try:
            old_text = old.decode("utf-8") if old is not None else ""
            new_text = new.decode("utf-8") if new is not None else ""
        except UnicodeDecodeError:
            quality_flags.append(f"binary_file_excluded:{path}")
            continue
        old_lines, new_lines = old_text.splitlines(keepends=True), new_text.splitlines(keepends=True)
        pieces.extend(difflib.unified_diff(old_lines, new_lines, fromfile=f"a/{path}", tofile=f"b/{path}", lineterm=""))
        changed[path] = new_lines
    categories = {key: {"effective_lines": 0, "files_changed": 0} for key in CATEGORIES}
    for path, lines in changed.items():
        category = _classify(path)
        categories[category]["files_changed"] += 1
        categories[category]["effective_lines"] += _effective_lines("".join(lines))
    total = sum(item["effective_lines"] for item in categories.values())
    return "\n".join(pieces) + ("\n" if pieces else ""), {
        "total_effective_lines": total,
        "files_changed": len(changed),
        "categories": categories,
        "quality_flags": sorted(set(quality_flags))[:32],
    }


def aaw_version() -> str:
    # Kept in one release source; no per-skill version is maintained.
    candidate = Path(__file__).resolve().parents[4] / "pyproject.toml"
    try:
        match = re.search(r'^version\s*=\s*"([^"]+)"', candidate.read_text("utf-8"), re.M)
        if match:
            return match.group(1)
    except OSError:
        pass
    return "0.1.0"


class TelemetryClient:
    def __init__(self, store: TelemetryStore):
        self.store = store

    def _config(self) -> tuple[str, str]:
        config = self.store.config()
        token = os.getenv("AAW_TELEMETRY_TOKEN", "")
        if not config["endpoint"]:
            raise TelemetryError("Set AAW_TELEMETRY_ENDPOINT or run `aaw telemetry configure` before flushing telemetry")
        return config["endpoint"], token

    @staticmethod
    def _json_headers(token: str) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    @staticmethod
    def _request(url: str, method: str, body: bytes | None, headers: dict[str, str]) -> tuple[int, dict[str, Any]]:
        request = Request(url, data=body, method=method, headers=headers)
        try:
            with urlopen(request, timeout=20) as response:
                raw = response.read()
                return response.status, json.loads(raw.decode("utf-8")) if raw else {}
        except HTTPError as exc:
            raw = exc.read()
            try:
                payload = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                payload = {}
            return exc.code, payload
        except URLError as exc:
            raise TelemetryError(f"Network error: {exc.reason}") from exc

    def flush(self) -> dict[str, Any]:
        endpoint, token = self._config()
        sent, retained = self._flush_records(endpoint, token)
        uploads, upload_error = self._flush_uploads(endpoint, token)
        # The Dev completion record is only created after the object is
        # confirmed, so send it in this same flush while preserving ordering.
        if uploads and upload_error is None:
            final_sent, retained = self._flush_records(endpoint, token)
            sent += final_sent
        return {"sent": sent, "uploaded": uploads, "pending": len(self.store.pending()), "error": upload_error, "retained": retained}

    def _flush_records(self, endpoint: str, token: str) -> tuple[int, int]:
        queue = self.store.pending()
        eligible = [entry for entry in queue if not entry.get("deferred") and not entry.get("terminal")]
        if not eligible:
            return 0, len(queue)
        selected: list[dict[str, Any]] = []
        for entry in eligible:
            candidate = {"record_type": entry["record_type"], "record_id": entry["record_id"], "occurred_at": entry["occurred_at"], "data": entry["data"]}
            if len(selected) >= MAX_BATCH_RECORDS or len(json.dumps({"schema_version": 1, "records": selected + [candidate]}).encode()) > MAX_BATCH_BYTES:
                break
            selected.append(candidate)
        payload = {"schema_version": SCHEMA_VERSION, "records": selected}
        try:
            status, response = self._request(endpoint + "/api/v1/telemetry/sync:batch", "POST", json.dumps(payload).encode(), self._json_headers(token))
        except TelemetryError as exc:
            self._mark_batch_error(queue, selected, str(exc), retryable=True)
            return 0, len(queue)
        if status != 200:
            self._mark_batch_error(queue, selected, _error_message(response, status), retryable=status == 429 or status >= 500)
            return 0, len(queue)
        results = response.get("results", [])
        keep: list[dict[str, Any]] = []
        accepted = 0
        selected_queue_ids = {entry["queue_id"] for entry in queue if any(
            entry["record_type"] == item["record_type"] and entry["record_id"] == item["record_id"] and entry["occurred_at"] == item["occurred_at"] and entry["data"] == item["data"]
            for item in selected
        )}
        selected_results = iter(results)
        for entry in queue:
            if entry["queue_id"] not in selected_queue_ids:
                keep.append(entry)
                continue
            result = next(selected_results, {})
            if result.get("status") in {"accepted", "duplicate", "stale"}:
                accepted += 1
                continue
            entry["attempts"] += 1
            entry["last_error"] = _error_message(result, "record rejected")
            error = result.get("error") if isinstance(result, dict) else None
            entry["terminal"] = not isinstance(error, dict) or not bool(error.get("retryable"))
            keep.append(entry)
        self.store._save_queue(keep)
        return accepted, len(keep)

    def _mark_batch_error(self, queue: list[dict[str, Any]], selected: list[dict[str, Any]], message: str, *, retryable: bool) -> None:
        keys = {(item["record_type"], item["record_id"]) for item in selected}
        for entry in queue:
            if (entry["record_type"], entry["record_id"]) in keys:
                entry["attempts"] += 1
                entry["last_error"] = message
                entry["terminal"] = not retryable
        self.store._save_queue(queue)

    def _flush_uploads(self, endpoint: str, token: str) -> tuple[int, str | None]:
        uploaded = 0
        for path, state in self.store.completed_dev_states():
            if not state.get("patch_path") or state.get("object_key"):
                continue
            patch_path = Path(state["patch_path"])
            if not patch_path.exists():
                return uploaded, f"Missing local patch: {patch_path}"
            create = {"object_type": "dev_patch", "owner_id": state["dev_run_id"], "sha256": state["sha256"], "compressed_size_bytes": state["compressed_size_bytes"], "compression": state["compression"]}
            try:
                status, response = self._request(endpoint + "/api/v1/objects/uploads", "POST", json.dumps(create).encode(), self._json_headers(token))
                if status not in {200, 201}:
                    return uploaded, _error_message(response, status)
                upload = response.get("data", {})
                if not upload.get("already_completed"):
                    headers = {str(k): str(v) for k, v in upload.get("required_headers", {}).items()}
                    headers.setdefault("Content-Type", "application/octet-stream")
                    put_status, _ = self._request(upload["upload_url"], "PUT", patch_path.read_bytes(), headers)
                    if not 200 <= put_status < 300:
                        return uploaded, f"Patch upload failed with HTTP {put_status}"
                complete = {"sha256": state["sha256"], "compressed_size_bytes": state["compressed_size_bytes"]}
                status, response = self._request(endpoint + f"/api/v1/objects/uploads/{upload['upload_id']}:complete", "POST", json.dumps(complete).encode(), self._json_headers(token))
                if status != 200:
                    return uploaded, _error_message(response, status)
            except (KeyError, TelemetryError) as exc:
                return uploaded, str(exc)
            state["object_key"] = response.get("data", {}).get("object_key") or upload.get("object_key")
            _json_dump(path, state)
            self.store.enqueue("dev_run", state["dev_run_id"], {"status": "completed", "patch_object_key": state["object_key"]}, deferred=False)
            uploaded += 1
        return uploaded, None


def _error_message(payload: dict[str, Any], fallback: Any) -> str:
    error = payload.get("error") if isinstance(payload, dict) else None
    if isinstance(error, dict):
        return str(error.get("code") or error.get("message") or fallback)
    return str(fallback)
