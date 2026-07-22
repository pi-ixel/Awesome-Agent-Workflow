"""Drift guard for the workflow-orchestration preamble injected into skills.

The canonical preamble text lives in docs/skill-context-preamble.md (between
the BEGIN/END markers).  Every workflow business skill must embed it verbatim,
right after its frontmatter.  Non-workflow skills must NOT embed it.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKILLS = ROOT / "skills"
PREAMBLE_DOC = ROOT / "docs" / "skill-context-preamble.md"

TARGET_SKILLS = [
    "sr-design",
    "sr-design-gate",
    "ar-clarify",
    "module-boundary-design",
    "module-asis-analysis",
    "module-tobe-design",
    "module-test-design",
    "module-design-gate",
    "task-split",
    "task-dev",
]

NON_TARGET_SKILLS = [
    "repo-init",
    "module-deep-research",
    "aaw-workflow",
]

PREAMBLE_HEADING = "## 前置操作：工作流编排检查"


def _canonical_preamble() -> str:
    text = PREAMBLE_DOC.read_text(encoding="utf-8").replace("\r\n", "\n")
    m = re.search(
        r"<!-- BEGIN PREAMBLE -->\n(.*?)\n<!-- END PREAMBLE -->",
        text,
        re.DOTALL,
    )
    if not m:
        raise AssertionError("BEGIN/END PREAMBLE markers not found in docs")
    return m.group(1).strip("\n")


def _skill_md(name: str) -> str:
    return (
        (SKILLS / name / "SKILL.md")
        .read_text(encoding="utf-8-sig")
        .replace("\r\n", "\n")
    )


class PreambleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.preamble = _canonical_preamble()

    def test_canonical_preamble_is_the_expected_section(self) -> None:
        self.assertTrue(self.preamble.startswith(PREAMBLE_HEADING))

    def test_targets_embed_preamble_verbatim(self) -> None:
        for name in TARGET_SKILLS:
            with self.subTest(skill=name):
                self.assertIn(
                    self.preamble,
                    _skill_md(name),
                    f"{name}/SKILL.md is missing the canonical preamble verbatim",
                )

    def test_preamble_is_first_section_after_frontmatter(self) -> None:
        for name in TARGET_SKILLS:
            with self.subTest(skill=name):
                content = _skill_md(name)
                # Strip the leading YAML frontmatter block.
                self.assertTrue(content.startswith("---\n"))
                _, _, body = content[4:].partition("\n---\n")
                self.assertTrue(body, f"{name}/SKILL.md has no body after frontmatter")
                first_heading = next(
                    line for line in body.splitlines() if line.startswith("## ")
                )
                self.assertEqual(
                    first_heading,
                    PREAMBLE_HEADING,
                    f"{name}/SKILL.md first ## section is not the preamble",
                )

    def test_non_targets_do_not_embed_preamble(self) -> None:
        for name in NON_TARGET_SKILLS:
            with self.subTest(skill=name):
                self.assertNotIn(
                    PREAMBLE_HEADING,
                    _skill_md(name),
                    f"{name}/SKILL.md must not contain the workflow preamble",
                )


if __name__ == "__main__":
    unittest.main()
