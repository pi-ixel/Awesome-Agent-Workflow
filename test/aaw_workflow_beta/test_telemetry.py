from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[2] / "skills" / "aaw-workflow" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from cli.telemetry import TelemetryClient, TelemetryStore, build_patch  # noqa: E402


class TelemetryTests(unittest.TestCase):
    def test_patch_uses_d0_as_baseline_and_counts_categories(self) -> None:
        # The pre-existing dirty change is D0, so only the later D1 change is
        # represented by the patch.
        patch, statistics = build_patch(
            {"src/service.py": b"value = 'dirty-before-dev'\n"},
            {"src/service.py": b"value = 'changed-during-dev'\n", "tests/test_api.py": b"assert True\n"},
            [],
        )

        self.assertIn("changed-during-dev", patch)
        self.assertNotIn("+++ b/src/service.py\n+value = 'dirty-before-dev'", patch)
        self.assertEqual(2, statistics["total_effective_lines"])
        self.assertEqual(1, statistics["categories"]["production_source"]["files_changed"])
        self.assertEqual(1, statistics["categories"]["test_source"]["files_changed"])

    def test_flush_removes_accepted_records_without_a_network_dependency(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TelemetryStore(Path(temp))
            store.configure("https://telemetry.example.test")
            store.enqueue("workflow_run", "workflow-1", {"status": "in_progress"})
            previous_token = os.environ.get("AAW_TELEMETRY_TOKEN")
            os.environ["AAW_TELEMETRY_TOKEN"] = "test-token"
            try:
                client = TelemetryClient(store)
                client._request = staticmethod(
                    lambda *_: (200, {"results": [{"record_type": "workflow_run", "record_id": "workflow-1", "status": "accepted"}]})
                )
                result = client.flush()
            finally:
                if previous_token is None:
                    del os.environ["AAW_TELEMETRY_TOKEN"]
                else:
                    os.environ["AAW_TELEMETRY_TOKEN"] = previous_token

            self.assertEqual(1, result["sent"])
            self.assertEqual([], store.pending())

    def test_non_retryable_rejection_is_retained_for_diagnostics_not_retried(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TelemetryStore(Path(temp))
            store.configure("https://telemetry.example.test")
            store.enqueue("workflow_run", "workflow-1", {"status": "in_progress"})
            previous_token = os.environ.get("AAW_TELEMETRY_TOKEN")
            os.environ["AAW_TELEMETRY_TOKEN"] = "test-token"
            try:
                client = TelemetryClient(store)
                calls = 0

                def reject(*_):
                    nonlocal calls
                    calls += 1
                    return 200, {"results": [{"record_type": "workflow_run", "record_id": "workflow-1", "status": "rejected", "error": {"code": "INVALID_REQUEST", "retryable": False}}]}

                client._request = staticmethod(reject)
                client.flush()
                client.flush()
            finally:
                if previous_token is None:
                    del os.environ["AAW_TELEMETRY_TOKEN"]
                else:
                    os.environ["AAW_TELEMETRY_TOKEN"] = previous_token

            self.assertEqual(1, calls)
            self.assertTrue(store.pending()[0]["terminal"])


if __name__ == "__main__":
    unittest.main()
