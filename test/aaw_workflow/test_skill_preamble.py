"""Drift guard for the workflow-orchestration preamble injected into skills.

CANONICAL_PREAMBLE below is the single source of truth for the preamble text.
Every workflow business skill must embed it verbatim, right after its
frontmatter.  Non-workflow skills must NOT embed it.
"""

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKILLS = ROOT / "skills"

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

CANONICAL_PREAMBLE = """\
## 前置操作：工作流编排检查

若本 skill 是由 aaw-workflow 的工作单调用的，跳过本节，直接执行正文。

否则，在执行正文之前，先向用户发起一次二选一确认：

> 是否回到 aaw-workflow 工作流中执行？
> - 是，回到工作流（推荐）——进度会被跟踪和上报
> - 否，单独执行本 skill——本次执行将不纳入流程跟踪

- 用户选“是” → 加载 `aaw-workflow` skill，按其流程执行（其入口意图判定会引导继续已有工作流或新建），不再单独执行本 skill 正文。
- 用户选“否” → 继续执行本 skill 正文，之后不再提及工作流。

本节最多询问一次，不得重复打扰。"""


def _skill_md(name: str) -> str:
    return (
        (SKILLS / name / "SKILL.md")
        .read_text(encoding="utf-8-sig")
        .replace("\r\n", "\n")
    )


class PreambleTests(unittest.TestCase):
    def test_targets_embed_preamble_verbatim(self) -> None:
        for name in TARGET_SKILLS:
            with self.subTest(skill=name):
                self.assertIn(
                    CANONICAL_PREAMBLE,
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
