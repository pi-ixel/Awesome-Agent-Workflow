from __future__ import annotations

import sys
import threading
from pathlib import Path

from aaw_skill_eval.services.observability.logs import LogWriter, display_record, read_log_index
from aaw_skill_eval.services.providers.protocols.jsonl import execute_streaming


def test_streaming_records_invocation_and_output_before_newline(tmp_path: Path) -> None:
    logs = LogWriter(tmp_path / "logs", scope="run", attempt=1)
    first_chunk = threading.Event()
    result = {}

    def on_log(source: str, channel: str, text: str) -> None:
        logs.write(source, channel, text)
        if channel == "stdout" and "first" in text:
            first_chunk.set()

    def execute() -> None:
        result["value"] = execute_streaming(
            [
                sys.executable,
                "-u",
                "-c",
                "import sys,time;sys.stdout.write('first');sys.stdout.flush();"
                "time.sleep(1.5);sys.stdout.write(' last')",
            ],
            prompt="api_key=test-secret",
            cwd=tmp_path,
            env={},
            timeout_seconds=10,
            stdout_path=tmp_path / "agent.stdout.txt",
            stderr_path=tmp_path / "agent.stderr.txt",
            on_progress=None,
            on_log=on_log,
            log_source="runner",
            is_cancelled=None,
        )

    thread = threading.Thread(target=execute)
    thread.start()
    assert first_chunk.wait(1), "stdout should arrive before the process exits or writes a newline"
    assert thread.is_alive()
    thread.join(timeout=5)
    assert not thread.is_alive()
    assert result["value"][:3] == (0, "first last", "")

    records = read_log_index(logs.path, cursor=None)["records"]
    invocations = [
        display_record(record, mode="raw", unmasked=False)["details"]
        for record in records
        if record["channel"] == "invocation"
    ]
    assert [item["phase"] for item in invocations] == ["start", "end"]
    assert invocations[0]["pid"] > 0
    assert invocations[1]["exit_code"] == 0
    assert invocations[1]["stdout_bytes"] == len("first last")
    assert invocations[0]["cwd"] == str(tmp_path)
    prompt_file = tmp_path / invocations[0]["prompt_file"]
    assert prompt_file.read_text(encoding="utf-8") == "api_key=test-secret"


def test_file_based_agent_prompt_is_snapshotted(tmp_path: Path) -> None:
    judge_dir = tmp_path / "judge"
    result = execute_streaming(
        [sys.executable, "-c", "print('done')"],
        prompt=None,
        prompt_snapshot="Judge task with password=hush",
        cwd=tmp_path,
        env={},
        timeout_seconds=10,
        stdout_path=judge_dir / "agent.stdout.txt",
        stderr_path=judge_dir / "agent.stderr.txt",
        on_progress=None,
        on_log=None,
        log_source="judge",
        is_cancelled=None,
    )
    assert result[0] == 0
    assert [path.read_text(encoding="utf-8") for path in (judge_dir / "invocations").iterdir()] == [
        "Judge task with password=hush"
    ]


def test_diagnostic_redaction_handles_environment_style_secrets() -> None:
    record = {"text": 'OPENAI_API_KEY="top-secret" AWS_SECRET_ACCESS_KEY=private Bearer abc123'}
    text = display_record(record, mode="raw", unmasked=False)["text"]
    assert "top-secret" not in text
    assert "private" not in text
    assert "abc123" not in text
