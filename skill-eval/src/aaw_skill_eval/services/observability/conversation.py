"""Rebuild a structured, read-only conversation from ACP wire recordings.

The `chrys-acp.jsonl` artifacts are the raw JSON-RPC notification stream
between the platform and `chrys acp` (see services/acp.py for the writer).
This module replays such a recording and restores the "attempt -> turn"
hierarchy: per turn the prompt reference, the agent's messages and thoughts,
and tool calls with their inputs and results. Recordings made before the
in-memory tool_call_update bugfix parse identically, because the wire file is
the untouched original.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..providers.protocols.acp.wire import chunk_text, tool_input_summary, tool_result_summary

RUNNER_WIRE = "chrys-acp.jsonl"
JUDGE_WIRE = f"judge/{RUNNER_WIRE}"

_IGNORED_SESSION_UPDATES = {
    "available_commands_update",
    "current_mode_update",
    "config_option_update",
    "user_message_chunk",
}


def _wire_path(artifact_dir: Path, source: str) -> Path:
    return artifact_dir / (RUNNER_WIRE if source == "runner" else JUDGE_WIRE)


def _legacy_turn_files(artifact_dir: Path, source: str) -> list[Path]:
    root = artifact_dir if source == "runner" else artifact_dir / "judge"
    return sorted(root.glob("chrys-turn-*.json")) if root.is_dir() else []


def _missing_reason(artifact_dir: Path, source: str, run_status: str | None = None) -> str:
    label = "Runner" if source == "runner" else "Judge"
    legacy = _legacy_turn_files(artifact_dir, source)
    if legacy:
        return (
            f"旧版 CLI 记录格式：{label} 侧仅有每轮最终输出"
            f"（{len(legacy)} 个 chrys-turn-*.json 文本记录），"
            "无逐条工具调用记录、无提示词与会话流 wire 记录。按“不补造内容”原则不做还原，"
            "可在诊断区查看原始输出文件"
        )
    if source == "judge" and not (artifact_dir / "judge").is_dir():
        if run_status in {"timeout", "cancelled", "failed", "infra_error", "agent_error"}:
            return "Runner 未完成，Judge 未执行，没有 Judge 会话记录"
        return "没有 Judge 的 ACP wire 记录（该实验未配置 LLM 盲评或 Judge 未执行）"
    return f"该 run 没有 {label} 的 ACP wire 记录（可能使用 Codex 平台或该阶段未执行）"


def _prompt_files(artifact_dir: Path, source: str) -> dict[int, dict]:
    """Map turn number -> prompt reference from the run's invocation log."""
    index = artifact_dir / "logs" / "index.jsonl"
    mapping: dict[int, dict] = {}
    if not index.is_file():
        return mapping
    with index.open(encoding="utf-8", errors="replace") as stream:
        for line in stream:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(record, dict) or record.get("channel") != "invocation":
                continue
            try:
                detail = json.loads(record.get("text") or "")
            except (json.JSONDecodeError, TypeError):
                continue
            if not isinstance(detail, dict):
                continue
            if detail.get("source") != source or detail.get("phase") != "start":
                continue
            turn = detail.get("turn")
            prompt_file = detail.get("prompt_file")
            if isinstance(turn, int) and isinstance(prompt_file, str) and prompt_file:
                prompt_path = artifact_dir / prompt_file
                mapping[turn] = {
                    "file": prompt_file,
                    "available": prompt_path.is_file(),
                    "bytes": prompt_path.stat().st_size if prompt_path.is_file() else None,
                }
    return mapping


