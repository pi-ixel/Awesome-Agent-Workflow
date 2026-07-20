"""Tests for the global `--version` flag and the unified version source."""

from __future__ import annotations

import json
import re
import unittest

from _cli_base import ROOT, CliTestBase

from cli.version import is_newer, parse_version

VERSION_FILE = ROOT / "skills" / "aaw-workflow" / "scripts" / "cli" / "VERSION"

# Shared strict-version samples (docs/auto-update-design.md §3.2); reused by
# server-side and packaging tests to keep the rule identical everywhere.
VALID_VERSIONS = ["0.0.1", "1.2.0", "10.20.30", "1.0.0"]
INVALID_VERSIONS = ["1.2", "1.2.3.4", "01.2.3", "1.02.3", "1.2.03", "v1.2.3", "1.2.3-beta", "", "1..3", "a.b.c"]


class VersionTests(CliTestBase):
    def test_version_flag_prints_version_file(self) -> None:
        expected = VERSION_FILE.read_text("utf-8").strip()

        result = self.run_cli("--version")

        self.assertEqual(expected, result.stdout.strip())

    def test_version_declarations_are_consistent(self) -> None:
        """Guard against version drift across all five declaration sites."""
        version = VERSION_FILE.read_text("utf-8").strip()

        pyproject = (ROOT / "pyproject.toml").read_text("utf-8")
        match = re.search(r'^version\s*=\s*"([^"]+)"', pyproject, re.MULTILINE)
        assert match is not None
        self.assertEqual(version, match.group(1), "pyproject.toml version drifted")

        for relative in (".claude-plugin/plugin.json", ".codex-plugin/plugin.json"):
            data = json.loads((ROOT / relative).read_text("utf-8"))
            self.assertEqual(version, data["version"], f"{relative} version drifted")

        marketplace = json.loads((ROOT / ".claude-plugin" / "marketplace.json").read_text("utf-8"))
        self.assertEqual(version, marketplace["plugins"][0]["version"], "marketplace.json version drifted")

    def test_version_file_is_strict_three_part(self) -> None:
        self.assertIsNotNone(parse_version(VERSION_FILE.read_text("utf-8").strip()))


class UvRunSmokeTests(CliTestBase):
    """`uv run aaw.py` must resolve the PEP 723 inline metadata and run the CLI."""

    def test_uv_run_prints_version(self) -> None:
        import shutil
        import subprocess

        uv = shutil.which("uv")
        if uv is None:
            self.skipTest("uv not installed")
        expected = VERSION_FILE.read_text("utf-8").strip()
        result = subprocess.run(
            [uv, "run", str(ROOT / "skills" / "aaw-workflow" / "scripts" / "aaw.py"), "--version"],
            cwd=self.cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=300,
        )
        self.assertEqual(0, result.returncode, msg=result.stderr)
        self.assertEqual(expected, result.stdout.strip())


class ParseVersionTests(unittest.TestCase):
    def test_valid_versions_parse(self) -> None:
        for value in VALID_VERSIONS:
            self.assertIsNotNone(parse_version(value), value)

    def test_invalid_versions_rejected(self) -> None:
        for value in INVALID_VERSIONS:
            self.assertIsNone(parse_version(value), value)

    def test_parse_returns_integer_tuple(self) -> None:
        self.assertEqual((10, 20, 30), parse_version("10.20.30"))

    def test_is_newer_compares_numerically(self) -> None:
        self.assertTrue(is_newer("1.10.0", "1.9.9"))
        self.assertTrue(is_newer("2.0.0", "1.99.99"))
        self.assertFalse(is_newer("1.2.3", "1.2.3"))
        self.assertFalse(is_newer("1.2.2", "1.2.3"))

    def test_is_newer_invalid_candidate_never_wins(self) -> None:
        for value in INVALID_VERSIONS:
            self.assertFalse(is_newer(value, "0.0.0"), value)

    def test_is_newer_invalid_current_is_treated_as_lowest(self) -> None:
        self.assertTrue(is_newer("0.0.1", "corrupted"))


if __name__ == "__main__":
    unittest.main()
