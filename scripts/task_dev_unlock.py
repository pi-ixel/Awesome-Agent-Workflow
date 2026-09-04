#!/usr/bin/env python3
"""Emergency unlock for task-dev states created by the legacy HEAD lock."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class UnlockError(RuntimeError):
    pass


def _git(root: Path, *args: str, allow_failure: bool = False) -> str:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=root,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise UnlockError(f"cannot execute Git: {exc}") from exc
    if result.returncode != 0:
        if allow_failure:
            return ""
        detail = result.stderr.decode("utf-8", "replace").strip()
        raise UnlockError(f"git {' '.join(args)} failed: {detail or result.returncode}")
    return result.stdout.decode("utf-8", "replace").strip()


def _repo_root(path: Path) -> Path:
    root = _git(path.resolve(), "rev-parse", "--show-toplevel")
    if not root:
        raise UnlockError("the current directory is not inside a Git repository")
    return Path(root).resolve()


def _sr_dir(root: Path, sr: str) -> Path:
    if not sr or Path(sr).name != sr:
        raise UnlockError("--sr must be a single SR directory name")
    sdd_dir = (root / ".sdd").resolve()
    candidate = (sdd_dir / sr).resolve()
    if candidate.parent != sdd_dir:
        raise UnlockError("--sr resolves outside the .sdd directory")
    if not candidate.is_dir():
        raise UnlockError(f"SR directory does not exist: {candidate}")
    return candidate


def _read_state(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text("utf-8-sig"))
    except OSError as exc:
        raise UnlockError(f"cannot read {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise UnlockError(f"invalid task-dev state JSON: {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise UnlockError(f"task-dev state must be a JSON object: {path}")
    return data


def _write_state(path: Path, state: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".unlock.tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", "utf-8")
    temporary.replace(path)


def _locked_states(sr_dir: Path) -> list[tuple[Path, dict[str, Any]]]:
    state_root = sr_dir / ".aaw" / "task-dev"
    if not state_root.is_dir():
        return []
    locked: list[tuple[Path, dict[str, Any]]] = []
    for path in sorted(state_root.glob("*/*/state.json")):
        state = _read_state(path)
        if state.get("schema_version") == 2 and state.get("integrity_error"):
            for field in ("head_commit", "index_baseline_tree"):
                if not isinstance(state.get(field), str) or not state[field]:
                    raise UnlockError(f"locked state is missing {field}: {path}")
            locked.append((path, state))
    return locked


def unlock(root: Path, sr: str) -> dict[str, Any]:
    sr_dir = _sr_dir(root, sr)
    locked = _locked_states(sr_dir)
    if not locked:
        return {"status": "not_locked", "sr": sr, "unlocked": 0, "states": []}

    current_head = _git(root, "rev-parse", "HEAD", allow_failure=True) or "UNBORN"
    current_index = _git(root, "write-tree")
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    prepared: list[tuple[Path, Path, dict[str, Any]]] = []

    for position, (path, state) in enumerate(locked, start=1):
        suffix = timestamp if len(locked) == 1 else f"{timestamp}-{position}"
        backup = path.with_name(f"state.unlock-backup-{suffix}.json")
        if backup.exists():
            raise UnlockError(f"backup path already exists: {backup}")
        updated = dict(state)
        updated["head_commit"] = current_head
        updated["index_baseline_tree"] = current_index
        updated["integrity_error"] = None
        prepared.append((path, backup, updated))

    written: list[tuple[Path, Path]] = []
    try:
        for path, backup, updated in prepared:
            shutil.copy2(path, backup)
            _write_state(path, updated)
            written.append((path, backup))
    except OSError as exc:
        for path, backup in reversed(written):
            try:
                shutil.copy2(backup, path)
            except OSError:
                pass
        raise UnlockError(f"cannot update task-dev state: {exc}") from exc

    return {
        "status": "unlocked",
        "sr": sr,
        "unlocked": len(prepared),
        "head_commit": current_head,
        "index_baseline_tree": current_index,
        "states": [
            {
                "path": str(path),
                "backup": str(backup),
                "step_id": updated.get("step_id"),
                "attempt": updated.get("attempt"),
            }
            for path, backup, updated in prepared
        ],
        "warning": (
            "The legacy workflow now uses the current HEAD as its baseline; "
            "changes already committed before unlock may be absent from changed_files."
        ),
        "next_argv": ["aaw", "next", "--sr", sr, "--json"],
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Unlock legacy task-dev states by rebinding their HEAD and index baselines "
            "to the repository's current Git state. State files are backed up first."
        )
    )
    parser.add_argument("--sr", required=True, help="SR directory name under .sdd")
    parser.add_argument("--repo", type=Path, default=Path.cwd(), help="repository path; defaults to cwd")
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON")
    return parser


def main() -> int:
    args = _parser().parse_args()
    try:
        result = unlock(_repo_root(args.repo), args.sr)
    except UnlockError as exc:
        if args.json:
            print(json.dumps({"status": "failed", "error": str(exc)}, ensure_ascii=False))
        else:
            print(f"task-dev unlock failed: {exc}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif result["status"] == "not_locked":
        print(f"No locked task-dev state was found for {args.sr}.")
    else:
        print(f"Unlocked {result['unlocked']} task-dev state(s) for {args.sr}.")
        for item in result["states"]:
            print(f"  state:  {item['path']}")
            print(f"  backup: {item['backup']}")
        print(f"Warning: {result['warning']}")
        print("Next: " + " ".join(result["next_argv"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
