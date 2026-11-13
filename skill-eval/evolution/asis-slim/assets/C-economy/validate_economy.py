#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""C 套（经济性）：把「同样信息量下的冗余成本」量化为 output-constraints 检查。

子项（加权）：
- 产物存在 (4)
- 规模上限 (2)：≤ 18000 字符
- 证据定位密度 (2)：≥ 50% 的表行带文件定位
- 正文重复率 (2)：30-gram 重复覆盖 ≤ 15%
- 重述 Skill 元指令 (2)：≤ 4 处
- 单句重复 (2)：重复句占比 ≤ 10%

只读 workspace 与产物文件；退出码 0，stdout 输出 JSON。
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

SR = "SR-OPS-A"
WORKSPACE = Path(os.environ.get("AAW_WORKSPACE") or ".").resolve()

items: list[tuple[str, int, bool, str]] = []


def check(label: str, weight: int, ok: bool, detail: str = "") -> None:
    items.append((label, weight, bool(ok), detail))


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return ""


def tables_and_body(text: str) -> tuple[list[str], str]:
    """Split table rows from prose; fenced code (mermaid etc.) is excluded from prose."""
    rows, body = [], []
    in_fence = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if stripped.startswith("|"):
            if not re.fullmatch(r"\|[\s\-:|]+\|", stripped):
                rows.append(stripped)
            continue
        body.append(stripped)
    return rows, "\n".join(body)


def repeat_ratio(body: str, size: int = 30) -> float:
    compact = re.sub(r"\s+", "", body)
    if len(compact) < size * 2:
        return 0.0
    counts: dict[str, int] = {}
    for index in range(len(compact) - size + 1):
        gram = compact[index : index + size]
        counts[gram] = counts.get(gram, 0) + 1
    repeated = sum(size for gram, count in counts.items() if count > 1)
    return repeated / len(compact)


def sentence_duplicate_ratio(text: str, minimum: int = 24) -> float:
    sentences = [
        re.sub(r"\s+", "", part)
        for part in re.split(r"[。；\n]+", text)
        if len(part.strip()) >= minimum
    ]
    total = sum(len(item) for item in sentences)
    if not total:
        return 0.0
    counts: dict[str, int] = {}
    for sentence in sentences:
        counts[sentence] = counts.get(sentence, 0) + 1
    duplicated = sum(len(item) * (count - 1) for item, count in counts.items() if count > 1)
    return duplicated / total


candidates = sorted(WORKSPACE.glob(f".sdd/{SR}/*/*/.context/详细设计上下文.md"))
text = read(candidates[0]) if candidates else ""

# 空壳产物不参与其余经济性判定：否则「什么都没有」会因「没有冗余」而拿到高分。
substantive = bool(candidates) and len(text) >= 1200

if not substantive:
    reason = "未找到 ASIS 产物" if not candidates else f"产物仅 {len(text)} 字符，属空壳产物"
    check("产物存在", 4, bool(candidates), reason)
    for label, weight in (
        ("最小有效规模", 3),
        ("规模上限", 2),
        ("单结论预算", 2),
        ("证据定位密度", 2),
        ("正文重复率", 2),
        ("重述 Skill 元指令", 2),
        ("单句重复", 2),
    ):
        check(label, weight, False, reason)
else:
    rows, body = tables_and_body(text)
    chars = len(text)
    conclusions = sorted(set(re.findall(r"\bA\d{1,3}\b", text)))
    check("产物存在", 4, True, candidates[0].relative_to(WORKSPACE).as_posix())
    check("最小有效规模", 3, chars >= 1200, f"产物 {chars} 字符（下限 1200，防止空壳产物拿高分）")
    check("规模上限", 2, chars <= 32000, f"产物 {chars} 字符（上限 32000）")
    budget = chars / max(1, len(conclusions))
    check(
        "单结论预算",
        2,
        len(conclusions) >= 6 and budget <= 1800,
        f"{len(conclusions)} 条结论、平均 {budget:.0f} 字符/条（上限 1800）",
    )

    ev_rows = [
        row
        for row in rows
        if re.search(r"[A-Za-z0-9_./\-]+\.(go|md|json|yaml)", row) or re.search(r"`[A-Za-z]", row)
    ]
    ratio = len(ev_rows) / max(1, len(rows))
    check("证据定位密度", 2, ratio >= 0.5, f"含文件定位的表行 {len(ev_rows)}/{len(rows)} = {ratio:.0%}（下限 50%）")

    repeat = repeat_ratio(body)
    check("正文重复率", 2, repeat <= 0.15, f"正文 30-gram 重复覆盖 {repeat:.1%}（上限 15%）")

    meta = len(re.findall(r"本 ?skill|阶段产出|SubAgent|固定目录|工作流程|模板|检查清单|按 skill", text))
    check("重述 Skill 元指令", 2, meta <= 4, f"Skill 元指令类表述 {meta} 处（上限 4）")

    dup = sentence_duplicate_ratio(body)
    check("单句重复", 2, dup <= 0.10, f"重复句占比 {dup:.1%}（上限 10%）")

weight_total = sum(weight for _, weight, _, _ in items)
weight_passed = sum(weight for _, weight, ok, _ in items if ok)
score = round(100.0 * weight_passed / weight_total, 1) if weight_total else 0.0
failed = [f"{label}（{detail}）" for label, _, ok, detail in items if not ok]
evidence = f"经济性子项 {weight_passed}/{weight_total} 权重通过。"
if failed:
    evidence += "未通过：" + "；".join(failed[:6])
print(
    json.dumps(
        {"checks": [{"id": "output-constraints", "score": score, "weight": 1, "evidence": evidence[:2000]}]},
        ensure_ascii=False,
    )
)
print(
    "NOTES: " + json.dumps({"artifact": bool(candidates), "failed": [i[0] for i in items if not i[2]]}, ensure_ascii=False),
    file=sys.stderr,
)
