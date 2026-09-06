from __future__ import annotations

from pathlib import Path

from ..errors import ApiError

LOG_FILES = ("server.log", "error.log", "access.log")
MAX_TAIL_BYTES = 2 * 1024 * 1024
MAX_LINES = 500


def describe_files(directory: Path) -> list[dict]:
    files = []
    for name in LOG_FILES:
        path = directory / name
        files.append(
            {
                "file": name,
                "size_bytes": path.stat().st_size if path.is_file() else 0,
                "available": path.is_file(),
            }
        )
    return files


def read_tail(
    directory: Path,
    file_name: str,
    *,
    lines: int,
    level: str | None = None,
    event: str | None = None,
    query: str | None = None,
) -> dict:
    """Return the last matching lines of a whitelisted log file.

    Only a bounded tail window is ever read, so a rotated 100MB file costs the
    same as an empty one. Line filters are substring matches against the
    ``[LEVEL]`` marker and the ``event=`` field of the text format.
    """
    if file_name not in LOG_FILES:
        raise ApiError(404, "LOG_FILE_UNKNOWN", f"未知日志文件 {file_name}")
    path = directory / file_name
    if not path.is_file():
        return {
            "file": file_name,
            "lines": [],
            "truncated": False,
            "size_bytes": 0,
            "scanned_bytes": 0,
        }
    size = path.stat().st_size
    start = max(0, size - MAX_TAIL_BYTES)
    with path.open("rb") as stream:
        stream.seek(start)
        chunk = stream.read()
    rows = chunk.decode("utf-8", errors="replace").splitlines()
    if start > 0 and rows:
        rows = rows[1:]  # the first row is likely cut in half
    if level:
        marker = f"[{level.upper()}]"
        rows = [row for row in rows if marker in row]
    if event:
        rows = [row for row in rows if f"event={event}" in row]
    if query:
        needle = query.lower()
        rows = [row for row in rows if needle in row.lower()]
    truncated = start > 0 or len(rows) > lines
    return {
        "file": file_name,
        "lines": rows[-lines:],
        "truncated": truncated,
        "size_bytes": size,
        "scanned_bytes": len(chunk),
    }
