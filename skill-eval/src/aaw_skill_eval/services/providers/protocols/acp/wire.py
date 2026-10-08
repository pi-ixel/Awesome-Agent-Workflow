"""ACP wire payload digests shared with the observability layer.

Extracted from the former single-module ACP client so
observability/conversation.py can reuse the exact same summarization of
message chunks, tool inputs and tool results without importing the session
class (and without a provider-internal private import).
"""

from __future__ import annotations

import json
from typing import Any

_TOOL_INPUT_PRIORITY = ("skill_name", "command", "path", "pattern", "query", "url")


def chunk_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, dict):
        if isinstance(content.get("text"), str):
            return content["text"]
        return chunk_text(content.get("content"))
    if isinstance(content, list):
        parts = [chunk_text(item) for item in content]
        return "".join(part for part in parts if part)
    return ""


def tool_input_summary(raw_input: Any, title: str) -> str:
    """Short key=value digest of a tool call's rawInput for the log console.

    Keeps at most two fields, prefers the identifying ones (skill_name,
    command, path, ...) and skips values that just duplicate the title (chrys
    already uses the command/path as the tool title for execute/read tools).
    """
    if isinstance(raw_input, dict):
        ordered = [key for key in _TOOL_INPUT_PRIORITY if key in raw_input]
        ordered += [key for key in raw_input if key not in _TOOL_INPUT_PRIORITY]
        parts: list[str] = []
        for key in ordered:
            value = raw_input[key]
            if isinstance(value, (dict, list)):
                text = json.dumps(value, ensure_ascii=False)
            elif isinstance(value, str):
                text = value
            else:
                text = str(value)
            text = " ".join(text.split())
            if not text or text == title:
                continue
            parts.append(f"{key}={text[:120]}")
            if len(parts) >= 2:
                break
        return " · ".join(parts)
    if isinstance(raw_input, str):
        text = " ".join(raw_input.split())
        return text[:120] if text and text != title else ""
    return ""


def tool_result_summary(update: dict[str, Any]) -> str:
    """One-line digest of a tool_call_update's result payload.

    chrys sends the tool result as `content` (the same nested text shape as
    agent_message_chunk) and/or a plain-string `rawOutput`.
    """
    text = chunk_text(update.get("content"))
    if not text:
        raw_output = update.get("rawOutput")
        if isinstance(raw_output, str):
            text = raw_output
    return " ".join(text.split())[:200]
