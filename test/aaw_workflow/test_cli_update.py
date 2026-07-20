"""Tests for `aaw update` (cli/update.py): staged transaction, lock, recovery.

Most cases drive cli.update in-process with an injected tmp install dir so the
real repository checkout is never touched (docs/auto-update-design.md §4.5).
"""

from __future__ import annotations

import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import _cli_base  # noqa: F401  (adds scripts dir to sys.path)
from _cli_base import ROOT, CliTestBase

from cli import update as cli_update
from cli.install_lock import InstallLock, LockTimeout
from cli.update import UpdateError, recover_transaction, run_update

OLD_VERSION = "1.1.0"
NEW_VERSION = "1.2.0"


def _build_zip(
    version: str = NEW_VERSION,
    skills: tuple[str, ...] = ("aaw-workflow",),
    omit_skill_md: str | None = None,
    slip_entry: str | None = None,
    manifest_version: str | None = None,
    manifest_skills: list[str] | None = None,
    external: tuple[str, ...] = (),
    removed: tuple[str, ...] = (),
    omit_manifest: bool = False,
    manifest_schema: object = 1,
) -> bytes:
    manifest = {
        "schema": manifest_schema,
        "version": manifest_version or version,
        "skills": list(manifest_skills if manifest_skills is not None else skills),
        "external_skills": list(external),
        "removed_skills": list(removed),
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as bundle:
        if not omit_manifest:
            bundle.writestr("release-manifest.json", json.dumps(manifest))
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
    size_override: int | None = None
    release_body_override: object | None = None

    def do_GET(self):  # noqa: N802
        if self.path == "/api/v1/client/release":
            if self.release_body_override is not None:
                body = self.release_body_override
            elif not self.releases:
                body = {"latest_version": None}
            else:
                latest = max(self.releases, key=lambda v: tuple(int(p) for p in v.split(".")))
                size = len(self.releases[latest])
                body = {
                    "latest_version": latest,
                    "file_name": f"aaw-skills-{latest}.zip",
                    "size_bytes": self.size_override if self.size_override is not None else size,
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
        _ReleaseHandler.size_override = None
        _ReleaseHandler.release_body_override = None
        # keep lock-wait failures fast in tests
        self.env = patch.dict(os.environ, {"AAW_LOCK_TIMEOUT": "2"})
        self.env.start()

    def tearDown(self) -> None:
        self.env.stop()
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

    def residual_dirs(self) -> list[Path]:
        return [
            p for p in (self.root / "skills").iterdir()
            if p.name.startswith(".aaw-txn-") or p.name.startswith(".aaw-stage-")
        ]

    def update(self, install: Path):
        return run_update(install_dir=install, endpoint=self.endpoint, out=lambda _: None)


class UpdateFlowTests(UpdateTestBase):
    def test_full_update_swaps_all_skills(self) -> None:
        install = self.make_install(extra_skills=("zz-extra",))
        _ReleaseHandler.releases = {NEW_VERSION: _build_zip(skills=("aaw-workflow", "zz-extra"))}

        result = self.update(install)

        self.assertEqual("updated", result["status"])
        self.assertEqual(OLD_VERSION, result["from_version"])
        self.assertEqual(NEW_VERSION, result["to_version"])
        self.assertEqual(["aaw-workflow", "zz-extra"], sorted(result["updated_skills"]))
        self.assertEqual(NEW_VERSION, self.official_version())
        self.assertIn(NEW_VERSION, (self.root / "skills" / "zz-extra" / "SKILL.md").read_text("utf-8"))
        self.assertEqual([], self.residual_dirs())

    def test_noop_when_already_latest(self) -> None:
        install = self.make_install(version=NEW_VERSION)
        _ReleaseHandler.releases = {NEW_VERSION: _build_zip()}

        result = self.update(install)

        self.assertEqual("up_to_date", result["status"])
        self.assertEqual(NEW_VERSION, self.official_version())

    def test_noop_when_server_has_no_release(self) -> None:
        install = self.make_install()

        result = self.update(install)

        self.assertEqual("up_to_date", result["status"])

    def test_new_skill_added_and_user_skill_untouched(self) -> None:
        install = self.make_install()
        (self.root / "skills" / "my-own-skill").mkdir()
        (self.root / "skills" / "my-own-skill" / "SKILL.md").write_text("# mine", "utf-8")
        _ReleaseHandler.releases = {NEW_VERSION: _build_zip(skills=("aaw-workflow", "brand-new"))}

        result = self.update(install)

        self.assertEqual("updated", result["status"])
        self.assertTrue((self.root / "skills" / "brand-new" / "SKILL.md").is_file())
        self.assertEqual("# mine", (self.root / "skills" / "my-own-skill" / "SKILL.md").read_text("utf-8"))

    def test_removed_skill_deleted_only_after_commit(self) -> None:
        install = self.make_install(extra_skills=("legacy-skill",))
        _ReleaseHandler.releases = {NEW_VERSION: _build_zip(removed=("legacy-skill",))}

        result = self.update(install)

        self.assertEqual("updated", result["status"])
        self.assertEqual(["legacy-skill"], result["removed_skills"])
        self.assertFalse((self.root / "skills" / "legacy-skill").exists())
        self.assertEqual([], self.residual_dirs())

    def test_extensions_dir_untouched_by_update(self) -> None:
        install = self.make_install()
        ext = self.root / "skills" / ".aaw-extensions" / "definitions"
        ext.mkdir(parents=True)
        (ext / "custom.yaml").write_text("name: custom", "utf-8")
        _ReleaseHandler.releases = {NEW_VERSION: _build_zip()}

        self.update(install)

        self.assertEqual("name: custom", (ext / "custom.yaml").read_text("utf-8"))

    def test_zip_version_mismatch_rejected_before_touching_install(self) -> None:
        install = self.make_install()
        _ReleaseHandler.releases = {NEW_VERSION: _build_zip(version="9.9.9")}

        with self.assertRaises(UpdateError):
            self.update(install)

        self.assertEqual(OLD_VERSION, self.official_version())
        self.assertEqual([], self.residual_dirs())

    def test_zip_slip_entry_rejected(self) -> None:
        install = self.make_install()
        _ReleaseHandler.releases = {NEW_VERSION: _build_zip(slip_entry="../evil.txt")}

        with self.assertRaises(UpdateError):
            self.update(install)

        self.assertFalse((self.root / "evil.txt").exists())
        self.assertEqual(OLD_VERSION, self.official_version())
        self.assertEqual([], self.residual_dirs())

    def test_missing_skill_md_rejected(self) -> None:
        install = self.make_install()
        _ReleaseHandler.releases = {
            NEW_VERSION: _build_zip(skills=("aaw-workflow", "zz-extra"), omit_skill_md="zz-extra"),
        }

        with self.assertRaises(UpdateError):
            self.update(install)

        self.assertEqual(OLD_VERSION, self.official_version())

    def test_truncated_download_rejected(self) -> None:
        install = self.make_install()
        _ReleaseHandler.releases = {NEW_VERSION: _build_zip()}
        _ReleaseHandler.size_override = len(_ReleaseHandler.releases[NEW_VERSION]) + 100

        with self.assertRaises(UpdateError) as ctx:
            self.update(install)

        self.assertIn("下载不完整", ctx.exception.message)
        self.assertEqual([], self.residual_dirs())

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
                self.update(install)

        # aaw-workflow was already swapped in; rollback must restore the old copy
        self.assertEqual(OLD_VERSION, self.official_version())
        self.assertIn(OLD_VERSION, (self.root / "skills" / "zz-extra" / "SKILL.md").read_text("utf-8"))
        self.assertEqual([], self.residual_dirs())

    def test_swap_failure_removes_already_landed_new_skill(self) -> None:
        install = self.make_install()
        _ReleaseHandler.releases = {
            NEW_VERSION: _build_zip(skills=("aaw-workflow", "brand-new", "zz-last"))
        }
        original = cli_update._rename_step

        def flaky(manifest, tx_dir, key, source, target):
            if key == "swap:zz-last":
                raise OSError("simulated late swap failure")
            original(manifest, tx_dir, key, source, target)

        with patch.object(cli_update, "_rename_step", flaky):
            with self.assertRaises(UpdateError):
                self.update(install)

        self.assertEqual(OLD_VERSION, self.official_version())
        self.assertFalse((self.root / "skills" / "brand-new").exists())
        self.assertFalse((self.root / "skills" / "zz-last").exists())
        self.assertEqual([], self.residual_dirs())

    def test_regular_file_at_managed_target_is_rejected_untouched(self) -> None:
        install = self.make_install()
        conflict = self.root / "skills" / "brand-new"
        conflict.write_text("important user file", "utf-8")
        _ReleaseHandler.releases = {
            NEW_VERSION: _build_zip(skills=("aaw-workflow", "brand-new"))
        }

        with self.assertRaises(UpdateError) as ctx:
            self.update(install)

        self.assertIn("不是 Skill 目录", ctx.exception.message)
        self.assertEqual("important user file", conflict.read_text("utf-8"))
        self.assertEqual(OLD_VERSION, self.official_version())

    def test_committed_cleanup_failure_is_warning_and_recovered_next_run(self) -> None:
        install = self.make_install()
        _ReleaseHandler.releases = {NEW_VERSION: _build_zip()}
        original = cli_update._remove_tree
        messages: list[str] = []

        def fail_tx_cleanup(path: Path):
            if path.name.startswith(cli_update.TX_PREFIX):
                raise OSError("simulated cleanup contention")
            return original(path)

        with patch.object(cli_update, "_remove_tree", fail_tx_cleanup):
            result = run_update(install_dir=install, endpoint=self.endpoint, out=messages.append)

        self.assertEqual("updated", result["status"])
        self.assertEqual(NEW_VERSION, self.official_version())
        self.assertTrue(any("更新已提交" in item for item in messages))
        self.assertTrue(any(p.name.startswith(cli_update.TX_PREFIX) for p in self.residual_dirs()))

        result = self.update(install)
        self.assertEqual("up_to_date", result["status"])
        self.assertEqual([], self.residual_dirs())

    def test_symlinked_install_is_rejected(self) -> None:
        real = self.make_install()
        link_root = self.root / "linked-skills"
        link_root.mkdir()
        link = link_root / "aaw-workflow"
        try:
            os.symlink(real, link, target_is_directory=True)
        except OSError as e:  # no symlink privilege on Windows
            self.skipTest(f"symlinks unavailable: {e}")
        _ReleaseHandler.releases = {NEW_VERSION: _build_zip()}

        with self.assertRaises(UpdateError) as ctx:
            self.update(link)
        self.assertIn("链接", ctx.exception.message)


class ManifestValidationTests(UpdateTestBase):
    def _expect_rejected(self, zip_bytes: bytes, needle: str) -> None:
        install = self.make_install()
        _ReleaseHandler.releases = {NEW_VERSION: zip_bytes}

        with self.assertRaises(UpdateError) as ctx:
            self.update(install)

        self.assertIn(needle, ctx.exception.message)
        self.assertEqual(OLD_VERSION, self.official_version())
        self.assertEqual([], self.residual_dirs())

    def test_missing_manifest_rejected(self) -> None:
        self._expect_rejected(_build_zip(omit_manifest=True), "release-manifest.json")

    def test_extra_top_dir_rejected(self) -> None:
        self._expect_rejected(
            _build_zip(skills=("aaw-workflow", "sneaky"), manifest_skills=["aaw-workflow"]),
            "不一致",
        )

    def test_reserved_name_rejected(self) -> None:
        self._expect_rejected(
            _build_zip(manifest_skills=["aaw-workflow", ".aaw-evil"]), "非法 Skill 名称"
        )

    def test_overlapping_lists_rejected(self) -> None:
        self._expect_rejected(
            _build_zip(removed=("aaw-workflow",)), "列表交叉"
        )

    def test_unknown_manifest_schema_rejected(self) -> None:
        self._expect_rejected(_build_zip(manifest_schema=999), "schema")

    def test_missing_external_skill_rejected(self) -> None:
        self._expect_rejected(_build_zip(external=("needs-me",)), "needs-me")

    def test_present_external_skill_accepted(self) -> None:
        install = self.make_install(extra_skills=("needs-me",))
        _ReleaseHandler.releases = {NEW_VERSION: _build_zip(external=("needs-me",))}

        result = self.update(install)

        self.assertEqual("updated", result["status"])
        # external skill is referenced, not managed: left as-is
        self.assertIn(OLD_VERSION, (self.root / "skills" / "needs-me" / "SKILL.md").read_text("utf-8"))


class LockSemanticsTests(UpdateTestBase):
    def test_shared_locks_coexist_and_block_exclusive(self) -> None:
        (self.root / "skills").mkdir()
        a = InstallLock(self.root / "skills")
        b = InstallLock(self.root / "skills")
        c = InstallLock(self.root / "skills")
        try:
            a.acquire_shared(timeout=1)
            b.acquire_shared(timeout=1)  # shared locks coexist
            with self.assertRaises(LockTimeout):
                c.acquire_exclusive(timeout=0.4)
            a.release()
            b.release()
            c.acquire_exclusive(timeout=1)  # all shared released -> exclusive ok
        finally:
            a.close()
            b.close()
            c.close()

    def test_exclusive_blocks_shared(self) -> None:
        (self.root / "skills").mkdir()
        holder = InstallLock(self.root / "skills")
        other = InstallLock(self.root / "skills")
        try:
            holder.acquire_exclusive(timeout=1)
            with self.assertRaises(LockTimeout):
                other.acquire_shared(timeout=0.4)
            holder.release()
            other.acquire_shared(timeout=1)
        finally:
            holder.close()
            other.close()

    def test_update_times_out_when_shared_lock_held_elsewhere(self) -> None:
        install = self.make_install()
        _ReleaseHandler.releases = {NEW_VERSION: _build_zip()}
        holder = InstallLock(self.root / "skills")
        holder.acquire_shared(timeout=1)
        try:
            with self.assertRaises(UpdateError) as ctx:
                self.update(install)
            self.assertIn("超时", ctx.exception.message)
            self.assertEqual(OLD_VERSION, self.official_version())
        finally:
            holder.close()

        # holder gone: update proceeds
        result = self.update(install)
        self.assertEqual("updated", result["status"])

    def test_lock_upgrade_rereads_version_and_yields(self) -> None:
        # by the time the exclusive lock is acquired, the install already
        # reached latest (concurrent updater finished first)
        install = self.make_install(version=NEW_VERSION)
        _ReleaseHandler.releases = {NEW_VERSION: _build_zip()}
        skills_root = self.root / "skills"
        lock = InstallLock(skills_root)
        lock.acquire_shared(timeout=1)
        try:
            result = cli_update._perform_update(
                install, skills_root, lock, NEW_VERSION,
                f"aaw-skills-{NEW_VERSION}.zip", len(_ReleaseHandler.releases[NEW_VERSION]),
                self.endpoint, lambda _: None,
            )
            self.assertIsNone(result)
            self.assertEqual("exclusive", lock.mode)
            self.assertEqual([], self.residual_dirs())  # own stage removed
        finally:
            lock.close()

    def test_foreign_stage_is_never_cleaned(self) -> None:
        install = self.make_install()
        foreign = self.root / "skills" / ".aaw-stage-someoneelse"
        (foreign / "payload").mkdir(parents=True)
        _ReleaseHandler.releases = {NEW_VERSION: _build_zip()}

        result = self.update(install)

        self.assertEqual("updated", result["status"])
        self.assertTrue(foreign.is_dir())  # not a residual transaction, not ours

    def test_launcher_does_not_import_cli_before_shared_lock(self) -> None:
        skills_root = self.root / "bootstrap-skills"
        install = skills_root / "aaw-workflow"
        shutil.copytree(ROOT / "skills" / "aaw-workflow", install)
        marker = self.root / "cli-imported.marker"
        init_file = install / "scripts" / "cli" / "__init__.py"
        with init_file.open("a", encoding="utf-8") as stream:
            stream.write(
                "\nimport os\nfrom pathlib import Path\n"
                "if os.environ.get('AAW_IMPORT_MARKER'):\n"
                "    Path(os.environ['AAW_IMPORT_MARKER']).write_text('imported')\n"
            )

        holder = InstallLock(skills_root)
        holder.acquire_exclusive(timeout=1)
        env = {
            **os.environ,
            "PYTHONIOENCODING": "utf-8",
            "AAW_IMPORT_MARKER": str(marker),
            "AAW_LOCK_TIMEOUT": "2",
        }
        process = subprocess.Popen(
            [sys.executable, str(install / "scripts" / "aaw.py"), "--version"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            env=env,
        )
        try:
            time.sleep(0.3)
            self.assertFalse(marker.exists(), "cli package imported before shared lock")
            holder.release()
            stdout, stderr = process.communicate(timeout=5)
        finally:
            holder.close()
            if process.poll() is None:
                process.kill()
                process.wait()
        self.assertEqual(0, process.returncode, stderr)
        self.assertTrue(marker.is_file())
        self.assertEqual(
            (install / "scripts" / "cli" / "VERSION").read_text("utf-8").strip(),
            stdout.strip(),
        )

    def test_bootstrap_lock_timeout_preserves_update_json_contract(self) -> None:
        skills_root = self.root / "json-skills"
        install = skills_root / "aaw-workflow"
        shutil.copytree(ROOT / "skills" / "aaw-workflow", install)
        holder = InstallLock(skills_root)
        holder.acquire_exclusive(timeout=1)
        try:
            result = subprocess.run(
                [sys.executable, str(install / "scripts" / "aaw.py"), "update", "--json"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                env={**os.environ, "PYTHONIOENCODING": "utf-8", "AAW_LOCK_TIMEOUT": "0.2"},
                timeout=5,
            )
        finally:
            holder.close()

        self.assertEqual(1, result.returncode, result.stderr)
        self.assertEqual("failed", json.loads(result.stdout)["status"])

    def test_bootstrap_recovery_failure_reports_recovery_required_json(self) -> None:
        skills_root = self.root / "recovery-json-skills"
        install = skills_root / "aaw-workflow"
        shutil.copytree(ROOT / "skills" / "aaw-workflow", install)
        broken_tx = skills_root / ".aaw-txn-broken"
        broken_tx.mkdir()
        (broken_tx / "transaction.json").write_text("not-json", "utf-8")

        result = subprocess.run(
            [sys.executable, str(install / "scripts" / "aaw.py"), "update", "--json"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            env={**os.environ, "PYTHONIOENCODING": "utf-8", "AAW_LOCK_TIMEOUT": "1"},
            timeout=5,
        )

        self.assertEqual(2, result.returncode, result.stderr)
        self.assertEqual("recovery_required", json.loads(result.stdout)["status"])


class ReleaseResponseValidationTests(UpdateTestBase):
    def test_non_object_response_is_rejected(self) -> None:
        install = self.make_install()
        _ReleaseHandler.release_body_override = ["not", "an", "object"]

        with self.assertRaises(UpdateError) as ctx:
            self.update(install)

        self.assertIn("JSON object", ctx.exception.message)

    def test_missing_latest_version_is_rejected(self) -> None:
        install = self.make_install()
        _ReleaseHandler.release_body_override = {"unexpected": True}

        with self.assertRaises(UpdateError) as ctx:
            self.update(install)

        self.assertIn("latest_version", ctx.exception.message)

    def test_malicious_file_name_is_rejected_without_touching_local_file(self) -> None:
        install = self.make_install()
        victim = self.root / "skills" / "victim.zip"
        victim.write_text("important", "utf-8")
        _ReleaseHandler.release_body_override = {
            "latest_version": NEW_VERSION,
            "file_name": "../victim.zip",
            "size_bytes": 100,
        }

        with self.assertRaises(UpdateError) as ctx:
            self.update(install)

        self.assertIn("file_name", ctx.exception.message)
        self.assertEqual("important", victim.read_text("utf-8"))
        self.assertEqual([], self.residual_dirs())

    def test_boolean_size_is_rejected(self) -> None:
        install = self.make_install()
        _ReleaseHandler.release_body_override = {
            "latest_version": NEW_VERSION,
            "file_name": f"aaw-skills-{NEW_VERSION}.zip",
            "size_bytes": True,
        }

        with self.assertRaises(UpdateError) as ctx:
            self.update(install)

        self.assertIn("size_bytes", ctx.exception.message)

    def test_query_timeout_is_total_deadline(self) -> None:
        def slow_urlopen(*_args, **_kwargs):
            time.sleep(0.3)
            raise OSError("late failure")

        started = time.monotonic()
        with patch.object(cli_update, "urlopen", slow_urlopen):
            with self.assertRaises(UpdateError) as ctx:
                cli_update.query_latest("http://unused", timeout=0.05)
        elapsed = time.monotonic() - started

        self.assertIn("总耗时", ctx.exception.message)
        self.assertLess(elapsed, 0.2)


class ResidualTransactionTests(UpdateTestBase):
    def _make_tx(self, phase: str, skills: list[str]) -> Path:
        skills_root = self.root / "skills"
        tx_dir = skills_root / ".aaw-txn-deadbeef"
        (tx_dir / "backup").mkdir(parents=True)
        manifest = {
            "schema": 2,
            "tx_id": "deadbeef",
            "skills_root": str(skills_root),
            "latest_version": NEW_VERSION,
            "skills": skills,
            "removed_skills": [],
            "phase": phase,
            "steps": {},
        }
        (tx_dir / "transaction.json").write_text(json.dumps(manifest), "utf-8")
        (tx_dir / "recover.py").write_text(cli_update._RECOVER_SCRIPT, "utf-8")
        return tx_dir

    def test_interrupted_backup_phase_is_recovered_before_query(self) -> None:
        # old aaw-workflow was moved to backup/, official position empty (killed mid-backup)
        self.make_install()
        tx_dir = self._make_tx("backup", ["aaw-workflow"])
        (self.root / "skills" / "aaw-workflow").rename(tx_dir / "backup" / "aaw-workflow")
        self.assertFalse((self.root / "skills" / "aaw-workflow").exists())
        _ReleaseHandler.releases = {NEW_VERSION: _build_zip()}

        install = self.root / "skills" / "aaw-workflow"
        result = self.update(install)

        # residue recovered first (old copy restored), then updated to latest
        self.assertEqual("updated", result["status"])
        self.assertEqual(OLD_VERSION, result["from_version"])
        self.assertEqual(NEW_VERSION, self.official_version())
        self.assertEqual([], self.residual_dirs())

    def test_residue_recovered_even_without_new_release(self) -> None:
        # docs §4.2: local recovery happens before (and regardless of) the query
        install = self.make_install()
        self._make_tx("committed", ["aaw-workflow"])

        result = self.update(install)

        self.assertEqual("up_to_date", result["status"])
        self.assertEqual([], self.residual_dirs())
        self.assertEqual(OLD_VERSION, self.official_version())

    def test_manifestless_cleanup_residue_is_removed_before_query(self) -> None:
        install = self.make_install()
        leftover = self.root / "skills" / ".aaw-txn-cleanup-only"
        leftover.mkdir()
        (leftover / "already-cleaned.tmp").write_text("residue", "utf-8")

        result = self.update(install)

        self.assertEqual("up_to_date", result["status"])
        self.assertFalse(leftover.exists())

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
        self.assertEqual([], self.residual_dirs())

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
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(OLD_VERSION, self.official_version())
        self.assertFalse(tx_dir.exists())

    def test_generated_recover_script_removes_landed_new_skill(self) -> None:
        self.make_install()
        tx_dir = self._make_tx("swap", ["brand-new"])
        brand_new = self.root / "skills" / "brand-new"
        brand_new.mkdir()
        (brand_new / "SKILL.md").write_text("# new", "utf-8")
        manifest_path = tx_dir / "transaction.json"
        manifest = json.loads(manifest_path.read_text("utf-8"))
        manifest.update({
            "schema": 3,
            "targets": {"brand-new": {"operation": "add", "had_original": False}},
            "steps": {"swap:brand-new": "done"},
        })
        manifest_path.write_text(json.dumps(manifest), "utf-8")

        result = subprocess.run(
            [sys.executable, str(tx_dir / "recover.py")],
            capture_output=True,
            text=True,
            encoding="utf-8",
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertFalse(brand_new.exists())
        self.assertFalse(tx_dir.exists())


class ManualUpdateCliTests(CliTestBase):
    """`aaw update` output through the real CLI (fixture endpoint: no release)."""

    def test_update_reports_already_latest(self) -> None:
        result = self.run_cli("update")

        self.assertIn("已是最新", result.stdout)

    def test_update_json_reports_up_to_date_status(self) -> None:
        result = self.run_cli("update", "--json")

        payload = json.loads(result.stdout)
        self.assertEqual("up_to_date", payload["status"])
        self.assertEqual([], payload["updated_skills"])

    def test_update_fails_with_exit_1_when_server_unreachable(self) -> None:
        result = self.run_cli(
            "update", "--json",
            expect=1,
            extra_env={"AAW_TELEMETRY_ENDPOINT": "http://127.0.0.1:1"},
        )

        self.assertEqual("failed", json.loads(result.stdout)["status"])
        self.assertIn("更新失败", result.stderr)


if __name__ == "__main__":
    unittest.main()
