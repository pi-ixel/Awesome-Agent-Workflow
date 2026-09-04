"""Tests for the `aaw status` command."""

from __future__ import annotations

import json
import unittest

from _cli_base import CliTestBase


class StatusCliTests(CliTestBase):
    def test_missing_sr_exits_with_error(self) -> None:
        result = self.run_cli("status", "--sr", "SR-NOPE", expect=1)

        self.assertIn("SR SR-NOPE 不存在", result.stderr)

    def test_detail_json_contains_step_states(self) -> None:
        self.start_sr("SR-DETAIL")

        data = self.status_json("SR-DETAIL")

        self.assertEqual("SR-DETAIL", data["sr"])
        self.assertEqual("sr", data["entry"])
        self.assertEqual("SR-DETAIL", data["vars"]["SR"])
        step = data["steps"][0]
        self.assertEqual(1, step["id"])
        self.assertEqual("sr-init", step["type"])
        self.assertFalse(step["finished"])
        self.assertEqual("ready", step["execution_status"])
        self.assertIsNone(step["started_at"])

    def test_listing_json_returns_sorted_srs(self) -> None:
        self.start_sr("SR-B")
        self.start_sr("SR-A")

        data = json.loads(self.run_cli("status", "--json").stdout)

        self.assertEqual(["SR-A", "SR-B"], data["srs"])

    def test_listing_ignores_directories_without_workflow(self) -> None:
        self.start_sr("SR-REAL")
        (self.cwd / ".sdd" / "not-a-workflow").mkdir()

        data = json.loads(self.run_cli("status", "--json").stdout)

        self.assertEqual(["SR-REAL"], data["srs"])

    def test_human_listing_shows_progress(self) -> None:
        self.start_sr("SR-LIST")

        result = self.run_cli("status")

        self.assertIn("SR 列表:", result.stdout)
        self.assertIn("SR-LIST", result.stdout)
        self.assertIn("[0/1]", result.stdout)

    def test_human_output_without_srs(self) -> None:
        result = self.run_cli("status")

        self.assertIn("暂无 SR", result.stdout)


if __name__ == "__main__":
    unittest.main()
