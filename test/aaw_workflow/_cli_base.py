"""Shared helpers for CLI-level tests of skills/aaw-workflow/scripts/cli.

Each test_cli_*.py file covers one CLI command; this module provides the
subprocess runner and workflow-advancing helpers they share.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
AAW_SCRIPT = ROOT / "skills" / "aaw-workflow" / "scripts" / "aaw.py"
SCRIPTS_DIR = AAW_SCRIPT.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


class CliTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.cwd = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_cli(self, *args: str, expect: int = 0) -> subprocess.CompletedProcess:
        env = {
            **os.environ,
            "PYTHONIOENCODING": "utf-8",
            # Hermetic: never reach the real telemetry endpoint.
            "AAW_TELEMETRY_ENDPOINT": "http://127.0.0.1:1",
        }
        result = subprocess.run(
            [sys.executable, str(AAW_SCRIPT), *args],
            cwd=self.cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            env=env,
        )
        self.assertEqual(
            expect,
            result.returncode,
            msg=f"argv={args!r}\nstdout={result.stdout!r}\nstderr={result.stderr!r}",
        )
        return result

    def start_sr(self, sr: str) -> dict:
        result = self.run_cli("start", "--entry", "sr", "--sr", sr, "--json")
        return json.loads(result.stdout)

    def user_confirm(self, sr: str) -> dict:
        return json.loads(self.run_cli("user-confirm", "--sr", sr, "--json").stdout)

    def complete_step_1(self, sr: str) -> dict:
        """step 1 (sr-init) is a skill step: needs `next` first plus its output file.

        The sr-init -> sr-design edge is `user_confirm: must`, so the successor is
        released via auto user-confirm; `generated`/`next` in the returned done
        payload are updated from the confirm result.
        """
        self.run_cli("next", "--sr", sr, "--json")
        (self.cwd / ".sdd" / "software_architecture.md").write_text("architecture", "utf-8")
        result = json.loads(self.run_cli("done", "--sr", sr, "1", "--json").stdout)
        if result.get("state") == "awaiting_user_confirm":
            confirm = self.user_confirm(sr)
            result["generated"] = confirm["generated"]
            result["next"] = confirm["next"]
        return result

    def advance_to_step_3(self, sr: str) -> None:
        """Finish steps 1-2 so step 3 (ar-split, requires --data) is ready.

        The final `next` marks step 3 started — prompt steps also require an
        actual start timestamp before `done` now.
        """
        self.start_sr(sr)
        self.complete_step_1(sr)
        (self.cwd / ".sdd" / sr / "SR-design.md").write_text("sr design", "utf-8")
        self.run_cli("next", "--sr", sr, "--json")
        self.run_cli("done", "--sr", sr, "2", "--json")
        self.user_confirm(sr)
        self.run_cli("next", "--sr", sr, "--json")

    def status_json(self, sr: str) -> dict:
        return json.loads(self.run_cli("status", "--sr", sr, "--json").stdout)
