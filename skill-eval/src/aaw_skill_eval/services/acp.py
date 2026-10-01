"""Chrys ACP (Agent Client Protocol) stdio client.

Runs `chrys acp` as a line-delimited JSON-RPC 2.0 server over stdio and turns
its notification stream into platform progress/log events, so the page shows
agent message chunks, tool activity and token usage in real time.

Wire protocol (validated against chrys 0.22.6, see out/acp_smoke.py):
- client -> agent requests: initialize, session/new, session/set_model,
  session/prompt, session/close; notification session/cancel.
- agent -> client: session/update notifications whose `update.sessionUpdate`
  is one of agent_message_chunk / agent_thought_chunk / tool_call /
  tool_call_update / plan / usage_update / session_info_update / ..., plus
  chrys extensions sent as `_chrys/runtime_update`, `_chrys/usage_update`,
  `_chrys/error`, `_chrys/warning`, ...
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import threading
import time
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from ..config import Settings
from ..errors import EvalError, InfrastructureError
from .logs import LogCallback
from .workspace_scan import WORKSPACE_SCAN_INTERVAL_SECONDS, scan_workspace

PROTOCOL_VERSION = 1
CLIENT_NAME = "aaw-skill-eval"

ACP_IDLE_TIMEOUT_FLOOR_SECONDS = 60
ACP_HEARTBEAT_INTERVAL_SECONDS = 30.0
ACP_CHUNK_FLUSH_INTERVAL_SECONDS = 1.0
ACP_PROGRESS_THROTTLE_SECONDS = 3.0
ACP_CANCEL_GRACE_SECONDS = 8.0
ACP_REQUEST_TIMEOUT_SECONDS = 90.0

ProgressCallback = Callable[[str, str], None]
CancelCallback = Callable[[], bool]


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _terminate_process_tree(process: subprocess.Popen) -> None:
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


def _absolute_turn_limit(timeout_seconds: int) -> int:
    """Hard wall-clock ceiling for one turn so a chatty agent cannot run forever."""
    return max(3 * int(timeout_seconds), 3600)


def _as_int(value: Any, fallback: int | None) -> int | None:
    if isinstance(value, bool):
        return fallback
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return fallback


def _chunk_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, dict):
        if isinstance(content.get("text"), str):
            return content["text"]
        return _chunk_text(content.get("content"))
    if isinstance(content, list):
        parts = [_chunk_text(item) for item in content]
        return "".join(part for part in parts if part)
    return ""


_TOOL_INPUT_PRIORITY = ("skill_name", "command", "path", "pattern", "query", "url")


def _tool_input_summary(raw_input: Any, title: str) -> str:
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


def _tool_result_summary(update: dict[str, Any]) -> str:
    """One-line digest of a tool_call_update's result payload.

    chrys sends the tool result as `content` (the same nested text shape as
    agent_message_chunk) and/or a plain-string `rawOutput`.
    """
    text = _chunk_text(update.get("content"))
    if not text:
        raw_output = update.get("rawOutput")
        if isinstance(raw_output, str):
            text = raw_output
    return " ".join(text.split())[:200]


@dataclass
class AcpTurnResult:
    stop_reason: str | None = None
    text: str = ""
    usage: dict[str, Any] | None = None
    duration_ms: int = 0
    timed_out: bool = False
    cancelled: bool = False
    idle_timeout: bool = False
    events: list[dict[str, Any]] = field(default_factory=list)
    error: dict[str, Any] | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None


class ChrysAcpSession:
    """One `chrys acp` process bound to one agent profile and workspace."""

    def __init__(
        self,
        settings: Settings,
        *,
        agent_profile: str,
        cwd: Path,
        artifact_dir: Path,
        on_log: LogCallback | None = None,
        log_source: str = "runner",
        isolated_root: Path | None = None,
    ) -> None:
        self.settings = settings
        self.agent_profile = agent_profile
        self.cwd = cwd
        self.artifact_dir = artifact_dir
        self.on_log = on_log
        self.log_source = log_source
        # Pre-materialized per-run config home. When set, the session uses it
        # as-is instead of (re)writing the shared chrys-isolated directory —
        # mandatory once no_skill/current runs execute in parallel.
        self.isolated_root = isolated_root
        self.session_id: str | None = None
        self.models_state: dict[str, Any] | None = None
        self.process: subprocess.Popen | None = None
        self._stderr_path = artifact_dir / "chrys-acp.stderr.txt"
        self._wire_path = artifact_dir / "chrys-acp.jsonl"
        self._lock = threading.Lock()
        self._responses: dict[int, dict[str, Any]] = {}
        self._request_events: dict[int, threading.Event] = {}
        self._next_id = 0
        self._closed = False
        self.last_activity = 0.0
        # live runtime state, updated from notifications
        self.context_size: int | None = None
        self.context_used: int | None = None
        self.input_tokens: int | None = None
        self.output_tokens: int | None = None
        self.cache_hit_tokens: int | None = None
        self.model_profile_id: str | None = None
        self.tool_names: list[str] = []
        self.skill_names: list[str] = []
        # chunk buffering for the log console
        self._chunk_parts: list[str] = []
        self._chunk_kind: str | None = None
        self._chunk_flushed_at = 0.0
        # progress throttling
        self._last_progress_at = 0.0
        # turn capture (set while a prompt is in flight)
        self._capture_text: list[str] | None = None
        self._capture_tools: list[dict[str, Any]] | None = None
        self._capture_tool_index: dict[str, dict[str, Any]] = {}
        self._active_progress: ProgressCallback | None = None
        # skills the agent loaded via the `load skill` tool this session
        self.skills_loaded: list[str] = []
        # toolCallId -> display title; tool_call_update events carry no title,
        # so the start event's title is remembered to label later updates.
        self._tool_titles: dict[str, str] = {}

    # ------------------------------------------------------------------ util

    def _log(self, channel: str, text: str) -> None:
        if self.on_log is not None:
            self.on_log(self.log_source, channel, text)

    def _progress(self, message: str, *, force: bool = False) -> None:
        """Throttled activity progress fed from ACP notifications (reader thread).

        `force` bypasses the throttle for rare, high-signal events such as
        skill loads — those must always reach the run timeline.
        """
        callback = self._active_progress
        if callback is None:
            return
        now = time.monotonic()
        if not force and now - self._last_progress_at < ACP_PROGRESS_THROTTLE_SECONDS:
            return
        self._last_progress_at = now
        callback("activity", message)

    def command(self) -> list[str]:
        from .runner import command_prefix

        return [
            *command_prefix(self.settings.chrys_command),
            "acp",
            "-a",
            self.agent_profile,
            "--approval",
            "bypass",
            "-C",
            str(self.cwd),
        ]

    def _command_text(self) -> str:
        command = self.command()
        return subprocess.list2cmdline(command) if os.name == "nt" else shlex.join(command)

    # ------------------------------------------------------------- lifecycle

    def start(self) -> None:
        self.artifact_dir.mkdir(parents=True, exist_ok=True)
        # Run chrys against an isolated config home so the operator's global
        # skills (~APPDATA/chrys/skills) cannot leak into evaluation runs and
        # pollute the no_skill baseline (R4P1). Fails closed: without the
        # isolation the baseline would be silently contaminated.
        # With pair-parallel execution the orchestrator materializes one
        # config home per run from the experiment template (isolated_root);
        # the shared chrys-isolated fallback is only for standalone callers.
        if self.isolated_root is not None:
            isolated_root = self.isolated_root
            isolated_root.mkdir(parents=True, exist_ok=True)
            isolation_note = f"每 Run 独立：{isolated_root}"
        else:
            from .chrys import prepare_isolated_home

            try:
                isolated_root = prepare_isolated_home(self.settings)
            except (EvalError, InfrastructureError, OSError) as exc:
                raise InfrastructureError(
                    "CHRYS_ISOLATION_FAILED", f"Failed to prepare isolated chrys home: {exc}"
                ) from exc
            isolation_note = f"共享隔离目录：{isolated_root}"
        env = {**os.environ, "NO_COLOR": "1", "TERM": "dumb"}
        if os.name == "nt":
            env["APPDATA"] = str(isolated_root)
        else:
            env["HOME"] = str(isolated_root)
        try:
            self.process = subprocess.Popen(
                self.command(),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=self.cwd,
                env=env,
            )
        except FileNotFoundError as exc:
            raise InfrastructureError(
                "CHRYS_NOT_FOUND", f"Chrys executable not found: {self.settings.chrys_command}"
            ) from exc
        except OSError as exc:
            raise InfrastructureError("CHRYS_SPAWN_FAILED", f"Failed to start chrys acp: {exc}") from exc
        self.last_activity = time.monotonic()
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._drain_stderr, daemon=True).start()
        self._log(
            "acp",
            f"ACP 进程已启动 · PID {self.process.pid} · agent {self.agent_profile}"
            f" · 工作区 {self.cwd} · chrys 运行环境已隔离（{isolation_note}），不含用户全局技能",
        )

    def _read_stdout(self) -> None:
        process = self.process
        assert process is not None and process.stdout is not None
        with self._wire_path.open("a", encoding="utf-8") as wire:
            for raw in iter(process.stdout.readline, b""):
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                wire.write(line + "\n")
                wire.flush()
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    self._log("acp", f"收到非 JSON 输出：{line[:400]}")
                    continue
                if not isinstance(message, dict):
                    continue
                try:
                    self._dispatch(message)
                except Exception as exc:  # pragma: no cover - defensive
                    self._log("acp", f"ACP 消息处理失败：{exc!r}；原始消息：{line[:400]}")
                    self._wake_all()
                    return

    def _drain_stderr(self) -> None:
        process = self.process
        assert process is not None and process.stderr is not None
        parts: list[str] = []
        with self._stderr_path.open("a", encoding="utf-8") as output:
            for raw in iter(process.stderr.readline, b""):
                chunk = raw.decode("utf-8", "replace")
                parts.append(chunk)
                output.write(chunk)
                output.flush()
        text = "".join(parts).strip()
        if text:
            self._log("stderr", text[-4000:])

    def _wake_all(self) -> None:
        with self._lock:
            for event in self._request_events.values():
                event.set()

    # ------------------------------------------------------------ transport

    def _send(self, payload: dict[str, Any]) -> None:
        if self.process is None or self.process.stdin is None or self._closed:
            raise InfrastructureError("ACP_CLOSED", "chrys acp process is not running")
        try:
            self.process.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
            self.process.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            raise InfrastructureError("ACP_WRITE_FAILED", f"chrys acp stdin write failed: {exc}") from exc

    def _request(
        self,
        method: str,
        params: dict[str, Any] | None,
        *,
        timeout: float = ACP_REQUEST_TIMEOUT_SECONDS,
    ) -> dict[str, Any]:
        with self._lock:
            self._next_id += 1
            request_id = self._next_id
            event = threading.Event()
            self._request_events[request_id] = event
        self._send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                **({"params": params} if params is not None else {}),
            }
        )
        if not event.wait(timeout):
            with self._lock:
                self._request_events.pop(request_id, None)
            raise InfrastructureError(
                "ACP_REQUEST_TIMEOUT", f"chrys acp did not answer {method} within {timeout:.0f}s"
            )
        with self._lock:
            self._request_events.pop(request_id, None)
            response = self._responses.pop(request_id, {})
        if "error" in response:
            return {"_error": response["error"]}
        return response.get("result", {})

    def _notify(self, method: str, params: dict[str, Any] | None) -> None:
        with suppress(InfrastructureError):
            self._send(
                {"jsonrpc": "2.0", "method": method, **({"params": params} if params is not None else {})}
            )

    def _dispatch(self, message: dict[str, Any]) -> None:
        if "id" in message and ("result" in message or "error" in message):
            with self._lock:
                self._responses[message["id"]] = message
                event = self._request_events.get(message["id"])
            if event is not None:
                event.set()
            return
        method = message.get("method")
        if not isinstance(method, str):
            return
        self.last_activity = time.monotonic()
        try:
            self._handle_notification(method, message.get("params") or {})
        except Exception as exc:  # pragma: no cover - defensive
            self._log("acp", f"处理通知 {method} 失败：{exc!r}")

    # -------------------------------------------------------- notifications

    def _flush_chunks(self) -> None:
        with self._lock:
            parts = self._chunk_parts
            kind = self._chunk_kind
            self._chunk_parts = []
            self._chunk_kind = None
            self._chunk_flushed_at = time.monotonic()
        text = "".join(parts)
        if text.strip():
            label = "Agent 消息" if kind != "thought" else "Agent 思考"
            self._log("acp", f"{label}：{text}")

    def _buffer_chunk(self, text: str, kind: str) -> None:
        with self._lock:
            if self._chunk_kind is not None and self._chunk_kind != kind:
                self._flush_chunks_locked()
            self._chunk_kind = kind
            self._chunk_parts.append(text)

    def _flush_chunks_locked(self) -> None:
        # caller holds self._lock
        parts, kind = self._chunk_parts, self._chunk_kind
        self._chunk_parts = []
        self._chunk_kind = None
        self._chunk_flushed_at = time.monotonic()
        text = "".join(parts)
        if text.strip():
            label = "Agent 消息" if kind != "thought" else "Agent 思考"
            self._on_log_chunk(label, text)

    def _on_log_chunk(self, label: str, text: str) -> None:
        if self.on_log is not None:
            self.on_log(self.log_source, "acp", f"{label}：{text}")

    def _handle_notification(self, method: str, params: dict[str, Any]) -> None:
        if method == "session/update":
            self._handle_session_update(params)
            return
        if method == "_chrys/runtime_update":
            runtime = params.get("runtime") or {}
            model = runtime.get("modelProfileId")
            if isinstance(model, str):
                self.model_profile_id = model
            # chrys 0.22.6 puts toolNames/skillNames at the runtime top level
            # (siblings of runtimeDetails); only fall back to runtimeDetails
            # for other builds. Reading the wrong level made the page show
            # "工具 0 个 · Skills 0 个" forever (R2P1).
            details = runtime.get("runtimeDetails") or {}
            tools = runtime.get("toolNames")
            if not isinstance(tools, list):
                tools = details.get("toolNames") or []
            skills = runtime.get("skillNames")
            if not isinstance(skills, list):
                skills = details.get("skillNames") or []
            self.tool_names = [str(item) for item in tools if isinstance(item, (str, int))]
            self.skill_names = [str(item) for item in skills if isinstance(item, (str, int))]
            names = "、".join(self.skill_names[:5])
            self._log(
                "acp",
                f"运行时更新 · 模型 {self.model_profile_id or '—'} · 工具 {len(self.tool_names)} 个"
                f" · Skills {len(self.skill_names)} 个"
                + (f"（{names}{'…' if len(self.skill_names) > 5 else ''}）" if names else ""),
            )
            return
        if method == "_chrys/usage_update":
            self.input_tokens = _as_int(params.get("inputTokens"), self.input_tokens)
            self.output_tokens = _as_int(params.get("outputTokens"), self.output_tokens)
            self.cache_hit_tokens = _as_int(params.get("cacheHitTokens"), self.cache_hit_tokens)
            return
        if method == "_chrys/error":
            self._log("acp", f"Chrys 错误 · {params.get('code', '')} {params.get('message', '')}".strip())
            return
        if method == "_chrys/warning":
            self._log("acp", f"Chrys 警告 · {params.get('message') or params}")
            return
        name = method.removeprefix("_chrys/")
        if name in {
            "sub_agent_progress",
            "sub_agent_invocation_start",
            "sub_agent_tool_call_start",
            "sub_agent_tool_call_result",
            "sub_agent_paused",
            "sub_agent_resumed",
        }:
            detail = params.get("title") or params.get("name") or params.get("profile") or ""
            self._log("acp", f"子 Agent 活动 · {name} {detail}".strip())
        elif name in {
            "context_pressure",
            "context_compressed",
            "compaction_started",
            "compaction_finished",
            "workspace_updated",
            "approval_reviewed",
            "profile_switched",
            "rollback_result",
        }:
            self._log("acp", f"事件 · {name}")

    def _handle_session_update(self, params: dict[str, Any]) -> None:
        update = params.get("update") or {}
        kind = update.get("sessionUpdate")
        if kind == "agent_message_chunk":
            text = _chunk_text(update.get("content"))
            if text:
                self._buffer_chunk(text, "agent")
                if self._capture_text is not None:
                    self._capture_text.append(text)
                self._progress("Agent 正在输出消息")
            return
        if kind == "agent_thought_chunk":
            text = _chunk_text(update.get("content"))
            if text:
                self._buffer_chunk(text, "thought")
                self._progress("Agent 正在推理")
            return
        if kind in {"tool_call", "tool_call_update"}:
            tool_call_id = update.get("toolCallId")
            known_title = (
                self._tool_titles.get(tool_call_id) if isinstance(tool_call_id, str) else None
            )
            title = str(update.get("title") or known_title or tool_call_id or "工具调用")
            kind_label = str(update.get("kind") or "")
            raw_input = update.get("rawInput")
            status = update.get("status")
            input_summary = _tool_input_summary(raw_input, title)
            result_summary = _tool_result_summary(update) if kind == "tool_call_update" else ""
            skill_name = None
            if (
                isinstance(raw_input, dict)
                and isinstance(raw_input.get("skill_name"), str)
                and "skill" in title.casefold()
            ):
                skill_name = raw_input["skill_name"]
                if skill_name not in self.skills_loaded:
                    self.skills_loaded.append(skill_name)
                # A skill load is high-signal: always surface it in the run
                # timeline so baseline contamination (e.g. a no_skill group
                # agent loading a global skill) is visible on the page.
                self._progress(f"Agent 加载了技能：{skill_name}", force=True)
            if kind == "tool_call" and isinstance(tool_call_id, str) and update.get("title"):
                if len(self._tool_titles) > 2000:
                    self._tool_titles.clear()
                self._tool_titles[tool_call_id] = str(update["title"])
            if self._capture_tools is not None:
                entry = (
                    self._capture_tool_index.get(tool_call_id)
                    if isinstance(tool_call_id, str)
                    else None
                )
                if entry is None:
                    entry = {
                        "type": "tool_call",
                        "tool_call_id": tool_call_id,
                        "tool_name": update.get("title") or known_title,
                        "tool_kind": update.get("kind"),
                        "status": status,
                        "input": input_summary or None,
                        **({"result": result_summary} if result_summary else {}),
                        **({"skill_name": skill_name} if skill_name else {}),
                    }
                    self._capture_tools.append(entry)
                    if isinstance(tool_call_id, str):
                        self._capture_tool_index[tool_call_id] = entry
                else:
                    # tool_call_update merges into the tool_call entry so the
                    # turn keeps one record per call, carrying its final
                    # status and a result digest.
                    if status is not None:
                        entry["status"] = status
                    if result_summary:
                        entry["result"] = result_summary
                    if skill_name:
                        entry["skill_name"] = skill_name
            if kind == "tool_call":
                detail = f"工具调用 · {title}"
                if input_summary:
                    detail += f" · {input_summary}"
                elif kind_label:
                    detail += f"（{kind_label}）"
                self._log("acp", detail)
                self._progress(f"工具调用：{title}" + (f"（{input_summary}）" if input_summary else ""))
            elif isinstance(status, str) and status:
                # tool_call_update carries the result. This branch used to
                # crash on an undefined `status` name, so every update was
                # swallowed into "处理通知 ... 失败：NameError" log noise and
                # tool results never reached the console.
                if status == "completed":
                    self._log(
                        "acp",
                        f"工具完成 · {title}" + (f" · {result_summary}" if result_summary else ""),
                    )
                    self._progress(f"工具完成：{title}")
                elif status == "failed":
                    self._log(
                        "acp",
                        f"工具失败 · {title}" + (f" · {result_summary}" if result_summary else ""),
                    )
                    self._progress(f"工具失败：{title}", force=True)
                else:
                    self._log("acp", f"工具进展 · {title} → {status}")
            return
        if kind == "plan":
            entries = update.get("entries") or []
            done = sum(
                1 for entry in entries if isinstance(entry, dict) and entry.get("status") == "completed"
            )
            self._log("acp", f"计划更新 · {len(entries)} 项（已完成 {done}）")
            self._progress(f"Agent 更新了执行计划（{len(entries)} 项）")
            return
        if kind == "usage_update":
            self.context_size = _as_int(update.get("size"), self.context_size)
            self.context_used = _as_int(update.get("used"), self.context_used)
            return
        if kind == "session_info_update":
            info = update.get("info") or {}
            if isinstance(info, dict) and info.get("title"):
                self._log("acp", f"会话标题：{info['title']}")
            return
        if kind in {"available_commands_update", "current_mode_update", "config_option_update", "user_message_chunk"}:
            return
        self._log("acp", f"事件 · {kind or 'session_update'}")

    # ------------------------------------------------------------- protocol

    def initialize(self) -> None:
        result = self._request(
            "initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}},
                "clientInfo": {"name": CLIENT_NAME, "version": "1"},
            },
        )
        if "_error" in result:
            raise InfrastructureError(
                "ACP_INIT_FAILED", f"chrys acp initialize failed: {result['_error']}"
            )
        info = result.get("agentInfo") or {}
        self._log(
            "acp",
            f"ACP 已初始化 · agent {info.get('name', '?')} {info.get('version', '')}".strip(),
        )

    def new_session(self, cwd: Path | None = None) -> str:
        result = self._request("session/new", {"cwd": str(cwd or self.cwd), "mcpServers": []})
        if "_error" in result:
            raise InfrastructureError(
                "ACP_SESSION_FAILED", f"chrys acp session/new failed: {result['_error']}"
            )
        session_id = result.get("sessionId")
        if not isinstance(session_id, str) or not session_id:
            raise InfrastructureError("ACP_SESSION_FAILED", "chrys acp did not return a sessionId")
        self.session_id = session_id
        models = result.get("models")
        if isinstance(models, dict):
            self.models_state = models
        count = len(self.available_models())
        self._log("acp", f"会话已建立 · sessionId {session_id[:8]}… · 可用模型 {count} 个")
        return session_id

    def available_models(self) -> list[dict[str, Any]]:
        models = (self.models_state or {}).get("availableModels")
        return [item for item in models if isinstance(item, dict)] if isinstance(models, list) else []

    def current_model_id(self) -> str | None:
        current = (self.models_state or {}).get("currentModelId")
        return current if isinstance(current, str) else None

    def ensure_model(self, model_ref: str) -> str:
        """Pin the session model; accepts a Chrys Model Profile id or display name."""
        models = self.available_models()
        resolved = None
        for item in models:
            if item.get("modelId") == model_ref or item.get("name") == model_ref:
                resolved = str(item["modelId"])
                break
        if resolved is None:
            listing = "、".join(
                f"{item.get('name')}({item.get('modelId')})" for item in models[:8]
            )
            raise EvalError(
                "CHRYS_MODEL_NOT_FOUND",
                f"Chrys Model Profile was not found: {model_ref}；可用：{listing or '无'}",
                status_code=400,
            )
        current = self.current_model_id()
        if current == resolved:
            self._log("acp", f"会话模型已固定 · {model_ref}（{resolved}）")
            return resolved
        result = self._request(
            "session/set_model", {"sessionId": self.session_id, "modelId": resolved}
        )
        if "_error" in result:
            raise InfrastructureError(
                "ACP_SET_MODEL_FAILED", f"chrys acp set_model failed: {result['_error']}"
            )
        self._log("acp", f"会话模型已切换 · {current or '—'} → {resolved}（{model_ref}）")
        return resolved

    # --------------------------------------------------------------- prompt

    def prompt(
        self,
        text: str,
        *,
        timeout_seconds: int,
        on_progress: ProgressCallback | None = None,
        is_cancelled: CancelCallback | None = None,
        turn: int = 1,
    ) -> AcpTurnResult:
        if self.session_id is None:
            raise InfrastructureError("ACP_NO_SESSION", "No ACP session was created")
        process = self.process
        assert process is not None
        result = AcpTurnResult()
        invocation_id = uuid4().hex
        started = time.monotonic()
        idle_limit = max(int(timeout_seconds), ACP_IDLE_TIMEOUT_FLOOR_SECONDS)
        absolute_limit = _absolute_turn_limit(timeout_seconds)
        prompt_dir = self.artifact_dir / "invocations"
        prompt_dir.mkdir(parents=True, exist_ok=True)
        prefix = "judge/" if self.log_source == "judge" else ""
        prompt_file = prompt_dir / f"{invocation_id}.prompt.txt"
        prompt_file.write_text(text, encoding="utf-8")

        def invocation_event(phase: str, **details: Any) -> None:
            self._log(
                "invocation",
                json.dumps(
                    {
                        "id": invocation_id,
                        "phase": phase,
                        "source": self.log_source,
                        "command": self._command_text(),
                        "cwd": str(self.cwd),
                        "prompt_file": f"{prefix}invocations/{prompt_file.name}",
                        "timeout_seconds": idle_limit,
                        **details,
                    },
                    ensure_ascii=False,
                ),
            )

        invocation_event(
            "start",
            pid=process.pid,
            process_state="running",
            turn=turn,
            started_at=_now_iso(),
            session_id=self.session_id,
            model_profile=self.model_profile_id,
        )
        self._log(
            "acp",
            f"=== 第 {turn} 轮提示已发送（{len(text)} 字符）"
            f" · 无活动超时 {idle_limit}s · 总时长上限 {absolute_limit}s ===",
        )
        with self._lock:
            self._next_id += 1
            request_id = self._next_id
            done_event = threading.Event()
            self._request_events[request_id] = done_event
        capture_text: list[str] = []
        capture_tools: list[dict[str, Any]] = []
        self._capture_text = capture_text
        self._capture_tools = capture_tools
        self._capture_tool_index = {}
        self._active_progress = on_progress
        self._chunk_flushed_at = time.monotonic()
        try:
            self._send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "session/prompt",
                    "params": {
                        "sessionId": self.session_id,
                        "prompt": [{"type": "text", "text": text}],
                    },
                }
            )
            timed_out = False
            cancelled = False
            idle_timeout = False
            workspace_baseline = scan_workspace(self.cwd, exclude=set())
            last_workspace_change: float | None = None
            last_scan = time.monotonic()
            last_heartbeat = started
            while not done_event.is_set():
                now = time.monotonic()
                if is_cancelled is not None and is_cancelled():
                    cancelled = True
                    self._notify("session/cancel", {"sessionId": self.session_id})
                    self._log("acp", "已请求取消当前轮次（session/cancel）")
                    if not done_event.wait(ACP_CANCEL_GRACE_SECONDS):
                        _terminate_process_tree(process)
                    break
                idle_source = max(self.last_activity, last_workspace_change or 0.0, started)
                idle = now - idle_source
                if idle >= idle_limit:
                    timed_out = True
                    idle_timeout = True
                    self._log(
                        "acp",
                        f"连续 {idle_limit}s 无活动信号（无 ACP 事件、无工作区文件改动），请求结束当前轮",
                    )
                    self._notify("session/cancel", {"sessionId": self.session_id})
                    if not done_event.wait(ACP_CANCEL_GRACE_SECONDS):
                        _terminate_process_tree(process)
                    break
                if now - started >= absolute_limit:
                    timed_out = True
                    self._log(
                        "acp",
                        f"单轮总时长已达 {int(now - started)}s 上限（期间仍有活动），强制结束",
                    )
                    self._notify("session/cancel", {"sessionId": self.session_id})
                    if not done_event.wait(ACP_CANCEL_GRACE_SECONDS):
                        _terminate_process_tree(process)
                    break
                if now - last_scan >= WORKSPACE_SCAN_INTERVAL_SECONDS:
                    last_scan = now
                    snapshot_files = scan_workspace(self.cwd, exclude=set())
                    changed = [
                        name
                        for name, signature in snapshot_files.items()
                        if workspace_baseline.get(name) != signature
                    ]
                    removed = [name for name in workspace_baseline if name not in snapshot_files]
                    if changed or removed:
                        last_workspace_change = now
                        sample = "、".join(changed[:3])
                        self._progress(
                            f"工作区文件有更新：{len(changed)} 个变动"
                            + (f"（如 {sample}）" if sample else "")
                            + (f"，{len(removed)} 个删除" if removed else "")
                        )
                        workspace_baseline = snapshot_files
                if now - self._chunk_flushed_at >= ACP_CHUNK_FLUSH_INTERVAL_SECONDS:
                    self._flush_chunks()
                if on_progress is not None and now - last_heartbeat >= ACP_HEARTBEAT_INTERVAL_SECONDS:
                    last_heartbeat = now
                    elapsed = int(now - started)
                    silent = int(now - idle_source)
                    remaining = max(0, idle_limit - silent)
                    context = (
                        f"上下文 {self.context_used or 0}/{self.context_size or 0} tokens"
                        if self.context_size
                        else "上下文用量未知"
                    )
                    tokens = (
                        f"累计输入 {self.input_tokens or 0} · 输出 {self.output_tokens or 0} tokens"
                        if (self.input_tokens or self.output_tokens)
                        else "token 用量暂无"
                    )
                    on_progress(
                        "heartbeat",
                        f"ACP PID {process.pid} 仍在运行；已运行 {elapsed}s，"
                        f"最近 {silent}s 无活动信号；{context}；{tokens}；"
                        f"无活动超时还剩 {remaining}s（总时长上限 {absolute_limit}s）",
                    )
                time.sleep(0.25)
            self._flush_chunks()
            with self._lock:
                response = self._responses.pop(request_id, {})
                self._request_events.pop(request_id, None)
            duration_ms = int((time.monotonic() - started) * 1000)
            turn_text = "".join(capture_text)
            usage: dict[str, Any] | None = None
            stop_reason: str | None = None
            error: dict[str, Any] | None = None
            if "error" in response:
                error = response["error"]
            elif isinstance(response.get("result"), dict):
                stop_reason = response["result"].get("stopReason")
                usage = response["result"].get("usage")
            if usage:
                result.input_tokens = _as_int(usage.get("inputTokens"), None)
                result.output_tokens = _as_int(usage.get("outputTokens"), None)
            if result.input_tokens is None and self.input_tokens is not None:
                result.input_tokens = self.input_tokens
                result.output_tokens = self.output_tokens
            result.stop_reason = stop_reason
            result.text = turn_text
            result.usage = usage
            result.duration_ms = duration_ms
            result.timed_out = timed_out
            result.cancelled = cancelled
            result.idle_timeout = idle_timeout
            result.error = error
            result.events = list(capture_tools) + [
                {
                    "type": "turn_end",
                    "turn": turn,
                    "stop_reason": stop_reason,
                    "input_tokens": result.input_tokens,
                    "output_tokens": result.output_tokens,
                }
            ]
            invocation_event(
                "end",
                pid=process.pid,
                process_state="running" if process.poll() is None else "exited",
                ended_at=_now_iso(),
                exit_code=0 if (error is None and not timed_out and not cancelled) else 1,
                duration_ms=duration_ms,
                timed_out=timed_out,
                idle_timeout=idle_timeout,
                cancelled=cancelled,
                turn=turn,
                stop_reason=stop_reason,
                input_tokens=result.input_tokens,
                output_tokens=result.output_tokens,
                session_id=self.session_id,
            )
            summary = (
                f"=== 第 {turn} 轮结束 · stopReason {stop_reason or '—'}"
                f" · 用时 {duration_ms / 1000:.1f}s"
            )
            if result.input_tokens is not None or result.output_tokens is not None:
                summary += f" · tokens {result.input_tokens or 0} 入 / {result.output_tokens or 0} 出"
            self._log("acp", summary + " ===")
            return result
        finally:
            self._capture_text = None
            self._capture_tools = None
            self._capture_tool_index = {}
            self._active_progress = None

    # ----------------------------------------------------------------- close

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        process = self.process
        if process is not None and process.poll() is None and self.session_id is not None:
            with suppress(Exception):
                self._request("session/close", {"sessionId": self.session_id}, timeout=15)
        if process is not None:
            if process.poll() is None:
                with suppress(OSError):
                    if process.stdin is not None:
                        process.stdin.close()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    _terminate_process_tree(process)
            self._flush_chunks()
            if process.returncode not in (0, None):
                self._log("acp", f"ACP 进程异常退出 · 退出码 {process.returncode}")

    def __enter__(self) -> ChrysAcpSession:
        self.start()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()
