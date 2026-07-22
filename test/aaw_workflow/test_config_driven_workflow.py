from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


ROOT = Path(__file__).resolve().parents[2]
AAW_SCRIPT = ROOT / "skills" / "aaw-workflow" / "scripts" / "aaw.py"
SCRIPTS_DIR = AAW_SCRIPT.parent
sys.path.insert(0, str(SCRIPTS_DIR))

from cli.models import DataError, WorkflowError  # noqa: E402
from cli import main as cli_main  # noqa: E402
from cli.workflow import WorkflowManager, _validate_data_schema  # noqa: E402


class ConfigDrivenWorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.sdd = self.root / ".sdd"
        self.mgr = WorkflowManager(self.sdd)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _abs(self, stored_path: str) -> Path:
        """Resolve a repo-relative stored path the same way the manager does."""
        return self.root / stored_path

    def test_task_dev_completion_schema_requires_core_results(self) -> None:
        schema = self.mgr.templates["task-dev"]["data_schema"]
        with self.assertRaisesRegex(DataError, "implementation"):
            _validate_data_schema(
                {"task_id": "T1", "workflow_source": "builtin"},
                schema,
            )

        _validate_data_schema(
            {
                "task_id": "T1",
                "workflow_source": "builtin",
                "implementation": "completed",
                "tests": "passed",
                "review_and_optimization": "completed",
                "revalidation": "passed",
                "checks": [{"name": "codeCheck", "status": "passed"}],
            },
            schema,
        )

    def _touch_required_inputs(self, wf, step_id: int) -> None:
        step = wf.get_step(step_id)
        assert step is not None
        for item in step.input:
            path = item.get("path")
            if path and item.get("required", True):
                p = self._abs(path)
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text("required input", "utf-8")

    def _touch_required_outputs(self, wf, step_id: int) -> None:
        step = wf.get_step(step_id)
        assert step is not None
        for item in step.output:
            path = item.get("path")
            if path and item.get("required", True):
                p = self._abs(path)
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text("required output", "utf-8")

    def _done(self, wf, step_id: int, data_raw: str | None = None):
        step = wf.get_step(step_id)
        assert step is not None
        if step.execution in {"skill", "prompt"} and not step.started_at:
            self.mgr.mark_started(wf, step_id)
        self._touch_required_inputs(wf, step_id)
        self._touch_required_outputs(wf, step_id)
        result = self.mgr.mark_done(wf, step_id, data_raw)
        if result.get("state") == "awaiting_user_confirm":
            return self.mgr.user_confirm(wf)
        return result

    def _gate_pass_data(self) -> str:
        return json.dumps(
            {
                "gate_result": "pass",
                "recommendation": "可进入 AICoding",
                "report": "gate passed",
            },
            ensure_ascii=False,
        )

    def _workflow_at_gate(self, sr: str):
        wf = self.mgr.start("ar", {"SR": sr, "AR": "AR-001", "描述": "用户管理"})
        self._done(wf, 1)
        self._done(wf, 2)
        self._done(wf, 3)
        self._done(
            wf,
            4,
            json.dumps(
                {
                    "module_groups": [
                        {"name": "A,B", "modules": ["模块A"], "requirement": "用户管理"}
                    ]
                },
                ensure_ascii=False,
            ),
        )
        for step_id in [5, 6, 7]:
            self._done(wf, step_id)
        return wf

    def _workflow_at_sr_gate(self, sr: str):
        wf = self.mgr.start("sr", {"SR": sr})
        self._done(wf, 1)
        self._done(wf, 2)
        return wf

    def _sr_gate_pass_data(self) -> str:
        return json.dumps(
            {
                "gate_result": "pass",
                "recommendation": "可进入 AR 拆分",
                "report": None,
                "summary": {
                    "unqualified_dimensions": 0,
                    "p0_conflicts": 0,
                    "p1_conflicts": 0,
                    "p2_findings": 0,
                    "pending_questions": 0,
                    "blocking_issues": 0,
                },
            },
            ensure_ascii=False,
        )

    def test_status_without_sdd_returns_empty_list(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run(
                [sys.executable, str(AAW_SCRIPT), "status", "--json"],
                cwd=tmp,
                check=True,
                text=True,
                capture_output=True,
            )

        self.assertEqual({"srs": []}, json.loads(result.stdout))

    def test_cli_start_accepts_ascii_title_var_alias(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run(
                [
                    sys.executable,
                    str(AAW_SCRIPT),
                    "start",
                    "--entry",
                    "ar",
                    "--var",
                    "SR=SR-CLI",
                    "--var",
                    "AR=AR-001",
                    "--var",
                    "TITLE=user-management",
                    "--json",
                ],
                cwd=tmp,
                check=True,
                text=True,
                capture_output=True,
            )

        payload = json.loads(result.stdout)
        self.assertEqual("SR-CLI", payload["sr"])
        self.assertEqual("ar", payload["entry"])

    def test_start_sr_entry_creates_init_work_order(self) -> None:
        wf = self.mgr.start("sr", {"SR": "SR-001"})
        payload = self.mgr.build_next_payload(wf)

        self.assertFalse(payload["done"])
        order = payload["ready"][0]
        self.assertEqual("sr-init", order["type"])
        self.assertEqual("skill", order["execution"])
        self.assertEqual(["repo-init"], order["skill"])
        self.assertEqual(["sr-design"], order["available_next"])
        self.assertFalse(order["deliverables_exist"])
        self.assertIn("software_architecture.md", order["deliverables"]["missing_required"][0])
        self.assertTrue((self.sdd / "SR-001" / ".aaw" / "data").is_dir())

    def test_deliverables_exist_marks_required_output_as_skippable(self) -> None:
        wf = self.mgr.start("sr", {"SR": "SR-001"})
        arch = self.sdd / "software_architecture.md"
        arch.write_text("architecture", "utf-8")

        order = self.mgr.build_next_payload(wf)["ready"][0]

        self.assertTrue(order["deliverables"]["can_skip"])
        self.assertTrue(order["deliverables_exist"])

    def test_missing_required_output_blocks_done(self) -> None:
        wf = self.mgr.start("sr", {"SR": "SR-OUTPUT"})

        with self.assertRaises(WorkflowError):
            self.mgr.mark_done(wf, 1)

        (self.sdd / "software_architecture.md").write_text("architecture", "utf-8")
        self.mgr.mark_started(wf, 1)
        result = self.mgr.mark_done(wf, 1)

        self.assertEqual("awaiting_user_confirm", result["state"])
        self.assertEqual(0, result["generated"])
        self.assertEqual(1, result["planned"])
        self.assertEqual([], self.mgr.get_ready(wf))
        pending = self.mgr.build_next_payload(wf)
        self.assertEqual("awaiting_user_confirm", pending["status"])
        self.assertEqual([], pending["ready"])
        self.assertIn("user-confirm", pending["commands"]["user_confirm"])

        confirmed = self.mgr.user_confirm(wf)

        self.assertEqual(1, confirmed["generated"])
        self.assertEqual("sr-design", self.mgr.get_ready(wf)[0].type)

    def test_done_waits_for_user_confirm_on_must_edge(self) -> None:
        wf = self.mgr.start("sr", {"SR": "SR-CONFIRM"})
        self._touch_required_outputs(wf, 1)
        self.mgr.mark_started(wf, 1)

        result = self.mgr.mark_done(wf, 1)

        self.assertEqual("awaiting_user_confirm", result["state"])
        self.assertEqual(0, result["generated"])
        self.assertEqual(1, result["planned"])
        self.assertTrue(wf.get_step(1).finished)
        self.assertEqual([], wf.get_step(1).next)
        self.assertEqual(1, len(wf.steps))
        self.assertEqual([], self.mgr.get_ready(wf))

        payload = self.mgr.build_next_payload(wf)
        self.assertEqual("awaiting_user_confirm", payload["status"])
        self.assertEqual([], payload["ready"])
        self.assertEqual("sr-design", payload["pending_user_confirm"]["planned_next"][0]["type"])

        confirmed = self.mgr.user_confirm(wf)

        self.assertEqual(1, confirmed["generated"])
        self.assertEqual([2], wf.get_step(1).next)
        self.assertEqual("sr-design", self.mgr.get_ready(wf)[0].type)

    def test_step_execution_timestamps_are_persisted_in_workflow_yaml(self) -> None:
        wf = self.mgr.start("sr", {"SR": "SR-TIMESTAMPS"})

        step = self.mgr.mark_started(wf, 1)
        started_at = step.started_at
        self.assertEqual("running", step.execution_status)
        self.assertEqual(1, step.attempt)
        self.assertIsNotNone(started_at)
        self.assertEqual(started_at, self.mgr.load("SR-TIMESTAMPS").get_step(1).started_at)

        self._done(wf, 1)
        completed = self.mgr.load("SR-TIMESTAMPS").get_step(1)
        assert completed is not None
        self.assertEqual("completed", completed.execution_status)
        self.assertEqual(started_at, completed.started_at)
        self.assertIsNotNone(completed.ended_at)
        self.assertGreaterEqual(completed.ended_at, started_at)

    def test_next_retries_same_start_message_after_initial_transition(self) -> None:
        self.mgr.start("sr", {"SR": "SR-RUNNING"})
        store = MagicMock()
        message = {"message_id": "start-message", "data": {"status": "start"}}
        store.step_message.return_value = message

        with (
            patch.object(cli_main, "_get_manager", return_value=self.mgr),
            patch.object(cli_main, "_get_telemetry", return_value=store),
            patch.object(cli_main, "_echo_json"),
            patch.object(cli_main.TelemetryClient, "send", return_value={"status": "accepted"}) as send,
        ):
            cli_main.next("SR-RUNNING", True)
            cli_main.next("SR-RUNNING", True)

        step = self.mgr.load("SR-RUNNING").get_step(1)
        assert step is not None
        self.assertEqual("running", step.execution_status)
        self.assertIsNotNone(step.started_at)
        self.assertEqual(2, store.step_message.call_count)
        self.assertEqual("start", store.step_message.call_args.args[2])
        self.assertTrue(all(call.args == (message,) for call in send.call_args_list))

    def test_next_retries_missing_task_dev_baseline_for_running_step(self) -> None:
        step = MagicMock(
            id=8,
            type="task-dev",
            execution="skill",
            execution_status="running",
            attempt=1,
        )
        workflow = MagicMock()
        manager = MagicMock()
        manager.load.return_value = workflow
        manager.get_ready.return_value = [step]
        manager.mark_started.return_value = step
        manager.build_next_payload.return_value = {"done": False, "ready": []}
        store = MagicMock()
        message = {"message_id": "task-dev-start", "data": {"status": "start"}}
        store.step_message.return_value = message

        with (
            patch.object(cli_main, "_get_manager", return_value=manager),
            patch.object(cli_main, "_get_telemetry", return_value=store),
            patch.object(cli_main, "_echo_json"),
            patch.object(cli_main.TelemetryClient, "send", return_value={"status": "duplicate"}),
        ):
            cli_main.next("SR-TASK-DEV", True)

        store.dev_started.assert_called_once_with(workflow, step, 1)
        manager.mark_started.assert_called_once_with(workflow, 8, 1)

    def test_done_keeps_task_dev_artifacts_when_diff_upload_fails(self) -> None:
        workflow = MagicMock()
        step = MagicMock(type="task-dev", attempt=1)
        workflow.get_step.return_value = step
        manager = MagicMock()
        manager.load.return_value = workflow
        manager.mark_done.return_value = {"ok": True}
        store = MagicMock()
        dev_state = {"file": {"file_name": "step.diff", "sha256": "a" * 64}}
        store.dev_finished.return_value = dev_state
        store.step_message.return_value = {"message_id": "task-dev-done"}

        with (
            patch.object(cli_main, "_get_manager", return_value=manager),
            patch.object(cli_main, "_get_telemetry", return_value=store),
            patch.object(cli_main, "_echo_json") as echo,
            patch.object(cli_main.TelemetryClient, "send", side_effect=cli_main.TelemetryError("upload failed")),
        ):
            cli_main.done("SR-TASK-DEV", 8, None, None, True)

        store.cleanup_step.assert_not_called()
        self.assertEqual("failed", echo.call_args.args[0]["telemetry"]["status"])

    def test_done_cleans_task_dev_artifacts_after_successful_upload(self) -> None:
        workflow = MagicMock()
        step = MagicMock(type="task-dev", attempt=1)
        workflow.get_step.return_value = step
        manager = MagicMock()
        manager.load.return_value = workflow
        manager.mark_done.return_value = {"ok": True}
        store = MagicMock()
        dev_state = {"file": {"file_name": "step.diff", "sha256": "a" * 64}}
        store.dev_finished.return_value = dev_state
        store.step_message.return_value = {"message_id": "task-dev-done"}

        with (
            patch.object(cli_main, "_get_manager", return_value=manager),
            patch.object(cli_main, "_get_telemetry", return_value=store),
            patch.object(cli_main, "_echo_json"),
            patch.object(
                cli_main.TelemetryClient,
                "send",
                return_value={"message_id": "task-dev-done", "status": "accepted", "uploaded": 1},
            ),
        ):
            cli_main.done("SR-TASK-DEV", 8, None, None, True)

        store.cleanup_step.assert_called_once_with(workflow, step, 1, dev_state)

    def test_prompt_template_is_returned_by_next_payload(self) -> None:
        wf = self._workflow_at_sr_gate("SR-001")
        self._done(wf, 3, self._sr_gate_pass_data())

        order = self.mgr.build_next_payload(wf)["ready"][0]

        self.assertEqual("ar-split", order["type"])
        self.assertEqual("prompt", order["execution"])
        self.assertEqual("prompts/ar-split.md", order["prompt"]["template"])
        self.assertIn("是否需要拆分 AR", order["prompt"]["rendered"])
        self.assertIn("ars", order["data"]["fields"])
        self.assertTrue(order["data_file"]["path"].endswith("/.sdd/SR-001/.aaw/data/step-0004-ar-split.json"))
        self.assertTrue(order["data_file"]["relative_path"].endswith(".sdd/SR-001/.aaw/data/step-0004-ar-split.json"))
        self.assertEqual("utf-8", order["data_file"]["encoding"])
        self.assertIn("aaw.py", order["commands"]["done"])
        self.assertIn("--data-file", order["commands"]["done"])
        self.assertIn("step-0004-ar-split.json", order["commands"]["done"])
        self.assertTrue(order["commands"]["done_inline"].endswith("done --sr SR-001 4 --data '<JSON>' --json"))
        self.assertEqual("aaw done --sr SR-001 4 --data '<JSON>' --json", order["commands"]["legacy_done"])

    def test_sr_design_generates_gate_with_optional_report_without_confirmation(self) -> None:
        wf = self.mgr.start("sr", {"SR": "SR-GATE"})
        self._done(wf, 1)
        self.mgr.mark_started(wf, 2)
        self._touch_required_outputs(wf, 2)

        result = self.mgr.mark_done(wf, 2)

        self.assertEqual(1, result["generated"])
        self.assertNotEqual("awaiting_user_confirm", result.get("state"))
        gate = self.mgr.get_ready(wf)[0]
        self.assertEqual("sr-design-gate", gate.type)
        self.assertEqual(["sr-design-gate"], gate.skill)
        self.assertEqual(
            [".sdd/software_architecture.md", ".sdd/SR-GATE/SR-design.md"],
            [item["path"] for item in gate.input],
        )
        self.assertTrue(all(item["required"] for item in gate.input))
        self.assertEqual(".sdd/SR-GATE/SR-design-gate.md", gate.output[0]["path"])
        self.assertFalse(gate.output[0]["required"])
        deliverables = self.mgr.check_deliverables(gate)
        self.assertEqual([".sdd/SR-GATE/SR-design-gate.md"], deliverables["optional"])
        self.assertFalse(deliverables["can_skip"])
        report = self._abs(gate.output[0]["path"])
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text("historical gate report", "utf-8")
        self.assertFalse(self.mgr.check_deliverables(gate)["can_skip"])
        gate_order = self.mgr.build_next_payload(wf)["ready"][0]
        self.assertIn("summary", gate_order["data"]["fields"])

    def test_sr_gate_pass_waits_for_user_confirmation_before_ar_split(self) -> None:
        wf = self._workflow_at_sr_gate("SR-GATE-PASS")
        self.mgr.mark_started(wf, 3)
        gate = wf.get_step(3)
        assert gate is not None
        report = self._abs(gate.output[0]["path"])

        result = self.mgr.mark_done(wf, 3, self._sr_gate_pass_data())

        self.assertFalse(report.exists())
        self.assertEqual("awaiting_user_confirm", result["state"])
        self.assertEqual([], self.mgr.get_ready(wf))
        pending = self.mgr.build_next_payload(wf)["pending_user_confirm"]
        self.assertEqual("ar-split", pending["planned_next"][0]["type"])
        confirmed = self.mgr.user_confirm(wf)
        self.assertEqual(1, confirmed["generated"])
        self.assertEqual("ar-split", self.mgr.get_ready(wf)[0].type)

    def test_sr_gate_fail_and_blocked_keep_gate_unfinished(self) -> None:
        for gate_result, expected_message in (("fail", "门禁不通过"), ("blocked", "门禁阻塞")):
            with self.subTest(gate_result=gate_result):
                wf = self._workflow_at_sr_gate(f"SR-GATE-{gate_result.upper()}")
                gate = wf.get_step(3)
                assert gate is not None
                report = self._abs(gate.output[0]["path"])
                report.parent.mkdir(parents=True, exist_ok=True)
                report.write_text(f"gate {gate_result}", "utf-8")
                with self.assertRaises(DataError) as ctx:
                    self._done(
                        wf,
                        3,
                        json.dumps(
                            {
                                "gate_result": gate_result,
                                "recommendation": "整改后重试",
                                "report": gate.output[0]["path"],
                                "summary": {
                                    "unqualified_dimensions": 1,
                                    "p0_conflicts": 1 if gate_result == "fail" else 0,
                                    "p1_conflicts": 0,
                                    "p2_findings": 0,
                                    "pending_questions": 0,
                                    "blocking_issues": 1 if gate_result == "blocked" else 0,
                                },
                            },
                            ensure_ascii=False,
                        ),
                    )
                self.assertIn(expected_message, str(ctx.exception))
                self.assertTrue(report.exists())
                self.assertFalse(gate.finished)
                self.assertEqual([], gate.next)
                self.assertEqual([3], [step.id for step in self.mgr.get_ready(wf)])

    def test_choice_generates_ar_clarify_steps_from_config(self) -> None:
        wf = self._workflow_at_sr_gate("SR-001")
        self._done(wf, 3, self._sr_gate_pass_data())

        result = self._done(
            wf,
            4,
            json.dumps(
                {
                    "ars": [
                        {"id": "AR-001", "title": "用户管理"},
                        {"id": "AR-002", "title": "权限控制"},
                    ]
                },
                ensure_ascii=False,
            ),
        )

        self.assertEqual(2, result["generated"])
        ready = self.mgr.get_ready(wf)
        self.assertEqual(["AR-001-ar-clarify", "AR-002-ar-clarify"], [s.name for s in ready])
        self.assertEqual("AR-001", ready[0].vars["AR"])
        self.assertEqual("用户管理", ready[0].vars["描述"])
        self.assertEqual("AR-001:用户管理", ready[0].input[0]["value"])

    def test_cli_done_accepts_data_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cwd = Path(tmp)
            subprocess.run(
                [sys.executable, str(AAW_SCRIPT), "start", "--entry", "sr", "--sr", "SR-DATAFILE", "--json"],
                cwd=cwd,
                check=True,
                text=True,
                capture_output=True,
            )
            (cwd / ".sdd" / "software_architecture.md").write_text("architecture", "utf-8")
            subprocess.run(
                [sys.executable, str(AAW_SCRIPT), "next", "--sr", "SR-DATAFILE", "--json"],
                cwd=cwd,
                check=True,
                text=True,
                capture_output=True,
            )
            subprocess.run(
                [sys.executable, str(AAW_SCRIPT), "done", "--sr", "SR-DATAFILE", "1", "--json"],
                cwd=cwd,
                check=True,
                text=True,
                capture_output=True,
            )
            subprocess.run(
                [sys.executable, str(AAW_SCRIPT), "user-confirm", "--sr", "SR-DATAFILE", "--json"],
                cwd=cwd,
                check=True,
                text=True,
                capture_output=True,
            )
            (cwd / ".sdd" / "SR-DATAFILE" / "SR-design.md").write_text("sr design", "utf-8")
            subprocess.run(
                [sys.executable, str(AAW_SCRIPT), "next", "--sr", "SR-DATAFILE", "--json"],
                cwd=cwd,
                check=True,
                text=True,
                capture_output=True,
            )
            subprocess.run(
                [sys.executable, str(AAW_SCRIPT), "done", "--sr", "SR-DATAFILE", "2", "--json"],
                cwd=cwd,
                check=True,
                text=True,
                capture_output=True,
            )
            gate_data_file = cwd / "gate.json"
            gate_data_file.write_text(self._sr_gate_pass_data(), "utf-8-sig")
            subprocess.run(
                [sys.executable, str(AAW_SCRIPT), "next", "--sr", "SR-DATAFILE", "--json"],
                cwd=cwd,
                check=True,
                text=True,
                capture_output=True,
            )
            subprocess.run(
                [
                    sys.executable,
                    str(AAW_SCRIPT),
                    "done",
                    "--sr",
                    "SR-DATAFILE",
                    "3",
                    "--data-file",
                    str(gate_data_file),
                    "--json",
                ],
                cwd=cwd,
                check=True,
                text=True,
                capture_output=True,
            )
            subprocess.run(
                [sys.executable, str(AAW_SCRIPT), "user-confirm", "--sr", "SR-DATAFILE", "--json"],
                cwd=cwd,
                check=True,
                text=True,
                capture_output=True,
            )
            data_file = cwd / "split.json"
            data_file.write_text(
                json.dumps({"ars": [{"id": "AR-001", "title": "用户管理"}]}, ensure_ascii=False),
                "utf-8-sig",
            )
            subprocess.run(
                [sys.executable, str(AAW_SCRIPT), "next", "--sr", "SR-DATAFILE", "--json"],
                cwd=cwd,
                check=True,
                text=True,
                capture_output=True,
            )
            subprocess.run(
                [
                    sys.executable,
                    str(AAW_SCRIPT),
                    "done",
                    "--sr",
                    "SR-DATAFILE",
                    "4",
                    "--data-file",
                    str(data_file),
                    "--json",
                ],
                cwd=cwd,
                check=True,
                text=True,
                capture_output=True,
            )
            nxt = subprocess.run(
                [sys.executable, str(AAW_SCRIPT), "next", "--sr", "SR-DATAFILE", "--json"],
                cwd=cwd,
                check=True,
                text=True,
                capture_output=True,
            )

        self.assertEqual(["AR-001-ar-clarify"], [item["name"] for item in json.loads(nxt.stdout)["ready"]])

    def test_choice_no_split_uses_configured_synthetic_ar(self) -> None:
        wf = self._workflow_at_sr_gate("SR-001")
        self._done(wf, 3, self._sr_gate_pass_data())

        self._done(wf, 4, json.dumps({"mode": "no_split"}))
        ready = self.mgr.get_ready(wf)

        self.assertEqual(1, len(ready))
        self.assertEqual("module-boundary-design", ready[0].type)
        self.assertEqual("ALL", ready[0].vars["AR"])
        self.assertTrue(ready[0].output[0]["path"].endswith("/SR-001/ALL/module-boundary-design.md"))

    def test_invalid_choice_item_is_rejected_without_mutating_workflow(self) -> None:
        wf = self._workflow_at_sr_gate("SR-BAD")
        self._done(wf, 3, self._sr_gate_pass_data())

        with self.assertRaises(DataError):
            self._done(wf, 4, json.dumps({"ars": [{"id": "AR-001"}]}))

        step = wf.get_step(4)
        assert step is not None
        self.assertFalse(step.finished)
        self.assertEqual([], step.next)
        self.assertEqual(4, len(wf.steps))

    def test_ar_entry_skips_sr_design_and_ar_split(self) -> None:
        wf = self.mgr.start("ar", {"SR": "SR-002", "AR": "AR-010", "描述": "直接入口"})
        first = self.mgr.build_next_payload(wf)["ready"][0]
        self.assertEqual("ar-init", first["type"])

        self._done(wf, 1)
        second = self.mgr.build_next_payload(wf)["ready"][0]

        self.assertEqual("ar-clarify", second["type"])
        self.assertEqual("AR-010", second["vars"]["AR"])
        self.assertNotIn("sr-design", [s.type for s in wf.steps])
        self.assertNotIn("sr-design-gate", [s.type for s in wf.steps])
        self.assertNotIn("ar-split", [s.type for s in wf.steps])

    def test_ar_entry_requires_repo_init_artifact_before_done(self) -> None:
        wf = self.mgr.start("ar", {"SR": "SR-REPO", "AR": "AR-001", "描述": "直接入口"})
        first = self.mgr.build_next_payload(wf)["ready"][0]

        self.assertTrue(first["inputs"]["blocked"])
        self.assertEqual(".sdd/software_architecture.md", first["inputs"]["missing_required"][0])
        self.mgr.mark_started(wf, 1)
        with self.assertRaises(WorkflowError):
            self.mgr.mark_done(wf, 1)

        (self.sdd / "software_architecture.md").write_text("architecture", "utf-8")
        result = self.mgr.mark_done(wf, 1)

        self.assertEqual(1, result["generated"])
        self.assertEqual("ar-clarify", self.mgr.get_ready(wf)[0].type)

    def test_start_allows_existing_sr_directory_without_workflow(self) -> None:
        existing = self.sdd / "SR-EXISTING"
        existing.mkdir(parents=True)
        (existing / "source.md").write_text("existing context", "utf-8")

        wf = self.mgr.start("ar", {"SR": "SR-EXISTING", "AR": "AR-001", "描述": "已有资料"})

        self.assertEqual("SR-EXISTING", wf.sr)
        with self.assertRaises(WorkflowError):
            self.mgr.start("ar", {"SR": "SR-EXISTING", "AR": "AR-002", "描述": "重复启动"})

    def test_foreach_generates_module_steps_from_config(self) -> None:
        wf = self.mgr.start("ar", {"SR": "SR-003", "AR": "AR-001", "描述": "用户管理"})
        self._done(wf, 1)
        self._done(wf, 2)
        self._done(wf, 3)

        result = self._done(
            wf,
            4,
            json.dumps(
                {
                    "module_groups": [
                        {
                            "name": "A,B",
                            "modules": ["模块A", "模块B"],
                            "requirement": "用户管理",
                        }
                    ]
                },
                ensure_ascii=False,
            ),
        )

        self.assertEqual(1, result["generated"])
        ready = self.mgr.get_ready(wf)
        self.assertEqual("module-asis-analysis", ready[0].type)
        self.assertEqual("模块A,B", ready[0].vars["模块组名"])
        self.assertEqual("用户管理", ready[0].vars["需求短名"])
        self.assertIn("AR-001-用户管理-模块A,B模块详细设计说明书.context.md", ready[0].output[0]["path"])

    def test_gate_pass_generates_task_split(self) -> None:
        wf = self._workflow_at_gate("SR-GATE-PASS")
        gate_order = self.mgr.build_next_payload(wf)["ready"][0]

        self.assertEqual("module-design-gate", gate_order["type"])
        self.assertIn("gate_result", gate_order["data"]["fields"])
        self.assertTrue(gate_order["data_file"]["path"].endswith("/.sdd/SR-GATE-PASS/.aaw/data/step-0008-module-design-gate.json"))
        self.assertTrue(gate_order["deliverables"]["required"][0].endswith("模块设计门禁结果.md"))

        result = self._done(wf, 8, self._gate_pass_data())

        self.assertEqual(1, result["generated"])
        ready = self.mgr.get_ready(wf)
        self.assertEqual("task-split", ready[0].type)

    def test_gate_fail_keeps_step_unfinished_without_generating_downstream(self) -> None:
        wf = self._workflow_at_gate("SR-GATE-FAIL")
        gate_step = wf.get_step(8)
        assert gate_step is not None
        report = self._abs(gate_step.output[0]["path"])

        with self.assertRaises(DataError) as ctx:
            self._done(
                wf,
                8,
                json.dumps(
                    {
                        "gate_result": "fail",
                        "recommendation": "回 TOBE 补设计后重试",
                        "report": "gate failed",
                    },
                    ensure_ascii=False,
                ),
            )

        self.assertIn("门禁不通过", str(ctx.exception))
        self.assertTrue(report.exists())
        self.assertFalse(gate_step.finished)
        self.assertEqual([], gate_step.next)
        self.assertEqual(8, len(wf.steps))
        self.assertEqual([8], [s.id for s in self.mgr.get_ready(wf)])

    def test_gate_blocked_keeps_step_unfinished_without_rollback(self) -> None:
        wf = self._workflow_at_gate("SR-GATE-BLOCKED")
        gate_step = wf.get_step(8)
        assert gate_step is not None
        report = self._abs(gate_step.output[0]["path"])

        with self.assertRaises(DataError) as ctx:
            self._done(
                wf,
                8,
                json.dumps(
                    {
                        "gate_result": "blocked",
                        "recommendation": "阻塞，缺少必要输入",
                        "report": "gate blocked",
                    },
                    ensure_ascii=False,
                ),
            )

        self.assertIn("门禁阻塞", str(ctx.exception))
        self.assertTrue(report.exists())
        self.assertFalse(gate_step.finished)
        self.assertEqual([], gate_step.next)
        self.assertEqual(8, len(wf.steps))
        self.assertEqual([8], [s.id for s in self.mgr.get_ready(wf)])

    def test_task_split_foreach_uses_index_and_task_title(self) -> None:
        wf = self.mgr.start("ar", {"SR": "SR-004", "AR": "AR-001", "描述": "用户管理"})
        self._done(wf, 1)
        self._done(wf, 2)
        self._done(wf, 3)
        self._done(
            wf,
            4,
            json.dumps(
                {
                    "module_groups": [
                        {"name": "A,B", "modules": ["模块A"], "requirement": "用户管理"}
                    ]
                },
                ensure_ascii=False,
            ),
        )
        for step_id in [5, 6, 7]:
            self._done(wf, step_id)
        self._done(wf, 8, self._gate_pass_data())

        result = self._done(wf, 9, json.dumps({"tasks": ["用户CRUD", "权限校验"]}, ensure_ascii=False))

        self.assertEqual(2, result["generated"])
        ready = self.mgr.get_ready(wf)
        self.assertEqual(["T1-task-dev"], [s.name for s in ready])
        self.assertTrue(ready[0].input[1]["path"].endswith("/模块A,B_tasks/T1-用户CRUD.md"))
        task_steps = [step for step in wf.steps if step.type == "task-dev"]
        self.assertEqual([], task_steps[0].depends_on)
        self.assertEqual([task_steps[0].id], task_steps[1].depends_on)
        task_steps[0].finished = True
        task_steps[0].execution_status = "completed"
        self.assertEqual(["T2-task-dev"], [s.name for s in self.mgr.get_ready(wf)])

    def test_task_split_rejects_prefixed_task_titles(self) -> None:
        wf = self.mgr.start("ar", {"SR": "SR-004B", "AR": "AR-001", "描述": "用户管理"})
        self._done(wf, 1)
        self._done(wf, 2)
        self._done(wf, 3)
        self._done(
            wf,
            4,
            json.dumps(
                {
                    "module_groups": [
                        {"name": "A,B", "modules": ["模块A"], "requirement": "用户管理"}
                    ]
                },
                ensure_ascii=False,
            ),
        )
        for step_id in [5, 6, 7]:
            self._done(wf, step_id)
        self._done(wf, 8, self._gate_pass_data())

        with self.assertRaises(DataError) as ctx:
            self._done(wf, 9, json.dumps({"tasks": ["T1-用户CRUD"]}, ensure_ascii=False))

        self.assertIn("不要包含 T1-/T2- 前缀", str(ctx.exception))
        step = wf.get_step(9)
        assert step is not None
        self.assertFalse(step.finished)
        self.assertEqual([], step.next)

    def test_missing_foreach_data_raises_data_error(self) -> None:
        wf = self.mgr.start("ar", {"SR": "SR-005", "AR": "AR-001", "描述": "用户管理"})
        self._done(wf, 1)
        self._done(wf, 2)
        self._done(wf, 3)

        with self.assertRaises(DataError):
            self._done(wf, 4, json.dumps({"module_groups": []}))

    def test_rollback_removes_descendant_steps_and_files(self) -> None:
        wf = self.mgr.start("ar", {"SR": "SR-006", "AR": "AR-001", "描述": "用户管理"})
        self._done(wf, 1)
        ar_step = wf.get_step(2)
        assert ar_step is not None
        ar_output = self._abs(ar_step.output[0]["path"])
        ar_output.parent.mkdir(parents=True, exist_ok=True)
        ar_output.write_text("clarified", "utf-8")
        self._done(wf, 2)

        result = self.mgr.rollback(wf, 1)

        self.assertEqual(2, result["removed"])
        self.assertFalse(ar_output.exists())
        self.assertEqual([1], [s.id for s in wf.steps])
        self.assertFalse(wf.steps[0].finished)
        self.assertEqual([], wf.steps[0].next)

    def test_io_paths_are_stored_repo_relative(self) -> None:
        wf = self.mgr.start("sr", {"SR": "SR-REL"})
        step = wf.get_step(1)
        assert step is not None

        for item in step.input + step.output:
            path = item.get("path")
            if path:
                self.assertFalse(
                    Path(path).is_absolute(),
                    msg=f"stored path must be repo-relative, got {path!r}",
                )
                self.assertTrue(path.startswith(".sdd/"), msg=path)

    def test_workflow_is_portable_after_moving_sdd_dir(self) -> None:
        # Author the workflow and produce the required deliverable under root A.
        wf = self.mgr.start("sr", {"SR": "SR-MOVE"})
        self.mgr.mark_started(wf, 1)
        self._touch_required_outputs(wf, 1)

        # Relocate the whole .sdd tree to a fresh root B and validate from there.
        import shutil

        other_root = Path(self.tmp.name) / "relocated"
        other_root.mkdir()
        shutil.move(str(self.sdd), str(other_root / ".sdd"))

        moved_mgr = WorkflowManager(other_root / ".sdd")
        moved_wf = moved_mgr.load("SR-MOVE")
        # The required output travelled with the tree, so check_deliverables must
        # resolve it relative to the new root — no absolute path baked into yaml.
        self.assertTrue(moved_mgr.check_deliverables(moved_wf.get_step(1))["can_skip"])
        result = moved_mgr.mark_done(moved_wf, 1)
        if result.get("state") == "awaiting_user_confirm":
            result = moved_mgr.user_confirm(moved_wf)
        self.assertEqual(1, result["generated"])


if __name__ == "__main__":
    unittest.main()
