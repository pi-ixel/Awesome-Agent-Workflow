"""Tests for definition version binding and drift detection.

A workflow outlives the definitions it started against: a full-package update
replaces CLI and definitions while in-flight workflows keep their steps.  These
tests pin that the version is recorded, that a mismatch is surfaced instead of
silently mixing rule sets, and that a node type removed from definitions gives
a diagnosable error rather than a bare KeyError.
"""

from __future__ import annotations

import json
import unittest

import yaml

from _cli_base import CliTestBase


class DefinitionVersionBindingTests(CliTestBase):
    def _read(self, sr: str) -> dict:
        return yaml.safe_load(
            (self.cwd / ".sdd" / sr / "workflow.yaml").read_text("utf-8")
        )

    def _write(self, sr: str, data: dict) -> None:
        (self.cwd / ".sdd" / sr / "workflow.yaml").write_text(
            yaml.dump(data, allow_unicode=True, sort_keys=False), "utf-8"
        )

    def test_start_records_definition_version(self) -> None:
        self.start_sr("SR-VER")

        data = self._read("SR-VER")

        self.assertIsInstance(data["definition_version"], int)

    def test_matching_version_reports_no_drift(self) -> None:
        self.start_sr("SR-SAME")

        payload = json.loads(self.run_cli("next", "--sr", "SR-SAME", "--json").stdout)

        self.assertNotIn("definition_drift", payload)

    def test_version_mismatch_is_surfaced_by_next(self) -> None:
        self.start_sr("SR-DRIFT")
        data = self._read("SR-DRIFT")
        current = data["definition_version"]
        data["definition_version"] = current + 1
        self._write("SR-DRIFT", data)

        payload = json.loads(self.run_cli("next", "--sr", "SR-DRIFT", "--json").stdout)

        drift = payload["definition_drift"]
        self.assertEqual(current + 1, drift["created_with"])
        self.assertEqual(current, drift["current"])
        self.assertIn("definition version", drift["message"])

    def test_version_mismatch_is_surfaced_by_status(self) -> None:
        self.start_sr("SR-DRIFT2")
        data = self._read("SR-DRIFT2")
        data["definition_version"] = data["definition_version"] + 1
        self._write("SR-DRIFT2", data)

        payload = self.status_json("SR-DRIFT2")

        self.assertIn("definition_drift", payload)

    def test_drift_warns_but_does_not_block(self) -> None:
        """An in-flight workflow must stay runnable after a definition bump."""
        self.start_sr("SR-DRIFT3")
        data = self._read("SR-DRIFT3")
        data["definition_version"] = data["definition_version"] + 1
        self._write("SR-DRIFT3", data)

        result = self.complete_step_1("SR-DRIFT3")

        self.assertTrue(result["ok"])

    def test_file_without_version_reports_unknown_rather_than_false_match(self) -> None:
        """A pre-binding file cannot know its origin, so it claims no drift."""
        self.start_sr("SR-NOVER")
        data = self._read("SR-NOVER")
        del data["definition_version"]
        self._write("SR-NOVER", data)

        payload = json.loads(self.run_cli("next", "--sr", "SR-NOVER", "--json").stdout)

        self.assertNotIn("definition_drift", payload)

    def test_human_output_shows_drift_warning(self) -> None:
        self.start_sr("SR-DRIFT4")
        data = self._read("SR-DRIFT4")
        data["definition_version"] = data["definition_version"] + 1
        self._write("SR-DRIFT4", data)

        result = self.run_cli("status", "--sr", "SR-DRIFT4")

        self.assertIn("definition version", result.stdout)


class UnknownNodeTypeTests(CliTestBase):
    """A node removed from definitions must not surface as a bare KeyError."""

    def _orphan(self, sr: str) -> None:
        path = self.cwd / ".sdd" / sr / "workflow.yaml"
        data = yaml.safe_load(path.read_text("utf-8"))
        data["steps"][0]["type"] = "node-that-no-longer-exists"
        path.write_text(yaml.dump(data, allow_unicode=True, sort_keys=False), "utf-8")

    def test_done_on_removed_node_type_reports_diagnosable_error(self) -> None:
        self.start_sr("SR-ORPHAN")
        self.run_cli("next", "--sr", "SR-ORPHAN", "--json")
        # Satisfy the deliverable check so the failure is the missing node type.
        (self.cwd / ".sdd" / "software_architecture.md").write_text("arch", "utf-8")
        self._orphan("SR-ORPHAN")

        result = self.run_cli("done", "--sr", "SR-ORPHAN", "1", "--json", expect=1)
        payload = json.loads(result.stdout)

        self.assertFalse(payload["ok"])
        self.assertIn("node-that-no-longer-exists", payload["error"]["message"])
        self.assertNotIn("KeyError", result.stderr)

    def test_status_still_loads_a_workflow_with_a_removed_node(self) -> None:
        """Reading state must not require every node type to still exist."""
        self.start_sr("SR-ORPHAN2")
        self._orphan("SR-ORPHAN2")

        payload = self.status_json("SR-ORPHAN2")

        self.assertEqual("node-that-no-longer-exists", payload["steps"][0]["type"])


if __name__ == "__main__":
    unittest.main()
