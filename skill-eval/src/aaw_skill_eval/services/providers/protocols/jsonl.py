"""Platform-agnostic subprocess streaming and JSONL event parsing helpers.

Shared by every provider backend that drives a line-oriented child process:
spawns the command with prompt injection, drains stdout/stderr to artifact
files while feeding the progress/log pipeline, and parses the JSONL event
stream (thread id, token usage, skill invocations).
"""

from __future__ import annotations

import codecs
import json
import os
import shlex
import subprocess
import threading
import time
from collections.abc import Callable
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from ...observability.logs import LogCallback
from ...workspace.scan import (
    WORKSPACE_SCAN_INTERVAL_SECONDS,
    relative_if_inside,
    scan_workspace,
)

ProgressCallback = Callable[[str, str], None]
CancelCallback = Callable[[], bool]


def parse_jsonl(raw: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            events.append({"type": "unparsed", "text": line[:20_000]})
            continue
        if isinstance(value, dict):
            events.append(value)
    return events


def find_thread_id(events: list[dict[str, Any]]) -> str | None:
    for event in events:
        for key in ("thread_id", "session_id", "threadId", "sessionId"):
            value = event.get(key)
            if isinstance(value, str) and value:
                return value
        thread = event.get("thread")
        if isinstance(thread, dict) and isinstance(thread.get("id"), str):
            return thread["id"]
    return None


def skill_invocation(events: list[dict[str, Any]], skill_name: str | None) -> str:
    if not skill_name:
        return "no"
    target = skill_name.casefold()
    for event in events:
        label = " ".join(
            str(event.get(key, ""))
            for key in ("type", "name", "tool", "tool_name", "toolName", "event")
        ).casefold()
        if "skill" not in label:
            continue
        if target in json.dumps(event, ensure_ascii=False).casefold():
            return "yes"
    return "unknown"


def token_usage(events: list[dict[str, Any]]) -> tuple[int | None, int | None]:
    last_usage: dict[str, Any] | None = None

    def visit(value: Any) -> None:
        nonlocal last_usage
        if isinstance(value, dict):
            keys = set(value)
            if {"input_tokens", "output_tokens"} <= keys:
                last_usage = value
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    for event in events:
        visit(event)
    if last_usage is None:
        return None, None
    input_tokens = last_usage.get("input_tokens")
    output_tokens = last_usage.get("output_tokens")
    return (
        int(input_tokens) if isinstance(input_tokens, int | float) else None,
        int(output_tokens) if isinstance(output_tokens, int | float) else None,
    )


def safe_event_summary(line: str) -> str:
    try:
        value = json.loads(line)
    except json.JSONDecodeError:
        return "Runner 产生了新输出"
    if not isinstance(value, dict):
        return "Runner 产生了新事件"
    labels = [value.get(key) for key in ("type", "event", "name", "tool", "tool_name", "toolName")]
    label = next((str(item) for item in labels if item), "event")
    return f"Runner 事件：{label[:120]}"


def _terminate_process_tree(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            capture_output=True,
            check=False,
        )
    else:
        process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()


def execute_streaming(
    command: list[str],
    *,
    prompt: str | None,
    prompt_snapshot: str | None = None,
    cwd: Path,
    env: dict[str, str],
    timeout_seconds: int,
    stdout_path: Path,
    stderr_path: Path,
    on_progress: ProgressCallback | None,
    on_log: LogCallback | None,
    log_source: str,
    is_cancelled: CancelCallback | None,
) -> tuple[int | None, str, str, int, bool, bool, dict[str, Any]]:
    started = time.monotonic()
    started_at = datetime.now(UTC).isoformat()
    invocation_id = uuid4().hex
    stdout_parts: list[str] = []
    stderr_parts: list[str] = []
    last_output = [started]
    stdout_path.parent.mkdir(parents=True, exist_ok=True)
    prompt_name = None
    snapshot = prompt if prompt is not None else prompt_snapshot
    if snapshot is not None:
        prompt_dir = stdout_path.parent / "invocations"
        prompt_dir.mkdir(parents=True, exist_ok=True)
        prompt_file = prompt_dir / f"{invocation_id}.prompt.txt"
        prompt_file.write_text(snapshot, encoding="utf-8")
        prompt_name = f"{'judge/' if log_source == 'judge' else ''}invocations/{prompt_file.name}"
    command_text = subprocess.list2cmdline(command) if os.name == "nt" else shlex.join(command)

    def invocation_event(phase: str, **details: Any) -> None:
        if on_log is not None:
            on_log(log_source, "invocation", json.dumps({
                "id": invocation_id,
                "phase": phase,
                "source": log_source,
                "command": command_text,
                "cwd": str(cwd),
                "prompt_file": prompt_name,
                "started_at": started_at,
                "timeout_seconds": timeout_seconds,
                **details,
            }, ensure_ascii=False))

    try:
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE if prompt is not None else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=cwd,
            env=env,
            bufsize=0,
        )
    except OSError as exc:
        invocation_event("spawn_error", error=str(exc), ended_at=datetime.now(UTC).isoformat())
        raise

    invocation_event("start", pid=process.pid, process_state="running")

    if process.stdin is not None:
        def send_prompt() -> None:
            try:
                process.stdin.write((prompt or "").encode("utf-8"))
                process.stdin.flush()
            except (BrokenPipeError, OSError):
                pass
            finally:
                with suppress(OSError):
                    process.stdin.close()

        threading.Thread(target=send_prompt, daemon=True).start()

    def drain(
        stream,
        destination: Path,
        chunks: list[str],
        *,
        channel: str,
        report: bool,
    ) -> None:
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        with destination.open("a", encoding="utf-8") as output:
            while True:
                data = os.read(stream.fileno(), 4096)
                if not data:
                    break
                chunk = decoder.decode(data)
                if not chunk:
                    continue
                last_output[0] = time.monotonic()
                chunks.append(chunk)
                output.write(chunk)
                output.flush()
                if on_log is not None:
                    on_log(log_source, channel, chunk)
                if report and on_progress is not None:
                    on_progress("activity", safe_event_summary(chunk))
            tail = decoder.decode(b"", final=True)
            if tail:
                chunks.append(tail)
                output.write(tail)
                output.flush()
                if on_log is not None:
                    on_log(log_source, channel, tail)
        stream.close()

    stdout_thread = threading.Thread(
        target=drain,
        args=(process.stdout, stdout_path, stdout_parts),
        kwargs={"channel": "stdout", "report": True},
        daemon=True,
    )
    stderr_thread = threading.Thread(
        target=drain,
        args=(process.stderr, stderr_path, stderr_parts),
        kwargs={"channel": "stderr", "report": True},
        daemon=True,
    )
    stdout_thread.start()
    stderr_thread.start()

    excluded_outputs = {
        name
        for name in (
            relative_if_inside(cwd, stdout_path),
            relative_if_inside(cwd, stderr_path),
        )
        if name
    }
    workspace_baseline = scan_workspace(cwd, exclude=excluded_outputs)
    workspace_changed_files = 0
    last_workspace_change: float | None = None
    last_workspace_scan = time.monotonic()

    timed_out = False
    cancelled = False
    last_heartbeat = started
    while process.poll() is None:
        current = time.monotonic()
        if is_cancelled is not None and is_cancelled():
            cancelled = True
            _terminate_process_tree(process)
            break
        if current - started >= timeout_seconds:
            timed_out = True
            _terminate_process_tree(process)
            break
        if current - last_workspace_scan >= WORKSPACE_SCAN_INTERVAL_SECONDS:
            last_workspace_scan = current
            snapshot_files = scan_workspace(cwd, exclude=excluded_outputs)
            changed = [
                name
                for name, signature in snapshot_files.items()
                if workspace_baseline.get(name) != signature
            ]
            removed = [name for name in workspace_baseline if name not in snapshot_files]
            if changed or removed:
                workspace_changed_files += len(changed) + len(removed)
                last_workspace_change = current
                sample = "、".join(changed[:3])
                if on_progress is not None:
                    on_progress(
                        "activity",
                        f"工作区文件有更新：{len(changed)} 个变动"
                        + (f"（如 {sample}）" if sample else "")
                        + (f"，{len(removed)} 个删除" if removed else ""),
                    )
                workspace_baseline = snapshot_files
        if on_progress is not None and current - last_heartbeat >= 30:
            elapsed = int(current - started)
            silent = int(current - last_output[0])
            remaining = max(0, timeout_seconds - elapsed)
            workspace_note = (
                f"工作区 {int(current - last_workspace_change)}s 前有文件更新"
                if last_workspace_change is not None
                else "工作区暂无文件改动"
            )
            on_progress(
                "heartbeat",
                f"子进程 PID {process.pid} 仍在运行；已运行 {elapsed}s，"
                f"最近 {silent}s 无 stdout/stderr；{workspace_note}；本轮超时还剩 {remaining}s",
            )
            last_heartbeat = current
        time.sleep(0.25)
    stdout_thread.join(timeout=5)
    stderr_thread.join(timeout=5)
    duration_ms = int((time.monotonic() - started) * 1000)
    workspace_stats = {
        "changed_files": workspace_changed_files,
        "last_change_age_seconds": (
            round(time.monotonic() - last_workspace_change, 1)
            if last_workspace_change is not None
            else None
        ),
    }
    invocation_event(
        "end",
        pid=process.pid,
        process_state="exited",
        ended_at=datetime.now(UTC).isoformat(),
        exit_code=process.returncode,
        duration_ms=duration_ms,
        timed_out=timed_out,
        cancelled=cancelled,
        stdout_bytes=len("".join(stdout_parts).encode("utf-8")),
        stderr_bytes=len("".join(stderr_parts).encode("utf-8")),
        workspace_changed_files=workspace_stats["changed_files"],
        workspace_last_change_age_seconds=workspace_stats["last_change_age_seconds"],
    )
    return (
        process.returncode,
        "".join(stdout_parts),
        "".join(stderr_parts),
        duration_ms,
        timed_out,
        cancelled,
        workspace_stats,
    )
