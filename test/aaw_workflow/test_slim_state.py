"""Tests for the slim workflow.yaml state schema.

The state file records what runtime produced; everything a node template owns
is rehydrated on load.  These tests pin that contract from both directions:
new files stay slim, and older fat files still load and behave identically.
"""

from __future__ import annotations

import json
import unittest

import yaml

from _cli_base import CliTestBase


# Fields a node template owns.  They must never reach the state file again.
TEMPLATE_OWNED = ("name", "execution", "session", "skill", "prompt",
                  "data_prompt", "input", "available_next")


class SlimStateTests(CliTestBase):
    def _workflow_yaml(self, sr: str) -> dict:
        path = self.cwd / ".sdd" / sr / "workflow.yaml"
        return yaml.safe_load(path.read_text("utf-8"))

    def test_new_state_file_omits_template_owned_fields(self) -> None:
        self.start_sr("SR-SLIM")

        step = self._workflow_yaml("SR-SLIM")["steps"][0]

        for field in TEMPLATE_OWNED:
            self.assertNotIn(field, step, f"{field} must be derived, not persisted")

    def test_state_file_keeps_runtime_facts(self) -> None:
        self.start_sr("SR-KEEP")
        self.complete_step_1("SR-KEEP")

        step = self._workflow_yaml("SR-KEEP")["steps"][0]

        self.assertEqual(1, step["id"])
        self.assertEqual("sr-init", step["type"])
        self.assertTrue(step["finished"])
        self.assertEqual("completed", step["execution_status"])
        self.assertTrue(step["started_at"])
        self.assertTrue(step["ended_at"])

    def test_dead_fields_are_gone(self) -> None:
        """`control` was never assigned and `transition_history` never read."""
        self.start_sr("SR-DEAD")
        self.complete_step_1("SR-DEAD")

        data = self._workflow_yaml("SR-DEAD")

        self.assertNotIn("control", data)
        self.assertNotIn("transition_history", data)

    def test_work_order_still_exposes_derived_fields(self) -> None:
        """Slimming the file must not slim what the agent receives."""
        self.start_sr("SR-HYDRATE")

        payload = json.loads(self.run_cli("next", "--sr", "SR-HYDRATE", "--json").stdout)
        ready = payload["ready"][0]

        self.assertEqual("sr-init", ready["type"])
        self.assertTrue(ready["name"])
        self.assertTrue(ready["skill"] or ready["prompt"])
        self.assertTrue(ready["output"])

    def test_foreach_runtime_vars_survive_reload(self) -> None:
        """`vars` carries values that came from --data and cannot be re-derived."""
        self.advance_to_ar_split("SR-VARS")
        self.run_cli(
            "done", "--sr", "SR-VARS", "4",
            "--data", json.dumps({"ars": [
                {"id": "AR-001", "title": "用户管理"},
                {"id": "AR-002", "title": "权限"},
            ]}, ensure_ascii=False),
            "--json",
        )

        clarify_vars = [
            s.get("vars", {})
            for s in self._workflow_yaml("SR-VARS")["steps"]
            if s["type"] == "ar-clarify"
        ]

        self.assertEqual(2, len(clarify_vars))
        self.assertEqual(["AR-001", "AR-002"], [v["AR"] for v in clarify_vars])
        self.assertEqual(["用户管理", "权限"], [v["描述"] for v in clarify_vars])


class LegacyStateCompatibilityTests(CliTestBase):
    """An older fat workflow.yaml must keep working and slim down on write."""

    def _fatten(self, sr: str) -> None:
        """Re-add the template-owned fields an older CLI used to persist."""
        path = self.cwd / ".sdd" / sr / "workflow.yaml"
        data = yaml.safe_load(path.read_text("utf-8"))
        for step in data["steps"]:
            step["name"] = "stale name from an older CLI"
            step["execution"] = "prompt"
            step["session"] = "inherit"
            step["skill"] = []
            step["prompt"] = {"inline": "stale prompt", "rendered": "stale prompt"}
            step["input"] = []
            step["available_next"] = ["stale-node"]
        data["control"] = {"auto_confirm_all": True}
        data["transition_history"] = [{"type": "user_confirm", "from_step": 1}]
        path.write_text(yaml.dump(data, allow_unicode=True, sort_keys=False), "utf-8")

    def test_legacy_file_loads_and_rehydrates_from_definitions(self) -> None:
        self.start_sr("SR-LEGACY")
        self._fatten("SR-LEGACY")

        payload = json.loads(self.run_cli("next", "--sr", "SR-LEGACY", "--json").stdout)
        ready = payload["ready"][0]

        # The stale copies lose to the current definition.
        self.assertNotEqual("stale name from an older CLI", ready["name"])
        self.assertNotIn("stale-node", ready["available_next"])

    def test_legacy_file_slims_down_on_next_write(self) -> None:
        self.start_sr("SR-SHRINK")
        self._fatten("SR-SHRINK")
        path = self.cwd / ".sdd" / "SR-SHRINK" / "workflow.yaml"
        before_step = yaml.safe_load(path.read_text("utf-8"))["steps"][0]

        self.complete_step_1("SR-SHRINK")

        data = yaml.safe_load(path.read_text("utf-8"))
        after_step = data["steps"][0]

        # Same step, fewer keys: the template-owned copies are gone.
        self.assertLess(len(after_step), len(before_step))
        self.assertNotIn("control", data)
        self.assertNotIn("transition_history", data)
        for field in TEMPLATE_OWNED:
            self.assertNotIn(field, after_step)

    def test_legacy_workflow_still_completes_a_step(self) -> None:
        self.start_sr("SR-LEGACYRUN")
        self._fatten("SR-LEGACYRUN")

        result = self.complete_step_1("SR-LEGACYRUN")

        self.assertTrue(result["ok"])


if __name__ == "__main__":
    unittest.main()
