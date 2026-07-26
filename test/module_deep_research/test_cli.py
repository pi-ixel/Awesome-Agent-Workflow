from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "skills" / "module-deep-research" / "scripts" / "deep_research.py"
TEMPLATES = (
    ROOT / "skills" / "module-deep-research" / "assets" / "templates"
)


class DeepResearchCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.cwd = Path(self.temp.name)
        self.source = self.cwd / "src" / "payment"
        self.source.mkdir(parents=True)
        (self.source / "service.py").write_text(
            "def create_payment():\n"
            "    return 'created'\n",
            "utf-8",
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def run_cli(self, *args: str, expect: int = 0) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            cwd=self.cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env={
                **os.environ,
                "PYTHONIOENCODING": "utf-8",
                "PYTHONUTF8": "1",
            },
            timeout=30,
        )
        self.assertEqual(
            expect,
            result.returncode,
            msg=f"argv={args!r}\nstdout={result.stdout!r}\nstderr={result.stderr!r}",
        )
        return result

    def run_git(self, *args: str) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            ["git", *args],
            cwd=self.cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
        self.assertEqual(
            0,
            result.returncode,
            msg=f"git {args!r}\nstdout={result.stdout!r}\nstderr={result.stderr!r}",
        )
        return result

    def init(self, budget: str = "45m") -> dict:
        result = self.run_cli(
            "init",
            "--module",
            "payment",
            "--path",
            "src/payment",
            "--budget",
            budget,
            "--json",
        )
        return json.loads(result.stdout)

    def test_uv_entrypoint(self) -> None:
        result = subprocess.run(
            ["uv", "run", "--no-project", str(SCRIPT), "--help"],
            cwd=self.cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env={
                **os.environ,
                "PYTHONIOENCODING": "utf-8",
                "PYTHONUTF8": "1",
            },
            timeout=30,
        )
        self.assertEqual(0, result.returncode, msg=result.stderr)
        self.assertIn("deep-research", result.stdout)

    def next_task(self) -> dict:
        result = self.run_cli("next", "--module", "payment", "--json")
        return json.loads(result.stdout)

    def acceptance_checks(self, work: dict, claim_ref: int = 0) -> list[dict]:
        return [
            {
                "criterion_index": index,
                "status": "satisfied",
                "claim_refs": [claim_ref],
                "notes": "测试结论与原始证据覆盖该完成标准。",
            }
            for index, _ in enumerate(work["task"]["acceptance"])
        ]

    def state_path(self) -> Path:
        return (
            self.cwd
            / ".sdd"
            / "modules"
            / "payment"
            / "研究过程"
            / "research-state.json"
        )

    def test_init_and_next_use_json_as_only_queue_state(self) -> None:
        payload = self.init()
        self.assertEqual("initialized", payload["status"])
        self.assertGreaterEqual(payload["task_count"], 10)

        process = self.state_path().parent
        self.assertTrue(self.state_path().is_file())
        self.assertFalse((process / "研究队列.md").exists())
        self.assertFalse((process / "待解问题.md").exists())
        overview = (
            self.cwd
            / ".sdd"
            / "modules"
            / "payment"
            / "payment模块认知说明书.md"
        ).read_text("utf-8")
        self.assertIn("## 6. 功能地图", overview)
        self.assertIn("## 4. 设计模式与关键抽象", overview)
        self.assertIn("### 3.4 依赖全景图", overview)
        self.assertIn("## 10. 演进与变更指南", overview)
        self.assertIn("## 12. 名词与术语解释", overview)
        self.assertTrue(
            (
                self.cwd
                / ".sdd"
                / "modules"
                / "payment"
                / "数据模型与状态.md"
            ).is_file()
        )

        work = self.next_task()
        self.assertEqual("task", work["status"])
        self.assertEqual("DR-001", work["task"]["id"])
        self.assertIn("本轮只研究一个问题", work["prompt"])
        self.assertIn("建议优先取证位置", work["prompt"])
        self.assertIn("acceptance_checks", work["prompt"])
        self.assertNotIn("{{", work["prompt"])
        self.assertIn("uv run", work["commands"]["done"])

    def test_done_validates_evidence_and_changed_asset(self) -> None:
        self.init()
        work = self.next_task()
        task_id = work["task"]["id"]
        summary = self.cwd / ".sdd" / "modules" / "payment" / "payment模块认知说明书.md"
        summary.write_text(summary.read_text("utf-8") + "\n已确认支付模块入口。\n", "utf-8")

        finding = self.cwd / work["result_file"]
        finding.write_text(
            json.dumps(
                {
                    "task_id": task_id,
                    "outcome": "completed",
                    "summary": "确认公开入口 create_payment。",
                    "claims": [
                        {
                            "statement": "create_payment 是当前样例公开入口。",
                            "status": "FACT",
                            "evidence": [
                                {
                                    "path": "src/payment/service.py",
                                    "line_start": 1,
                                    "line_end": 2,
                                    "symbol": "create_payment",
                                    "proves": "函数定义和返回行为存在。",
                                }
                            ],
                        }
                    ],
                    "acceptance_checks": self.acceptance_checks(work),
                    "updated_assets": [
                        ".sdd/modules/payment/payment模块认知说明书.md"
                    ],
                    "new_tasks": [],
                    "unresolved_issues": [],
                },
                ensure_ascii=False,
            ),
            "utf-8",
        )
        result = self.run_cli(
            "done",
            "--module",
            "payment",
            "--task",
            task_id,
            "--result",
            work["result_file"],
            "--json",
        )
        payload = json.loads(result.stdout)
        self.assertEqual("active", payload["status"])
        self.assertEqual("completed", payload["task_outcome"])

    def test_done_rejects_unchanged_claimed_asset(self) -> None:
        self.init()
        work = self.next_task()
        task_id = work["task"]["id"]
        finding = self.cwd / work["result_file"]
        finding.write_text(
            json.dumps(
                {
                    "task_id": task_id,
                    "outcome": "completed",
                    "summary": "声称更新但实际没有改文档。",
                    "claims": [
                        {
                            "statement": "样例函数存在。",
                            "status": "FACT",
                            "evidence": [
                                {
                                    "path": "src/payment/service.py",
                                    "line_start": 1,
                                    "line_end": 1,
                                    "symbol": "create_payment",
                                    "proves": "函数定义存在。",
                                }
                            ],
                        }
                    ],
                    "acceptance_checks": self.acceptance_checks(work),
                    "updated_assets": [
                        ".sdd/modules/payment/payment模块认知说明书.md"
                    ],
                    "new_tasks": [],
                    "unresolved_issues": [],
                },
                ensure_ascii=False,
            ),
            "utf-8",
        )
        failed = self.run_cli(
            "done",
            "--module",
            "payment",
            "--task",
            task_id,
            "--result",
            work["result_file"],
            "--json",
            expect=2,
        )
        error = json.loads(failed.stderr)
        self.assertIn("没有变化", error["error"])

    def test_done_requires_each_acceptance_criterion_to_be_checked(self) -> None:
        self.init()
        work = self.next_task()
        task_id = work["task"]["id"]
        summary = (
            self.cwd
            / ".sdd"
            / "modules"
            / "payment"
            / "payment模块认知说明书.md"
        )
        summary.write_text(summary.read_text("utf-8") + "\n已核对模块入口。\n", "utf-8")
        finding = self.cwd / work["result_file"]
        finding.write_text(
            json.dumps(
                {
                    "task_id": task_id,
                    "outcome": "completed",
                    "summary": "只提交了结论，没有逐项核对完成标准。",
                    "claims": [
                        {
                            "statement": "create_payment 是样例入口。",
                            "status": "FACT",
                            "evidence": [
                                {
                                    "path": "src/payment/service.py",
                                    "line_start": 1,
                                    "line_end": 2,
                                    "symbol": "create_payment",
                                    "proves": "函数入口存在。",
                                }
                            ],
                        }
                    ],
                    "updated_assets": [
                        ".sdd/modules/payment/payment模块认知说明书.md"
                    ],
                    "new_tasks": [],
                    "unresolved_issues": [],
                },
                ensure_ascii=False,
            ),
            "utf-8",
        )
        failed = self.run_cli(
            "done",
            "--module",
            "payment",
            "--task",
            task_id,
            "--result",
            work["result_file"],
            "--json",
            expect=2,
        )
        self.assertIn(
            "acceptance_checks",
            json.loads(failed.stderr)["error"],
        )

    def test_pause_and_resume_preserve_current_task(self) -> None:
        self.init()
        work = self.next_task()
        task_id = work["task"]["id"]

        paused = json.loads(
            self.run_cli("pause", "--module", "payment", "--json").stdout
        )
        self.assertEqual(task_id, paused["current_task_id"])
        self.assertEqual(
            "paused",
            json.loads(
                self.run_cli("next", "--module", "payment", "--json").stdout
            )["status"],
        )

        self.run_cli(
            "resume",
            "--module",
            "payment",
            "--budget",
            "30m",
            "--json",
        )
        resumed = self.next_task()
        self.assertEqual(task_id, resumed["task"]["id"])

    def test_add_question_reopens_completed_research_and_preserves_history(
        self,
    ) -> None:
        self.init()
        state = json.loads(self.state_path().read_text("utf-8"))
        original_task_ids = [task["id"] for task in state["tasks"]]
        for task in state["tasks"]:
            task["status"] = "completed"
            task["summary"] = "既有研究已经完成。"
            task["ended_at"] = state["created_at"]
        state["status"] = "complete"
        state["phase"] = "complete"
        state["completed_at"] = state["created_at"]
        state["session"]["active_started_at"] = None
        state["session"]["elapsed_seconds"] = 12
        self.state_path().write_text(
            json.dumps(state, ensure_ascii=False, indent=2),
            "utf-8",
        )
        base = self.cwd / ".sdd" / "modules" / "payment"
        overview = base / "payment模块认知说明书.md"
        overview.write_text(
            overview.read_text("utf-8").replace(
                "- 状态：研究中",
                "- 状态：已完成",
            ),
            "utf-8",
        )
        for name in ("数据模型与状态.md", "约束与风险.md"):
            path = base / name
            path.write_text(
                path.read_text("utf-8").replace(
                    "- 文档状态：研究中",
                    "- 文档状态：已完成",
                ),
                "utf-8",
            )

        added = json.loads(
            self.run_cli(
                "add-question",
                "--module",
                "payment",
                "--question",
                "重复支付请求在当前实现中如何处理？",
                "--budget",
                "30m",
                "--json",
            ).stdout
        )
        self.assertEqual("question_added", added["status"])
        self.assertTrue(added["reopened"])

        reopened = json.loads(self.state_path().read_text("utf-8"))
        self.assertEqual("active", reopened["status"])
        self.assertEqual("research", reopened["phase"])
        self.assertIsNone(reopened["completed_at"])
        self.assertEqual(30 * 60, reopened["session"]["budget_seconds"])
        self.assertEqual(0, reopened["session"]["elapsed_seconds"])
        self.assertTrue(set(original_task_ids).issubset(
            {task["id"] for task in reopened["tasks"]}
        ))
        question_task = next(
            task for task in reopened["tasks"] if task["id"] == added["task_id"]
        )
        self.assertEqual("user-question", question_task["type"])
        self.assertEqual(100, question_task["priority"])
        self.assertIn("- 状态：研究中", overview.read_text("utf-8"))
        self.assertIn(
            "- 文档状态：研究中",
            (base / "数据模型与状态.md").read_text("utf-8"),
        )

        work = self.next_task()
        self.assertEqual(added["task_id"], work["task"]["id"])
        self.assertIn("重复支付请求在当前实现中如何处理？", work["prompt"])
        self.assertIn("来源：用户", work["prompt"])
        duplicate = json.loads(
            self.run_cli(
                "add-question",
                "--module",
                "payment",
                "--question",
                "重复支付请求在当前实现中如何处理？",
                "--json",
            ).stdout
        )
        self.assertEqual("question_exists", duplicate["status"])
        self.assertEqual("running", duplicate["task_status"])

        finding = self.cwd / work["result_file"]
        finding.write_text(
            json.dumps(
                {
                    "task_id": work["task"]["id"],
                    "outcome": "completed",
                    "summary": "当前样例没有额外的重复请求处理机制。",
                    "claims": [
                        {
                            "statement": "当前入口直接返回固定结果。",
                            "status": "FACT",
                            "evidence": [
                                {
                                    "path": "src/payment/service.py",
                                    "line_start": 1,
                                    "line_end": 2,
                                    "symbol": "create_payment",
                                    "proves": "当前入口没有额外参数或重复请求分支。",
                                }
                            ],
                        }
                    ],
                    "acceptance_checks": self.acceptance_checks(work),
                    "updated_assets": [],
                    "new_tasks": [],
                    "unresolved_issues": [],
                },
                ensure_ascii=False,
            ),
            "utf-8",
        )
        self.run_cli(
            "done",
            "--module",
            "payment",
            "--task",
            work["task"]["id"],
            "--result",
            work["result_file"],
            "--json",
        )
        self.assertEqual(
            "needs_recheck",
            json.loads(
                self.run_cli("next", "--module", "payment", "--json").stdout
            )["status"],
        )

    def test_add_question_invalidates_running_recheck(self) -> None:
        self.init()
        state = json.loads(self.state_path().read_text("utf-8"))
        for task in state["tasks"]:
            task["status"] = "completed"
            task["summary"] = "测试中视为已完成。"
            task["ended_at"] = state["created_at"]
        self.state_path().write_text(
            json.dumps(state, ensure_ascii=False, indent=2),
            "utf-8",
        )
        recheck = json.loads(
            self.run_cli("recheck", "--module", "payment", "--json").stdout
        )
        running_recheck = self.next_task()
        self.assertEqual(recheck["task_id"], running_recheck["task"]["id"])

        added = json.loads(
            self.run_cli(
                "add-question",
                "--module",
                "payment",
                "--question",
                "这个模块是否允许并行创建支付？",
                "--json",
            ).stdout
        )
        self.assertEqual([recheck["task_id"]], added["invalidated_rechecks"])
        state = json.loads(self.state_path().read_text("utf-8"))
        invalidated = next(
            task for task in state["tasks"] if task["id"] == recheck["task_id"]
        )
        self.assertEqual("split", invalidated["status"])
        self.assertIsNone(state["current_task_id"])
        next_work = self.next_task()
        self.assertEqual(added["task_id"], next_work["task"]["id"])

    def test_git_history_backfill_and_incremental_refresh_use_current_code_evidence(
        self,
    ) -> None:
        self.run_git("init")
        self.run_git("add", "src/payment/service.py")
        self.run_git(
            "-c",
            "user.name=Deep Research Test",
            "-c",
            "user.email=deep-research@example.com",
            "commit",
            "-m",
            "create payment entry",
        )
        (self.source / "service.py").write_text(
            "def create_payment():\n"
            "    return 'accepted'\n",
            "utf-8",
        )
        self.run_git("add", "src/payment/service.py")
        self.run_git(
            "-c",
            "user.name=Deep Research Test",
            "-c",
            "user.email=deep-research@example.com",
            "commit",
            "-m",
            "change payment result",
        )

        initialized = self.init()
        self.assertEqual(2, initialized["history"]["commit_count"])
        state = json.loads(self.state_path().read_text("utf-8"))
        history_tasks = [
            task for task in state["tasks"] if task["type"] == "git-change"
        ]
        self.assertEqual(2, len(history_tasks))
        self.assertTrue(
            all(task["reason"] == "history-backfill" for task in history_tasks)
        )
        self.assertTrue(all(task["priority"] == 55 for task in history_tasks))

        (self.source / "service.py").write_text(
            "def create_payment():\n"
            "    return 'settled'\n",
            "utf-8",
        )
        self.run_git("add", "src/payment/service.py")
        self.run_git(
            "-c",
            "user.name=Deep Research Test",
            "-c",
            "user.email=deep-research@example.com",
            "commit",
            "-m",
            "settle payment result",
        )
        synced = json.loads(
            self.run_cli("history-sync", "--module", "payment", "--json").stdout
        )
        self.assertEqual("history_synced", synced["status"])
        self.assertEqual(1, len(synced["created_tasks"]))

        state = json.loads(self.state_path().read_text("utf-8"))
        refresh_id = synced["created_tasks"][0]
        refresh_task = next(task for task in state["tasks"] if task["id"] == refresh_id)
        self.assertEqual("history-refresh", refresh_task["reason"])
        self.assertEqual(98, refresh_task["priority"])
        for task in state["tasks"]:
            if task["id"] != refresh_id:
                task["status"] = "completed"
                task["summary"] = "测试中视为已完成。"
                task["ended_at"] = state["created_at"]
        self.state_path().write_text(
            json.dumps(state, ensure_ascii=False, indent=2),
            "utf-8",
        )
        work = self.next_task()
        self.assertEqual(refresh_id, work["task"]["id"])
        self.assertIn("只能作为调查入口", work["prompt"])
        self.assertIn("当前模块源码为事实来源", work["prompt"])

        finding = self.cwd / work["result_file"]
        invalid_evidence = {
            "path": "src/payment/service.py",
            "line_start": 1,
            "line_end": 2,
            "symbol": "create_payment",
            "proves": "当前实现返回 settled。",
            "commit": work["task"]["context"]["git_commit"],
        }
        result = {
            "task_id": refresh_id,
            "outcome": "completed",
            "summary": "提交线索已回到当前源码核对。",
            "claims": [
                {
                    "statement": "当前 create_payment 返回 settled。",
                    "status": "FACT",
                    "evidence": [invalid_evidence],
                }
            ],
            "acceptance_checks": self.acceptance_checks(work),
            "updated_assets": [],
            "new_tasks": [],
            "unresolved_issues": [],
        }
        finding.write_text(json.dumps(result, ensure_ascii=False), "utf-8")
        rejected = self.run_cli(
            "done",
            "--module",
            "payment",
            "--task",
            refresh_id,
            "--result",
            work["result_file"],
            "--json",
            expect=2,
        )
        self.assertIn("不能把 Git 提交", json.loads(rejected.stderr)["error"])

        invalid_evidence.pop("commit")
        finding.write_text(json.dumps(result, ensure_ascii=False), "utf-8")
        accepted = json.loads(
            self.run_cli(
                "done",
                "--module",
                "payment",
                "--task",
                refresh_id,
                "--result",
                work["result_file"],
                "--json",
            ).stdout
        )
        self.assertEqual("completed", accepted["task_outcome"])

        recheck_created = json.loads(
            self.run_cli("recheck", "--module", "payment", "--json").stdout
        )
        recheck_work = self.next_task()
        self.assertEqual(recheck_created["task_id"], recheck_work["task"]["id"])
        (self.source / "service.py").write_text(
            "def create_payment():\n"
            "    return 'archived'\n",
            "utf-8",
        )
        self.run_git("add", "src/payment/service.py")
        self.run_git(
            "-c",
            "user.name=Deep Research Test",
            "-c",
            "user.email=deep-research@example.com",
            "commit",
            "-m",
            "archive payment result",
        )
        superseded = json.loads(
            self.run_cli(
                "done",
                "--module",
                "payment",
                "--task",
                recheck_work["task"]["id"],
                "--result",
                recheck_work["result_file"],
                "--json",
            ).stdout
        )
        self.assertEqual("superseded_by_new_commits", superseded["task_outcome"])
        self.assertEqual("research", superseded["phase"])
        self.assertEqual(1, len(superseded["created_tasks"]))

    def test_recheck_can_complete_after_all_research_tasks(self) -> None:
        self.init()
        base = self.cwd / ".sdd" / "modules" / "payment"
        evidence = "[FACT] 本节不适用或已核对。证据：src/payment/service.py:1。"
        for name in (
            "payment模块认知说明书.md",
            "数据模型与状态.md",
            "约束与风险.md",
        ):
            path = base / name
            content = path.read_text("utf-8").replace("待研究。", evidence)
            path.write_text(content, "utf-8")
        flow_relative = "业务功能/业务流程/创建支付.md"
        flow = base / flow_relative
        flow.write_text(
            (TEMPLATES / "business-flow.md")
            .read_text("utf-8")
            .replace("<功能名称>", "创建支付")
            .replace("{{DATE}}", date.today().isoformat())
            .replace("待研究。", evidence),
            "utf-8",
        )
        overview_path = base / "payment模块认知说明书.md"
        overview_path.write_text(
            overview_path.read_text("utf-8")
            + f"\n| 创建支付 | 业务流程 | create_payment | 样例 | {flow_relative} |\n",
            "utf-8",
        )
        state = json.loads(self.state_path().read_text("utf-8"))
        for task in state["tasks"]:
            task["status"] = "completed"
            task["summary"] = f"{task['title']} 已完成"
            task["ended_at"] = state["created_at"]
        self.state_path().write_text(
            json.dumps(state, ensure_ascii=False, indent=2),
            "utf-8",
        )

        created = json.loads(
            self.run_cli("recheck", "--module", "payment", "--json").stdout
        )
        self.assertEqual("recheck_created", created["status"])
        work = self.next_task()
        self.assertEqual("recheck", work["task"]["type"])

        finding = self.cwd / work["result_file"]
        finding.write_text(
            json.dumps(
                {
                    "task_id": work["task"]["id"],
                    "outcome": "completed",
                    "summary": "抽样路径、失败场景和假设变更均可由认知资产解释。",
                    "claims": [
                        {
                            "statement": "抽样入口存在可复核的实现证据。",
                            "status": "FACT",
                            "evidence": [
                                {
                                    "path": "src/payment/service.py",
                                    "line_start": 1,
                                    "line_end": 2,
                                    "symbol": "create_payment",
                                    "proves": "核心入口定义和返回行为可被复核。",
                                }
                            ],
                        }
                    ],
                    "acceptance_checks": self.acceptance_checks(work),
                    "updated_assets": [],
                    "new_tasks": [],
                    "unresolved_issues": [],
                },
                ensure_ascii=False,
            ),
            "utf-8",
        )
        done = json.loads(
            self.run_cli(
                "done",
                "--module",
                "payment",
                "--task",
                work["task"]["id"],
                "--result",
                work["result_file"],
                "--json",
            ).stdout
        )
        self.assertEqual("complete", done["status"])
        self.assertEqual("complete", done["phase"])
        self.assertIn("- 状态：已完成", overview_path.read_text("utf-8"))


if __name__ == "__main__":
    unittest.main()
