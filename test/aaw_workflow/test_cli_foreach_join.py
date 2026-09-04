"""Tests for foreach fan-in (`join_to`): a join step generated up front that
waits for every sibling of the fan-out before it becomes ready."""

from __future__ import annotations

import json
import unittest

from _cli_base import CliTestBase

FLOW_YAML = """
entrypoints:
  join-demo:
    start: scan
    vars: [SR]
edges:
  scan:
    kind: choice
    data_schema:
      description: 提交扫描出的模块清单
      fields:
        modules:
          description: 模块名列表
          example: [alpha, beta]
    choices:
      - when: data.modules
        to: work
        foreach: data.modules
        scheduling: serial
        join_to: wrap
  work:
    kind: terminal
  wrap:
    kind: terminal
"""

SCAN_YAML = """
name: 扫描模块
execution: prompt
prompt:
  steps:
    - do: 扫描仓库并提交模块清单
"""

WORK_YAML = """
name: 逐模块执行
execution: prompt
prompt:
  steps:
    - do: 完成本模块的工作
"""

WRAP_YAML = """
name: 汇总
execution: prompt
prompt:
  steps:
    - do: 汇总全部模块产出
"""


class ForeachJoinTests(CliTestBase):
    def setUp(self) -> None:
        super().setUp()
        defs = self.cwd / ".sdd" / ".aaw" / "definitions"
        defs.mkdir(parents=True)
        (defs / "flow.yaml").write_text(FLOW_YAML, "utf8")
        (defs / "scan.yaml").write_text(SCAN_YAML, "utf8")
        (defs / "work.yaml").write_text(WORK_YAML, "utf8")
        (defs / "wrap.yaml").write_text(WRAP_YAML, "utf8")

    def start_and_scan(self, sr: str) -> None:
        self.run_cli("start", "--entry", "join-demo", "--sr", sr, "--json")
        self.run_cli("next", "--sr", sr, "--json")
        self.run_cli(
            "done", "--sr", sr, "1",
            "--data", json.dumps({"modules": ["alpha", "beta"]}),
            "--json",
        )

    def status(self, sr: str) -> dict:
        return json.loads(self.run_cli("status", "--sr", sr, "--json").stdout)

    def ready_ids(self, sr: str) -> list[int]:
        self.run_cli("next", "--sr", sr, "--json")
        payload = json.loads(self.run_cli("next", "--sr", sr, "--peek", "--json").stdout)
        return [step["id"] for step in payload["ready"]]

    def test_join_generates_one_wrapper_depending_on_all_siblings(self) -> None:
        self.start_and_scan("SR-J1")

        data = self.status("SR-J1")
        steps = {step["id"]: step for step in data["steps"]}
        self.assertEqual(len(data["steps"]), 4)
        self.assertEqual(steps[2]["type"], "work")
        self.assertEqual(steps[3]["type"], "work")
        self.assertEqual(steps[4]["type"], "wrap")
        self.assertEqual(steps[4]["depends_on"], [2, 3])

    def test_join_step_not_ready_until_every_sibling_finishes(self) -> None:
        self.start_and_scan("SR-J2")

        # 串行扇出：只有第一个分身就绪
        self.assertEqual(self.ready_ids("SR-J2"), [2])
        self.run_cli("done", "--sr", "SR-J2", "2", "--json")
        # 第一个分身完成后放行第二个；join 仍被它阻塞
        self.assertEqual(self.ready_ids("SR-J2"), [3])
        self.run_cli("done", "--sr", "SR-2", "2", expect=1)
        self.run_cli("done", "--sr", "SR-J2", "3", "--json")
        # 全部分身完成，join 才就绪
        self.assertEqual(self.ready_ids("SR-J2"), [4])
        self.run_cli("next", "--sr", "SR-J2", "--json")
        result = json.loads(self.run_cli("done", "--sr", "SR-J2", "4", "--json").stdout)
        self.assertTrue(result["ok"])

    def test_plan_projects_the_join_edge(self) -> None:
        result = self.run_cli("plan", "--entry", "join-demo", "--json")

        data = json.loads(result.stdout)
        join_rows = [edge for edge in data["edges"] if edge["kind"] == "join"]
        self.assertEqual(len(join_rows), 1)
        self.assertEqual(join_rows[0]["from"], "work")
        self.assertEqual(join_rows[0]["to"], "wrap")

    def test_join_to_requires_a_node_definition(self) -> None:
        bad = self.cwd / ".sdd" / ".aaw" / "definitions" / "flow.yaml"
        bad.write_text(FLOW_YAML.replace("join_to: wrap", "join_to: missing"), "utf8")
        self.run_cli("start", "--entry", "join-demo", "--sr", "SR-J3", "--json")
        self.run_cli("next", "--sr", "SR-J3", "--json")
        result = self.run_cli(
            "done", "--sr", "SR-J3", "1",
            "--data", json.dumps({"modules": ["alpha"]}),
            "--json", expect=1,
        )
        self.assertIn("join_to", result.stdout)


if __name__ == "__main__":
    unittest.main()
