from __future__ import annotations

import base64
import json
import re
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock
from typing import Any

MAX_LOG_READ_BYTES = 256 * 1024
MAX_INDEX_CHUNK_CHARS = 8_000
LogCallback = Callable[[str, str, str], None]

_ANSI_ESCAPE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-_])")
_SECRET_PATTERNS = (
    re.compile(
        r'''(?i)((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret[_-]?access[_-]?key|client[_-]?secret|private[_-]?key|secret|password)["']?\s*[=:]\s*["']?)([^\s,;"']+)'''
    ),
    re.compile(r"(?i)(\bBearer\s+)[A-Za-z0-9._~+/-]+"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{16,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
)


def _timestamp() -> str:
    return datetime.now(UTC).isoformat()


def _chunk_text(text: str) -> list[str]:
    if not text:
        return [""]
    chunks: list[str] = []
    remaining = text
    while remaining:
        boundary = min(len(remaining), MAX_INDEX_CHUNK_CHARS)
        if boundary < len(remaining):
            newline = remaining.rfind("\n", 0, boundary)
            if newline > 0:
                boundary = newline + 1
        chunks.append(remaining[:boundary])
        remaining = remaining[boundary:]
    return chunks


class LogWriter:
    """Append-only, process-local writer for a single experiment or run log index."""

    def __init__(self, root: Path, *, scope: str, attempt: int | None = None) -> None:
        self.root = root
        self.scope = scope
        self.attempt = attempt
        self.path = root / "index.jsonl"
        self._lock = Lock()
        self.root.mkdir(parents=True, exist_ok=True)
        self._sequence = self._last_sequence()

    def _last_sequence(self) -> int:
        if not self.path.exists():
            return 0
        try:
            with self.path.open("rb") as stream:
                stream.seek(0, 2)
                end = stream.tell()
                stream.seek(max(0, end - 16_384))
                lines = stream.read().decode("utf-8", "replace").splitlines()
            for line in reversed(lines):
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(value, dict) and isinstance(value.get("sequence"), int):
                    return value["sequence"]
        except OSError:
            return 0
        return 0

    def write(
        self,
        source: str,
        channel: str,
        text: str,
        *,
        stage: str | None = None,
    ) -> None:
        if not isinstance(text, str):
            text = str(text)
        with self._lock, self.path.open("a", encoding="utf-8", newline="\n") as stream:
            for chunk in ([text] if channel == "invocation" else _chunk_text(text)):
                self._sequence += 1
                entry = {
                    "sequence": self._sequence,
                    "timestamp": _timestamp(),
                    "scope": self.scope,
                    "source": source,
                    "channel": channel,
                    "attempt": self.attempt,
                    "stage": stage,
                    "text": chunk,
                    "partial": not chunk.endswith("\n"),
                }
                stream.write(
                    json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n"
                )
            stream.flush()

    def event(self, source: str, text: str, *, stage: str | None = None) -> None:
        self.write(source, "event", text, stage=stage)


def encode_cursor(offset: int) -> str:
    payload = json.dumps({"v": 1, "offset": max(0, offset)}, separators=(",", ":"))
    return base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii").rstrip("=")


def decode_cursor(cursor: str | None) -> int | None:
    if not cursor:
        return 0
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        payload = base64.urlsafe_b64decode(padded.encode("ascii"))
        value = json.loads(payload.decode("utf-8"))
        offset = value.get("offset") if isinstance(value, dict) else None
        if not isinstance(offset, int) or offset < 0:
            return None
        return offset
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
        return None


def read_log_index(
    path: Path,
    *,
    cursor: str | None,
    limit_bytes: int = MAX_LOG_READ_BYTES,
) -> dict[str, Any]:
    """Read complete JSONL entries after an opaque byte cursor."""

    requested_offset = decode_cursor(cursor)
    reset_required = requested_offset is None
    offset = requested_offset or 0
    if not path.exists():
        return {
            "records": [],
            "next_cursor": encode_cursor(0),
            "reset_required": reset_required,
            "historical": True,
            "has_more": False,
        }
    try:
        size = path.stat().st_size
    except OSError:
        size = 0
    if offset > size:
        offset = 0
        reset_required = True
    read_size = min(max(1, limit_bytes), MAX_LOG_READ_BYTES)
    try:
        with path.open("rb") as stream:
            stream.seek(offset)
            data = stream.read(read_size)
    except OSError:
        data = b""
    last_newline = data.rfind(b"\n")
    if last_newline < 0:
        return {
            "records": [],
            "next_cursor": encode_cursor(offset),
            "reset_required": reset_required,
            "historical": False,
            "has_more": bool(data),
        }
    consumed = last_newline + 1
    records: list[dict[str, Any]] = []
    for line in data[:consumed].decode("utf-8", "replace").splitlines():
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(entry, dict):
            records.append(entry)
    next_offset = offset + consumed
    return {
        "records": records,
        "next_cursor": encode_cursor(next_offset),
        "reset_required": reset_required,
        "historical": False,
        "has_more": next_offset < size,
    }


def _mask_secrets(text: str) -> str:
    def replace_assignment(match: re.Match[str]) -> str:
        return f"{match.group(1)}***"

    for pattern in _SECRET_PATTERNS[:2]:
        text = pattern.sub(replace_assignment, text)
    for pattern in _SECRET_PATTERNS[2:]:
        text = pattern.sub("***", text)
    return text


def _event_summary(record: dict[str, Any], text: str) -> str:
    if record.get("channel") == "event":
        return text
    if record.get("channel") == "invocation":
        try:
            event = json.loads(text)
            source = event.get("source", "agent")
            phase = event.get("phase", "event")
            return f"{source} 调用 {phase} · PID {event.get('pid', '—')}"
        except json.JSONDecodeError:
            return "Agent 调用状态更新"
    stripped = text.strip()
    if not stripped:
        return "收到空输出"
    try:
        value = json.loads(stripped)
    except json.JSONDecodeError:
        return f"收到 {record.get('channel', 'output')} 输出（{len(text)} 字符）"
    if isinstance(value, dict):
        for key in ("type", "event", "name", "tool", "tool_name", "toolName"):
            label = value.get(key)
            if label:
                return f"{record.get('source', 'system')} 事件：{str(label)[:160]}"
    return f"收到 {record.get('channel', 'output')} 结构化输出（{len(text)} 字符）"


def display_record(
    record: dict[str, Any],
    *,
    mode: str,
    unmasked: bool,
) -> dict[str, Any]:
    raw_text = str(record.get("text", ""))
    text = _ANSI_ESCAPE.sub("", raw_text)
    details = None
    if record.get("channel") == "invocation":
        try:
            value = json.loads(text)
            if isinstance(value, dict):
                details = value if unmasked else {
                    key: _mask_secrets(value) if isinstance(value, str) else value
                    for key, value in value.items()
                }
        except json.JSONDecodeError:
            pass
    if mode != "raw":
        text = _event_summary(record, text)
    if not unmasked:
        text = _mask_secrets(text)
    return {
        "sequence": record.get("sequence"),
        "timestamp": record.get("timestamp"),
        "scope": record.get("scope"),
        "source": record.get("source"),
        "channel": record.get("channel"),
        "attempt": record.get("attempt"),
        "stage": record.get("stage"),
        "text": text,
        "partial": bool(record.get("partial")),
        "details": details,
    }
