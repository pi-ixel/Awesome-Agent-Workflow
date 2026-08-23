from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import tempfile
import urllib.error
import urllib.request
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .network import build_direct_opener

__version__ = "0.1.0"


class DeliveryError(RuntimeError):
    pass


def _insecure_tls_enabled() -> bool:
    value = os.getenv("TESTWF_TELEMETRY_INSECURE", "").strip().lower()
    if value in {"", "0", "false", "no", "off"}:
        return False
    if value in {"1", "true", "yes", "on"}:
        return True
    raise ValueError("TESTWF_TELEMETRY_INSECURE must be a boolean value")


class TelemetryClient:
    """HTTP client deliberately independent from the AAW CLI implementation."""

    def __init__(
        self,
        endpoint: str | None = None,
        token: str | None = None,
        *,
        opener: urllib.request.OpenerDirector | None = None,
        insecure_tls: bool | None = None,
    ):
        self.endpoint = (endpoint or os.getenv("TESTWF_TELEMETRY_ENDPOINT", "http://127.0.0.1:18080")).rstrip("/")
        self.token = token if token is not None else os.getenv("TESTWF_TELEMETRY_TOKEN")
        allow_insecure_tls = _insecure_tls_enabled() if insecure_tls is None else insecure_tls
        self.opener = opener or build_direct_opener(insecure_tls=allow_insecure_tls)

    def _request(self, path: str, method: str, body: bytes, content_type: str) -> dict[str, Any]:
        headers = {"Content-Type": content_type, "Accept": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        request = urllib.request.Request(self.endpoint + path, data=body, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=20) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            try:
                detail = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                detail = {}
            raise DeliveryError(detail.get("message") or detail.get("code") or f"HTTP {exc.code}") from exc
        except urllib.error.URLError as exc:
            raise DeliveryError(f"network error: {exc.reason}") from exc
        try:
            return json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise DeliveryError("server returned invalid JSON") from exc

    def send_event(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._request(
            "/api/v1/testing/telemetry/sync",
            "POST",
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            "application/json",
        )

    def upload_change(self, message_id: str, path: Path) -> dict[str, Any]:
        return self._request(
            f"/api/v1/testing/objects/code-changes/{message_id}",
            "PUT",
            path.read_bytes(),
            "application/octet-stream",
        )


def change_artifact(path: Path) -> dict[str, str]:
    content = path.read_bytes()
    if not content:
        raise ValueError("Diff file must not be empty")
    return {
        "file_name": path.name,
        "sha256": hashlib.sha256(content).hexdigest(),
        "change_kind": "test_code",
    }


# CLI implementation lives in this file intentionally: testwf is a small,
# two-command tool and does not need separate package entry modules.
def _now_ms() -> int:
    return int(datetime.now(UTC).timestamp() * 1000)


def _state_path(root: Path) -> Path:
    return root / ".testwf" / "workflow.json"


def _outbox_dir(root: Path) -> Path:
    return root / ".testwf" / "telemetry" / "outbox"


def _git(root: Path, args: list[str], *, index: Path | None = None) -> bytes:
    env = os.environ.copy()
    env.pop("GIT_INDEX_FILE", None)
    if index is not None:
        env["GIT_INDEX_FILE"] = str(index)
    result = subprocess.run(
        ["git", *args], cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        check=False, timeout=60,
    )
    if result.returncode != 0:
        raise ValueError(result.stderr.decode("utf-8", "replace").strip() or "Git command failed")
    return result.stdout


def _snapshot_tree(root: Path) -> str:
    with tempfile.NamedTemporaryFile(prefix="testwf-index-", delete=False) as handle:
        index = Path(handle.name)
    try:
        _git(root, ["read-tree", "--empty"], index=index)
        _git(root, ["add", "-f", "-A", "--", ".", ":(exclude).testwf"], index=index)
        tree = _git(root, ["write-tree"], index=index).decode("ascii").strip()
    finally:
        index.unlink(missing_ok=True)
    if len(tree) not in {40, 64} or any(char not in "0123456789abcdef" for char in tree):
        raise ValueError("Git returned an invalid worktree snapshot")
    return tree


def _local_diff(root: Path, before_tree: str) -> bytes:
    after_tree = _snapshot_tree(root)
    return _git(root, [
        "diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames",
        before_tree, after_tree, "--", ".", ":(exclude).testwf",
    ])


def _load_state(root: Path) -> dict[str, Any]:
    path = _state_path(root)
    if not path.is_file():
        raise ValueError("No active test workflow; run `testwf start` first")
    return json.loads(path.read_text("utf-8"))


def _save_state(root: Path, state: dict[str, Any]) -> None:
    path = _state_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", "utf-8")
    temporary.replace(path)


def _git_value(root: Path, key: str, fallback: str) -> str:
    try:
        return _git(root, ["config", "--get", key]).decode("utf-8", "replace").strip() or fallback
    except ValueError:
        return fallback


def _event_id(workflow_id: str, status: str) -> str:
    return str(uuid.uuid5(uuid.UUID(workflow_id), f"testwf:code-change:1:{status}"))


def _payload(state: dict[str, Any], status: str, artifact: dict[str, str] | None = None) -> dict[str, Any]:
    completed_at = _now_ms() if status == "done" else None
    event: dict[str, Any] = {
        "step_id": 1, "step_type": "test-code-change", "step_name": "本地测试代码生成",
        "attempt": 1, "status": status, "started_at": state["started_at"], "completed_at": completed_at,
    }
    if artifact is not None:
        event["change_artifact"] = artifact
    return {
        "message_id": _event_id(state["workflow_id"], status), "workflow_id": state["workflow_id"],
        "cli_version": __version__, "repository": state["repository"], "user": state["user"],
        "started_at": state["started_at"], "completed_at": completed_at,
        "updated_at": completed_at or _now_ms(), "event": event,
    }


def _queue(root: Path, body: dict[str, Any], diff: Path | None) -> Path:
    path = _outbox_dir(root) / f"{body['message_id']}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"payload": body, "diff": str(diff) if diff else None}, ensure_ascii=False), "utf-8")
    return path


def _deliver(client: TelemetryClient, entry: Path) -> None:
    queued = json.loads(entry.read_text("utf-8"))
    response = client.send_event(queued["payload"])
    if response.get("status") not in {"accepted", "duplicate"}:
        raise DeliveryError(response.get("status", "event rejected"))
    if queued.get("diff"):
        client.upload_change(queued["payload"]["message_id"], Path(queued["diff"]))
    entry.unlink(missing_ok=True)


def _send(root: Path, body: dict[str, Any], diff: Path | None = None) -> None:
    client = TelemetryClient()
    for entry in sorted(_outbox_dir(root).glob("*.json")) if _outbox_dir(root).is_dir() else []:
        try:
            _deliver(client, entry)
        except DeliveryError:
            continue
    entry = _queue(root, body, diff)
    try:
        _deliver(client, entry)
    except DeliveryError as exc:
        print(f"telemetry queued: {exc}")


def _start(args: argparse.Namespace) -> None:
    root = Path.cwd()
    if _state_path(root).exists():
        previous = _load_state(root)
        if previous.get("status") == "in_progress":
            raise ValueError("An active test workflow already exists; run `testwf finished` first")
    email = args.user_email or _git_value(root, "user.email", "unknown@invalid")
    state = {
        "workflow_id": str(uuid.uuid4()), "repository": args.repository, "started_at": _now_ms(),
        "user": {"email": email, "name": args.user_name or _git_value(root, "user.name", email.partition("@")[0])},
        "status": "in_progress",
    }
    _save_state(root, state)
    state["baseline_tree"] = _snapshot_tree(root)
    _save_state(root, state)
    _send(root, _payload(state, "start"))
    print(json.dumps({"workflow_id": state["workflow_id"], "status": "started"}, ensure_ascii=False))


def _finished(_: argparse.Namespace) -> None:
    root = Path.cwd()
    state = _load_state(root)
    if state.get("status") != "in_progress" or not state.get("baseline_tree"):
        raise ValueError("Test workflow has no usable start baseline")
    raw = _local_diff(root, state["baseline_tree"])
    if not raw:
        raise ValueError("No local code changes since start; refusing to finish without a Diff")
    patch = root / ".testwf" / "telemetry" / "changes" / f"{_event_id(state['workflow_id'], 'done')}.diff"
    patch.parent.mkdir(parents=True, exist_ok=True)
    patch.write_bytes(raw)
    body = _payload(state, "done", change_artifact(patch))
    state["status"] = "completed"
    state["completed_at"] = body["completed_at"]
    _save_state(root, state)
    _send(root, body, patch)
    print(json.dumps({"workflow_id": state["workflow_id"], "status": "finished"}, ensure_ascii=False))


def main() -> None:
    parser = argparse.ArgumentParser(prog="testwf")
    sub = parser.add_subparsers(dest="command", required=True)
    start = sub.add_parser("start", help="记录本地代码基线并上报开始")
    start.add_argument("--repository", required=True)
    start.add_argument("--user-email")
    start.add_argument("--user-name")
    start.set_defaults(func=_start)
    finished = sub.add_parser("finished", help="上报开始后生成的本地测试代码 Diff")
    finished.set_defaults(func=_finished)
    args = parser.parse_args()
    try:
        args.func(args)
    except (DeliveryError, OSError, ValueError) as exc:
        parser.error(str(exc))
