"""E2E: dev-entry task steps run the same durable phase machine as the sr entry.

The personal dev entry fans out `dev-task-dev` steps instead of `task-dev`.
Both load the same task-dev skill and both prompts promise
"task_dev.guidance is the source of truth for progress" -- these tests pin
that the CLI actually delivers on that promise for the dev entry:
guidance is produced, phases advance through reports, an early `done` is
refused with recovery guidance, code changes invalidate the revalidation,
and completing a task unlocks the next serial task.
"""

from __future__ import annotations

import json
import subprocess
import unittest

from _cli_base import CliTestBase


def _git(cwd, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


class DevTaskDevPhaseTests(CliTestBase):
    def setUp(self) -> None:
        super().setUp()
        _git(self.cwd, "init", "--quiet")
        _git(self.cwd, "config", "user.email", "test@example.com")
        _git(self.cwd, "config", "user.name", "AAW Test")
        self.source = self.cwd / "src" / "example.py"
        self.source.parent.mkdir(parents=True, exist_ok=True)
        self.source.write_text("VALUE = 1\n", "utf-8")
        _git(self.cwd, "add", "--", "src/example.py")
        _git(self.cwd, "commit", "--quiet", "-m", "baseline")

    # -- helpers ----------------------------------------------------------

    def _advance_to_first_task(self, sr: str) -> dict:
        """Walk the dev entry up to the first claimed dev-task-dev step.

        Returns the `next` payload whose ready[0] is the claimed T1 step.
        """
        self.run_cli("start", "--entry", "dev", "--sr", sr, "--json")
        self.run_cli("next", "--sr", sr, "--json")
        self.run_cli("done", "--sr", sr, "1", "--json")

        (self.cwd / ".sdd" / sr / "dev-design.md").write_text("# design\n", "utf-8")
        self.run_cli("next", "--sr", sr, "--json")
        self.run_cli("done", "--sr", sr, "2", "--json")

        (self.cwd / ".sdd" / sr / "test-design.md").write_text("# test design\n", "utf-8")
        self.run_cli("next", "--sr", sr, "--json")
        self.run_cli("done", "--sr", sr, "3", "--json")

        gate_dir = self.cwd / ".sdd" / sr / ".context"
        gate_dir.mkdir(parents=True, exist_ok=True)
        gate_rel = f".sdd/{sr}/.context/dev-design-gate.md"
        (self.cwd / gate_rel).write_text("# gate pass\n", "utf-8")
        self.run_cli("next", "--sr", sr, "--json")
        self.run_cli(
            "done", "--sr", sr, "4", "--json",
            "--data", json.dumps({
                "gate_result": "pass",
                "recommendation": "ok",
                "report": gate_rel,
                "summary": {"unqualified_items": 0, "blocking_issues": 0, "pending_questions": 0},
            }, ensure_ascii=False),
        )

        overview = self.cwd / ".sdd" / sr / "tasks-overview.md"
        overview.write_text(
            "# tasks\n\n### T1：任务一\n- 状态：\n\n### T2：任务二\n- 状态：\n"
            "\n## 执行记录\n\n### T1：任务一\n- 状态：\n- 待处理：\n",
            "utf-8",
        )
        self.run_cli("next", "--sr", sr, "--json")
        self.run_cli(
            "done", "--sr", sr, "5", "--json",
            "--data", json.dumps({"tasks": ["任务一", "任务二"]}, ensure_ascii=False),
        )
        self.run_cli("user-confirm", "--sr", sr, "--json")
        return json.loads(self.run_cli("next", "--sr", sr, "--json").stdout)

    def _task_dev(self, payload: dict) -> dict:
        return payload["ready"][0]["task_dev"]

    def _submit_report(self, sr: str, task_dev: dict, report: dict) -> dict:
        """Write the report to the guidance's data_file and run next."""
        path = task_dev["commands"]["data_file"]
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(report, fh, ensure_ascii=False)
        return json.loads(self.run_cli("next", "--sr", sr, "--json").stdout)

    def _implementation_report(self) -> dict:
        return {
            "implementation": "completed",
            "tests": "passed",
            "checks": [{"name": "unit-tests", "status": "passed"}],
        }

    def _review_report(self) -> dict:
        return {
            "schema_version": 1,
            "task_id": "T1",
            "verdict": "pass",
            "reviewers": [
                {"role": "reviewer-a", "status": "completed", "report_ref": "reviewer-a.json"},
                {"role": "reviewer-b", "status": "completed", "report_ref": "reviewer-b.json"},
            ],
            "covered_dimensions": [
                "requirements", "security", "performance",
                "structure", "readability", "evolution",
            ],
            "applied_extension_rule_ids": [],
            "findings": [],
        }

    def _revalidation_report(self) -> dict:
        return {
            "status": "passed",
            "open_blocking_findings": [],
            "finding_resolutions": [],
            "semantic_impact": "none",
            "targeted_review_required": False,
            "targeted_review_refs": [],
            "checks": [{"name": "affected-tests", "status": "passed"}],
        }

    def _delivery_report(self) -> dict:
        return {
            "proposed_commit_message": "feat(T1): implement task one",
            "message_basis": "dev-design 方案与验收标准",
            "diff_confirmed": True,
        }

    def _backfill_overview(self, sr: str, task_id: str) -> None:
        path = self.cwd / ".sdd" / sr / "tasks-overview.md"
        text = path.read_text("utf-8")
        head, sep, tail = text.partition("## 执行记录")
        assert sep, "overview is missing the 执行记录 section"
        marker = f"### {task_id}"
        assert marker in tail, f"overview is missing the {marker} handoff"
        tail = tail.replace("- 状态：", "- 状态：Completed", 1)
        tail = tail.replace(
            "- 待处理：",
            "- 实现期补充与残余风险：无\n- 待处理：",
            1,
        )
        path.write_text(head + sep + tail, "utf-8")

    def _completion_report(self, *, resolutions: list | None = None,
                           findings: list | None = None) -> dict:
        review = self._review_report()
        if findings is not None:
            review["verdict"] = "fail" if findings else "pass"
            review["findings"] = findings
        return {
            "review": review,
            "finding_resolutions": [] if resolutions is None else resolutions,
            "codecheck": {
                "status": "passed",
                "report_ref": "codecheck-output.json",
                "checks": [{"name": "codecheck", "status": "passed"}],
            },
            "semantic_impact": "none",
            "targeted_review_required": False,
            "targeted_review_refs": [],
            "delivery": self._delivery_report(),
        }

    def _run_full_chain(self, sr: str) -> dict:
        """Drive one task from claim to done; returns the final done payload."""
        payload = self._advance_to_first_task(sr)
        task_dev = self._task_dev(payload)
        assert task_dev["guidance"]["current_phase"] == "implementation"

        # Implementation submission.
        self.source.write_text("VALUE = 2\n", "utf-8")
        payload = self._submit_report(sr, task_dev, self._implementation_report())
        task_dev = self._task_dev(payload)
        assert task_dev["status"] == "implemented", task_dev
        assert task_dev["guidance"]["current_phase"] == "completion", task_dev

        # Post-review fix happens between the two submissions (accepted by
        # design: no digest anchors exist).
        self.source.write_text("VALUE = 3\n", "utf-8")

        # The merged completion report.
        completion = self._completion_report(
            resolutions=[{"id": "REV-001", "status": "fixed", "rationale": "compatible behavior restored"}],
            findings=[{
                "id": "REV-001", "severity": "low", "dimension": "structure",
                "subcategory": "clarity", "file": "src/example.py", "line": 1,
                "evidence": "value change", "impact": "minor",
                "recommendation": "use the reviewed value", "status": "open",
            }],
        )
        payload = self._submit_report(sr, task_dev, completion)
        task_dev = self._task_dev(payload)
        assert task_dev["status"] == "prepared", task_dev

        self._backfill_overview(sr, "T1")
        done_argv = task_dev["commands"]["done_argv"]
        return json.loads(
            self.run_cli(*done_argv[2:]).stdout
        )

    # -- tests -------------------------------------------------------------

    def test_dev_task_dev_work_order_carries_phase_guidance(self) -> None:
        payload = self._advance_to_first_task("SR-DP1")

        ready = payload["ready"][0]
        self.assertEqual("dev-task-dev", ready["type"])
        self.assertIn("task_dev", ready)

        task_dev = ready["task_dev"]
        self.assertEqual("initialized", task_dev["status"])
        guidance = task_dev["guidance"]
        self.assertEqual("implementation", guidance["current_phase"])
        self.assertEqual("review", guidance["next_phase"])
        self.assertTrue(guidance["objective"])
        self.assertTrue(guidance["required_actions"])
        self.assertIn("next_argv", task_dev["commands"])
        self.assertIn("data_file", task_dev["commands"])

    def test_status_reports_task_dev_guidance_for_dev_entry(self) -> None:
        self._advance_to_first_task("SR-DP2")

        data = self.status_json("SR-DP2")
        running = [s for s in data["steps"] if s["type"] == "dev-task-dev" and s.get("task_dev")]

        self.assertEqual(1, len(running))
        self.assertEqual("implementation", running[0]["task_dev"]["guidance"]["current_phase"])

    def test_early_done_is_rejected_with_recovery_guidance(self) -> None:
        self._advance_to_first_task("SR-DP3")

        result = self.run_cli("done", "--sr", "SR-DP3", "6", "--json", expect=1)
        payload = json.loads(result.stdout)

        self.assertFalse(payload["ok"])
        self.assertEqual("TASK_DEV_STATE", payload["error"]["code"])
        self.assertEqual("implementation", payload["guidance"]["current_phase"])
        # The workflow state is untouched by the refusal.
        data = self.status_json("SR-DP3")
        self.assertFalse(data["steps"][5]["finished"])

    def test_full_chain_completes_task_and_unlocks_next(self) -> None:
        result = self._run_full_chain("SR-DP4")

        self.assertTrue(result["ok"])
        self.assertTrue(result["step_finished"])
        self.assertIn("task_dev", result)
        self.assertEqual("completed", result["task_dev"]["status"])

        # The second serial task becomes ready with its own phase machine.
        payload = json.loads(self.run_cli("next", "--sr", "SR-DP4", "--json").stdout)
        ready = payload["ready"][0]
        self.assertEqual("dev-task-dev", ready["type"])
        self.assertEqual("initialized", ready["task_dev"]["status"])
        self.assertEqual("T2", ready["task_dev"]["task_id"])

    def test_code_change_between_submissions_is_accepted(self) -> None:
        sr = "SR-DP5"
        payload = self._advance_to_first_task(sr)
        task_dev = self._task_dev(payload)

        self.source.write_text("VALUE = 2\n", "utf-8")
        payload = self._submit_report(sr, task_dev, self._implementation_report())
        task_dev = self._task_dev(payload)
        self.assertEqual("implemented", task_dev["status"])
        self.assertEqual("completion", task_dev["guidance"]["current_phase"])

        # Code changes between the two submissions: the phase does NOT roll
        # back and nothing warns -- out-of-band changes are accepted by design.
        self.source.write_text("VALUE = 42\n", "utf-8")
        payload = json.loads(self.run_cli("next", "--sr", sr, "--json").stdout)
        task_dev = self._task_dev(payload)

        self.assertEqual("implemented", task_dev["status"])
        self.assertEqual("completion", task_dev["guidance"]["current_phase"])
        self.assertNotIn("warnings", payload["ready"][0]["task_dev"])

    def test_digest_drift_does_not_block_done_in_prepared(self) -> None:
        """A prepared task stays completable after an unrelated code change."""
        sr = "SR-DP7"
        payload = self._advance_to_first_task(sr)
        task_dev = self._task_dev(payload)
        # First gate, then drive to prepared through the merged completion.
        self.source.write_text("VALUE = 2\n", "utf-8")
        payload = self._submit_report(sr, task_dev, self._implementation_report())
        task_dev = self._task_dev(payload)
        self.source.write_text("VALUE = 3\n", "utf-8")
        payload = self._submit_report(sr, task_dev, self._completion_report())
        task_dev = self._task_dev(payload)
        self.assertEqual("prepared", task_dev["status"])
        self._backfill_overview(sr, "T1")

        # Unrelated code change AFTER reaching prepared: done must still pass.
        self.source.write_text("VALUE = 99\n", "utf-8")
        done_argv = task_dev["commands"]["done_argv"]
        result = json.loads(self.run_cli(*done_argv[2:]).stdout)

        self.assertTrue(result["ok"])
        self.assertTrue(result["step_finished"])
        # And the drift is reported, not silently swallowed.
        status_payload = self.status_json(sr)
        running_or_done = [s for s in status_payload["steps"] if s["id"] == 5][0]
        self.assertTrue(running_or_done["finished"])

    def test_malformed_phase_report_returns_recovery_guidance(self) -> None:
        payload = self._advance_to_first_task("SR-DP6")
        task_dev = self._task_dev(payload)

        with open(task_dev["commands"]["data_file"], "w", encoding="utf-8") as fh:
            fh.write("{}")

        result = self.run_cli("next", "--sr", "SR-DP6", "--json", expect=1)
        error = json.loads(result.stdout)

        self.assertFalse(error["ok"])
        self.assertEqual("TASK_DEV_STATE", error["error"]["code"])
        self.assertEqual("implementation", error["guidance"]["current_phase"])
        self.assertIn("next_argv", error["commands"])


if __name__ == "__main__":
    unittest.main()
