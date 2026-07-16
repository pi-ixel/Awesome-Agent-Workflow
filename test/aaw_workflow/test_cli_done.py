"""Tests for the `aaw done` command."""

from __future__ import annotations

import unittest

from _cli_base import CliTestBase


class DoneCliTests(CliTestBase):
    def test_data_and_data_file_are_mutually_exclusive(self) -> None:
        self.start_sr("SR-CONFLICT")

        result = self.run_cli(
            "done", "--sr", "SR-CONFLICT", "1",
            "--data", "{}", "--data-file", "whatever.json",
            expect=1,
        )

        self.assertIn("--data 和 --data-file 不能同时使用", result.stderr)

    def test_unreadable_data_file_exits_with_error(self) -> None:
        self.start_sr("SR-NOFILE")

        result = self.run_cli(
            "done", "--sr", "SR-NOFILE", "1", "--data-file", "missing.json", expect=1
        )

        self.assertIn("--data-file 读取失败", result.stderr)

    def test_nonexistent_step_exits_with_error(self) -> None:
        self.start_sr("SR-NOSTEP")

        result = self.run_cli("done", "--sr", "SR-NOSTEP", "99", expect=1)

        self.assertIn("step 99 does not exist", result.stderr)

    def test_skill_step_requires_next_before_done(self) -> None:
        self.start_sr("SR-NONEXT")
        (self.cwd / ".sdd" / "software_architecture.md").write_text("architecture", "utf-8")

        result = self.run_cli("done", "--sr", "SR-NONEXT", "1", expect=1)

        self.assertIn("has no actual start timestamp", result.stderr)

    def test_done_twice_exits_with_error(self) -> None:
        self.start_sr("SR-TWICE")
        self.complete_step_1("SR-TWICE")

        result = self.run_cli("done", "--sr", "SR-TWICE", "1", expect=1)

        self.assertIn("已完成", result.stderr)

    def test_invalid_json_data_exits_with_error(self) -> None:
        self.advance_to_step_3("SR-BADJSON")

        result = self.run_cli("done", "--sr", "SR-BADJSON", "3", "--data", "not json", expect=1)

        self.assertIn("--data JSON 解析失败", result.stderr)

    def test_non_object_json_data_exits_with_error(self) -> None:
        self.advance_to_step_3("SR-ARRAY")

        result = self.run_cli("done", "--sr", "SR-ARRAY", "3", "--data", "[1, 2]", expect=1)

        self.assertIn("--data 必须是 JSON object", result.stderr)

    def test_data_error_does_not_mutate_workflow(self) -> None:
        self.advance_to_step_3("SR-INTACT")

        self.run_cli("done", "--sr", "SR-INTACT", "3", "--data", "not json", expect=1)

        data = self.status_json("SR-INTACT")
        step3 = data["steps"][2]
        self.assertFalse(step3["finished"])
        self.assertEqual([], step3["next"])
        self.assertEqual(3, len(data["steps"]))

    def test_telemetry_failure_is_nonfatal_and_reported(self) -> None:
        self.start_sr("SR-TELEM")

        result = self.complete_step_1("SR-TELEM")

        self.assertTrue(result["ok"])
        self.assertEqual(1, result["generated"])
        self.assertEqual("failed", result["telemetry"]["status"])
        self.assertTrue(result["telemetry"]["error"])

    def test_human_output_reports_confirm_flow_and_generated_successors(self) -> None:
        self.start_sr("SR-DONEOUT")
        self.run_cli("next", "--sr", "SR-DONEOUT", "--json")
        (self.cwd / ".sdd" / "software_architecture.md").write_text("architecture", "utf-8")

        done_result = self.run_cli("done", "--sr", "SR-DONEOUT", "1")
        self.assertIn("step 1 已完成", done_result.stdout)
        self.assertIn("等待用户确认", done_result.stdout)
        self.assertIn("user-confirm", done_result.stdout)

        confirm_result = self.run_cli("user-confirm", "--sr", "SR-DONEOUT")
        self.assertIn("用户已确认", confirm_result.stdout)
        self.assertIn("生成 1 个后继 step", confirm_result.stdout)


if __name__ == "__main__":
    unittest.main()
