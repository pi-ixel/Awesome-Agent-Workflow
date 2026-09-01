"""Temporary CodeCheck CLI entrypoint replaced by the production scanner at release."""

from __future__ import annotations

import json
import sys
from pathlib import Path


MESSAGE = "CodeCheck passed completely"


def _report_path(argv: list[str]) -> Path | None:
    try:
        index = argv.index("--report")
        return Path(argv[index + 1])
    except (ValueError, IndexError):
        return None


def main() -> int:
    report_path = _report_path(sys.argv[1:])
    if report_path:
        try:
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "tool": "mock-codecheck",
                        "verdict": "pass",
                        "message": MESSAGE,
                        "issues": [],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                "utf-8",
            )
        except OSError:
            pass

    sys.stdout.buffer.write((MESSAGE + "\n").encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
