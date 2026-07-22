from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import call, patch

SCRIPTS = Path(__file__).resolve().parents[2] / "skills" / "aaw-workflow" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from cli.telemetry import (  # noqa: E402
    TelemetryClient,
    TelemetryDeliveryError,
    TelemetryError,
    TelemetryStore,
    SnapshotFile,
    _git,
    aaw_version,
    git_user,
    repository_name,
    unix_ms,
)


class TelemetryTests(unittest.TestCase):
    @staticmethod
    def _store(root: Path) -> TelemetryStore:
        return TelemetryStore(root, root / ".aaw" / "telemetry")

    def _workflow(self):
        return SimpleNamespace(
            sr="SR-TIMESTAMPS",
            vars={},
            status="in_progress",
            created_at="2026-07-15T01:00:00Z",
        )

    def _step(self):
        return SimpleNamespace(
            id=1,
            type="module-design-gate",
            attempt=1,
            vars={},
            started_at="2026-07-15T01:02:03Z",
            ended_at="2026-07-15T01:07:03Z",
        )

    def _dev_step(self):
        return SimpleNamespace(
            id=2,
            type="task-dev",
            name="T1-task-dev",
            attempt=1,
            execution="skill",
            skill=["task-dev"],
            vars={"序号": 1},
            result_data={
                "task_id": "T1",
                "workflow_source": "repository",
                "implementation": "completed",
                "tests": "passed",
                "review_and_optimization": "completed",
                "revalidation": "passed",
            },
            started_at="2026-07-15T01:02:03Z",
            ended_at="2026-07-15T01:07:03Z",
        )

    def _message(self, store: TelemetryStore, step=None):
        with (
            patch("cli.telemetry.git_user", return_value=("developer@example.com", "Z12345678")),
            patch("cli.telemetry.repository_name", return_value="example-service"),
        ):
            return store.step_message(self._workflow(), step or self._step(), "done")

    def test_repository_name_omits_organization(self) -> None:
        for remote in (
            "https://github.com/pi-ixel/Awesome-Agent-Workflow.git",
            "git@github.com:pi-ixel/Awesome-Agent-Workflow.git",
        ):
            with self.subTest(remote=remote), patch(
                "cli.telemetry._git",
                side_effect=["new_CLI", "upstream", remote],
            ):
                self.assertEqual("Awesome-Agent-Workflow", repository_name(Path.cwd()))

    def test_repository_name_uses_current_branch_tracking_remote(self) -> None:
        root = Path.cwd()
        with patch(
            "cli.telemetry._git",
            side_effect=["feature", "company", "ssh://git@example.test/team/service.git"],
        ) as git:
            self.assertEqual("service", repository_name(root))

        self.assertEqual(
            [
                call(["branch", "--show-current"], root),
                call(["config", "--get", "branch.feature.remote"], root),
                call(["remote", "get-url", "company"], root),
            ],
            git.call_args_list,
        )

    def test_repository_name_uses_origin_without_tracking_remote(self) -> None:
        with patch(
            "cli.telemetry._git",
            side_effect=[None, "https://example.test/team/origin-service.git"],
        ):
            self.assertEqual("origin-service", repository_name(Path.cwd()))

    def test_repository_name_uses_only_configured_remote(self) -> None:
        with patch(
            "cli.telemetry._git",
            side_effect=[None, None, "company", "https://example.test/team/only-service.git"],
        ):
            self.assertEqual("only-service", repository_name(Path.cwd()))

    def test_repository_name_falls_back_to_git_top_level(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "fallback-service"
            root.mkdir()
            with patch(
                "cli.telemetry._git",
                side_effect=[None, None, "company\nupstream", str(root)],
            ):
                self.assertEqual("fallback-service", repository_name(root))

    def test_git_trusts_only_the_explicit_workflow_root(self) -> None:
        root = Path.cwd()
        completed = SimpleNamespace(returncode=0, stdout="origin-url\n")
        with patch("cli.telemetry.subprocess.run", return_value=completed) as run:
            self.assertEqual("origin-url", _git(["remote", "get-url", "origin"], root))

        command = run.call_args.args[0]
        self.assertEqual("git", command[0])
        self.assertEqual("-c", command[1])
        self.assertEqual(f"safe.directory={root.resolve().as_posix()}", command[2])
        self.assertEqual(["remote", "get-url", "origin"], command[3:])

    def test_git_name_is_reported_as_display_name(self) -> None:
        with patch("cli.telemetry._git", side_effect=["developer@example.com", "Developer"]), patch.dict(os.environ, {}, clear=True):
            self.assertEqual(("developer@example.com", "Developer"), git_user(Path.cwd()))

    def test_missing_git_name_falls_back_to_email_local_part(self) -> None:
        with patch("cli.telemetry._git", side_effect=["developer@example.com", None]), patch.dict(os.environ, {}, clear=True):
            self.assertEqual(("developer@example.com", "developer"), git_user(Path.cwd()))

    def test_default_telemetry_storage_is_in_user_home(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TelemetryStore(Path(temp))
        self.assertEqual((Path.home() / ".aaw" / "telemetry").resolve(), store.dir)

    def test_unix_ms_matches_server_whole_second_precision(self) -> None:
        self.assertEqual(1784193036000, unix_ms("2026-07-16T09:10:35.953123+00:00"))
        self.assertEqual(1784193041000, unix_ms("2026-07-16T09:10:40.744705Z"))

    def test_version_falls_back_when_version_file_is_missing(self) -> None:
        with patch("cli.version.Path.read_text", side_effect=FileNotFoundError("no VERSION file")):
            self.assertEqual("0.0.0", aaw_version())

    def test_step_message_is_built_in_memory_from_yaml_timestamps(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = self._store(Path(temp))
            message = self._message(store)
            self.assertFalse(store.dir.exists())
        self.assertEqual("example-service", message["repository"])
        self.assertEqual("done", message["data"]["status"])
        self.assertEqual(1, message["data"]["step_id"])
        self.assertEqual("module-design-gate", message["data"]["step_name"])
        self.assertEqual(1, message["data"]["attempt"])
        self.assertEqual("skill", message["data"]["execution_type"])
        self.assertEqual(["module-design-gate"], message["data"]["skill_names"])
        self.assertEqual(1784077323000, message["data"]["started_at"])
        self.assertEqual(1784077623000, message["data"]["completed_at"])
        self.assertIsNone(message["data"]["file"])

    def test_start_step_message_allows_null_completed_at(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = self._store(Path(temp))
            step = self._step()
            with (
                patch("cli.telemetry.git_user", return_value=("developer@example.com", "Z12345678")),
                patch("cli.telemetry.repository_name", return_value="example-service"),
            ):
                message = store.step_message(self._workflow(), step, "start")

        self.assertEqual("start", message["data"]["status"])
        self.assertEqual(1784077323000, message["data"]["started_at"])
        self.assertIsNone(message["data"]["completed_at"])
        self.assertIsNone(message["completed_at"])
        self.assertEqual(message["data"]["started_at"], message["updated_at"])
        self.assertIsNone(message["data"]["file"])

    def test_task_dev_done_reports_task_identity_and_development_summary(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = self._store(Path(temp))
            with (
                patch("cli.telemetry.git_user", return_value=("developer@example.com", "Z12345678")),
                patch("cli.telemetry.repository_name", return_value="example-service"),
            ):
                message = store.step_message(
                    self._workflow(),
                    self._dev_step(),
                    "done",
                    file={"file_name": "T1.diff", "sha256": "a" * 64},
                )

        self.assertEqual("T1", message["data"]["task_id"])
        self.assertEqual("T1-task-dev", message["data"]["step_name"])
        self.assertEqual("passed", message["data"]["development"]["tests"])

    def test_step_message_id_is_stable_for_same_status_and_attempt(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = self._store(Path(temp))
            with (
                patch("cli.telemetry.git_user", return_value=("developer@example.com", "Z12345678")),
                patch("cli.telemetry.repository_name", return_value="example-service"),
            ):
                first = store.step_message(self._workflow(), self._step(), "done")
                second = store.step_message(self._workflow(), self._step(), "done")
                started = store.step_message(self._workflow(), self._step(), "start")

        self.assertEqual(first["message_id"], second["message_id"])
        self.assertNotEqual(first["message_id"], started["message_id"])

    def test_send_posts_message_directly_without_queue(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = self._store(Path(temp))
            message = self._message(store)
            seen = []

            def accept(url, method, body, headers=None):
                seen.append((url, method, headers))
                return 200, {"message_id": message["message_id"], "status": "accepted", "error": None}

            client = TelemetryClient(Path(temp))
            client.endpoint = "https://telemetry.example.test"
            client._request = staticmethod(accept)
            result = client.send(message)
            self.assertEqual("accepted", result["status"])
            self.assertFalse(store.dir.exists())
        self.assertEqual("https://telemetry.example.test/api/v1/telemetry/sync", seen[0][0])
        self.assertEqual("POST", seen[0][1])
        self.assertNotIn("Authorization", seen[0][2])

    def test_rejected_message_is_not_persisted_for_retry(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = self._store(Path(temp))
            message = self._message(store)
            client = TelemetryClient(Path(temp))
            client._request = staticmethod(
                lambda *_args, **_kwargs: (400, {"code": "INVALID_REQUEST", "message": "bad data", "retryable": False})
            )
            with self.assertRaisesRegex(TelemetryError, "INVALID_REQUEST: bad data"):
                client.send(message)
            self.assertFalse(store.dir.exists())

    def test_retryable_failure_is_persisted_and_retried(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            telemetry_dir = root / ".aaw" / "telemetry"
            message = self._message(self._store(root))
            client = TelemetryClient(root, telemetry_dir)

            def unavailable(*_args, **_kwargs):
                raise TelemetryDeliveryError("network unavailable", retryable=True)

            client._request = staticmethod(unavailable)
            with self.assertRaisesRegex(TelemetryError, "network unavailable"):
                client.send(message)
            pending = telemetry_dir / "pending" / f"{message['message_id']}.json"
            self.assertTrue(pending.exists())

            client._request = staticmethod(
                lambda *_args, **_kwargs: (
                    200,
                    {"message_id": message["message_id"], "status": "duplicate", "error": None},
                )
            )
            self.assertEqual(1, client.retry_pending())
            self.assertFalse(pending.exists())

    def test_dev_diff_is_uploaded_only_after_message_acceptance(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            patch_path = root / "step.diff"
            patch_path.write_bytes(b"diff bytes")
            state = {
                "patch_path": str(patch_path),
                "file": {"file_name": "step.diff", "sha256": "a" * 64},
                "size_bytes": 10,
            }
            message = self._message(self._store(root))
            message["message_id"] = "message-1"
            seen = []

            def accept(url, method, body, headers=None):
                seen.append((url, method, body, headers))
                if url.endswith("/telemetry/sync"):
                    return 200, {"message_id": "message-1", "status": "accepted", "error": None}
                return 200, {"message_id": "message-1", "status": "confirmed", "sha256": "a" * 64}

            client = TelemetryClient(root)
            client.endpoint = "https://telemetry.example.test"
            client._request = staticmethod(accept)
            result = client.send(message, state)
            self.assertEqual(1, result["uploaded"])
            self.assertEqual(["POST", "PUT"], [request[1] for request in seen])
            self.assertEqual(
                "https://telemetry.example.test/api/v1/objects/step-diffs/message-1",
                seen[1][0],
            )
            self.assertEqual(b"diff bytes", seen[1][2])
            self.assertEqual("application/octet-stream", seen[1][3]["Content-Type"])

    def test_task_dev_temporary_files_are_cleaned_after_done(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = self._store(Path(temp))
            workflow = self._workflow()
            step = self._dev_step()
            with (
                patch("cli.telemetry.repository_name", return_value="example-service"),
                patch.object(
                    store,
                    "_worktree_files",
                    return_value=({"src/service.py": SnapshotFile(b"before\n")}, []),
                ),
            ):
                store.dev_started(workflow, step)
            with (
                patch("cli.telemetry.repository_name", return_value="example-service"),
                patch.object(
                    store,
                    "_worktree_files",
                    return_value=({"src/service.py": SnapshotFile(b"after\n")}, []),
                ),
            ):
                state = store.dev_finished(workflow, step)
                self.assertTrue(Path(state["state_path"]).exists())
                self.assertTrue(Path(state["patch_path"]).exists())
                repo_path = store._dev_repo_path(workflow, step, 1)
                self.assertTrue(repo_path.exists())
                store.cleanup_step(workflow, step, 1, state)
            self.assertFalse(Path(state["state_path"]).exists())
            self.assertFalse(Path(state["patch_path"]).exists())
            self.assertFalse(repo_path.exists())

    def test_task_dev_start_reuses_existing_baseline(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            store = self._store(root)
            workflow = self._workflow()
            step = self._dev_step()
            with (
                patch("cli.telemetry.repository_name", return_value="example-service"),
                patch.object(
                    store,
                    "_worktree_files",
                    return_value=({"src/service.py": SnapshotFile(b"before\n")}, []),
                ) as snapshot,
            ):
                first = store.dev_started(workflow, step)
                second = store.dev_started(workflow, step)
                store.cleanup_step(workflow, step, 1)

            self.assertEqual(first, second)
            snapshot.assert_called_once()

    def test_git_patch_uses_dirty_d0_and_is_git_apply_compatible(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            subprocess.run(["git", "init", "--quiet"], cwd=root, check=True)
            source = root / "src" / "service.py"
            binary = root / "assets" / "probe.bin"
            markdown = root / "docs" / "README.MD"
            unchanged = root / "dirty-unchanged.txt"
            source.parent.mkdir(parents=True)
            binary.parent.mkdir(parents=True)
            markdown.parent.mkdir(parents=True)
            source.write_text("value = 'committed'\n", "utf-8")
            binary.write_bytes(b"\x00dirty-before-dev")
            markdown.write_text("before task-dev\n", "utf-8")
            unchanged.write_text("already dirty\n", "utf-8")
            subprocess.run(["git", "add", "src/service.py"], cwd=root, check=True)
            source.write_text("value = 'dirty-before-dev'\n", "utf-8")

            store = self._store(root)
            workflow = self._workflow()
            step = self._dev_step()
            with patch("cli.telemetry.repository_name", return_value="example-service"):
                baseline = store.dev_started(workflow, step)
                self.assertIn("d0_tree", baseline)
                self.assertNotIn("snapshot", baseline)
                source.write_text("value = 'changed-during-dev'\n", "utf-8")
                binary.write_bytes(b"\x00changed-during-dev")
                markdown.write_text("changed during task-dev\n", "utf-8")
                state = store.dev_finished(workflow, step)

            patch_path = Path(state["patch_path"])
            patch_text = patch_path.read_text("utf-8")
            self.assertIn("dirty-before-dev", patch_text)
            self.assertIn("changed-during-dev", patch_text)
            self.assertNotIn("probe.bin", patch_text)
            self.assertNotIn("README.MD", patch_text)
            self.assertNotIn("GIT binary patch", patch_text)
            self.assertNotIn("dirty-unchanged.txt", patch_text)
            self.assertEqual(1, state["code_statistics"]["files_changed"])
            self.assertEqual(1, state["code_statistics"]["total_effective_lines"])

            source.write_text("value = 'dirty-before-dev'\n", "utf-8")
            binary.write_bytes(b"\x00dirty-before-dev")
            check = subprocess.run(
                ["git", "apply", "--check", str(patch_path)],
                cwd=root,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
            self.assertEqual(0, check.returncode, check.stderr)

    def test_symlink_snapshot_records_link_without_reading_target(self) -> None:
        with tempfile.TemporaryDirectory() as temp, tempfile.TemporaryDirectory() as external:
            root = Path(temp)
            subprocess.run(["git", "init", "--quiet"], cwd=root, check=True)
            target = Path(external) / "outside.txt"
            target.write_text("must not enter telemetry\n", "utf-8")
            link = root / "external-link.txt"
            try:
                link.symlink_to(target)
            except OSError as exc:
                self.skipTest(f"symlinks are unavailable: {exc}")

            store = self._store(root)
            files, _flags = store._worktree_files()
            entry = files["external-link.txt"]
            self.assertEqual("120000", entry.mode)
            self.assertEqual(os.fsencode(os.readlink(link)), entry.content)
            self.assertNotIn(b"must not enter telemetry", entry.content)

            workflow = self._workflow()
            step = self._dev_step()
            with patch("cli.telemetry.repository_name", return_value="example-service"):
                state = store.dev_started(workflow, step)
                repo_path = store._dev_repo_path(workflow, step, 1)
                tree_entry = subprocess.run(
                    ["git", f"--git-dir={repo_path}", "ls-tree", state["d0_tree"], "--", "external-link.txt"],
                    check=True,
                    text=True,
                    stdout=subprocess.PIPE,
                ).stdout
                store.cleanup_step(workflow, step, 1)
            self.assertTrue(tree_entry.startswith("120000 blob "))

    def test_snapshot_tree_preserves_symlink_mode(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            store = self._store(root)
            workflow = self._workflow()
            step = self._dev_step()
            with (
                patch("cli.telemetry.repository_name", return_value="example-service"),
                patch.object(
                    store,
                    "_worktree_files",
                    return_value=({"link.txt": SnapshotFile(b"../outside.txt", "120000")}, []),
                ),
            ):
                state = store.dev_started(workflow, step)
                repo_path = store._dev_repo_path(workflow, step, 1)
                tree_entry = subprocess.run(
                    ["git", f"--git-dir={repo_path}", "ls-tree", state["d0_tree"], "--", "link.txt"],
                    check=True,
                    text=True,
                    stdout=subprocess.PIPE,
                ).stdout
                store.cleanup_step(workflow, step, 1)
            self.assertTrue(tree_entry.startswith("120000 blob "))


if __name__ == "__main__":
    unittest.main()
