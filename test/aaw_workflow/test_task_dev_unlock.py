from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "task_dev_unlock.py"


class TaskDevUnlockTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        subprocess.run(["git", "init", "--quiet"], cwd=self.root, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=self.root, check=True)
        subprocess.run(["git", "config", "user.name", "AAW Test"], cwd=self.root, check=True)
        source = self.root / "source.txt"
        source.write_text("baseline\n", "utf-8")
        subprocess.run(["git", "add", "source.txt"], cwd=self.root, check=True)
        subprocess.run(["git", "commit", "--quiet", "-m", "baseline"], cwd=self.root, check=True)
        self.old_head = self._git("rev-parse", "HEAD")
        self.old_index = self._git("write-tree")

        source.write_text("committed task change\n", "utf-8")
        subprocess.run(["git", "add", "source.txt"], cwd=self.root, check=True)
        subprocess.run(["git", "commit", "--quiet", "-m", "checkpoint"], cwd=self.root, check=True)
        staged = self.root / "staged.txt"
        staged.write_text("staged change\n", "utf-8")
        subprocess.run(["git", "add", "staged.txt"], cwd=self.root, check=True)
        self.current_head = self._git("rev-parse", "HEAD")
        self.current_index = self._git("write-tree")

        self.state_path = self.root / ".sdd" / "SR-1" / ".aaw" / "task-dev" / "10" / "1" / "state.json"
        self.state_path.parent.mkdir(parents=True)
        self.original_state = {
            "schema_version": 2,
            "task_id": "T1",
            "step_id": 10,
            "attempt": 1,
            "status": "reviewed",
            "head_commit": self.old_head,
            "index_baseline_tree": self.old_index,
            "integrity_error": "HEAD changed during task-dev; stop and ask the user to resolve it",
        }
        self.state_path.write_text(json.dumps(self.original_state), "utf-8")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _git(self, *args: str) -> str:
        return subprocess.check_output(["git", *args], cwd=self.root, text=True).strip()

    def _run(self, *extra: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--repo", str(self.root), "--sr", "SR-1", "--json", *extra],
            cwd=self.root,
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

    def test_unlock_rebinds_state_without_changing_git_or_files(self) -> None:
        source_before = (self.root / "source.txt").read_bytes()
        staged_before = (self.root / "staged.txt").read_bytes()

        result = self._run()

        self.assertEqual(0, result.returncode, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual("unlocked", payload["status"])
        self.assertEqual(1, payload["unlocked"])
        updated = json.loads(self.state_path.read_text("utf-8"))
        self.assertEqual(self.current_head, updated["head_commit"])
        self.assertEqual(self.current_index, updated["index_baseline_tree"])
        self.assertIsNone(updated["integrity_error"])
        backup = Path(payload["states"][0]["backup"])
        self.assertEqual(self.original_state, json.loads(backup.read_text("utf-8")))
        self.assertEqual(self.current_head, self._git("rev-parse", "HEAD"))
        self.assertEqual(self.current_index, self._git("write-tree"))
        self.assertEqual(source_before, (self.root / "source.txt").read_bytes())
        self.assertEqual(staged_before, (self.root / "staged.txt").read_bytes())

    def test_second_run_reports_not_locked_and_keeps_backup(self) -> None:
        first = json.loads(self._run().stdout)
        second = self._run()

        self.assertEqual(0, second.returncode, second.stderr)
        self.assertEqual("not_locked", json.loads(second.stdout)["status"])
        self.assertTrue(Path(first["states"][0]["backup"]).is_file())


if __name__ == "__main__":
    unittest.main()
