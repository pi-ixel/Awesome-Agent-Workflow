from __future__ import annotations

import contextvars
import json
import logging
import logging.config
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")


class JsonFormatter(logging.Formatter):
    """Stable JSON logs; request bodies, tokens and repository remotes are never included."""

    _standard = set(logging.makeLogRecord({}).__dict__) | {"message", "asctime"}
    _sensitive = {
        "authorization",
        "cookie",
        "database_url",
        "file_sha256",
        "object_key",
        "password",
        "request_body",
        "sha256",
    }

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.now(UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "event": record.getMessage(),
            "request_id": request_id_var.get(),
        }
        for key, value in record.__dict__.items():
            if (
                key not in self._standard
                and key.lower() not in self._sensitive
                and not key.startswith("_")
            ):
                payload[key] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str, separators=(",", ":"))


def _resolve_config_path(path: Path) -> Path:
    if path.is_absolute() or path.exists():
        return path
    candidate = Path(__file__).resolve().parents[2] / path
    return candidate if candidate.exists() else path


def configure_logging(
    config_file: Path,
    *,
    level: str | None = None,
    directory_override: Path | None = None,
) -> Path:
    path = _resolve_config_path(config_file)
    with path.open("r", encoding="utf-8") as stream:
        config = yaml.safe_load(stream) or {}

    configured_directory = Path(config.pop("log_directory", "logs"))
    log_directory = directory_override or configured_directory
    if not log_directory.is_absolute():
        log_directory = Path.cwd() / log_directory
    log_directory.mkdir(mode=0o750, parents=True, exist_ok=True)

    file_handlers = {"server_file", "error_file", "audit_file"}
    for name in file_handlers:
        handler = config.get("handlers", {}).get(name)
        if handler is None:
            raise ValueError(f"logging config is missing handler {name!r}")
        handler["filename"] = str(log_directory / Path(handler["filename"]).name)
        handler["lock_file_directory"] = str(log_directory)
        log_file = Path(handler["filename"])
        log_file.touch(exist_ok=True)
        if os.name != "nt":
            log_file.chmod(0o640)

    if level is not None:
        normalized = level.upper()
        config["root"]["level"] = normalized
        config["handlers"]["console"]["level"] = normalized
        config["handlers"]["server_file"]["level"] = normalized
        config["loggers"]["aaw_telemetry.audit"]["level"] = normalized

    logging.config.dictConfig(config)
    logging.captureWarnings(True)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)
    return log_directory
