"""Drift guards for SR Mermaid change-visualization rules."""

from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = ROOT / "skills" / "sr-design" / "reference" / "design-template.md"
SR_SKILL = ROOT / "skills" / "sr-design" / "SKILL.md"
GATE_CHECKLIST = (
    ROOT / "skills" / "sr-design-gate" / "references" / "gate-checklist.md"
)
GATE_RESULT = (
    ROOT / "skills" / "sr-design-gate" / "references" / "gate-result-template.md"
)
FIXTURES = ROOT / "test" / "sr-design-gate" / "fixtures"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig").replace("\r\n", "\n")


class SrDiagramContractTests(unittest.TestCase):
    def test_template_defines_fixed_palette_and_in_diagram_legends(self) -> None:
        template = _read(TEMPLATE)
        for color in ("#dbeafe", "#2563eb", "#ffedd5", "#ea580c"):
            self.assertIn(color, template)
        for color in ("#fee2e2", "#dc2626", "#f3f4f6", "#6b7280"):
            self.assertIn(color, template)
        self.assertIn("subgraph Legend[图例]", template)
        self.assertIn("Note over U,EXT: 图例：变更", template)
        self.assertIn("linkStyle", template)
        self.assertIn("stroke-dasharray:5 5", template)

    def test_skill_requires_change_focused_diagrams(self) -> None:
        skill = _read(SR_SKILL)
        self.assertIn("必须表达目标方案相对当前代码与现有架构文档的变化", skill)
        self.assertIn("业务节点和连线不得添加状态前缀", skill)
        self.assertIn("变更前/变更后", skill)

    def test_gate_has_blocking_diagram_dimension_and_report_row(self) -> None:
        checklist = _read(GATE_CHECKLIST)
        report = _read(GATE_RESULT)
        self.assertIn("| 图表变更表达", checklist)
        self.assertIn("## 图表变更表达检查", checklist)
        self.assertIn("该维度即判未达标并阻断通过", checklist)
        self.assertIn("| 图表变更表达 |", report)

    def test_gate_fixtures_include_all_required_diagram_kinds(self) -> None:
        for case in ("pass", "case-01-conflicts"):
            with self.subTest(case=case):
                design = _read(FIXTURES / case / "SR-design.md")
                # design-template.md 声明的必填 mermaid 图共 2 张：
                # 2.1 主流程时序图（sequenceDiagram）、2.2 架构分层图（graph TB）。
                # fixture 必须都包含，且每张适用图带图内图例。
                self.assertGreaterEqual(design.count("```mermaid"), 2)
                self.assertIn("sequenceDiagram", design)
                self.assertIn("graph TB", design)
                self.assertIn("图例：变更", design)
                self.assertIn("subgraph Legend[图例]", design)


if __name__ == "__main__":
    unittest.main()
