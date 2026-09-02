"""Tests for the three-layer definitions loading (docs/auto-update-design.md §4.7).

Runs the copied install's aaw.py as a subprocess so the CLI self-locates the
tmp skills root and picks up install-level extensions next to it; the real
repository checkout is never touched.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from _cli_base import FIXTURE_ENDPOINT, ROOT

REAL_SKILL = ROOT / "skills" / "aaw-workflow"

EXT_FLOW = """\
entrypoints:
  ext:
    start: ext-node
    vars: [SR]
"""

EXT_NODE = """\
name: ext-node
execution: prompt
prompt:
  template: ext-node.md
"""


class DefinitionExtensionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.skills_root = root / "skills"
        self.install = self.skills_root / "aaw-workflow"
        shutil.copytree(REAL_SKILL, self.install, ignore=shutil.ignore_patterns("__pycache__"))
        self.project = root / "project"
        self.project.mkdir()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_cli(self, *args: str, expect: int = 0):
        env = {
            **os.environ,
            "PYTHONIOENCODING": "utf-8",
            "AAW_TELEMETRY_ENDPOINT": FIXTURE_ENDPOINT,
        }
        result = subprocess.run(
            [sys.executable, str(self.install / "scripts" / "aaw.py"), *args],
            cwd=self.project,
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

    def install_ext_dir(self) -> Path:
        path = self.skills_root / ".aaw-extensions" / "definitions"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def project_ext_dir(self) -> Path:
        path = self.project / ".sdd" / ".aaw" / "definitions"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _write_ext_entrypoint(self, ext: Path) -> None:
        (ext / "flow.yaml").write_text(EXT_FLOW, "utf-8")
        (ext / "ext-node.yaml").write_text(EXT_NODE, "utf-8")
        (ext / "ext-node.md").write_text("do the extension thing for {SR}", "utf-8")

    def test_install_level_extension_adds_entrypoint(self) -> None:
        self._write_ext_entrypoint(self.install_ext_dir())

        result = self.run_cli("start", "--entry", "ext", "--sr", "SR900", "--json")

        payload = json.loads(result.stdout)
        self.assertEqual("ext", payload["entry"])
        self.assertEqual("ext-node", payload["steps"][0]["type"])

    def test_project_level_extension_adds_entrypoint(self) -> None:
        self._write_ext_entrypoint(self.project_ext_dir())

        result = self.run_cli("start", "--entry", "ext", "--sr", "SR900", "--json")

        self.assertEqual("ext", json.loads(result.stdout)["entry"])

    def test_extension_prompt_template_resolves_within_its_own_layer(self) -> None:
        self._write_ext_entrypoint(self.install_ext_dir())
        self.run_cli("start", "--entry", "ext", "--sr", "SR900", "--json")

        result = self.run_cli("next", "--sr", "SR900", "--json")

        payload = json.loads(result.stdout)
        prompt = payload["ready"][0]["prompt"]
        self.assertIn("do the extension thing", prompt)

    def test_same_node_name_conflict_reports_both_sources(self) -> None:
        ext = self.install_ext_dir()
        (ext / "sr-init.yaml").write_text("name: sr-init\nexecution: noop\n", "utf-8")

        result = self.run_cli("start", "--sr", "SR900", "--json", expect=1)

        self.assertIn("冲突", result.stderr)
        self.assertIn("sr-init", result.stderr)
        # both the built-in and the extension paths are reported
        self.assertIn(str(ext / "sr-init.yaml"), result.stderr)
        self.assertIn("definitions", result.stderr)

    def test_same_entrypoint_conflict_rejected(self) -> None:
        ext = self.install_ext_dir()
        (ext / "flow.yaml").write_text("entrypoints:\n  sr:\n    start: sr-init\n", "utf-8")

        result = self.run_cli("start", "--sr", "SR900", "--json", expect=1)

        self.assertIn("冲突", result.stderr)
        self.assertIn("entrypoint sr", result.stderr)

    def test_extension_skill_reference_must_exist(self) -> None:
        ext = self.install_ext_dir()
        (ext / "flow.yaml").write_text(EXT_FLOW, "utf-8")
        (ext / "ext-node.yaml").write_text(
            "name: ext-node\nexecution: skill\nskill: [no-such-skill]\n", "utf-8"
        )

        result = self.run_cli("start", "--entry", "ext", "--sr", "SR900", "--json", expect=1)

        self.assertIn("no-such-skill", result.stderr)

    def test_extension_skill_reference_accepts_installed_skill(self) -> None:
        (self.skills_root / "my-skill").mkdir()
        (self.skills_root / "my-skill" / "SKILL.md").write_text("# my-skill", "utf-8")
        ext = self.install_ext_dir()
        (ext / "flow.yaml").write_text(EXT_FLOW, "utf-8")
        (ext / "ext-node.yaml").write_text(
            "name: ext-node\nexecution: skill\nskill: [my-skill]\n", "utf-8"
        )

        result = self.run_cli("start", "--entry", "ext", "--sr", "SR900", "--json")

        self.assertEqual("ext-node", json.loads(result.stdout)["steps"][0]["type"])


if __name__ == "__main__":
    unittest.main()
