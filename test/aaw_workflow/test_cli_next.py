"""Tests for the `aaw next` command."""

from __future__ import annotations

import json
import unittest
from unittest.mock import MagicMock, patch

from _cli_base import CliTestBase
from cli import main as cli_main


class NextCliTests(CliTestBase):
    def test_missing_sr_exits_with_error(self) -> None:
        result = self.run_cli("next", "--sr", "SR-NOPE", expect=1)

        self.assertIn("SR SR-NOPE 不存在", result.stderr)

    def test_marks_ready_skill_step_as_running(self) -> None:
        self.start_sr("SR-RUN")

        payload = json.loads(self.run_cli("next", "--sr", "SR-RUN", "--json").stdout)

        self.assertFalse(payload["done"])
        self.assertEqual([1], [s["id"] for s in payload["ready"]])
        step = self.status_json("SR-RUN")["steps"][0]
        self.assertEqual("running", step["execution_status"])
        self.assertEqual(1, step["attempt"])
        self.assertIsNotNone(step["started_at"])
        self.assertEqual(1, len(payload["telemetry"]))
        telemetry = payload["telemetry"][0]
        self.assertEqual(1, telemetry["step_id"])
        self.assertEqual("sr-init", telemetry["step_type"])
        self.assertEqual(1, telemetry["attempt"])
        self.assertEqual("failed", telemetry["status"])
        self.assertTrue(telemetry["error"])

    def test_json_reports_each_start_telemetry_result(self) -> None:
        workflow = MagicMock(sr="SR-MULTI")
        first_step = MagicMock(
            id=1,
            type="sr-init",
            execution="skill",
            execution_status="ready",
            attempt=0,
        )
        second_step = MagicMock(
            id=2,
            type="sr-design",
            execution="prompt",
            execution_status="running",
            attempt=2,
        )
        manager = MagicMock()
        manager.load.return_value = workflow
        manager.get_ready.return_value = [first_step, second_step]
        manager.mark_started.side_effect = [first_step, second_step]
        manager.build_next_payload.return_value = {
            "sr": "SR-MULTI",
            "ready": [],
            "done": False,
        }
        store = MagicMock()
        store.step_message.side_effect = [
            {"message_id": "message-1"},
            {"message_id": "message-2"},
        ]

        with (
            patch.object(cli_main, "_get_manager", return_value=manager),
            patch.object(cli_main, "_get_telemetry", return_value=store),
            patch.object(cli_main, "_echo_json") as echo_json,
            patch.object(
                cli_main.TelemetryClient,
                "send",
                side_effect=[
                    {"message_id": "message-1", "status": "accepted", "uploaded": 0},
                    {"message_id": "message-2", "status": "duplicate", "uploaded": 0},
                ],
            ),
        ):
            cli_main.next("SR-MULTI", use_json=True)

        payload = echo_json.call_args.args[0]
        self.assertEqual(
            [
                {
                    "step_id": 1,
                    "step_type": "sr-init",
                    "attempt": 1,
                    "message_id": "message-1",
                    "status": "accepted",
                    "uploaded": 0,
                },
                {
                    "step_id": 2,
                    "step_type": "sr-design",
                    "attempt": 2,
                    "message_id": "message-2",
                    "status": "duplicate",
                    "uploaded": 0,
                },
            ],
            payload["telemetry"],
        )

    def test_repeated_next_is_idempotent_for_running_step(self) -> None:
        self.start_sr("SR-IDEM")
        self.run_cli("next", "--sr", "SR-IDEM", "--json")
        started_at = self.status_json("SR-IDEM")["steps"][0]["started_at"]

        self.run_cli("next", "--sr", "SR-IDEM", "--json")

        step = self.status_json("SR-IDEM")["steps"][0]
        self.assertEqual(1, step["attempt"])
        self.assertEqual(started_at, step["started_at"])

    def test_human_output_lists_ready_work_orders(self) -> None:
        self.start_sr("SR-READY")

        result = self.run_cli("next", "--sr", "SR-READY")

        self.assertIn("就绪工作单:", result.stdout)
        self.assertIn("[1]", result.stdout)
        self.assertIn("skill: repo-init", result.stdout)
        self.assertIn("telemetry: failed", result.stdout)
        self.assertIn("done:", result.stdout)

    def test_human_output_delegates_existing_deliverable_handling(self) -> None:
        self.start_sr("SR-EXISTING")
        architecture = self.cwd / ".sdd" / "software_architecture.md"
        architecture.write_text("existing draft", "utf-8")

        result = self.run_cli("next", "--sr", "SR-EXISTING")

        self.assertIn("交付件已存在", result.stdout)
        self.assertIn("按当前工作单的复用检查处理", result.stdout)
        self.assertNotIn("仍需完整执行当前工作单", result.stdout)
        self.assertNotIn("可直接执行 done", result.stdout)

    def _sr_design_order(self, sr: str) -> dict:
        payload = json.loads(self.run_cli("next", "--sr", sr, "--json").stdout)
        for order in payload["ready"]:
            if order["type"] == "sr-design":
                return order
        self.fail(f"no sr-design work order in ready: {payload['ready']!r}")

    def test_sr_design_work_order_requires_original_requirement(self) -> None:
        self.start_sr("SR-DESIGN")
        self.complete_step_1("SR-DESIGN")

        order = self._sr_design_order("SR-DESIGN")

        req_path = ".sdd/SR-DESIGN/original-requirement.md"
        self.assertIn(req_path, order["inputs"]["required"])
        self.assertTrue(order["inputs"]["all_required_exist"])

    def test_sr_design_blocked_when_requirement_deleted(self) -> None:
        self.start_sr("SR-DESIGN2")
        self.complete_step_1("SR-DESIGN2")
        req_path = ".sdd/SR-DESIGN2/original-requirement.md"
        (self.cwd / ".sdd" / "SR-DESIGN2" / "original-requirement.md").unlink()

        order = self._sr_design_order("SR-DESIGN2")

        self.assertTrue(order["inputs"]["blocked"])
        self.assertIn(req_path, order["inputs"]["missing_required"])

        result = self.run_cli("done", "--sr", "SR-DESIGN2", str(order["id"]), expect=1)
        self.assertIn("required input", result.stderr)

    def test_next_does_not_write_session_marker(self) -> None:
        """question-tracker 2.0 起不再消费 .current_session；next 不得生成该文件。"""
        self.start_sr("SR-NOMARK-NEXT")

        self.run_cli("next", "--sr", "SR-NOMARK-NEXT")

        self.assertFalse((self.cwd / ".sdd" / ".current_session").exists())


if __name__ == "__main__":
    unittest.main()
