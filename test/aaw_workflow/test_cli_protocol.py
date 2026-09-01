"""Tests for the machine protocol envelope (docs/cli-machine-protocol.md).

Covers the two guarantees introduced by the protocol-foundation stage:
every ``--json`` output carries ``schema_version``, and a ``--json`` failure
emits a structured ``error{code,message}`` on stdout while stderr keeps the
human-readable text.
"""

from __future__ import annotations

import json
import unittest

from _cli_base import CliTestBase


PROTOCOL_VERSION = 1


class ProtocolEnvelopeTests(CliTestBase):
    """Successful --json output carries the protocol envelope."""

    def test_start_success_carries_schema_version(self) -> None:
        payload = self.start_sr("SR-ENV1")

        self.assertEqual(PROTOCOL_VERSION, payload["schema_version"])
        self.assertTrue(payload["ok"])

    def test_status_carries_schema_version(self) -> None:
        self.start_sr("SR-ENV2")

        payload = self.status_json("SR-ENV2")

        self.assertEqual(PROTOCOL_VERSION, payload["schema_version"])

    def test_status_without_sr_carries_schema_version(self) -> None:
        self.start_sr("SR-ENV3")

        payload = json.loads(self.run_cli("status", "--json").stdout)

        self.assertEqual(PROTOCOL_VERSION, payload["schema_version"])
        self.assertIn("SR-ENV3", payload["srs"])

    def test_next_carries_schema_version(self) -> None:
        self.start_sr("SR-ENV4")

        payload = json.loads(self.run_cli("next", "--sr", "SR-ENV4", "--json").stdout)

        self.assertEqual(PROTOCOL_VERSION, payload["schema_version"])

    def test_done_carries_schema_version(self) -> None:
        self.start_sr("SR-ENV5")

        payload = self.complete_step_1("SR-ENV5")

        self.assertEqual(PROTOCOL_VERSION, payload["schema_version"])
        self.assertTrue(payload["ok"])

    def test_rollback_preview_carries_schema_version(self) -> None:
        self.start_sr("SR-ENV6")
        self.complete_step_1("SR-ENV6")

        payload = json.loads(
            self.run_cli("rollback", "--sr", "SR-ENV6", "1", "--json").stdout
        )

        self.assertEqual(PROTOCOL_VERSION, payload["schema_version"])


class ProtocolErrorTests(CliTestBase):
    """A --json failure emits a structured error on stdout; stderr keeps text."""

    def _json_error(self, *args: str) -> tuple[dict, str]:
        result = self.run_cli(*args, expect=1)
        return json.loads(result.stdout), result.stderr

    def test_duplicate_sr_reports_structured_error(self) -> None:
        self.start_sr("SR-ERR1")
        req_file = self.cwd / ".aaw-test-requirement-SR-ERR1.md"

        payload, stderr = self._json_error(
            "start", "--entry", "sr", "--sr", "SR-ERR1",
            "--requirement-file", str(req_file), "--json",
        )

        self.assertEqual(PROTOCOL_VERSION, payload["schema_version"])
        self.assertFalse(payload["ok"])
        self.assertEqual("DUPLICATE_SR", payload["error"]["code"])
        self.assertIn("已存在", payload["error"]["message"])
        # stderr keeps the human-readable fallback alongside the JSON envelope.
        self.assertIn("已存在", stderr)

    def test_unknown_workflow_reports_structured_error(self) -> None:
        payload, _ = self._json_error("status", "--sr", "SR-NOPE", "--json")

        self.assertFalse(payload["ok"])
        self.assertEqual("WORKFLOW_NOT_FOUND", payload["error"]["code"])

    def test_unknown_entry_reports_structured_error(self) -> None:
        payload, _ = self._json_error(
            "start", "--entry", "nope", "--sr", "SR-ERR2", "--json"
        )

        self.assertFalse(payload["ok"])
        self.assertEqual("ENTRY_UNKNOWN", payload["error"]["code"])

    def test_malformed_var_reports_invalid_args(self) -> None:
        payload, _ = self._json_error("start", "--var", "SR-BAD", "--json")

        self.assertFalse(payload["ok"])
        self.assertEqual("INVALID_ARGS", payload["error"]["code"])

    def test_missing_required_vars_reports_invalid_args(self) -> None:
        payload, _ = self._json_error(
            "start", "--entry", "ar", "--sr", "SR-ERR3", "--json"
        )

        self.assertFalse(payload["ok"])
        self.assertEqual("INVALID_ARGS", payload["error"]["code"])

    def test_nonexistent_step_reports_structured_error(self) -> None:
        self.start_sr("SR-ERR4")

        payload, _ = self._json_error("done", "--sr", "SR-ERR4", "99", "--json")

        self.assertFalse(payload["ok"])
        self.assertEqual("STEP_NOT_FOUND", payload["error"]["code"])

    def test_done_twice_reports_step_already_complete(self) -> None:
        self.start_sr("SR-ERR5")
        self.complete_step_1("SR-ERR5")

        payload, _ = self._json_error("done", "--sr", "SR-ERR5", "1", "--json")

        self.assertFalse(payload["ok"])
        self.assertEqual("STEP_ALREADY_COMPLETE", payload["error"]["code"])

    def test_invalid_data_reports_data_validation(self) -> None:
        self.advance_to_ar_split("SR-ERR6")

        payload, _ = self._json_error(
            "done", "--sr", "SR-ERR6", "4", "--data", "not json", "--json"
        )

        self.assertFalse(payload["ok"])
        self.assertEqual("DATA_VALIDATION", payload["error"]["code"])

    def test_user_confirm_without_pending_reports_structured_error(self) -> None:
        self.start_sr("SR-ERR7")

        payload, _ = self._json_error("user-confirm", "--sr", "SR-ERR7", "--json")

        self.assertFalse(payload["ok"])
        self.assertEqual("AWAITING_USER_CONFIRM", payload["error"]["code"])

    def test_error_without_json_stays_text_only(self) -> None:
        """Without --json the old behaviour is unchanged: stderr text, no JSON."""
        result = self.run_cli("status", "--sr", "SR-NOPE", expect=1)

        self.assertIn("不存在", result.stderr)
        self.assertEqual("", result.stdout.strip())


if __name__ == "__main__":
    unittest.main()
