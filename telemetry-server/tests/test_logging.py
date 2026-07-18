from __future__ import annotations

import json
import logging
from pathlib import Path

from conftest import DIFF, message, sync, upload_diff

from aaw_telemetry.logging import configure_logging


def _events(path: Path) -> list[dict]:
    for handler in logging.getLogger().handlers:
        handler.flush()
    for handler in logging.getLogger("aaw_telemetry.audit").handlers:
        handler.flush()
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def test_structured_message_logs_are_traceable_without_identity_or_hash(client):
    payload = message()
    response = sync(client, payload)

    log_directory = client.app.state.log_directory
    audit_events = _events(log_directory / "audit.log")
    processed = [row for row in audit_events if row["event"] == "telemetry.message_processed"][0]

    assert processed["message_id"] == payload["message_id"]
    assert processed["workflow_id"] == payload["workflow_id"]
    assert processed["request_id"] == response.headers["X-Request-ID"]
    rendered = (log_directory / "audit.log").read_text(encoding="utf-8")
    assert payload["user_email"] not in rendered
    assert payload["data"]["file"]["sha256"] not in rendered


def test_upload_logs_only_safe_metadata(client):
    payload = message()
    sync(client, payload)
    upload_diff(client, payload)

    log_directory = client.app.state.log_directory
    audit_events = _events(log_directory / "audit.log")
    events = {row["event"] for row in audit_events}

    assert "objects.upload_confirmed" in events
    rendered = (log_directory / "audit.log").read_text(encoding="utf-8")
    assert payload["data"]["file"]["sha256"] not in rendered
    assert DIFF.decode() not in rendered


def test_request_and_error_logs_are_written_to_separate_files(client):
    assert (client.app.state.log_directory / "error.log").is_file()
    response = client.get("/health/live")
    logging.getLogger("aaw_telemetry.test").error(
        "test.expected_error",
        extra={"error_code": "EXPECTED", "password": "must-not-be-logged"},
    )

    log_directory = client.app.state.log_directory
    server_events = _events(log_directory / "server.log")
    error_events = _events(log_directory / "error.log")

    request = [row for row in server_events if row["event"] == "http.request_completed"][-1]
    error = [row for row in error_events if row["event"] == "test.expected_error"][-1]
    assert request["request_id"] == response.headers["X-Request-ID"]
    assert request["status_code"] == 200
    assert error["error_code"] == "EXPECTED"
    assert "password" not in error
    assert "must-not-be-logged" not in (log_directory / "error.log").read_text(encoding="utf-8")


def test_server_log_rotates_to_gzip(tmp_path):
    log_directory = configure_logging(
        Path("config/logging.yaml"),
        level="INFO",
        directory_override=tmp_path / "rotating-logs",
    )
    handler = next(
        item for item in logging.getLogger().handlers if item.name == "server_file"
    )
    handler.clh.maxBytes = 512
    handler.backupCount = 3

    logger = logging.getLogger("aaw_telemetry.rotation_test")
    for index in range(40):
        logger.info("rotation.test", extra={"index": index, "padding": "x" * 80})
    handler.flush()

    assert (log_directory / "server.log").is_file()
    assert list(log_directory.glob("server.log*.gz"))
