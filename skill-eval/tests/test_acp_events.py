"""Regression tests for the two reported live defects.

U1: ACP tool_call_update events carry the tool result, but the handler
referenced an undefined `status` name, so every update crashed with a
NameError inside _dispatch's defensive except — tool results never reached
the log console and the captured event list got duplicate, result-less
entries (ground truth: 62/129 NameError lines in recorded run logs).

U2: the score breakdown renders three evidence buttons with data-artifact
attributes, but the live bindDetailActions lost their click binding during
the log-console refactor (the binding only existed in a shadowed, dead
function definition), so the buttons never responded.
"""

from __future__ import annotations

import re
from pathlib import Path

from aaw_skill_eval.services.providers.protocols.acp import AcpSession

STATIC_APP_JS = Path(__file__).resolve().parents[1] / "src" / "aaw_skill_eval" / "static" / "app.js"


def _make_session(tmp_path: Path) -> tuple[AcpSession, list[str], list[str]]:
    """Session with recording log/progress hooks, as if a prompt turn is active."""
    log_lines: list[str] = []
    progress_lines: list[str] = []
    session = AcpSession(
        command=["chrys", "acp"],
        env={},
        agent_profile="code",
        cwd=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        on_log=lambda source, channel, text: log_lines.append(f"{source}/{channel}: {text}"),
        log_source="runner",
    )
    # simulate the capture state prompt() sets up
    session._capture_tools = []
    session._capture_tool_index = {}
    session._active_progress = lambda kind, message: progress_lines.append(message)
    return session, log_lines, progress_lines


def _dispatch(session: AcpSession, update: dict) -> None:
    message = {
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {"sessionId": "s1", "update": update},
    }
    session._dispatch(message)


def _tool_call(tool_call_id: str = "tc-1", **overrides: object) -> dict:
    payload = {
        "sessionUpdate": "tool_call",
        "toolCallId": tool_call_id,
        "title": "read_file",
        "kind": "read",
        "status": "in_progress",
        "rawInput": {"path": "AGENTS.md"},
    }
    payload.update(overrides)
    return payload


def _tool_call_update(tool_call_id: str = "tc-1", **overrides: object) -> dict:
    payload = {
        "sessionUpdate": "tool_call_update",
        "toolCallId": tool_call_id,
        "status": "completed",
        "content": [{"content": {"text": "1| line one\n2| line two"}}],
        "rawOutput": "1| line one\n2| line two",
    }
    payload.update(overrides)
    return payload


def test_tool_call_update_is_captured_and_logged(tmp_path: Path) -> None:
    session, logs, _progress = _make_session(tmp_path)
    _dispatch(session, _tool_call())
    _dispatch(session, _tool_call_update())

    # the old handler crashed here; _dispatch logged the NameError instead
    assert not any("失败" in line and "NameError" in line for line in logs), logs
    assert any("工具调用 · read_file · path=AGENTS.md" in line for line in logs), logs
    assert any("工具完成 · read_file · 1| line one 2| line two" in line for line in logs), logs

    # one merged entry per call, carrying the final status and result digest
    assert len(session._capture_tools) == 1
    entry = session._capture_tools[0]
    assert entry["tool_name"] == "read_file"
    assert entry["tool_kind"] == "read"
    assert entry["status"] == "completed"
    assert entry["input"] == "path=AGENTS.md"
    assert entry["result"] == "1| line one 2| line two"


def test_failed_tool_call_update_is_surfaced(tmp_path: Path) -> None:
    session, logs, progress = _make_session(tmp_path)
    _dispatch(session, _tool_call())
    _dispatch(session, _tool_call_update(status="failed", content=None, rawOutput="boom"))

    assert any("工具失败 · read_file · boom" in line for line in logs), logs
    # failures are high signal: they must bypass progress throttling
    assert any("工具失败：read_file" in line for line in progress), progress
    assert session._capture_tools[0]["status"] == "failed"
    assert session._capture_tools[0]["result"] == "boom"


