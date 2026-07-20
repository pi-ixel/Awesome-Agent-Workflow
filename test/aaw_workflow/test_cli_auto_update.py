"""End-to-end tests for `aaw start` auto-update (docs §4.2 / §4.4 step 7).

A full copy of the real aaw-workflow skill goes into a tmp skills root and its
aaw.py is executed directly, so the CLI self-locates the tmp install and the
repository checkout is never touched.  The fixture server counts release
queries to assert exactly when the CLI talks to it.
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
import unittest
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from _cli_base import ROOT

from cli.update import _definition_skill_refs

REAL_SKILL = ROOT / "skills" / "aaw-workflow"
# skills referenced by the real bundled definitions; declared as external in
# the test release manifest and materialised in the tmp install
DEFINITION_REFS = sorted(_definition_skill_refs(REAL_SKILL / "scripts" / "cli" / "definitions"))
# the tmp install is a copy of the real skill, so "old" is whatever it ships
OLD_VERSION = (REAL_SKILL / "scripts" / "cli" / "VERSION").read_text("utf-8").strip()
NEW_VERSION = "99.0.0"


def _zip_install(skill_dir: Path, version: str) -> bytes:
    """Package a working copy of the skill as a release zip with the given VERSION."""
    manifest = {
        "schema": 1,
        "version": version,
        "skills": ["aaw-workflow"],
        "external_skills": DEFINITION_REFS,
        "removed_skills": [],
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as bundle:
        bundle.writestr("release-manifest.json", json.dumps(manifest))
        for path in sorted(skill_dir.rglob("*")):
            if path.is_dir() or "__pycache__" in path.parts:
                continue
            rel = "aaw-workflow/" + path.relative_to(skill_dir).as_posix()
            if rel == "aaw-workflow/scripts/cli/VERSION":
                bundle.writestr(rel, version)
            else:
                bundle.writestr(rel, path.read_bytes())
    return buf.getvalue()


class _CountingHandler(BaseHTTPRequestHandler):
    releases: dict[str, bytes] = {}
    release_queries = 0

    def do_GET(self):  # noqa: N802
        if self.path == "/api/v1/client/release":
            type(self).release_queries += 1
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

    def do_POST(self):  # noqa: N802
        self.send_response(404)
        self.end_headers()

    do_PUT = do_POST

    def log_message(self, *args):  # silence
        pass


class AutoUpdateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _CountingHandler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.endpoint = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.skills_root = root / "skills"
        self.install = self.skills_root / "aaw-workflow"
        shutil.copytree(REAL_SKILL, self.install, ignore=shutil.ignore_patterns("__pycache__"))
        # materialise the externally-referenced skills so sanity passes
        for name in DEFINITION_REFS:
            (self.skills_root / name).mkdir()
            (self.skills_root / name / "SKILL.md").write_text(f"# {name}", "utf-8")
        self.project = root / "project"
        self.project.mkdir()
        _CountingHandler.releases = {}
        _CountingHandler.release_queries = 0

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_cli(self, *args: str, expect: int = 0, extra_env: dict[str, str] | None = None):
        env = {
            **os.environ,
            "PYTHONIOENCODING": "utf-8",
            "AAW_TELEMETRY_ENDPOINT": self.endpoint,
            **(extra_env or {}),
        }
        result = subprocess.run(
            [sys.executable, str(self.install / "scripts" / "aaw.py"), *args],
            cwd=self.project,
            capture_output=True,
            text=True,
            encoding="utf-8",
            env=env,
        )
        self.assertEqual(
            expect,
            result.returncode,
            msg=f"argv={args!r}\nstdout={result.stdout!r}\nstderr={result.stderr!r}",
        )
        return result

    def installed_version(self) -> str:
        return (self.install / "scripts" / "cli" / "VERSION").read_text("utf-8").strip()

    def handoff_files(self) -> list[Path]:
        return list(self.skills_root.glob(".aaw-handoff-*"))

    def _write_handoff(self, token: str, target_version: str) -> Path:
        path = self.skills_root / ".aaw-handoff-0000000000000001.json"
        path.write_text(json.dumps({
            "schema": 1,
            "token": token,
            "target_version": target_version,
            "created_at": "2026-01-01T00:00:00Z",
        }), "utf-8")
        return path

    # -- query timing ------------------------------------------------------

    def test_start_queries_release_before_creating_workflow(self) -> None:
        result = self.run_cli("start", "--sr", "SR100", "--json")

        json.loads(result.stdout)
        self.assertTrue((self.project / ".sdd" / "SR100" / "workflow.yaml").exists())
        self.assertEqual(1, _CountingHandler.release_queries)

    def test_other_commands_never_query_release(self) -> None:
        self.run_cli("start", "--sr", "SR100", "--json")
        baseline = _CountingHandler.release_queries

        self.run_cli("status", "--json")
        self.run_cli("status", "--sr", "SR100", "--json")
        self.run_cli("next", "--sr", "SR100", "--json")

        self.assertEqual(baseline, _CountingHandler.release_queries)

    def test_start_continues_with_warning_when_server_unreachable(self) -> None:
        result = self.run_cli(
            "start", "--sr", "SR100", "--json",
            extra_env={"AAW_TELEMETRY_ENDPOINT": "http://127.0.0.1:1"},
        )

        json.loads(result.stdout)
        self.assertIn("warning", result.stderr)
        self.assertTrue((self.project / ".sdd" / "SR100" / "workflow.yaml").exists())

    def test_start_with_equal_latest_does_not_update(self) -> None:
        _CountingHandler.releases = {OLD_VERSION: _zip_install(self.install, OLD_VERSION)}

        result = self.run_cli("start", "--sr", "SR100", "--json")

        json.loads(result.stdout)
        self.assertNotIn("更新完成", result.stderr)
        self.assertEqual(OLD_VERSION, self.installed_version())

    # -- successful auto-update + re-exec ---------------------------------

    def test_start_auto_updates_and_reexecs_original_argv(self) -> None:
        _CountingHandler.releases = {NEW_VERSION: _zip_install(self.install, NEW_VERSION)}

        result = self.run_cli("start", "--sr", "SR100", "--json")

        # stdout is pure business JSON from the re-executed new CLI
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual("SR100", payload["sr"])
        self.assertIn("更新完成", result.stderr)
        self.assertEqual(NEW_VERSION, self.installed_version())
        self.assertTrue((self.project / ".sdd" / "SR100" / "workflow.yaml").exists())
        # the re-executed process consumed the handoff instead of querying again
        self.assertEqual(1, _CountingHandler.release_queries)
        self.assertEqual([], self.handoff_files())

    def test_start_update_failure_rolls_back_and_continues(self) -> None:
        # packaged VERSION disagrees with the announced latest: sanity rejects it
        _CountingHandler.releases = {NEW_VERSION: _zip_install(self.install, "9.9.9")}

        result = self.run_cli("start", "--sr", "SR100", "--json")

        json.loads(result.stdout)
        self.assertIn("warning", result.stderr)
        self.assertEqual(OLD_VERSION, self.installed_version())
        self.assertTrue((self.project / ".sdd" / "SR100" / "workflow.yaml").exists())
        residue = [
            p for p in self.skills_root.iterdir()
            if p.name.startswith(".aaw-txn-") or p.name.startswith(".aaw-stage-")
        ]
        self.assertEqual([], residue)

    def test_start_recovers_residue_even_without_new_release(self) -> None:
        # docs §4.2: every command recovers local residue before any network I/O
        tx_dir = self.skills_root / ".aaw-txn-deadbeef"
        tx_dir.mkdir()
        (tx_dir / "transaction.json").write_text(json.dumps({
            "schema": 2,
            "skills_root": str(self.skills_root),
            "skills": ["aaw-workflow"],
            "removed_skills": [],
            "phase": "committed",
            "steps": {},
        }), "utf-8")

        result = self.run_cli("start", "--sr", "SR100", "--json")

        json.loads(result.stdout)
        self.assertFalse(tx_dir.exists())
        self.assertEqual(OLD_VERSION, self.installed_version())

    # -- handoff protocol -------------------------------------------------

    def test_valid_handoff_skips_server_and_is_consumed_once(self) -> None:
        path = self._write_handoff("tok-1", OLD_VERSION)
        env = {"AAW_UPDATE_HANDOFF": str(path), "AAW_UPDATE_HANDOFF_TOKEN": "tok-1"}

        result = self.run_cli("start", "--sr", "SR100", "--json", extra_env=env)

        json.loads(result.stdout)
        self.assertEqual(0, _CountingHandler.release_queries)  # no server query
        self.assertEqual([], self.handoff_files())  # consumed and removed

        # replay with the same environment: the handoff no longer exists
        replay = self.run_cli("start", "--sr", "SR101", "--json", extra_env=env, expect=1)
        self.assertIn("交接文件", replay.stderr)

    def test_forged_handoff_token_is_rejected(self) -> None:
        path = self._write_handoff("real-token", OLD_VERSION)
        env = {"AAW_UPDATE_HANDOFF": str(path), "AAW_UPDATE_HANDOFF_TOKEN": "forged-token"}

        result = self.run_cli("start", "--sr", "SR100", "--json", extra_env=env, expect=1)

        self.assertIn("校验失败", result.stderr)
        self.assertFalse((self.project / ".sdd").exists())

    def test_handoff_version_shortfall_breaks_reexec_loop(self) -> None:
        path = self._write_handoff("tok-1", "99.0.0")
        env = {"AAW_UPDATE_HANDOFF": str(path), "AAW_UPDATE_HANDOFF_TOKEN": "tok-1"}

        result = self.run_cli("start", "--sr", "SR100", "--json", extra_env=env, expect=1)

        self.assertIn("版本校验失败", result.stderr)
        self.assertFalse((self.project / ".sdd").exists())

    def test_handoff_outside_install_is_rejected_without_deleting_file(self) -> None:
        victim = Path(self.tmp.name) / "important.json"
        victim.write_text('{"important": true}', "utf-8")
        env = {
            "AAW_UPDATE_HANDOFF": str(victim),
            "AAW_UPDATE_HANDOFF_TOKEN": "forged-token",
        }

        result = self.run_cli("start", "--sr", "SR100", "--json", extra_env=env, expect=1)

        self.assertIn("不属于当前 AAW 安装", result.stderr)
        self.assertEqual('{"important": true}', victim.read_text("utf-8"))
        self.assertFalse((self.project / ".sdd").exists())


if __name__ == "__main__":
    unittest.main()
