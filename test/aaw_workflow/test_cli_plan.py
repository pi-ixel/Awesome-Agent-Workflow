"""Tests for the `aaw plan` definition-projection command."""

from __future__ import annotations

import json
import unittest

from _cli_base import CliTestBase


class PlanCliTests(CliTestBase):
    def test_plan_projects_the_dev_entry_chain(self) -> None:
        result = self.run_cli("plan", "--entry", "dev", "--json")

        data = json.loads(result.stdout)
        self.assertTrue(data["ok"])
        self.assertEqual("dev", data["entry"])
        self.assertEqual(
            ["dev-init", "dev-design", "dev-test-design", "dev-design-gate", "dev-task-split", "dev-task-dev"],
            [node["id"] for node in data["nodes"]],
        )
        self.assertEqual(
            [("dev-init", "dev-design"), ("dev-design", "dev-test-design"),
             ("dev-test-design", "dev-design-gate"), ("dev-design-gate", "dev-task-split"),
             ("dev-task-split", "dev-task-dev")],
            [(edge["from"], edge["to"]) for edge in data["edges"]],
        )

    def test_plan_marks_gates_confirmation_and_foreach(self) -> None:
        result = self.run_cli("plan", "--entry", "dev", "--json")

        data = json.loads(result.stdout)
        by_id = {node["id"]: node for node in data["nodes"]}
        self.assertTrue(by_id["dev-design-gate"]["is_gate"])
        self.assertFalse(by_id["dev-init"]["is_gate"])
        self.assertTrue(by_id["dev-task-split"]["has_data_schema"])
        split_edge = next(edge for edge in data["edges"] if edge["from"] == "dev-task-split")
        self.assertEqual("foreach", split_edge["kind"])
        self.assertEqual("must", split_edge["user_confirm"])

    def test_plan_projects_choice_branches_of_sr_entry(self) -> None:
        result = self.run_cli("plan", "--entry", "sr", "--json")

        data = json.loads(result.stdout)
        ids = [node["id"] for node in data["nodes"]]
        self.assertIn("ar-clarify", ids)
        self.assertIn("module-boundary-design", ids)
        self.assertIn("task-dev", ids)
        gate_edges = [edge for edge in data["edges"] if edge["from"] == "sr-design-gate"]
        self.assertEqual(["choice"], [edge["kind"] for edge in gate_edges])
        self.assertEqual(["ar-split"], [edge["to"] for edge in gate_edges])

    def test_plan_resolves_entry_from_an_existing_workflow(self) -> None:
        self.start_sr("SR-PLAN")

        result = self.run_cli("plan", "--sr", "SR-PLAN", "--json")

        data = json.loads(result.stdout)
        self.assertEqual("sr", data["entry"])
        self.assertEqual("sr-init", data["nodes"][0]["id"])

    def test_plan_requires_entry_or_sr(self) -> None:
        result = self.run_cli("plan", expect=1)

        self.assertIn("--entry 或 --sr", result.stderr)

    def test_plan_rejects_unknown_entry(self) -> None:
        result = self.run_cli("plan", "--entry", "nope", expect=1)

        self.assertIn("入口不存在", result.stderr)

    def test_human_output_marks_gate_and_confirmation(self) -> None:
        result = self.run_cli("plan", "--entry", "dev")

        self.assertIn("[门禁]", result.stdout)
        self.assertIn("(需确认)", result.stdout)
        self.assertIn("dev-task-dev", result.stdout)


if __name__ == "__main__":
    unittest.main()
