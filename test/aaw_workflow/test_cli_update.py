"""Tests for `aaw update` (cli/update.py): transaction, lock, recovery.

Most cases drive cli.update in-process with an injected tmp install dir so the
real repository checkout is never touched (docs/auto-update-design.md §4.5).
"""

from __future__ import annotations

import io
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import unittest
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import _cli_base  # noqa: F401  (adds scripts dir to sys.path)
from _cli_base import CliTestBase

from cli import update as cli_update
from cli.update import UpdateError, recover_transaction, run_update

OLD_VERSION = "1.1.0"
NEW_VERSION = "1.2.0"


def _build_zip(
    version: str = NEW_VERSION,
    skills: tuple[str, ...] = ("aaw-workflow",),
    omit_skill_md: str | None = None,
    slip_entry: str | None = None,
) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as bundle:
        for name in skills:
            if name != omit_skill_md:
                bundle.writestr(f"{name}/SKILL.md", f"# {name} {version}")
            else:
                bundle.writestr(f"{name}/other.txt", "content without SKILL.md")
            if name == "aaw-workflow":
                bundle.writestr(f"{name}/scripts/aaw.py", "# entry")
                bundle.writestr(f"{name}/scripts/cli/VERSION", version)
        if slip_entry:
            bundle.writestr(slip_entry, "evil")
    return buf.getvalue()


class _ReleaseHandler(BaseHTTPRequestHandler):
    releases: dict[str, bytes] = {}

    def do_GET(self):  # noqa: N802
        if self.path == "/api/v1/client/release":
            if not self.releases:
                body = {"latest_version": None}
            else:
                latest = max(self.releases, key=lambda v: tuple(int(p) for p in v.split(".")))
                body = {
                    "latest_version": latest,
                    "file_name": f"aaw-skills-{latest}.zip",
                    "size_bytes": len(self.releases[latest]),
                    "released_at": "2026-01-01T00:00:00Z",
                }
            payload = json.dumps(body).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        match = re.fullmatch(r"/api/v1/client/releases/([^/]+)/download/aaw-skills-\1\.zip", self.path)
        if match and match.group(1) in self.releases:
            payload = self.releases[match.group(1)]
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, *args):  # silence
        pass


class UpdateTestBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _ReleaseHandler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.endpoint = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        _ReleaseHandler.releases = {}

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def make_install(self, version: str = OLD_VERSION, extra_skills: tuple[str, ...] = ()) -> Path:
        skills_root = self.root / "skills"
        workflow = skills_root / "aaw-workflow"
        (workflow / "scripts" / "cli").mkdir(parents=True)
        (workflow / "SKILL.md").write_text(f"# aaw-workflow {version}", "utf-8")
        (workflow / "scripts" / "aaw.py").write_text("# entry", "utf-8")
        (workflow / "scripts" / "cli" / "VERSION").write_text(version, "utf-8")
        for name in extra_skills:
            (skills_root / name).mkdir()
            (skills_root / name / "SKILL.md").write_text(f"# {name} {version}", "utf-8")
        return workflow

    def official_version(self) -> str:
        return (self.root / "skills" / "aaw-workflow" / "scripts" / "cli" / "VERSION").read_text("utf-8").strip()

    def residual_tx_dirs(self) -> list[Path]:
        return [p for p in (self.root / "skills").iterdir() if p.name.startswith(".aaw-update-")]


