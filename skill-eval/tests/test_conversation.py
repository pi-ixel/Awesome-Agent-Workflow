"""Conversation replay: rebuild structured dialogues from ACP wire recordings."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient
from test_api_flow import _suite, _wait

from aaw_skill_eval.services.conversation import rebuild_conversation

WIRE_LINES: list[dict] = [
{"jsonrpc": "2.0",
      "id": 1,
      "result": {"protocolVersion": 1, "agentInfo": {"name": "chrys", "version": "0.22.6"}}},
{"jsonrpc": "2.0",
      "id": 2,
      "result": {"sessionId": "04d4ccab-85ea-4c48-9601-74f5262161cf", "models": {}}},
    {"jsonrpc": "2.0", "method": "_chrys/runtime_update", "params": {"runtime": {
        "modelProfileId": "gl-test",
        "toolNames": ["read_file", "run_command"],
        "skillNames": ["aaw-dev-eval"],
    }}},
    {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s", "update": {
        "sessionUpdate": "session_info_update", "info": {"title": "sun-3d task"}}}},
    # ---- turn 1 ----
    {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s", "update": {
        "sessionUpdate": "agent_thought_chunk", "content": {"text": "先看一下项目结构"}}}},
    {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s", "update": {
        "sessionUpdate": "agent_message_chunk", "content": {"text": "我来看一下"}}}},
    {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s", "update": {
        "sessionUpdate": "agent_message_chunk", "content": {"text": "项目的结构。"}}}},
    {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s", "update": {
        "sessionUpdate": "tool_call",
        "toolCallId": "tc-1", "title": "read_file", "kind": "read", "status": "in_progress",
        "rawInput": {"path": "AGENTS.md"}}}},
    {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s", "update": {
        "sessionUpdate": "tool_call_update",
        "toolCallId": "tc-1", "status": "completed",
        "content": [{"content": {"text": "1| line one"}}],
        "rawOutput": "1| line one"}}},
    {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s", "update": {
        "sessionUpdate": "plan", "entries": [{"status": "completed"}, {"status": "pending"}]}}},
    {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s", "update": {
        "sessionUpdate": "usage_update", "size": 200000, "used": 5000}}},
{"jsonrpc": "2.0",
      "id": 3,
      "result": {"stopReason": "end_turn", "usage": {"inputTokens": 120, "outputTokens": 80}}},
    # ---- turn 2 (follow-up) ----
    {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s", "update": {
        "sessionUpdate": "agent_message_chunk", "content": {"text": "继续修复"}}}},
    {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s", "update": {
        "sessionUpdate": "tool_call",
        "toolCallId": "tc-2", "title": "run_command", "kind": "execute", "status": "in_progress",
        "rawInput": {"command": "pytest -q"}}}},
    {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s", "update": {
        "sessionUpdate": "tool_call_update",
        "toolCallId": "tc-2", "status": "failed", "rawOutput": "exit 1"}}},
    {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s", "update": {
        "sessionUpdate": "agent_message_chunk",
        "content": {"text": "测试失败，原因是 api_key=\"top-secret\" 泄漏"}}}},
    {"jsonrpc": "2.0", "id": 4,
     "result": {"stopReason": "end_turn", "usage": {"inputTokens": 300, "outputTokens": 90}}},
]


def _write_wire(artifact_dir: Path, name: str, lines: list[dict]) -> Path:
    path = artifact_dir / name
    path.parent.mkdir(parents=True, exist_ok=True)
    wire_text = "\n".join(json.dumps(line, ensure_ascii=False) for line in lines) + "\n"
    path.write_text(wire_text, encoding="utf-8")
    return path


def _write_invocation_log(artifact_dir: Path, source: str, turns: list[tuple[int, str]]) -> None:
    logs = artifact_dir / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    records = []
    for turn, prompt_file in turns:
        records.append({
            "sequence": len(records) + 1, "timestamp": "2026-09-28T13:00:00+00:00",
            "scope": "run", "source": source, "channel": "invocation", "attempt": 1, "stage": None,
            "text": json.dumps({
                "id": f"inv-{turn}", "phase": "start", "source": source, "turn": turn,
                "prompt_file": prompt_file,
            }),
        })
    index_text = "\n".join(json.dumps(record, ensure_ascii=False) for record in records) + "\n"
    (logs / "index.jsonl").write_text(index_text, encoding="utf-8")
    for turn, prompt_file in turns:
        target = artifact_dir / prompt_file
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f"prompt for turn {turn}\n", encoding="utf-8")


def test_rebuild_conversation_restores_turns_and_tools(tmp_path: Path) -> None:
    _write_wire(tmp_path, "chrys-acp.jsonl", WIRE_LINES)
    _write_invocation_log(
        tmp_path, "runner", [(1, "invocations/one.prompt.txt"), (2, "invocations/two.prompt.txt")]
    )

    result = rebuild_conversation(tmp_path, "runner")

    assert result["available"] is True
    assert result["session"]["model"] == "gl-test"
    assert result["session"]["tools"] == 2
    assert result["session"]["skills"] == ["aaw-dev-eval"]
    assert result["session"]["title"] == "sun-3d task"
    assert result["session"]["agent"] == "chrys 0.22.6"

    assert [turn["turn"] for turn in result["turns"]] == [1, 2]

    turn1 = result["turns"][0]
    assert turn1["stop_reason"] == "end_turn"
    assert turn1["usage"] == {"input_tokens": 120, "output_tokens": 80}
    assert turn1["context"] == {"size": 200000, "used": 5000}
    assert turn1["prompt"]["file"] == "invocations/one.prompt.txt"
    assert turn1["prompt"]["available"] is True
    assert turn1["prompt"]["bytes"] and turn1["prompt"]["bytes"] >= 18
    kinds = [item["type"] for item in turn1["items"]]
    # thought + merged message + merged tool + plan
    assert kinds == ["thought", "message", "tool_call", "plan"]
    assert turn1["items"][1]["text"] == "我来看一下项目的结构。"
    tool = turn1["items"][2]
    assert tool["name"] == "read_file"
    assert tool["status"] == "completed"
    assert tool["input"] == "path=AGENTS.md"
    assert tool["result"] == "1| line one"
    assert turn1["items"][3] == {"type": "plan", "entries": 2, "completed": 1}

    turn2 = result["turns"][1]
    assert turn2["prompt"]["file"] == "invocations/two.prompt.txt"
    kinds2 = [item["type"] for item in turn2["items"]]
    assert kinds2 == ["message", "tool_call", "message"]
    failed = turn2["items"][1]
    assert failed["status"] == "failed"
    assert failed["result"] == "exit 1"
    assert failed["input"] == "command=pytest -q"
    # masking happens at the API layer, the rebuild keeps the original text
    assert "top-secret" in turn2["items"][2]["text"]


def test_rebuild_handles_mid_turn_truncation_and_orphan_updates(tmp_path: Path) -> None:
    lines = WIRE_LINES[:9]  # cut inside turn 1, before its response
    lines.append({
        "jsonrpc": "2.0", "method": "session/update",
        "params": {"sessionId": "s", "update": {
            "sessionUpdate": "tool_call_update", "toolCallId": "tc-orphan",
            "status": "completed", "rawOutput": "orphan result",
        }},
    })
    _write_wire(tmp_path, "chrys-acp.jsonl", lines)

    result = rebuild_conversation(tmp_path, "runner")

    assert result["available"] is True
    # truncated turn still surfaces with its items; stop_reason stays None
    assert len(result["turns"]) == 1
    turn = result["turns"][0]
    assert turn["stop_reason"] is None
    kinds = [item["type"] for item in turn["items"]]
    assert kinds == ["thought", "message", "tool_call", "tool_call"]
    assert turn["items"][3]["name"] is None
    assert turn["items"][3]["result"] == "orphan result"
    assert turn["prompt"] is None  # no invocation log in this fixture


def test_missing_wire_reports_legacy_or_absent_reason(tmp_path: Path) -> None:
    tmp_path.mkdir(parents=True, exist_ok=True)
    absent = rebuild_conversation(tmp_path, "runner")
    assert absent["available"] is False
    assert "没有 Runner 的 ACP wire 记录" in absent["reason"]

    (tmp_path / "chrys-turn-1.json").write_text("{}", encoding="utf-8")
    legacy = rebuild_conversation(tmp_path, "runner")
    assert legacy["available"] is False
    assert "旧版 CLI 记录格式" in legacy["reason"]
    # the reason must spell out what is missing instead of fabricating content
    assert "仅有每轮最终输出（1 个 chrys-turn-*.json 文本记录）" in legacy["reason"]
    assert "无逐条工具调用记录" in legacy["reason"]
    assert "无提示词与会话流 wire 记录" in legacy["reason"]
    assert "不补造内容" in legacy["reason"]

    (tmp_path / "judge").mkdir()
    (tmp_path / "judge" / "chrys-turn-1.json").write_text("{}", encoding="utf-8")
    legacy_judge = rebuild_conversation(tmp_path, "judge")
    assert legacy_judge["available"] is False
    assert "旧版 CLI 记录格式" in legacy_judge["reason"]


def test_rebuild_skips_unparseable_lines(tmp_path: Path) -> None:
    valid = json.dumps({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": "s",
            "update": {"sessionUpdate": "agent_message_chunk", "content": {"text": "hi"}},
        },
    })
    wire = tmp_path / "chrys-acp.jsonl"
    wire.write_text("\n".join(["{not valid json", valid, ""]) + "\n", encoding="utf-8")

    result = rebuild_conversation(tmp_path, "runner")
    assert result["available"] is True
    assert result["unparsed_lines"] == 1
    assert result["turns"][0]["items"][0]["text"] == "hi"


def test_conversation_endpoint_replays_wire_with_masking(
    client: TestClient, project: Path, skill: Path
) -> None:
    suite = _suite(client, project, skill)
    response = client.post(
        "/api/v1/experiments",
        json={
            "suite_id": suite["id"],
            "mode": "quick",
            "profile": {
                "name": "conv-fixture", "runner_model": "m", "judge_model": "m", "network": False,
            },
        },
    )
    experiment = _wait(client, response.json()["id"])
    run = experiment["runs"][0]
    artifact_dir = client.app.state.settings.artifacts_dir / experiment["id"] / run["id"]
    _write_wire(artifact_dir, "chrys-acp.jsonl", WIRE_LINES)
    _write_invocation_log(artifact_dir, "runner", [(1, "invocations/one.prompt.txt")])

    payload = client.get(f"/api/v1/runs/{run['id']}/conversation?source=runner").json()
    assert payload["source"] == "runner"
    assert payload["pending"] is False
    assert len(payload["attempts"]) == 1
    attempt = payload["attempts"][0]
    assert attempt["attempt"] == 1
    assert attempt["available"] is True
    assert [turn["turn"] for turn in attempt["turns"]] == [1, 2]
    # sensitive values are masked by default
    assert "top-secret" not in json.dumps(payload, ensure_ascii=False)
    assert "***" in json.dumps(payload, ensure_ascii=False)
    # and shown with the explicit opt-out
    unmasked_url = f"/api/v1/runs/{run['id']}/conversation?source=runner&unmasked=true"
    unmasked = client.get(unmasked_url).json()
    assert "top-secret" in json.dumps(unmasked, ensure_ascii=False)

    judge = client.get(f"/api/v1/runs/{run['id']}/conversation?source=judge").json()
    assert judge["attempts"][0]["available"] is False
    assert judge["attempts"][0]["reason"]

    bad = client.get(f"/api/v1/runs/{run['id']}/conversation?source=other")
    assert bad.status_code == 400

def test_conversation_panel_is_wired_into_the_page() -> None:
    static_dir = Path(__file__).resolve().parents[1] / "src" / "aaw_skill_eval" / "static"
    app = (static_dir / "app.js").read_text(encoding="utf-8")
    # per-run conversation buttons and the replay panel
    assert 'data-conversation' in app and "conversationPanelMarkup" in app
    assert "toggleConversation" in app and "switchConversationSource" in app
    # runner/judge tabs, attempt -> turn hierarchy, lazy prompt loading
    assert "data-conv-source" in app and "conv-turn-title" in app
    assert "loadPromptInto" in app and "data-conv-prompt" in app
    # live updates while the run is active
    assert "startConversationPolling" in app
    # raw logs demoted to a diagnostics section
    assert 'id="diagnosticSection"' in app and "诊断 · 原始日志与调用记录" in app
    # masking: replay/copy/export default to masked values with an explicit opt-out
    assert "data-conv-unmasked" in app and "toggleConversationMask" in app
    assert "copyConversation" in app and "exportConversation" in app
    assert "downloadText" in app and "masked-" in app

def test_judge_missing_reason_reflects_run_status(tmp_path: Path) -> None:
    tmp_path.mkdir(parents=True, exist_ok=True)
    # no judge directory at all: a run that never finished has a precise reason
    timed_out = rebuild_conversation(tmp_path, "judge", run_status="timeout")
    assert timed_out["available"] is False
    assert timed_out["reason"] == "Runner 未完成，Judge 未执行，没有 Judge 会话记录"
    # a completed run without judge artifacts reads differently
    completed = rebuild_conversation(tmp_path, "judge", run_status="completed")
    assert "未配置 LLM 盲评或 Judge 未执行" in completed["reason"]

def test_conversation_open_expands_the_run_card() -> None:
    """R1P1: the conversation slot renders inside the run-detail container,
    which stays hidden for completed runs; opening a conversation must set
    expandedRuns so the panel is actually visible."""
    from test_acp_events import _function_body

    static_dir = Path(__file__).resolve().parents[1] / "src" / "aaw_skill_eval" / "static"
    app = (static_dir / "app.js").read_text(encoding="utf-8")
    # the helper performs the expansion ...
    helper = _function_body(app, "expandRunForConversation")
    assert "expandedRuns[runId] = true" in helper
    # ... and both conversation entry points route through it
    for name in ("toggleConversation", "openConversationAt"):
        body = _function_body(app, name)
        assert "expandRunForConversation(runId)" in body, f"{name} must expand the run card"


def test_log_polling_is_conditional_on_active_status() -> None:
    """R1P2: terminal experiments must not keep the 1s log poller running."""
    import re

    from test_acp_events import _function_body

    static_dir = Path(__file__).resolve().parents[1] / "src" / "aaw_skill_eval" / "static"
    app = (static_dir / "app.js").read_text(encoding="utf-8")
    show_detail = _function_body(app, "showDetail")
    assert re.search(r"if\s*\(\s*stillActive\s*\)\s*startLogPolling\(\)", show_detail), (
        "startLogPolling must be guarded by the active-status check"
    )
    refresh = _function_body(app, "refreshDetail")
    assert "stopLogPolling()" in refresh, (
        "refreshDetail must stop the log poller once the experiment is terminal"
    )

def test_usage_updates_advance_mid_turn_replays(tmp_path: Path) -> None:
    """R2Q1: while the agent works inside a long tool call, _chrys/usage_update
    notifications are the only wire events; the replay must keep reflecting
    them so a polled panel visibly advances instead of freezing."""
    lines = [
        {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s", "update": {
            "sessionUpdate": "tool_call", "toolCallId": "tc-1", "title": "run_command",
            "kind": "execute", "status": "in_progress", "rawInput": {"command": "slow"}}}},
        {"jsonrpc": "2.0", "method": "_chrys/usage_update", "params": {
            "inputTokens": 100, "outputTokens": 10}},
        {"jsonrpc": "2.0", "method": "_chrys/usage_update", "params": {
            "inputTokens": 150, "outputTokens": 40}},
        {"jsonrpc": "2.0", "method": "_chrys/usage_update", "params": {
            "inputTokens": 210, "outputTokens": 75}},
    ]
    _write_wire(tmp_path, "chrys-acp.jsonl", lines)

    result = rebuild_conversation(tmp_path, "runner")
    turn = result["turns"][0]
    assert turn["stop_reason"] is None
    assert turn["usage"] == {"input_tokens": 210, "output_tokens": 75}
    assert turn["items"][0]["type"] == "tool_call"
    assert turn["items"][0]["status"] == "in_progress"
    # the turn-end response still overwrites with the authoritative usage
    lines.append({"jsonrpc": "2.0", "id": 3, "result": {
        "stopReason": "end_turn", "usage": {"inputTokens": 220, "outputTokens": 80}}})
    _write_wire(tmp_path, "chrys-acp.jsonl", lines)
    finished = rebuild_conversation(tmp_path, "runner")
    assert finished["turns"][0]["usage"] == {"input_tokens": 220, "output_tokens": 80}


def test_conversation_panel_signals_active_source() -> None:
    """R2Q1 observability: the panel names the run stage and points the
    observer at the side that is actually producing events."""
    static_dir = Path(__file__).resolve().parents[1] / "src" / "aaw_skill_eval" / "static"
    app = (static_dir / "app.js").read_text(encoding="utf-8")
    assert "sourceStageInfo" in app and "RUNNER_STAGES" in app
    assert "conv-tab-dot" in app  # per-source activity dot
    assert "可切换页签查看" in app  # hint when the other side is active
    assert "本轮进行中" in app  # mid-turn marker instead of a dead-stop label
