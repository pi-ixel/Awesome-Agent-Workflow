"""Tests for the CLI-managed session marker (.sdd/.current_session).

The marker tells question-tracker MCP where to store .question_state.json
(per-SR isolation). It is written by `aaw start` / `aaw next` — the workflow
loop always calls `next` before loading any sub-skill, so the marker is in
place before MCP tools are used.
"""

from __future__ import annotations

import os
import unittest
from pathlib import Path

from _cli_base import CliTestBase

from cli.workflow import write_session_marker  # noqa: E402

MARKER_REL = Path(".sdd") / ".current_session"


class SessionMarkerHelperTests(unittest.TestCase):
    """write_session_marker 辅助函数单元测试"""

    def setUp(self) -> None:
        import tempfile

        self.tmp = tempfile.TemporaryDirectory()
        self.cwd = Path(self.tmp.name)
        self._old_cwd = os.getcwd()
        os.chdir(self.cwd)

    def tearDown(self) -> None:
        os.chdir(self._old_cwd)
        self.tmp.cleanup()

    def _read_marker(self) -> str:
        return (self.cwd / MARKER_REL).read_text("utf-8")

    def test_writes_marker_with_exact_content(self) -> None:
        """写入标记，内容精确为 ./.sdd/<SR>/（单行、无引号、无尾随空格）"""
        write_session_marker(Path(".sdd"), "SR-001")

        self.assertEqual("./.sdd/SR-001/", self._read_marker())

    def test_creates_sdd_dir_if_missing(self) -> None:
        """.sdd 目录不存在时自动创建"""
        self.assertFalse((self.cwd / ".sdd").exists())

        write_session_marker(Path(".sdd"), "SR-002")

        self.assertTrue((self.cwd / MARKER_REL).is_file())

    def test_overwrites_existing_marker(self) -> None:
        """重复写入时覆盖旧值（切换 SR 场景）"""
        write_session_marker(Path(".sdd"), "SR-001")

        write_session_marker(Path(".sdd"), "SR-002")

        self.assertEqual("./.sdd/SR-002/", self._read_marker())


class SessionMarkerCliTests(CliTestBase):
    """CLI 命令对标记的维护行为"""

    def _read_marker(self) -> str:
        return (self.cwd / MARKER_REL).read_text("utf-8")

    def test_start_writes_marker(self) -> None:
        """aaw start 后标记指向该 SR"""
        self.run_cli("start", "--entry", "sr", "--sr", "SR-001", "--json")

        self.assertEqual("./.sdd/SR-001/", self._read_marker())

    def test_start_ar_entry_writes_sr_scoped_marker(self) -> None:
        """AR 入口的 start 同样写标记，且指向 SR 目录（per-SR 隔离，非 per-AR）"""
        self.run_cli(
            "start", "--entry", "ar",
            "--sr", "SR-100", "--ar", "AR-001", "--title", "用户管理",
            "--json",
        )

        self.assertEqual("./.sdd/SR-100/", self._read_marker())

    def test_next_writes_marker(self) -> None:
        """aaw next 后标记指向该 SR（覆盖 start 之后的每次循环）"""
        self.run_cli("start", "--entry", "sr", "--sr", "SR-001", "--json")
        (self.cwd / MARKER_REL).unlink(missing_ok=True)  # 删掉标记，验证 next 会重建

        self.run_cli("next", "--sr", "SR-001", "--json")

        self.assertEqual("./.sdd/SR-001/", self._read_marker())

    def test_next_switches_marker_to_latest_sr(self) -> None:
        """多 SR 交错时，标记跟随最近一次 next 的 SR"""
        self.run_cli("start", "--entry", "sr", "--sr", "SR-A", "--json")
        self.run_cli("start", "--entry", "sr", "--sr", "SR-B", "--json")

        self.run_cli("next", "--sr", "SR-A", "--json")

        self.assertEqual("./.sdd/SR-A/", self._read_marker())

    def test_failed_next_does_not_touch_marker(self) -> None:
        """next 的 SR 不存在（load 失败）时不得写入或破坏已有标记"""
        self.run_cli("start", "--entry", "sr", "--sr", "SR-OK", "--json")
        before = self._read_marker()

        self.run_cli("next", "--sr", "SR-MISSING", "--json", expect=1)

        self.assertEqual(before, self._read_marker())

    def test_status_does_not_write_marker(self) -> None:
        """status 是只读巡检命令，不写标记"""
        self.run_cli("start", "--entry", "sr", "--sr", "SR-001", "--json")
        (self.cwd / MARKER_REL).unlink(missing_ok=True)

        self.run_cli("status", "--sr", "SR-001", "--json")

        self.assertFalse((self.cwd / MARKER_REL).exists())

    def test_done_does_not_write_marker(self) -> None:
        """done 命令本身不写标记（前置的 next 会写，因此先删再单独调 done）"""
        self.run_cli("start", "--entry", "sr", "--sr", "SR-001", "--json")
        self.run_cli("next", "--sr", "SR-001", "--json")  # 让 step 1 进入 started
        (self.cwd / ".sdd" / "software_architecture.md").write_text("architecture", "utf-8")
        (self.cwd / MARKER_REL).unlink(missing_ok=True)

        self.run_cli("done", "--sr", "SR-001", "1", "--json")

        self.assertFalse((self.cwd / MARKER_REL).exists())

    def test_rollback_does_not_write_marker(self) -> None:
        """rollback 不写标记（与 done/status 同类，非子技能前置命令）"""
        self.run_cli("start", "--entry", "sr", "--sr", "SR-001", "--json")
        (self.cwd / MARKER_REL).unlink(missing_ok=True)

        self.run_cli("rollback", "--sr", "SR-001", "1", "--json")

        self.assertFalse((self.cwd / MARKER_REL).exists())

    def test_repeated_next_is_idempotent(self) -> None:
        """同一 SR 连续多次 next，标记内容稳定不损坏"""
        self.run_cli("start", "--entry", "sr", "--sr", "SR-001", "--json")

        self.run_cli("next", "--sr", "SR-001", "--json")
        first = self._read_marker()
        self.run_cli("next", "--sr", "SR-001", "--json")

        self.assertEqual(first, self._read_marker())


if __name__ == "__main__":
    unittest.main()
