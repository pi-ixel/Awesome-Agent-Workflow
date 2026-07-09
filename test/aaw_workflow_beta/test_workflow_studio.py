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

    def test_delete_referenced_node_is_rejected(self) -> None:
        with self.assertRaises(server.StudioError):
            server.delete_node({"node_type": "task-split"})


if __name__ == "__main__":
    unittest.main()