class UpdateFlowTests(UpdateTestBase):
    def test_full_update_swaps_all_skills(self) -> None:
        install = self.make_install(extra_skills=("zz-extra",))
        _ReleaseHandler.releases = {NEW_VERSION: _build_zip(skills=("aaw-workflow", "zz-extra"))}

        result = run_update(install_dir=install, endpoint=self.endpoint, out=lambda _: None)

        self.assertTrue(result["updated"])
        self.assertEqual(OLD_VERSION, result["old_version"])
        self.assertEqual(NEW_VERSION, result["new_version"])
        self.assertEqual(NEW_VERSION, self.official_version())
        self.assertIn(NEW_VERSION, (self.root / "skills" / "zz-extra" / "SKILL.md").read_text("utf-8"))
        self.assertEqual([], self.residual_tx_dirs())

    def test_noop_when_already_latest(self) -> None:
        install = self.make_install(version=NEW_VERSION)
        _ReleaseHandler.releases = {NEW_VERSION: _build_zip()}

        result = run_update(install_dir=install, endpoint=self.endpoint, out=lambda _: None)

        self.assertFalse(result["updated"])
        self.assertEqual(NEW_VERSION, self.official_version())

    def test_noop_when_server_has_no_release(self) -> None:
        install = self.make_install()

        result = run_update(install_dir=install, endpoint=self.endpoint, out=lambda _: None)

        self.assertFalse(result["updated"])

    def test_zip_version_mismatch_rejected_before_touching_install(self) -> None:
        install = self.make_install()
        _ReleaseHandler.releases = {NEW_VERSION: _build_zip(version="9.9.9")}

        with self.assertRaises(UpdateError):
            run_update(install_dir=install, endpoint=self.endpoint, out=lambda _: None)

        self.assertEqual(OLD_VERSION, self.official_version())
        self.assertEqual([], self.residual_tx_dirs())

    def test_zip_slip_entry_rejected(self) -> None:
        install = self.make_install()
        _ReleaseHandler.releases = {NEW_VERSION: _build_zip(slip_entry="../evil.txt")}

        with self.assertRaises(UpdateError):
            run_update(install_dir=install, endpoint=self.endpoint, out=lambda _: None)

        self.assertFalse((self.root / "evil.txt").exists())
        self.assertEqual(OLD_VERSION, self.official_version())
        self.assertEqual([], self.residual_tx_dirs())

    def test_missing_skill_md_rejected(self) -> None:
        install = self.make_install()
        _ReleaseHandler.releases = {
            NEW_VERSION: _build_zip(skills=("aaw-workflow", "zz-extra"), omit_skill_md="zz-extra"),
        }

        with self.assertRaises(UpdateError):
            run_update(install_dir=install, endpoint=self.endpoint, out=lambda _: None)

        self.assertEqual(OLD_VERSION, self.official_version())

    def test_swap_failure_rolls_back_all_skills(self) -> None:
        install = self.make_install(extra_skills=("zz-extra",))
        _ReleaseHandler.releases = {NEW_VERSION: _build_zip(skills=("aaw-workflow", "zz-extra"))}
        original = cli_update._rename_step

        def flaky(manifest, tx_dir, key, source, target):
            if key == "swap:zz-extra":
                raise OSError("simulated swap failure")
            original(manifest, tx_dir, key, source, target)

        with patch.object(cli_update, "_rename_step", flaky):
            with self.assertRaises(UpdateError):
                run_update(install_dir=install, endpoint=self.endpoint, out=lambda _: None)

        # aaw-workflow was already swapped in; rollback must restore the old copy
        self.assertEqual(OLD_VERSION, self.official_version())
        self.assertIn(OLD_VERSION, (self.root / "skills" / "zz-extra" / "SKILL.md").read_text("utf-8"))
        self.assertEqual([], self.residual_tx_dirs())

    def test_concurrent_update_is_rejected_by_kernel_lock(self) -> None:
        install = self.make_install()
        _ReleaseHandler.releases = {NEW_VERSION: _build_zip()}
        holder = cli_update._InstallLock(self.root / "skills", "token", "tx")
        try:
            with self.assertRaises(UpdateError) as ctx:
                run_update(install_dir=install, endpoint=self.endpoint, out=lambda _: None)
            self.assertIn("正在执行", ctx.exception.message)
        finally:
            holder.release()

        # released: update proceeds normally
        result = run_update(install_dir=install, endpoint=self.endpoint, out=lambda _: None)
        self.assertTrue(result["updated"])

    def test_symlinked_install_is_rejected(self) -> None:
        real = self.make_install()
        link_root = self.root / "linked-skills"
        link_root.mkdir()
        link = link_root / "aaw-workflow"
        try:
            os.symlink(real, link, target_is_directory=True)
        except OSError as e:  # no symlink privilege on Windows
            self.skipTest(f"symlinks unavailable: {e}")

        with self.assertRaises(UpdateError) as ctx:
            run_update(install_dir=link, endpoint=self.endpoint, out=lambda _: None)
        self.assertIn("链接", ctx.exception.message)


