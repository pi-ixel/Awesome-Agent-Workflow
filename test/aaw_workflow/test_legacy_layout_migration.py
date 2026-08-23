from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

from _cli_base import AAW_SCRIPT, SCRIPTS_DIR  # noqa: F401  (adds scripts dir to sys.path)

from cli.legacy_layout_migration import (  # noqa: E402
    MigrationExecutionError,
    build_plan,
    execute_plan,
    format_layout_notice,
)
from cli.legacy_layout_migration.constants import REMOVE_AFTER  # noqa: E402
from cli.models import Step, Workflow, WorkflowError  # noqa: E402
from cli.workflow import WorkflowManager  # noqa: E402


class LegacyLayoutMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.sdd = self.root / ".sdd"
        self.sr = "SR-LEGACY"
        self.ar = "AR-001"
        self.group = "支付审计模块"
        self.requirement = "快速退款"
        root = f".sdd/{self.sr}/{self.ar}"
        prefix = f"{root}/{self.ar}-{self.requirement}-{self.group}"
        self.old_paths = [
            f"{prefix}模块详细设计说明书.context.md",
            f"{prefix}模块详细设计说明书.md",
            f"{prefix}模块测试用例设计.md",
            f"{prefix}模块设计门禁结果.md",
            f"{root}/{self.group}_tasks/overview.md",
        ]
        module_root = f"{root}/{self.group}"
        self.new_paths = [
            f"{module_root}/.context/详细设计上下文.md",
            f"{module_root}/模块详细设计说明书.md",
            f"{module_root}/模块测试用例设计.md",
            f"{module_root}/.context/模块设计门禁结果.md",
            f"{module_root}/tasks-overview.md",
        ]
        scope = {
            "SR": self.sr,
            "AR": self.ar,
            "模块组名": self.group,
            "需求短名": self.requirement,
            "详设路径版本": "v1",
        }
        self.workflow = Workflow(
            sr=self.sr,
            workflow_id="8b7bd968-10f7-4d43-ad4b-8ee23111faef",
            entry="ar",
            vars=dict(scope),
            steps=[
                Step(
                    id=5,
                    type="module-asis-analysis",
                    name="legacy-module-artifacts",
                    finished=True,
                    vars=dict(scope),
                    output=[{"path": path, "required": True} for path in self.old_paths],
                )
            ],
        )
        self.workflow_path = self.sdd / self.sr / "workflow.yaml"
        self.workflow_path.parent.mkdir(parents=True)
        self.workflow.to_yaml(self.workflow_path)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _write_old_files(self) -> None:
        for index, stored_path in enumerate(self.old_paths, start=1):
            path = self.root / stored_path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"artifact-{index}", "utf-8")

    def test_notice_compares_five_files_from_the_ar_root(self) -> None:
        notice = format_layout_notice(self.workflow)
        old_tree, remainder = notice.split("新结构：", 1)
        new_tree = remainder.split("查看并执行迁移：", 1)[0]

        self.assertEqual(2, notice.count(f".sdd/{self.sr}/{self.ar}/"))
        self.assertEqual(5, old_tree.count(".md"))
        self.assertEqual(5, new_tree.count(".md"))
        for name in (
            "模块详细设计说明书.context.md",
            "模块详细设计说明书.md",
            "模块测试用例设计.md",
            "模块设计门禁结果.md",
            "overview.md",
            "详细设计上下文.md",
            "tasks-overview.md",
        ):
            self.assertIn(name, notice)
        self.assertNotIn("哈希", notice)
        self.assertNotIn("v1", notice)
        self.assertNotIn("v2", notice)

    def test_migrates_five_files_one_to_one_and_rewrites_workflow(self) -> None:
        self._write_old_files()
        plan = build_plan(self.root, self.workflow)

        self.assertEqual(5, len(plan.moves))
        self.assertEqual([], plan.unresolved)
        self.assertEqual(5, len({move.target for move in plan.moves}))

        result = execute_plan(self.root, self.workflow_path, self.workflow, plan)

        self.assertEqual("migrated", result["status"])
        self.assertEqual(5, result["moved"])
        for index, (old_path, new_path) in enumerate(zip(self.old_paths, self.new_paths), start=1):
            self.assertFalse((self.root / old_path).exists())
            self.assertEqual(f"artifact-{index}", (self.root / new_path).read_text("utf-8"))
        migrated = Workflow.from_yaml(self.workflow_path)
        self.assertEqual("v2", migrated.vars["详设路径版本"])
        self.assertEqual(self.new_paths, [item["path"] for item in migrated.steps[0].output])
        self.assertFalse((self.root / f".sdd/{self.sr}/{self.ar}/{self.group}_tasks").exists())
        self.assertEqual(self.sr, WorkflowManager(self.sdd).load(self.sr).sr)

    def test_normal_load_refuses_legacy_layout_until_migrated(self) -> None:
        manager = WorkflowManager(self.sdd)

        with self.assertRaises(WorkflowError) as context:
            manager.load(self.sr)

        message = str(context.exception)
        self.assertIn("旧结构", message)
        self.assertIn("新结构", message)
        self.assertIn("migrate-layout", message)

    def test_new_workflow_is_blocked_when_old_files_still_exist_on_disk(self) -> None:
        self._write_old_files()
        self.workflow.vars["详设路径版本"] = "v2"
        self.workflow.steps[0].vars["详设路径版本"] = "v2"
        self.workflow.steps[0].output = []
        self.workflow.to_yaml(self.workflow_path)

        with self.assertRaises(WorkflowError):
            WorkflowManager(self.sdd).load(self.sr)

    def test_existing_target_is_not_overwritten(self) -> None:
        self._write_old_files()
        target = self.root / self.new_paths[0]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("keep-me", "utf-8")
        plan = build_plan(self.root, self.workflow)

        with self.assertRaises(MigrationExecutionError):
            execute_plan(self.root, self.workflow_path, self.workflow, plan)

        self.assertEqual("keep-me", target.read_text("utf-8"))
        self.assertTrue((self.root / self.old_paths[0]).exists())

    def test_unknown_legacy_name_is_delegated_as_structured_resolution(self) -> None:
        unknown = f".sdd/{self.sr}/{self.ar}/手工改名模块详细设计说明书.md"
        self.workflow.steps[0].output.append({"path": unknown, "required": True})

        plan = build_plan(self.root, self.workflow)
        payload = plan.to_dict()

        self.assertEqual([unknown], plan.unresolved)
        self.assertIn("llm_resolution", payload)
        self.assertEqual(5, len(payload["llm_resolution"]["allowed_targets"]))

    def test_cli_previews_then_applies_the_migration(self) -> None:
        self._write_old_files()
        environment = dict(os.environ)
        environment["PYTHONIOENCODING"] = "utf-8"

        preview = subprocess.run(
            [sys.executable, str(AAW_SCRIPT), "migrate-layout", "--sr", self.sr, "--json"],
            cwd=self.root,
            env=environment,
            check=True,
            text=True,
            encoding="utf-8",
            capture_output=True,
        )
        preview_payload = json.loads(preview.stdout)
        self.assertEqual("ready", preview_payload["status"])
        self.assertEqual(5, len(preview_payload["plan"]["moves"]))
        self.assertEqual(
            ["aaw", "migrate-layout", "--sr", self.sr, "--apply", "--json"],
            preview_payload["apply_command_argv"],
        )

        applied = subprocess.run(
            [sys.executable, str(AAW_SCRIPT), "migrate-layout", "--sr", self.sr, "--apply", "--json"],
            cwd=self.root,
            env=environment,
            check=True,
            text=True,
            encoding="utf-8",
            capture_output=True,
        )
        self.assertEqual("migrated", json.loads(applied.stdout)["status"])

    def test_cli_apply_argv_preserves_llm_or_user_mapping(self) -> None:
        unknown = f".sdd/{self.sr}/{self.ar}/手工改名模块详细设计说明书.md"
        self.workflow.steps[0].output[1]["path"] = unknown
        self.workflow.to_yaml(self.workflow_path)
        resolved = f"{unknown}={self.new_paths[1]}"
        environment = dict(os.environ)
        environment["PYTHONIOENCODING"] = "utf-8"

        preview = subprocess.run(
            [
                sys.executable,
                str(AAW_SCRIPT),
                "migrate-layout",
                "--sr",
                self.sr,
                "--map",
                resolved,
                "--json",
            ],
            cwd=self.root,
            env=environment,
            check=True,
            text=True,
            encoding="utf-8",
            capture_output=True,
        )
        payload = json.loads(preview.stdout)

        self.assertEqual("ready", payload["status"])
        self.assertEqual(resolved, payload["apply_command_argv"][-1])


class LegacyLayoutMigrationExpiryTests(unittest.TestCase):
    def test_temporary_migration_must_be_removed_after_one_month(self) -> None:
        self.assertEqual(date(2026, 9, 23), REMOVE_AFTER)
        self.assertLess(
            date.today(),
            REMOVE_AFTER,
            "旧成果物目录迁移功能已到删除期限。请删除 legacy_layout_migration、"
            "migrate-layout 命令、WorkflowManager.load 中的临时 hook 及对应测试；不要延后日期。",
        )


if __name__ == "__main__":
    unittest.main()
