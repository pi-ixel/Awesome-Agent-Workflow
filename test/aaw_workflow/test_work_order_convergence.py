"""Tests for the phase-4 work-order and protocol convergence.

A work order carries only what the agent needs to execute the step; scheduling
state, routing rules and template variables stay on the CLI side.  ``next``
gains a read-only ``--peek`` mode, and every ``--json`` response carries ``ok``.
"""

from __future__ import annotations

import json
import unittest

from _cli_base import CliTestBase


class WorkOrderConvergenceTests(CliTestBase):
    def _next(self, sr: str, *extra: str) -> dict:
        result = self.run_cli("next", "--sr", sr, "--json", *extra)
        return json.loads(result.stdout)

    def test_work_order_has_no_scheduling_state(self) -> None:
        self.start_sr("SR-WO")
        order = self._next("SR-WO")["ready"][0]

        for field in ("session", "execution_status", "attempt", "started_at",
                      "available_next", "user_confirm", "vars", "depends_on",
                      "deliverables_exist"):
            self.assertNotIn(field, order)

    def test_commands_is_only_done_argv(self) -> None:
        self.start_sr("SR-CMD")
        order = self._next("SR-CMD")["ready"][0]

        self.assertEqual(list(order["commands"].keys()), ["done_argv"])

    def test_multiple_ready_steps_still_advance(self) -> None:
        """Slimming the work order must not change how a fan-out advances."""
        self.start_sr("SR-FAN")
        self.run_cli("next", "--sr", "SR-FAN", "--json")
        (self.cwd / ".sdd" / "software_architecture.md").write_text("a", "utf-8")
        self.run_cli("done", "--sr", "SR-FAN", "1", "--json")
        (self.cwd / ".sdd" / "SR-FAN" / "SR-design.md").write_text("d", "utf-8")
        self.run_cli("next", "--sr", "SR-FAN", "--json")
        self.run_cli("done", "--sr", "SR-FAN", "2", "--json")

        # step 3 (sr-design-gate) is ready and its work order is present.
        payload = self._next("SR-FAN")
        self.assertTrue(payload["ready"])


class OkSemanticTests(CliTestBase):
    def test_status_has_ok(self) -> None:
        self.start_sr("SR-OK")
        payload = self.status_json("SR-OK")
        self.assertTrue(payload["ok"])

    def test_status_listing_has_ok(self) -> None:
        self.start_sr("SR-OK2")
        payload = json.loads(self.run_cli("status", "--json").stdout)
        self.assertTrue(payload["ok"])

    def test_next_has_ok(self) -> None:
        self.start_sr("SR-OK3")
        payload = json.loads(self.run_cli("next", "--sr", "SR-OK3", "--json").stdout)
        self.assertTrue(payload["ok"])


class PeekModeTests(CliTestBase):
    def test_peek_does_not_mark_started(self) -> None:
        self.start_sr("SR-PEEK")

        before = (self.cwd / ".sdd" / "SR-PEEK" / "workflow.yaml").read_text("utf-8")
        payload = json.loads(
            self.run_cli("next", "--sr", "SR-PEEK", "--peek", "--json").stdout
        )
        after = (self.cwd / ".sdd" / "SR-PEEK" / "workflow.yaml").read_text("utf-8")

        self.assertTrue(payload["ok"])
        # The ready step is reported but not claimed.
        self.assertEqual("sr-init", payload["ready"][0]["type"])
        self.assertEqual(before, after, "peek must not write the state file")

    def test_peek_reports_no_telemetry(self) -> None:
        self.start_sr("SR-PEEK2")

        payload = json.loads(
            self.run_cli("next", "--sr", "SR-PEEK2", "--peek", "--json").stdout
        )

        self.assertEqual([], payload["telemetry"])

    def test_normal_next_claims_but_peek_does_not(self) -> None:
        self.start_sr("SR-PEEK3")
        self.run_cli("next", "--sr", "SR-PEEK3", "--json")

        data = self.status_json("SR-PEEK3")
        step = data["steps"][0]
        self.assertEqual("running", step["execution_status"])

        # re-peek a claimed step: state unchanged
        before = (self.cwd / ".sdd" / "SR-PEEK3" / "workflow.yaml").read_text("utf-8")
        self.run_cli("next", "--sr", "SR-PEEK3", "--peek", "--json")
        after = (self.cwd / ".sdd" / "SR-PEEK3" / "workflow.yaml").read_text("utf-8")
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