class ResidualTransactionTests(UpdateTestBase):
    def _make_tx(self, phase: str, skills: list[str]) -> Path:
        skills_root = self.root / "skills"
        tx_dir = skills_root / ".aaw-update-deadbeef"
        (tx_dir / "backup").mkdir(parents=True)
        manifest = {
            "schema": 1,
            "tx_id": "deadbeef",
            "owner_token": "tok",
            "skills_root": str(skills_root),
            "latest_version": NEW_VERSION,
            "skills": skills,
            "phase": phase,
            "steps": {},
        }
        (tx_dir / "transaction.json").write_text(json.dumps(manifest), "utf-8")
        (tx_dir / "recover.py").write_text(cli_update._RECOVER_SCRIPT, "utf-8")
        return tx_dir

    def test_interrupted_backup_phase_is_recovered_before_new_transaction(self) -> None:
        # old aaw-workflow was moved to backup/, official position empty (killed mid-backup)
        self.make_install()
        tx_dir = self._make_tx("backup", ["aaw-workflow"])
        (self.root / "skills" / "aaw-workflow").rename(tx_dir / "backup" / "aaw-workflow")
        self.assertFalse((self.root / "skills" / "aaw-workflow").exists())
        _ReleaseHandler.releases = {NEW_VERSION: _build_zip()}

        install = self.root / "skills" / "aaw-workflow"
        result = run_update(install_dir=install, endpoint=self.endpoint, out=lambda _: None)

        # residue recovered first (old copy restored), then updated to latest
        self.assertTrue(result["updated"])
        self.assertEqual(NEW_VERSION, self.official_version())
        self.assertEqual([], self.residual_tx_dirs())

    def test_committed_residue_is_cleaned(self) -> None:
        install = self.make_install()
        tx_dir = self._make_tx("committed", ["aaw-workflow"])
        (tx_dir / "backup" / "aaw-workflow").mkdir()
        _ReleaseHandler.releases = {NEW_VERSION: _build_zip()}

        result = run_update(install_dir=install, endpoint=self.endpoint, out=lambda _: None)

        self.assertTrue(result["updated"])
        self.assertEqual([], self.residual_tx_dirs())
        self.assertEqual(NEW_VERSION, self.official_version())

    def test_residue_left_untouched_when_no_new_release(self) -> None:
        # no release on the server: the update flow is never entered, residue stays
        install = self.make_install()
        self._make_tx("committed", ["aaw-workflow"])

        result = run_update(install_dir=install, endpoint=self.endpoint, out=lambda _: None)

        self.assertFalse(result["updated"])
        self.assertEqual(1, len(self.residual_tx_dirs()))
        self.assertEqual(OLD_VERSION, self.official_version())

    def test_recover_transaction_is_reentrant(self) -> None:
        # interrupted right after swap: backup holds old, official holds new
        self.make_install(version=NEW_VERSION)
        tx_dir = self._make_tx("swap", ["aaw-workflow"])
        old = tx_dir / "backup" / "aaw-workflow"
        (old / "scripts" / "cli").mkdir(parents=True)
        (old / "SKILL.md").write_text("# old", "utf-8")
        (old / "scripts" / "cli" / "VERSION").write_text(OLD_VERSION, "utf-8")

        self.assertEqual("rolled-back", recover_transaction(tx_dir))
        self.assertEqual(OLD_VERSION, self.official_version())
        self.assertFalse(tx_dir.exists())

        # rerunning recovery over an already-recovered site must not exist/raise
        self.assertEqual([], self.residual_tx_dirs())

    def test_generated_recover_script_restores_old_version(self) -> None:
        self.make_install(version=NEW_VERSION)  # official = swapped-in new copy
        tx_dir = self._make_tx("swap", ["aaw-workflow"])
        old = tx_dir / "backup" / "aaw-workflow"
        (old / "scripts" / "cli").mkdir(parents=True)
        (old / "SKILL.md").write_text("# old", "utf-8")
        (old / "scripts" / "cli" / "VERSION").write_text(OLD_VERSION, "utf-8")

        result = subprocess.run(
            [sys.executable, str(tx_dir / "recover.py")],
            capture_output=True, text=True, encoding="utf-8",
        )

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(OLD_VERSION, self.official_version())
        self.assertFalse(tx_dir.exists())


class ManualUpdateCliTests(CliTestBase):
    """`aaw update` output through the real CLI (fixture endpoint: no release)."""

    def test_update_reports_already_latest(self) -> None:
        result = self.run_cli("update")

        self.assertIn("已是最新", result.stdout)

    def test_update_json_reports_not_updated(self) -> None:
        result = self.run_cli("update", "--json")

        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertFalse(payload["updated"])

    def test_update_fails_when_server_unreachable(self) -> None:
        result = self.run_cli(
            "update",
            expect=1,
            extra_env={"AAW_TELEMETRY_ENDPOINT": "http://127.0.0.1:1"},
        )

        self.assertIn("更新失败", result.stderr)


if __name__ == "__main__":
    unittest.main()