class _Rebuilder:
    """Streaming state machine over one wire recording."""

    def __init__(self) -> None:
        self.session: dict[str, Any] = {}
        self.turns: list[dict[str, Any]] = []
        self._current: dict[str, Any] | None = None
        self._tools_by_id: dict[str, dict[str, Any]] = {}
        self._chunk: dict[str, Any] | None = None
        self.unparsed_lines = 0

    # ------------------------------------------------------------ helpers

    def _flush_chunk(self) -> None:
        chunk, self._chunk = self._chunk, None
        if not chunk or not chunk["text"].strip():
            return
        self._current_item(
            {
                "type": chunk["type"],
                "text": chunk["text"],
            }
        )

    def _ensure_turn(self) -> dict[str, Any]:
        if self._current is None:
            self._current = {
                "turn": len(self.turns) + 1,
                "stop_reason": None,
                "error": None,
                "usage": None,
                "context": None,
                "items": [],
            }
        return self._current

    def _current_item(self, item: dict[str, Any]) -> None:
        self._ensure_turn()["items"].append(item)

    def _buffer_chunk(self, text: str, chunk_type: str) -> None:
        if self._chunk is not None and self._chunk["type"] != chunk_type:
            self._flush_chunk()
        if self._chunk is None:
            self._chunk = {"type": chunk_type, "text": ""}
        self._chunk["text"] += text

    # ------------------------------------------------------------- events

    def _end_turn(self, result: dict[str, Any] | None, error: dict[str, Any] | None) -> None:
        self._flush_chunk()
        turn = self._current
        if turn is None:
            # a turn boundary with no preceding items: still record the turn
            # so prompt/stop info is not lost (e.g. a cancelled first turn)
            turn = self._ensure_turn()
        if error is not None:
            turn["error"] = error
        if isinstance(result, dict):
            stop_reason = result.get("stopReason")
            if isinstance(stop_reason, str):
                turn["stop_reason"] = stop_reason
            usage = result.get("usage")
            if isinstance(usage, dict):
                turn["usage"] = {
                    "input_tokens": usage.get("inputTokens"),
                    "output_tokens": usage.get("outputTokens"),
                }
        self.turns.append(turn)
        self._current = None
        self._tools_by_id = {}

    def feed(self, message: dict[str, Any]) -> None:
        if "id" in message and ("result" in message or "error" in message):
            result = message.get("result")
            error = message.get("error")
            if isinstance(result, dict) and "stopReason" in result:
                self._end_turn(result, None)
                return
            if error is not None:
                self._end_turn(None, error if isinstance(error, dict) else {"message": str(error)})
                return
            # initialize / session/new / set_model responses -> session facts
            if isinstance(result, dict):
                info = result.get("agentInfo")
                if isinstance(info, dict):
                    self.session["agent"] = " ".join(
                        str(part) for part in (info.get("name"), info.get("version")) if part
                    ).strip() or None
                if isinstance(result.get("sessionId"), str):
                    self.session["session_id"] = result["sessionId"][:8]
            return
        method = message.get("method")
        if not isinstance(method, str):
            return
        params = message.get("params") or {}
        if method == "session/update":
            self._feed_session_update(params.get("update") or {})
            return
        if method == "_chrys/runtime_update":
            runtime = params.get("runtime") or {}
            details = runtime.get("runtimeDetails") or {}
            model = runtime.get("modelProfileId")
            if isinstance(model, str):
                self.session["model"] = model
            tools = runtime.get("toolNames")
            if not isinstance(tools, list):
                tools = details.get("toolNames") or []
            skills = runtime.get("skillNames")
            if not isinstance(skills, list):
                skills = details.get("skillNames") or []
            self.session["tools"] = len(tools) if isinstance(tools, list) else 0
            if isinstance(skills, list):
                self.session["skills"] = [
                    str(item) for item in skills if isinstance(item, (str, int))
                ]
            return
        if method == "_chrys/usage_update":
            turn = self._ensure_turn()
            tokens = {
                "input_tokens": params.get("inputTokens"),
                "output_tokens": params.get("outputTokens"),
            }
            if any(value is not None for value in tokens.values()):
                # live token counters: keep updating mid-turn so a replay that
                # is polled while the agent works (e.g. inside a long tool
                # call, where usage updates are the only wire events) still
                # visibly advances. The turn-end response overwrites this
                # with the authoritative per-turn usage.
                turn["usage"] = tokens
            return
        if method == "_chrys/error":
            self._flush_chunk()
            self._current_item(
                {
                    "type": "system_error",
                    "text": f"{params.get('code', '')} {params.get('message', '')}".strip(),
                }
            )
            return
        if method == "_chrys/warning":
            self._flush_chunk()
            warning_text = str(params.get("message") or params)
            self._current_item({"type": "system_warning", "text": warning_text})
            return
        # remaining chrys extensions (sub-agent activity, compaction, ...) stay
        # in the raw log on purpose: the conversation keeps the dialogue.

    def _feed_session_update(self, update: dict[str, Any]) -> None:
        kind = update.get("sessionUpdate")
        if kind == "agent_message_chunk":
            text = chunk_text(update.get("content"))
            if text:
                self._buffer_chunk(text, "message")
            return
        if kind == "agent_thought_chunk":
            text = chunk_text(update.get("content"))
            if text:
                self._buffer_chunk(text, "thought")
            return
        if kind in {"tool_call", "tool_call_update"}:
            self._flush_chunk()
            tool_call_id = update.get("toolCallId")
            entry = self._tools_by_id.get(tool_call_id) if isinstance(tool_call_id, str) else None
            status = update.get("status")
            if entry is None:
                title = update.get("title")
                raw_input = update.get("rawInput")
                result_summary = tool_result_summary(update) if kind == "tool_call_update" else ""
                entry = {
                    "type": "tool_call",
                    "tool_call_id": tool_call_id,
                    "name": title,
                    "kind": update.get("kind"),
                    "status": status,
                    "input": tool_input_summary(
                        raw_input, str(title or tool_call_id or "")
                    )
                    or None,
                    "result": result_summary or None,
                }
                self._current_item(entry)
                if isinstance(tool_call_id, str):
                    self._tools_by_id[tool_call_id] = entry
                return
            if status is not None:
                entry["status"] = status
            if kind == "tool_call_update":
                summary = tool_result_summary(update)
                if summary:
                    entry["result"] = summary
            return
        if kind == "plan":
            entries = update.get("entries") or []
            completed = sum(
                1
                for entry in entries
                if isinstance(entry, dict) and entry.get("status") == "completed"
            )
            self._flush_chunk()
            self._current_item({"type": "plan", "entries": len(entries), "completed": completed})
            return
        if kind == "usage_update":
            turn = self._ensure_turn()
            size = update.get("size")
            used = update.get("used")
            if size is not None or used is not None:
                turn["context"] = {"size": size, "used": used}
            return
        if kind == "session_info_update":
            info = update.get("info") or {}
            if isinstance(info, dict) and info.get("title"):
                self.session["title"] = info["title"]
            return
        if kind in _IGNORED_SESSION_UPDATES:
            return
        # unknown session updates are ignored; the raw log keeps them

    def finish(self) -> None:
        self._flush_chunk()
        if self._current is not None:
            # recording ends mid-turn (run cancelled / process killed)
            self._current["stop_reason"] = None
            self.turns.append(self._current)
            self._current = None


def rebuild_conversation(artifact_dir: Path, source: str, *, run_status: str | None = None) -> dict:
    """Rebuild the structured conversation for one attempt of one run."""
    wire_path = _wire_path(artifact_dir, source)
    if not wire_path.is_file():
        return {
            "available": False,
            "reason": _missing_reason(artifact_dir, source, run_status),
            "session": {},
            "turns": [],
        }
    rebuilder = _Rebuilder()
    with wire_path.open(encoding="utf-8", errors="replace") as stream:
        for line in stream:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                rebuilder.unparsed_lines += 1
                continue
            if isinstance(message, dict):
                rebuilder.feed(message)
    rebuilder.finish()
    prompts = _prompt_files(artifact_dir, source)
    items = 0
    for turn in rebuilder.turns:
        turn["prompt"] = prompts.get(turn["turn"])
        items += len(turn["items"])
    signature = (
        f"turns={len(rebuilder.turns)};items={items};bytes={wire_path.stat().st_size}"
    )
    return {
        "available": True,
        "reason": None,
        "unparsed_lines": rebuilder.unparsed_lines or None,
        "session": rebuilder.session,
        "turns": rebuilder.turns,
        "signature": signature,
    }
