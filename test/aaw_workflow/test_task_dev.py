from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "skills" / "aaw-workflow" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from cli.models import Step, Workflow  # noqa: E402
from cli import main as cli_main  # noqa: E402
from cli.task_dev import REVIEW_DIMENSIONS, TaskDevError  # noqa: E402
from cli.workflow import WorkflowManager  # noqa: E402


class TaskDevStateMachineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        subprocess.run(["git", "init", "--quiet"], cwd=self.root, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=self.root, check=True)
        subprocess.run(["git", "config", "user.name", "AAW Test"], cwd=self.root, check=True)

        self.source = self.root / "src" / "example.py"
        self.overview = self.root / ".sdd" / "SR-1" / "AR-1" / "示例模块" / "tasks-overview.md"
        self.source.parent.mkdir(parents=True)
        self.overview.parent.mkdir(parents=True)
        self.source.write_text("VALUE = 1\n", "utf-8")
        self.overview.write_text("# tasks\n\n## 执行记录\n\n", "utf-8")
        subprocess.run(["git", "add", "--", "src/example.py", ".sdd/SR-1/AR-1/示例模块/tasks-overview.md"], cwd=self.root, check=True)
        subprocess.run(["git", "commit", "--quiet", "-m", "baseline"], cwd=self.root, check=True)

        self.manager = WorkflowManager(self.root / ".sdd")
        schema = self.manager.templates["task-dev"]["data_schema"]
        self.step = Step(
            id=10,
            type="task-dev",
            name="T1-task-dev",
            execution="skill",
            execution_status="running",
            attempt=1,
            started_at="2026-08-09T00:00:00Z",
            input=[{"path": ".sdd/SR-1/AR-1/示例模块/tasks-overview.md", "required": True}],
            data_schema=schema,
            vars={"序号": 1},
        )
        self.workflow = Workflow(
            sr="SR-1",
            workflow_id=str(uuid.uuid4()),
            created_at="2026-08-09T00:00:00Z",
            vars={"SR": "SR-1", "AR": "AR-1"},
            steps=[self.step],
        )
        self.task_dev = self.manager.task_dev
        self.task_dev.ensure_initialized(self.workflow, self.step)
        self.manager._save(self.workflow)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _write_phase_report(self, phase: str, data: dict) -> Path:
        path = self.task_dev._phase_file(self.workflow, self.step, phase)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
        return path

    def _next(self) -> dict:
        payload = self.manager.build_next_payload(self.workflow)
        return payload["ready"][0]["task_dev"]

    def _implemented(self) -> None:
        self.source.write_text("VALUE = 2\n", "utf-8")
        self._write_phase_report(
            "implemented",
            {
                "implementation": "completed",
                "tests": "passed",
                "checks": [{"name": "unit-tests", "status": "passed"}],
            },
        )
        self.assertEqual("implemented", self._next()["status"])

    def test_task_dev_next_payload_uses_compact_work_order(self) -> None:
        payload = self.manager.build_next_payload(self.workflow)
        order = payload["ready"][0]

        self.assertEqual(
            {
                "id",
                "type",
                "name",
                "execution",
                "session",
                "execution_status",
                "attempt",
                "started_at",
                "skill",
                "input",
                "task_dev",
            },
            set(order),
        )
        self.assertNotIn("commands", order)
        self.assertNotIn("data", order)
        self.assertNotIn("deliverables", order)
        self.assertNotIn("state_path", order["task_dev"])
        self.assertNotIn("completed_phases", order["task_dev"]["guidance"])
        self.assertNotIn("evidence_refs", order["task_dev"]["guidance"])
        self.assertLess(len(json.dumps(payload, ensure_ascii=False)), 4_000)

    def test_review_guidance_keeps_code_read_only_until_report_is_accepted(self) -> None:
        self._implemented()
        guidance = self._next()["guidance"]
        self.assertIn(
            "Neither the main Agent nor the Reviewers may modify code before the Review report is accepted",
            guidance["forbidden_actions"],
        )
        self.assertIn(
            "Merge their reports and write review-report.json for the current code digest before fixing any code",
            guidance["required_actions"],
        )

    def test_task_dev_cli_guidance_is_english_only(self) -> None:
        initial = json.dumps(self._next()["guidance"], ensure_ascii=False)
        self.assertIsNone(re.search(r"[\u3400-\u9fff]", initial))

        self._implemented()
        review = json.dumps(self._next()["guidance"], ensure_ascii=False)
        self.assertIsNone(re.search(r"[\u3400-\u9fff]", review))

    def _reviewed(self, *, with_finding: bool = True) -> None:
        digest = self.task_dev.guidance(self.workflow, self.step)["validated_code_digest"]
        findings = []
        verdict = "pass"
        if with_finding:
            verdict = "fail"
            findings = [
                {
                    "id": "REV-001",
                    "severity": "high",
                    "dimension": "evolution",
                    "subcategory": "upgrade_compatibility",
                    "file": "src/example.py",
                    "line": 1,
                    "evidence": "constant value is incompatible with the required mixed-version behavior",
                    "impact": "old consumers can observe an unsupported value",
                    "recommendation": "use the compatible value and retain a regression test",
                    "status": "open",
                }
            ]
        self._write_phase_report(
            "reviewed",
            {
                "schema_version": 1,
                "task_id": "T1",
                "validated_code_digest": digest,
                "verdict": verdict,
                "reviewers": [
                    {"role": "reviewer-a", "status": "completed", "report_ref": "reviewer-a.json"},
                    {"role": "reviewer-b", "status": "completed", "report_ref": "reviewer-b.json"},
                ],
                "covered_dimensions": sorted(REVIEW_DIMENSIONS),
                "applied_extension_rule_ids": [],
                "findings": findings,
            },
        )
        self.assertEqual("reviewed", self._next()["status"])

    def _revalidated(self) -> None:
        self.source.write_text("VALUE = 3\n", "utf-8")
        digest = self.task_dev.guidance(self.workflow, self.step)["validated_code_digest"]
        self._write_phase_report(
            "revalidated",
            {
                "status": "passed",
                "validated_code_digest": digest,
                "open_blocking_findings": [],
                "finding_resolutions": [
                    {"id": "REV-001", "status": "fixed", "rationale": "compatible behavior restored"}
                ],
                "semantic_impact": "compatibility",
                "targeted_review_required": True,
                "targeted_review_refs": ["reviewer-a-targeted.json"],
                "checks": [{"name": "affected-tests", "status": "passed"}],
            },
        )
        self.assertEqual("revalidated", self._next()["status"])

    def test_full_flow_prepares_message_without_add_or_commit_and_done_returns_stop(self) -> None:
        initial_head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.root, text=True).strip()
        initial_index = subprocess.check_output(["git", "write-tree"], cwd=self.root, text=True).strip()
        first = self.task_dev.guidance(self.workflow, self.step)
        self.assertEqual("implementation", first["guidance"]["current_phase"])
        self.assertNotIn("done_argv", first["commands"])

        self._implemented()
        self._reviewed()
        self._revalidated()
        codecheck = self.task_dev.guidance(self.workflow, self.step)
        self.assertEqual("codecheck", codecheck["guidance"]["current_phase"])
        self.assertTrue(Path(codecheck["guidance"]["instruction_refs"][0]).is_file())
        self.assertNotIn("subagent", codecheck["guidance"])
        self.assertNotIn("codecheck_argv", codecheck["commands"])

        self.overview.write_text(
            "# tasks\n\n## 执行记录\n\n### T1：example\n\n"
            "- 状态：Completed\n"
            "- 修改文件：src/example.py\n"
            "- 核心实现：updated example\n"
            "- 设计偏差：无\n"
            "- 待处理：无\n"
            "- 后续须知：无\n"
            "- 证据：AAW step 10 attempt 1\n",
            "utf-8",
        )
        self._write_phase_report(
            "prepared",
            {
                "proposed_commit_message": "feat(T1): update example validation",
                "message_basis": "implement the reviewed validation design and verified behavior",
                "diff_confirmed": True,
            },
        )
        # Persisted workflows may still carry the removed completion schema.
        # task-dev must ignore it and return a data-free done command.
        self.step.data_schema = {"fields": {"legacy": {"required": True, "type": "string"}}}
        prepared = self._next()
        self.assertEqual("prepared", prepared["status"])
        self.assertEqual({"task_id", "status", "guidance", "commands"}, set(prepared))
        self.assertNotIn("--data", prepared["commands"]["done_argv"])
        self.assertNotIn("data_file", prepared["commands"])
        state = self.task_dev.load(self.workflow, self.step)
        result = self.manager.mark_done(self.workflow, self.step.id)
        self.assertEqual("stop", result["task_dev"]["guidance"]["directive"])
        self.assertEqual({"task_id", "status", "guidance"}, set(result["task_dev"]))
        self.assertNotIn("result_data", result)
        self.assertEqual("T1", self.step.result_data["task_id"])
        self.assertEqual("passed", self.step.result_data["tests"])
        self.assertEqual(state["validated_code_digest"], self.step.result_data["validated_code_digest"])
        self.assertEqual(state["changed_files"], self.step.result_data["changed_files"])
        self.assertEqual(state["proposed_commit_message"], self.step.result_data["proposed_commit_message"])
        self.assertNotIn("checks", self.step.result_data)
        self.assertEqual(initial_head, subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.root, text=True).strip())
        self.assertEqual(initial_index, subprocess.check_output(["git", "write-tree"], cwd=self.root, text=True).strip())
        self.assertEqual("", subprocess.check_output(["git", "diff", "--cached", "--name-only"], cwd=self.root, text=True).strip())

    def test_codecheck_fix_invalidates_revalidation_and_reinvokes_skill(self) -> None:
        self._implemented()
        self._reviewed()
        self._revalidated()
        guidance = self.task_dev.guidance(self.workflow, self.step)
        self.assertIn("code-check skill", " ".join(guidance["guidance"]["required_actions"]))
        self.assertIn("ask the user", " ".join(guidance["guidance"]["required_actions"]))

        self.source.write_text("VALUE = 4\n", "utf-8")
        invalidated = self.task_dev.guidance(self.workflow, self.step)
        self.assertEqual("reviewed", invalidated["status"])
        self.assertEqual("revalidation", invalidated["guidance"]["current_phase"])

        digest = invalidated["validated_code_digest"]
        self._write_phase_report(
            "revalidated",
            {
                "status": "passed",
                "validated_code_digest": digest,
                "open_blocking_findings": [],
                "finding_resolutions": [],
                "semantic_impact": "none",
                "targeted_review_required": False,
                "targeted_review_refs": [],
                "checks": [{"name": "affected-tests", "status": "passed"}],
            },
        )
        retry = self._next()
        self.assertEqual("revalidated", retry["status"])
        self.assertEqual("codecheck", retry["guidance"]["current_phase"])
        self.assertTrue(Path(retry["guidance"]["instruction_refs"][0]).is_file())

    def test_early_done_is_rejected_with_current_guidance(self) -> None:
        with self.assertRaises(TaskDevError) as caught:
            self.task_dev.ensure_done_ready(self.workflow, self.step)
        self.assertIsNotNone(caught.exception.payload)
        self.assertEqual("implementation", caught.exception.payload["guidance"]["current_phase"])

    def test_status_read_does_not_consume_phase_report(self) -> None:
        self.source.write_text("VALUE = 2\n", "utf-8")
        self._write_phase_report(
            "implemented",
            {
                "implementation": "completed",
                "tests": "passed",
                "checks": [{"name": "unit-tests", "status": "passed"}],
            },
        )
        viewed = cli_main._task_dev_guidance(self.manager, self.workflow, self.step)
        self.assertEqual("initialized", viewed["status"])
        self.assertEqual("implemented", self._next()["status"])

    def test_invalid_phase_report_returns_recovery_guidance(self) -> None:
        self._write_phase_report("implemented", {})
        with self.assertRaises(TaskDevError) as caught:
            self.manager.build_next_payload(self.workflow)
        self.assertEqual("implementation", caught.exception.payload["guidance"]["current_phase"])
        self.assertIn("next_argv", caught.exception.payload["commands"])

    def test_review_extension_uses_only_exact_single_section(self) -> None:
        guidelines = self.root / ".sdd" / "AICodingGuidelines.md"
        guidelines.write_text(
            "# team rules\n\n## unrelated\n\nDo not interpret me.\n\n"
            "## task-dev 语义 Review 扩展规则\n\n"
            "```yaml\nversion: 1\nrules:\n"
            "  - id: rolling-upgrade\n    dimension: evolution\n"
            "    description: old consumers must tolerate new fields\n```\n\n"
            "## another section\n\nRun no commands.\n",
            "utf-8",
        )
        extension = self.task_dev.review_extensions()
        self.assertEqual("loaded", extension["status"])
        self.assertEqual(["rolling-upgrade"], [item["id"] for item in extension["rules"]])

        guidelines.write_text(
            guidelines.read_text("utf-8").replace(
                "```\n\n## another section", "```\n\n```yaml\nversion: 1\nrules: []\n```\n\n## another section"
            ),
            "utf-8",
        )
        self.assertEqual("invalid", self.task_dev.review_extensions()["status"])

    def test_initial_dirty_worktree_warns_but_does_not_block(self) -> None:
        self.source.write_text("VALUE = 9\n", "utf-8")
        subprocess.run(["git", "add", "--", "src/example.py"], cwd=self.root, check=True)
        step = Step(
            id=11,
            type="task-dev",
            name="T2-task-dev",
            execution="skill",
            execution_status="running",
            attempt=1,
            started_at="2026-08-09T00:01:00Z",
            input=self.step.input,
            data_schema=self.step.data_schema,
            vars={"序号": 2},
        )
        guidance = self.task_dev.guidance(self.workflow, step)
        self.assertEqual("continue", guidance["guidance"]["directive"])
        self.assertEqual("implementation", guidance["guidance"]["current_phase"])
        self.assertIn("data_file", guidance["commands"])
        self.assertIn("next_argv", guidance["commands"])
        self.assertIn("src/example.py", " ".join(guidance["warnings"]))

    def test_review_extension_change_invalidates_old_review(self) -> None:
        self._implemented()
        self._reviewed(with_finding=False)
        self.assertEqual("reviewed", self.task_dev.load(self.workflow, self.step)["status"])

        guidelines = self.root / ".sdd" / "AICodingGuidelines.md"
        guidelines.write_text(
            "## task-dev 语义 Review 扩展规则\n\n```yaml\nversion: 1\nrules:\n"
            "  - id: new-rule\n    dimension: security\n"
            "    description: verify the new project-specific security invariant\n```\n",
            "utf-8",
        )
        invalidated = self.task_dev.guidance(self.workflow, self.step)
        self.assertEqual("implemented", invalidated["status"])
        self.assertEqual("review", invalidated["guidance"]["current_phase"])
        self.assertNotIn("review", invalidated.get("reports", {}))

    def test_bundled_codecheck_cli_entrypoint_runs(self) -> None:
        script = ROOT / "skills" / "code-check" / "scripts" / "codecheck.py"
        report_path = self.root / "mock-report.json"
        result = subprocess.run(
            [sys.executable, str(script), "--report", str(report_path), "--ignored-future-arg"],
            cwd=self.root,
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual(0, result.returncode)
        self.assertEqual("CodeCheck passed completely", result.stdout.strip())
        self.assertEqual("pass", json.loads(report_path.read_text("utf-8"))["verdict"])

        malformed = subprocess.run(
            [sys.executable, str(script), "--report"],
            cwd=self.root,
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual(0, malformed.returncode)
        self.assertEqual("CodeCheck passed completely", malformed.stdout.strip())

    def test_task_dev_references_only_contain_agent_facing_resources(self) -> None:
        references = ROOT / "skills" / "task-dev" / "references"
        self.assertEqual(
            {
                "AICodingGuidelines.md",
                "revalidation-report.schema.json",
                "review-report.schema.json",
                "semantic-review-prompt.md",
            },
            {path.name for path in references.iterdir() if path.is_file()},
        )
        cli_schemas = ROOT / "skills" / "aaw-workflow" / "scripts" / "cli" / "schemas"
        self.assertFalse((cli_schemas / "codecheck-report.schema.json").exists())
        self.assertTrue((cli_schemas / "task-state.schema.json").is_file())
        command_names = {command.name for command in cli_main.app.registered_commands}
        self.assertNotIn("task-status", command_names)
        self.assertNotIn("task-checkpoint", command_names)
        self.assertNotIn("task-codecheck", command_names)
        self.assertNotIn("task-stage", command_names)
        self.assertNotIn("task-rebaseline", command_names)

    def test_codecheck_guidance_uses_skill_without_external_config(self) -> None:
        self._implemented()
        self._reviewed()
        self._revalidated()
        guidance = self.task_dev.guidance(self.workflow, self.step)
        self.assertEqual("continue", guidance["guidance"]["directive"])
        self.assertNotIn("subagent", guidance["guidance"])
        self.assertNotIn("codecheck_argv", guidance["commands"])
        self.assertTrue(guidance["guidance"]["instruction_refs"][0].endswith("code-check/SKILL.md"))

    def test_legacy_codecheck_state_reenters_standalone_skill_phase(self) -> None:
        self._implemented()
        self._reviewed()
        self._revalidated()
        state = self.task_dev.load(self.workflow, self.step)
        state["status"] = "codecheck_passed"
        state["last_codecheck"] = {"verdict": "pass"}
        state["codecheck_digest"] = state["validated_code_digest"]
        state["reports"]["codecheck"] = "legacy-report.json"
        self.task_dev.save(self.workflow, self.step, state)

        guidance = self.task_dev.guidance(self.workflow, self.step)
        migrated = self.task_dev.load(self.workflow, self.step)
        self.assertEqual("revalidated", guidance["status"])
        self.assertEqual("codecheck", guidance["guidance"]["current_phase"])
        self.assertNotIn("codecheck", migrated["reports"])
        self.assertNotIn("last_codecheck", migrated)
        self.assertNotIn("codecheck_digest", migrated)

    def test_index_change_does_not_block_workflow(self) -> None:
        self._implemented()
        subprocess.run(["git", "add", "--", "src/example.py"], cwd=self.root, check=True)
        guidance = self.task_dev.guidance(self.workflow, self.step)
        self.assertEqual("continue", guidance["guidance"]["directive"])
        self.assertEqual("review", guidance["guidance"]["current_phase"])
        self.assertIn("src/example.py", guidance["changed_files"])

    def test_commit_and_amend_during_task_preserve_scope_through_done(self) -> None:
        self._implemented()
        self._reviewed()
        self._revalidated()
        before = self.task_dev.guidance(self.workflow, self.step)
        subprocess.run(["git", "add", "--", "src/example.py"], cwd=self.root, check=True)
        subprocess.run(["git", "commit", "--quiet", "-m", "checkpoint"], cwd=self.root, check=True)
        committed_head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.root, text=True).strip()
        subprocess.run(
            ["git", "commit", "--quiet", "--amend", "--no-edit", "--date=2026-08-29T12:00:00+08:00"],
            cwd=self.root,
            check=True,
        )
        amended_head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.root, text=True).strip()
        self.assertNotEqual(committed_head, amended_head)

        after = self.task_dev.guidance(self.workflow, self.step)
        self.assertEqual("continue", after["guidance"]["directive"])
        self.assertEqual("revalidated", after["status"])
        self.assertEqual("codecheck", after["guidance"]["current_phase"])
        self.assertEqual(before["validated_code_digest"], after["validated_code_digest"])
        self.assertIn("src/example.py", after["changed_files"])

        self.overview.write_text(
            "# tasks\n\n## 执行记录\n\n### T1：example\n\n"
            "- 状态：Completed\n"
            "- 修改文件：src/example.py\n"
            "- 核心实现：updated example\n"
            "- 设计偏差：无\n"
            "- 待处理：无\n"
            "- 后续须知：无\n"
            "- 证据：AAW step 10 attempt 1\n",
            "utf-8",
        )
        self._write_phase_report(
            "prepared",
            {
                "proposed_commit_message": "feat(T1): update example validation",
                "message_basis": "implement and validate the reviewed behavior",
                "diff_confirmed": True,
            },
        )
        prepared = self._next()
        self.assertEqual("prepared", prepared["status"])
        result = self.manager.mark_done(self.workflow, self.step.id)
        self.assertEqual("completed", result["task_dev"]["status"])
        self.assertIn("src/example.py", self.step.result_data["changed_files"])

    def test_content_changing_commit_invalidates_revalidation_and_expands_scope(self) -> None:
        self._implemented()
        self._reviewed()
        self._revalidated()
        before = self.task_dev.guidance(self.workflow, self.step)

        dependency = self.root / "src" / "dependency.py"
        dependency.write_text("ENABLED = True\n", "utf-8")
        subprocess.run(["git", "add", "--", "src/example.py", "src/dependency.py"], cwd=self.root, check=True)
        subprocess.run(["git", "commit", "--quiet", "-m", "content change"], cwd=self.root, check=True)

        after = self.task_dev.guidance(self.workflow, self.step)
        self.assertEqual("reviewed", after["status"])
        self.assertEqual("revalidation", after["guidance"]["current_phase"])
        self.assertNotEqual(before["validated_code_digest"], after["validated_code_digest"])
        self.assertEqual(
            ["src/dependency.py", "src/example.py"],
            [name for name in after["changed_files"] if name.startswith("src/")],
        )

    def test_version_two_state_migrates_to_baseline_tree(self) -> None:
        state = self.task_dev.load(self.workflow, self.step)
        expected_tree = state["baseline_tree"]
        state["schema_version"] = 2
        state["head_commit"] = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=self.root, text=True
        ).strip()
        state["index_baseline_tree"] = subprocess.check_output(
            ["git", "write-tree"], cwd=self.root, text=True
        ).strip()
        state["integrity_error"] = "HEAD changed during task-dev"
        state.pop("baseline_tree")
        self.task_dev.save(self.workflow, self.step, state)

        migrated = self.task_dev.load(self.workflow, self.step)
        self.assertEqual(3, migrated["schema_version"])
        self.assertEqual(expected_tree, migrated["baseline_tree"])
        self.assertNotIn("head_commit", migrated)
        self.assertNotIn("index_baseline_tree", migrated)
        self.assertNotIn("integrity_error", migrated)

    def test_status_contains_self_sufficient_review_and_revalidation_refs(self) -> None:
        self._implemented()
        review = self.task_dev.guidance(self.workflow, self.step)
        self.assertTrue(review["guidance"]["instruction_refs"])
        self.assertTrue(Path(review["guidance"]["report_schema_ref"]).is_file())
        self.assertIn("reviewer-a", " ".join(review["guidance"]["required_actions"]))
        self.assertIn("reviewer-b", " ".join(review["guidance"]["required_actions"]))

        self._reviewed()
        revalidation = self.task_dev.guidance(self.workflow, self.step)
        self.assertTrue(Path(revalidation["guidance"]["report_schema_ref"]).is_file())
        self.assertIn("targeted Review", " ".join(revalidation["guidance"]["required_actions"]))

        self._revalidated()
        codecheck = self.task_dev.guidance(self.workflow, self.step)
        skill_ref = Path(codecheck["guidance"]["instruction_refs"][0])
        self.assertTrue(skill_ref.is_file())
        self.assertEqual("code-check", skill_ref.parent.name)
        self.assertNotIn("subagent", codecheck["guidance"])
        self.assertIn("低风险", skill_ref.read_text("utf-8"))
        self.assertIn("请求用户决策", skill_ref.read_text("utf-8"))


if __name__ == "__main__":
    unittest.main()
