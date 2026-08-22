"""Dev 入口冒烟测试：验证 dev 入口能完整跑通到 dev-task-dev 生成。"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AAW_SCRIPT = ROOT / "skills" / "aaw-workflow" / "scripts" / "aaw.py"
SCRIPTS_DIR = AAW_SCRIPT.parent


def run_cli(cwd: Path, *args: str):
    import subprocess
    import sys
    return subprocess.run(
        [sys.executable, str(AAW_SCRIPT), *args],
        cwd=str(cwd), capture_output=True, text=True, encoding="utf-8",
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    ).stdout


class DevEntryTest(unittest.TestCase):
    def test_full_dev_chain(self):
        with tempfile.TemporaryDirectory() as tmp:
            cwd = Path(tmp)
            sr = "DEV-001"

            # 1. start
            out = run_cli(cwd, "start", "--entry", "dev", "--sr", sr, "--json")
            self.assertIn("dev-init", out)
            # 2. dev-init
            run_cli(cwd, "next", "--sr", sr, "--json")
            self.assertEqual(0, _done(cwd, sr, "1"))
            # 3. dev-design
            (cwd / ".sdd" / sr).mkdir(parents=True, exist_ok=True)
            (cwd / ".sdd" / sr / "dev-design.md").write_text("# design", "utf-8")
            run_cli(cwd, "next", "--sr", sr, "--json")
            self.assertEqual(0, _done(cwd, sr, "2"))
            # 4. dev-design-gate
            (cwd / ".sdd" / sr / ".context").mkdir(parents=True, exist_ok=True)
            (cwd / ".sdd" / sr / ".context" / "dev-design-gate.md").write_text("# pass", "utf-8")
            run_cli(cwd, "next", "--sr", sr, "--json")
            data = json.dumps({
                "gate_result": "pass", "recommendation": "ok",
                "report": f".sdd/{sr}/.context/dev-design-gate.md",
                "summary": {"unqualified_items": 0, "blocking_issues": 0, "pending_questions": 0},
            }, ensure_ascii=False)
            self.assertEqual(0, _done(cwd, sr, "3", "--data", data))
            # 5. dev-task-split -> dev-task-dev foreach + user_confirm
            (cwd / ".sdd" / sr / "tasks-overview.md").write_text("### T1\n### T2", "utf-8")
            run_cli(cwd, "next", "--sr", sr, "--json")
            self.assertEqual(0, _done(cwd, sr, "4", "--data", json.dumps({"tasks": ["a", "b"]})))
            # user_confirm required
            out = run_cli(cwd, "next", "--sr", sr, "--json").strip()
            while not out.startswith("{"):
                out = out[out.index("{"):]
            state = json.loads(out)
            self.assertEqual("awaiting_user_confirm", state.get("status"))
            self.assertEqual("dev-task-split", state.get("pending_user_confirm", {}).get("from_type"))
            # 放行
            run_cli(cwd, "user-confirm", "--sr", sr, "--json")
            wf = (cwd / ".sdd" / sr / "workflow.yaml").read_text("utf-8")
            self.assertIn("dev-task-dev", wf)


def _done(cwd, sr, step, *extra):
    import subprocess, sys
    r = subprocess.run(
        [sys.executable, str(AAW_SCRIPT), "done", "--sr", sr, step, "--json", *extra],
        cwd=str(cwd), capture_output=True, text=True, encoding="utf-8",
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )
    return r.returncode


if __name__ == "__main__":
    unittest.main()