def test_tool_call_update_without_prior_call_creates_entry(tmp_path: Path) -> None:
    session, logs, _progress = _make_session(tmp_path)
    # chrys can emit an update whose tool_call start event was never seen
    _dispatch(session, _tool_call_update(tool_call_id="orphan-1"))

    assert not any("NameError" in line for line in logs), logs
    assert len(session._capture_tools) == 1
    entry = session._capture_tools[0]
    assert entry["tool_call_id"] == "orphan-1"
    assert entry["status"] == "completed"
    assert entry["result"]


def test_tool_result_summary_falls_back_to_raw_output(tmp_path: Path) -> None:
    session, logs, _progress = _make_session(tmp_path)
    _dispatch(session, _tool_call())
    # one-in-a-hundred real wire shape: rawOutput only, no content list
    _dispatch(session, _tool_call_update(content=None, rawOutput="Found 50 file(s) matching"))

    entry = session._capture_tools[0]
    assert entry["result"] == "Found 50 file(s) matching"


def test_interleaved_tool_calls_keep_separate_entries(tmp_path: Path) -> None:
    session, logs, _progress = _make_session(tmp_path)
    _dispatch(
        session, _tool_call(tool_call_id="tc-a", title="read_file", rawInput={"path": "a.md"})
    )
    _dispatch(
        session,
        _tool_call(tool_call_id="tc-b", title="run_command", rawInput={"command": "pytest"}),
    )
    _dispatch(session, _tool_call_update(tool_call_id="tc-a"))
    _dispatch(
        session,
        _tool_call_update(tool_call_id="tc-b", status="failed", content=None, rawOutput="exit 1"),
    )

    assert len(session._capture_tools) == 2
    by_id = {entry["tool_call_id"]: entry for entry in session._capture_tools}
    assert by_id["tc-a"]["status"] == "completed"
    assert by_id["tc-b"]["status"] == "failed"
    assert by_id["tc-a"]["tool_name"] == "read_file"
    assert by_id["tc-b"]["tool_name"] == "run_command"


def test_skill_load_from_tool_call_still_detected(tmp_path: Path) -> None:
    session, logs, progress = _make_session(tmp_path)
    _dispatch(
        session,
        _tool_call(
            title="load skill",
            rawInput={"skill_name": "aaw-dev-eval"},
        ),
    )
    _dispatch(session, _tool_call_update(content=None, rawOutput="loaded"))

    assert session.skills_loaded == ["aaw-dev-eval"]
    assert any("Agent 加载了技能：aaw-dev-eval" in line for line in progress), progress
    entry = session._capture_tools[0]
    assert entry["skill_name"] == "aaw-dev-eval"
    assert entry["status"] == "completed"


def _function_body(source: str, name: str) -> str:
    pattern = re.compile(rf"^(?:async )?function {name}\s*\(", re.MULTILINE)
    starts = list(pattern.finditer(source))
    assert len(starts) == 1, f"expected exactly one definition of {name}, found {len(starts)}"
    start = starts[0].start()
    following = re.search(r"\n(?:async )?function \w+", source[start + 1 :])
    end = start + 1 + following.start() if following else len(source)
    return source[start:end]


def test_live_bind_detail_actions_binds_artifact_buttons() -> None:
    source = STATIC_APP_JS.read_text(encoding="utf-8")
    body = _function_body(source, "bindDetailActions")
    assert "data-artifact" in body, "bindDetailActions must bind the evidence artifact buttons"
    assert "openArtifact" in body


def test_detail_functions_are_not_shadowed() -> None:
    """Shadowed duplicates made the dead copy look complete while the live
    one silently lost bindings — the root cause of the dead evidence buttons."""
    source = STATIC_APP_JS.read_text(encoding="utf-8")
    detail_functions = (
        "renderDetail",
        "bindDetailActions",
        "showDetail",
        "loadRunEvents",
        "refreshDetail",
    )
    for name in detail_functions:
        pattern = rf"^(?:async )?function {name}\s*\("
        definitions = re.findall(pattern, source, re.MULTILINE)
        assert len(definitions) == 1, f"{name} is defined {len(definitions)} times"
