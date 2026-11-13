#!/usr/bin/env python3
"""Validate Mermaid sources with the compiler bundled in this skill."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


SKILL_DIR = Path(__file__).resolve().parents[1]
RUNNER = Path(__file__).with_name("offline_mermaid_check.cjs")
BUNDLE = SKILL_DIR / "vendor" / "mermaid" / "mermaid.min.js"
BUNDLE_SHA256 = "8d8e0eec56d3a83b4b3c87f42050845546dee93ebe1875d2117c12e6947c0cb3"
FENCE_START = re.compile(r"^[ \t]*(`{3,}|~{3,})[ \t]*mermaid(?:[ \t].*)?$", re.IGNORECASE)


def extract_markdown(path: Path) -> tuple[list[tuple[str, str]], list[str]]:
    diagrams: list[tuple[str, str]] = []
    errors: list[str] = []
    opener: tuple[str, int, int] | None = None
    content: list[str] = []

    for line_number, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        if opener is None:
            match = FENCE_START.match(line)
            if match:
                fence = match.group(1)
                opener = (fence[0], len(fence), line_number)
                content = []
            continue

        marker, width, start_line = opener
        if re.match(rf"^[ \t]*{re.escape(marker)}{{{width},}}[ \t]*$", line):
            diagrams.append((f"{path}:{start_line}", "\n".join(content).strip() + "\n"))
            opener = None
            content = []
        else:
            content.append(line)

    if opener is not None:
        errors.append(f"{path}:{opener[2]}: unclosed Mermaid fence")
    return diagrams, errors


def collect(paths: list[Path]) -> tuple[list[tuple[str, str]], list[str]]:
    diagrams: list[tuple[str, str]] = []
    errors: list[str] = []
    for path in paths:
        if not path.is_file():
            errors.append(f"{path}: not a file")
        elif path.suffix.lower() in {".mmd", ".mermaid"}:
            diagrams.append((str(path), path.read_text(encoding="utf-8-sig")))
        elif path.suffix.lower() in {".md", ".markdown"}:
            found, found_errors = extract_markdown(path)
            diagrams.extend(found)
            errors.extend(found_errors)
            if not found and not found_errors:
                print(f"[SKIP] {path}: no Mermaid blocks")
        else:
            errors.append(f"{path}: expected .mmd, .mermaid, .md, or .markdown")
    return diagrams, errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate Mermaid files and Markdown blocks entirely offline."
    )
    parser.add_argument("paths", nargs="+", type=Path, help="Mermaid or Markdown files")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    diagrams, errors = collect(args.paths)
    for error in errors:
        print(f"[FAIL] {error}", file=sys.stderr)
    if errors:
        return 1
    if not diagrams:
        print("[FAIL] no Mermaid diagrams found", file=sys.stderr)
        return 2

    node = shutil.which("node")
    if node is None:
        print("[FAIL] local Node.js runtime unavailable; offline validation cannot run", file=sys.stderr)
        return 2
    if not RUNNER.is_file() or not BUNDLE.is_file():
        print("[FAIL] bundled Mermaid validator is incomplete", file=sys.stderr)
        return 2
    if hashlib.sha256(BUNDLE.read_bytes()).hexdigest() != BUNDLE_SHA256:
        print("[FAIL] bundled Mermaid validator failed its integrity check", file=sys.stderr)
        return 2

    payload = json.dumps(
        {"diagrams": [source for _, source in diagrams]},
        ensure_ascii=False,
    )
    try:
        environment = os.environ.copy()
        for name in (
            "NODE_OPTIONS",
            "NODE_PATH",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ):
            environment.pop(name, None)
        environment["NO_PROXY"] = "*"
        environment["no_proxy"] = "*"
        result = subprocess.run(
            [node, str(RUNNER)],
            input=payload,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            env=environment,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        print(f"[FAIL] cannot run bundled Mermaid validator: {error}", file=sys.stderr)
        return 2

    try:
        report = json.loads(result.stdout)
    except (json.JSONDecodeError, TypeError):
        detail = (result.stderr or result.stdout or "no validator output").strip()
        print(f"[FAIL] bundled Mermaid validator failed\n{detail}", file=sys.stderr)
        return 2

    outcomes = report.get("results", []) if isinstance(report, dict) else []
    if result.returncode not in {0, 1} or len(outcomes) != len(diagrams):
        print("[FAIL] bundled Mermaid validator returned an invalid report", file=sys.stderr)
        return 2

    failures = 0
    for (label, _), outcome in zip(diagrams, outcomes):
        if outcome.get("ok") is True:
            print(f"[OK] {label}")
        else:
            failures += 1
            print(f"[FAIL] {label}\n{outcome.get('error', 'parse failed')}", file=sys.stderr)

    if failures:
        print(f"{failures} of {len(diagrams)} diagram(s) failed", file=sys.stderr)
        return 1
    print(f"validated {len(diagrams)} diagram(s) offline")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
