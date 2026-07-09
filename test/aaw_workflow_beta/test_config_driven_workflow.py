from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
AAW_SCRIPT = ROOT / "skills" / "aaw-workflow" / "scripts" / "aaw.py"
SCRIPTS_DIR = AAW_SCRIPT.parent
sys.path.insert(0, str(SCRIPTS_DIR))

from cli.models import DataError, WorkflowError  # noqa: E402
from cli.workflow import WorkflowManager  # noqa: E402


class ConfigDrivenWorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.sdd = self.root / ".sdd"
        self.mgr = WorkflowManager(self.sdd)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _touch_required_inputs(self, wf, step_id: int) -> None:
        step = wf.get_step(step_id)
        assert step is not None
        for item in step.input:
            path = item.get("path")
            if path and item.get("required", True):
                p = Path(path)
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text("required input", "utf-8")

    def _touch_required_outputs(self, wf, step_id: int) -> None:
        step = wf.get_step(step_id)
        assert step is not None
        for item in step.output:
            path = item.get("path")
            if path and item.get("required", True):
                p = Path(path)
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text("required output", "utf-8")

    def _done(self, wf, step_id: int, data_raw: str | None = None):
        self._touch_required_inputs(wf, step_id)
        self._touch_required_outputs(wf, step_id)
        return self.mgr.mark_done(wf, step_id, data_raw)

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
        result = self.mgr.mark_done(wf, 1)

        self.assertEqual(1, result["generated"])
        self.assertEqual("sr-design", self.mgr.get_ready(wf)[0].type)

    def test_prompt_template_is_returned_by_next_payload(self) -> None:
        wf = self.mgr.start("sr", {"SR": "SR-001"})
        self._done(wf, 1)
        self._done(wf, 2)

        order = self.mgr.build_next_payload(wf)["ready"][0]

        self.assertEqual("ar-split", order["type"])
        self.assertEqual("prompt", order["execution"])
        self.assertEqual("prompts/ar-split.md", order["prompt"]["template"])
        self.assertIn("是否需要拆分 AR", order["prompt"]["rendered"])
        self.assertIn("ars", order["data"]["fields"])
        self.assertTrue(order["data_file"]["path"].endswith("/.sdd/SR-001/.aaw/data/step-0003-ar-split.json"))
        self.assertTrue(order["data_file"]["relative_path"].endswith(".sdd/SR-001/.aaw/data/step-0003-ar-split.json"))
        self.assertEqual("utf-8", order["data_file"]["encoding"])
        self.assertIn("aaw.py", order["commands"]["done"])
        self.assertIn("--data-file", order["commands"]["done"])
        self.assertIn("step-0003-ar-split.json", order["commands"]["done"])
        self.assertTrue(order["commands"]["done_inline"].endswith("done --sr SR-001 3 --data '<JSON>' --json"))
        self.assertEqual("aaw done --sr SR-001 3 --data '<JSON>' --json", order["commands"]["legacy_done"])

    def test_choice_generates_ar_clarify_steps_from_config(self) -> None:
        wf = self.mgr.start("sr", {"SR": "SR-001"})
        self._done(wf, 1)
        self._done(wf, 2)

        result = self._done(
            wf,
            3,
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
                [sys.executable, str(AAW_SCRIPT), "done", "--sr", "SR-DATAFILE", "1", "--json"],
                cwd=cwd,
                check=True,
                text=True,
                capture_output=True,
            )
            (cwd / ".sdd" / "SR-DATAFILE" / "SR-design.md").write_text("sr design", "utf-8")
            subprocess.run(
                [sys.executable, str(AAW_SCRIPT), "done", "--sr", "SR-DATAFILE", "2", "--json"],
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
                [
                    sys.executable,
                    str(AAW_SCRIPT),
                    "done",
                    "--sr",
                    "SR-DATAFILE",
                    "3",
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
        wf = self.mgr.start("sr", {"SR": "SR-001"})
        self._done(wf, 1)
        self._done(wf, 2)

        self._done(wf, 3, json.dumps({"mode": "no_split"}))
        ready = self.mgr.get_ready(wf)

        self.assertEqual(1, len(ready))
        self.assertEqual("module-boundary-design", ready[0].type)
        self.assertEqual("ALL", ready[0].vars["AR"])
        self.assertTrue(ready[0].output[0]["path"].endswith("/SR-001/ALL/module-boundary-design.md"))

    def test_invalid_choice_item_is_rejected_without_mutating_workflow(self) -> None:
        wf = self.mgr.start("sr", {"SR": "SR-BAD"})
        self._done(wf, 1)
        self._done(wf, 2)

        with self.assertRaises(DataError):
            self._done(wf, 3, json.dumps({"ars": [{"id": "AR-001"}]}))

        step = wf.get_step(3)
        assert step is not None
        self.assertFalse(step.finished)
        self.assertEqual([], step.next)
        self.assertEqual(3, len(wf.steps))

    def test_ar_entry_skips_sr_design_and_ar_split(self) -> None:
        wf = self.mgr.start("ar", {"SR": "SR-002", "AR": "AR-010", "描述": "直接入口"})
        first = self.mgr.build_next_payload(wf)["ready"][0]
        self.assertEqual("ar-init", first["type"])

        self._done(wf, 1)
        second = self.mgr.build_next_payload(wf)["ready"][0]

        self.assertEqual("ar-clarify", second["type"])
        self.assertEqual("AR-010", second["vars"]["AR"])
        self.assertNotIn("sr-design", [s.type for s in wf.steps])
        self.assertNotIn("ar-split", [s.type for s in wf.steps])

    def test_ar_entry_requires_repo_init_artifact_before_done(self) -> None:
        wf = self.mgr.start("ar", {"SR": "SR-REPO", "AR": "AR-001", "描述": "直接入口"})
        first = self.mgr.build_next_payload(wf)["ready"][0]

        self.assertTrue(first["inputs"]["blocked"])
        self.assertTrue(first["inputs"]["missing_required"][0].endswith("/.sdd/software_architecture.md"))
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
        report = Path(gate_step.output[0]["path"])

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
        report = Path(gate_step.output[0]["path"])

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
        self.assertEqual(["T1-task-dev", "T2-task-dev"], [s.name for s in ready])
        self.assertTrue(ready[0].input[0]["path"].endswith("/模块A,B_tasks/T1-用户CRUD.md"))
        self.assertTrue(ready[1].input[0]["path"].endswith("/模块A,B_tasks/T2-权限校验.md"))

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
        ar_output = Path(ar_step.output[0]["path"])
        ar_output.parent.mkdir(parents=True, exist_ok=True)
        ar_output.write_text("clarified", "utf-8")
        self._done(wf, 2)

        result = self.mgr.rollback(wf, 1)

        self.assertEqual(2, result["removed"])
        self.assertFalse(ar_output.exists())
        self.assertEqual([1], [s.id for s in wf.steps])
        self.assertFalse(wf.steps[0].finished)
        self.assertEqual([], wf.steps[0].next)


if __name__ == "__main__":
    unittest.main()
