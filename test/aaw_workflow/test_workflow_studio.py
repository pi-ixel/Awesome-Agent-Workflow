from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]
STUDIO_DIR = ROOT / "skills" / "aaw-workflow" / "scripts" / "studio"
DEFINITIONS_DIR = ROOT / "skills" / "aaw-workflow" / "scripts" / "cli" / "definitions"
sys.path.insert(0, str(STUDIO_DIR))

import server  # noqa: E402


class WorkflowStudioTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.defs = Path(self.tmp.name) / "definitions"
        shutil.copytree(DEFINITIONS_DIR, self.defs)
        self.old_env = os.environ.get("AAW_STUDIO_DEFINITIONS_DIR")
        os.environ["AAW_STUDIO_DEFINITIONS_DIR"] = str(self.defs)

    def tearDown(self) -> None:
        if self.old_env is None:
            os.environ.pop("AAW_STUDIO_DEFINITIONS_DIR", None)
        else:
            os.environ["AAW_STUDIO_DEFINITIONS_DIR"] = self.old_env
        self.tmp.cleanup()

    def test_config_exposes_gate_pass_edge(self) -> None:
        config = server.load_config()

        gate_edges = [
            edge
            for edge in config["edges"]
            if edge["source"] == "module-design-gate" and edge["target"] == "task-split"
        ]

        self.assertEqual(1, len(gate_edges))
        self.assertEqual("choice", gate_edges[0]["kind"])
        self.assertEqual("must", gate_edges[0]["user_confirm"])

    def test_config_summarizes_prompt_and_data_fields(self) -> None:
        config = server.load_config()
        by_type = {node["type"]: node for node in config["nodes"]}

        ar_split = by_type["ar-split"]
        self.assertEqual("prompt", ar_split["summary"]["execution"])
        self.assertEqual("prompts/ar-split.md", ar_split["summary"]["prompt"])
        self.assertTrue(ar_split["summary"]["has_data_prompt"])

    def test_insert_node_between_gate_and_task_split(self) -> None:
        config = server.load_config()
        gate_edge = next(
            edge
            for edge in config["edges"]
            if edge["source"] == "module-design-gate" and edge["target"] == "task-split"
        )

        result = server.insert_node(
            {
                "edge_id": gate_edge["id"],
                "node_type": "refresh-long-term-docs",
                "name": "{模块组名}-refresh-long-term-docs",
                "execution": "skill",
                "skill": "refresh-long-term-docs",
                "input_text": "\n".join(
                    [
                        ".sdd/{SR}/{AR}/{AR}-{需求短名}-{模块组名}模块详细设计说明书.md",
                        ".sdd/{SR}/{AR}/{AR}-{需求短名}-{模块组名}模块测试用例设计.md",
                        ".sdd/{SR}/{AR}/{AR}-{需求短名}-{模块组名}模块设计门禁结果.md",
                    ]
                ),
                "output_text": ".sdd/{SR}/{AR}/{AR}-{需求短名}-{模块组名}长期文档刷新记录.md",
                "data_prompt": "刷新长期文档后生成刷新记录。",
            }
        )

        flow = yaml.safe_load((self.defs / "flow.yaml").read_text("utf-8"))
        node = yaml.safe_load((self.defs / "refresh-long-term-docs.yaml").read_text("utf-8"))

        self.assertTrue(result["ok"])
        self.assertEqual("refresh-long-term-docs", flow["edges"]["module-design-gate"]["choices"][0]["to"])
        self.assertEqual({"kind": "direct", "to": "task-split"}, flow["edges"]["refresh-long-term-docs"])
        self.assertEqual(["refresh-long-term-docs"], node["skill"])
        self.assertEqual([], result["config"]["validation"]["errors"])

    def test_insert_prompt_node_writes_prompt_template(self) -> None:
        config = server.load_config()
        edge = next(edge for edge in config["edges"] if edge["source"] == "sr-init" and edge["target"] == "sr-design")

        server.insert_node(
            {
                "edge_id": edge["id"],
                "node_type": "confirm-sr-context",
                "name": "confirm-sr-context",
                "execution": "prompt",
                "prompt_mode": "template",
                "prompt_text": "prompts/confirm-sr-context.md",
            }
        )

        node = yaml.safe_load((self.defs / "confirm-sr-context.yaml").read_text("utf-8"))
        self.assertEqual({"template": "prompts/confirm-sr-context.md"}, node["prompt"])

    def test_insert_prompt_node_writes_inline_prompt(self) -> None:
        config = server.load_config()
        edge = next(edge for edge in config["edges"] if edge["source"] == "sr-init" and edge["target"] == "sr-design")

        server.insert_node(
            {
                "edge_id": edge["id"],
                "node_type": "confirm-user-choice",
                "name": "confirm-user-choice",
                "execution": "prompt",
                "prompt_mode": "inline",
                "prompt_text": "向用户确认是否继续推进该流程节点。",
            }
        )

        node = yaml.safe_load((self.defs / "confirm-user-choice.yaml").read_text("utf-8"))
        self.assertEqual({"inline": "向用户确认是否继续推进该流程节点。"}, node["prompt"])

    def test_insert_prompt_node_writes_step_prompt(self) -> None:
        config = server.load_config()
        edge = next(edge for edge in config["edges"] if edge["source"] == "sr-init" and edge["target"] == "sr-design")

        server.insert_node(
            {
                "edge_id": edge["id"],
                "node_type": "collect-context",
                "name": "collect-context",
                "execution": "prompt",
                "prompt_mode": "steps",
                "prompt_text": "check: 确认输入是否齐全\nconfirm: 让用户确认后继续",
            }
        )

        node = yaml.safe_load((self.defs / "collect-context.yaml").read_text("utf-8"))
        self.assertEqual(
            [{"check": "确认输入是否齐全"}, {"confirm": "让用户确认后继续"}],
            node["prompt"]["steps"],
        )

    def test_insert_node_before_entrypoint(self) -> None:
        result = server.insert_node(
            {
                "anchor_node": "sr-init",
                "position": "before",
                "node_type": "prepare-sr",
                "name": "prepare-sr",
                "execution": "skill",
                "skill": "prepare-sr",
            }
        )

        flow = yaml.safe_load((self.defs / "flow.yaml").read_text("utf-8"))

        self.assertTrue(result["ok"])
        self.assertEqual("prepare-sr", flow["entrypoints"]["sr"]["start"])
        self.assertEqual({"kind": "direct", "to": "sr-init"}, flow["edges"]["prepare-sr"])
        self.assertEqual([], result["config"]["validation"]["errors"])

    def test_insert_node_after_terminal(self) -> None:
        result = server.insert_node(
            {
                "anchor_node": "task-dev",
                "position": "after",
                "node_type": "archive-task-result",
                "name": "archive-task-result",
                "execution": "skill",
                "skill": "archive-task-result",
            }
        )

        flow = yaml.safe_load((self.defs / "flow.yaml").read_text("utf-8"))

        self.assertTrue(result["ok"])
        self.assertEqual({"kind": "direct", "to": "archive-task-result"}, flow["edges"]["task-dev"])
        self.assertEqual({"kind": "terminal"}, flow["edges"]["archive-task-result"])
        self.assertEqual([], result["config"]["validation"]["errors"])

    def test_delete_referenced_node_is_rejected(self) -> None:
        with self.assertRaises(server.StudioError):
            server.delete_node({"node_type": "task-split"})

    def test_remove_inserted_middle_node_reconnects_flow(self) -> None:
        config = server.load_config()
        gate_edge = next(
            edge
            for edge in config["edges"]
            if edge["source"] == "module-design-gate" and edge["target"] == "task-split"
        )
        server.insert_node(
            {
                "edge_id": gate_edge["id"],
                "node_type": "refresh-long-term-docs",
                "name": "{模块组名}-refresh-long-term-docs",
                "execution": "skill",
                "skill": "refresh-long-term-docs",
                "output_text": ".sdd/{SR}/{AR}/{AR}-{需求短名}-{模块组名}长期文档刷新记录.md",
            }
        )

        result = server.remove_node({"node_type": "refresh-long-term-docs"})
        flow = yaml.safe_load((self.defs / "flow.yaml").read_text("utf-8"))

        self.assertTrue(result["ok"])
        self.assertFalse((self.defs / "refresh-long-term-docs.yaml").exists())
        self.assertEqual("task-split", flow["edges"]["module-design-gate"]["choices"][0]["to"])
        self.assertNotIn("refresh-long-term-docs", flow["edges"])
        self.assertEqual([], result["config"]["validation"]["errors"])


if __name__ == "__main__":
    unittest.main()
