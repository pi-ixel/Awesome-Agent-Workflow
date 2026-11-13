#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""B 套（边界项）：不得把现状说反，且必须识别真实反直觉行为。

checkpoint: edge-cases
只读 workspace 与产物文件。

判定原则：只看明确断言，不看否定表达。
「Save 非原子」「没有临时文件+rename」都是正确表述，不算违规；
「Save 用临时文件+rename 保证原子」才算说反。
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


def sentences(text: str) -> list[str]:
    return [part.strip() for part in re.split(r"[。；\n]+", text) if part.strip()]


# 描述「可选方案 / 决策点 / 待确认」的句子不是现状断言，不能据以判「说反」。
# 表格里的决策项行常以编号开头（A31 / OQ8），也一并跳过。
NOT_A_CLAIM = (
    r"决策输入|决策点|TOBE|可选|待确认|需前置确认|方案选择|候选方案|等价方案|"
    r"是否|需要.{0,4}吗|待定|OQ\d|D\d+\s*\|"
)


def wrong_claim(text: str, subject: str, claim: str, negations: str) -> str | None:
    """Return the first line that asserts `claim` about `subject` without negation.

    以「行」为单位：表格一行就是一条完整陈述，行内出现决策/待确认标记时整行跳过，
    避免把「A31 落盘原子性…。 | 决策输入 |」这类决策行误判为现状断言。
    """
    for line in text.splitlines():
        if not line.strip():
            continue
        if not re.search(subject, line):
            continue
        if not re.search(claim, line):
            continue
        if re.search(negations, line):
            continue
        if re.search(NOT_A_CLAIM, line):
            continue
        return line.strip()[:140]
    return None


candidates = sorted(WORKSPACE.glob(f".sdd/{SR}/*/*/.context/详细设计上下文.md"))
text = read(candidates[0]) if candidates else ""

if not text:
    for label, weight in (
        ("产物存在", 3),
        ("写入非原子", 2),
        ("删除缺失 ID", 2),
        ("GetSessions 未拷贝", 2),
        ("重命名不同步 Host", 2),
        ("CreateFolder 根级判重", 2),
        ("嵌套归组被压平", 2),
    ):
        check(label, weight, False, "未找到 ASIS 产物")
else:
    check("产物存在", 3, True, candidates[0].relative_to(WORKSPACE).as_posix())

    # 1. Save 是直接覆盖，不得说成原子写。
    bad = wrong_claim(
        text,
        r"Save|保存|落盘|持久化",
        r"原子写|临时文件.{0,8}rename|rename.{0,8}替换",
        r"没有|不含|未使用|不是|并非|无(临时|原子)|直接覆盖|非原子|未复用|没有采用",
    )
    check("写入非原子", 2, bad is None, f"把 Save 说成原子写：{bad}")

    # 2. DeleteSession 对不存在的 ID 不报错。
    deleted_ok = any(
        re.search(r"DeleteSession|删除", sentence)
        and re.search(r"不存在|未命中|无命中|缺失|找不到", sentence)
        and re.search(r"静默|不报错|仍(返回|Save|落盘)|照样|返回成功|无错误", sentence)
        for sentence in sentences(text)
    )
    # 「三种语义并存」这类归纳也接受。
    deleted_ok = deleted_ok or any(
        re.search(r"DeleteSession", sentence) and re.search(r"静默", sentence)
        for sentence in sentences(text)
    )
    check("删除缺失 ID", 2, deleted_ok, "未识别 DeleteSession 删除不存在的 ID 时静默成功")

    # 3. GetSessions 暴露内部切片；不得声称返回副本。
    bad = wrong_claim(
        text,
        r"GetSessions|Sessions",
        r"返回.{0,8}(副本|拷贝|快照)|深拷贝|浅拷贝",
        r"未|没有|不|无|非",
    )
    check("GetSessions 未拷贝", 2, bad is None, f"声称返回副本：{bad}")
    leak = any(
        re.search(r"GetSessions|Sessions", sentence)
        and re.search(r"内部|底层|原始|导出", sentence)
        and re.search(r"切片|slice|指针|未拷贝|未复制", sentence)
        for sentence in sentences(text)
    )
    check("切片外泄已识别", 2, leak, "未识别 GetSessions 直接暴露内部切片/指针")

    # 4. RenameSession 只改 Name，不同步 Host。
    bad = wrong_claim(
        text,
        r"RenameSession|重命名",
        r"同步.{0,8}(Host|连接目标|config)|一并(修改|更新).{0,8}Host",
        r"不|未|没有|仅|只",
    )
    check("重命名不同步 Host", 2, bad is None, f"声称重命名会同步 Host：{bad}")
    rename_ok = any(
        re.search(r"RenameSession|重命名", sentence)
        and re.search(r"只(改|写|修改)[^。；\n]{0,12}Name|仅(改|写|修改)[^。；\n]{0,12}Name|不(改|触碰|同步)[^。；\n]{0,16}(Host|Config)", sentence)
        for sentence in sentences(text)
    )
    check("重命名语义已识别", 2, rename_ok, "未写明 RenameSession 只改 Name、不同步 Host")

    # 5. CreateFolder 只在根级判重，不得声称递归校验。
    bad = wrong_claim(
        text,
        r"CreateFolder|创建(根级)?文件夹",
        r"(递归|任意层级|嵌套)[^。；\n]{0,10}(判重|校验|检查|比较)|全树[^。；\n]{0,8}(判重|校验)",
        r"不|未|没有|仅|只",
    )
    check("CreateFolder 根级判重", 2, bad is None, f"声称 CreateFolder 递归判重：{bad}")
    folder_ok = any(
        re.search(r"CreateFolder|创建(根级)?文件夹", sentence)
        and re.search(r"根(层|级)|无父节点|没有父节点|不递归", sentence)
        for sentence in sentences(text)
    )
    check("CreateFolder 范围已识别", 2, folder_ok, "未写明 CreateFolder 只在根级创建/判重")

    # 6. 嵌套归组会被压平（groupName 只在根级匹配）。
    flatten_ok = any(
        re.search(r"groupName|归组|分组|group", sentence)
        and re.search(r"根(层|级)|压平|扁平|非递归|不递归", sentence)
        for sentence in sentences(text)
    )
    check("嵌套归组被压平", 2, flatten_ok, "未识别把会话放入嵌套文件夹会被压平到根级")

weight_total = sum(weight for _, weight, _, _ in items)
weight_passed = sum(weight for _, weight, ok, _ in items if ok)
score = round(100.0 * weight_passed / weight_total, 1) if weight_total else 0.0
failed = [f"{label}（{detail}）" for label, _, ok, detail in items if not ok]
evidence = f"边界与反直觉行为子项 {weight_passed}/{weight_total} 权重通过。"
if failed:
    evidence += "未通过：" + "；".join(failed[:6])
print(
    json.dumps(
        {"checks": [{"id": "edge-cases", "score": score, "weight": 1, "evidence": evidence[:2000]}]},
        ensure_ascii=False,
    )
)
print("NOTES: " + json.dumps({"failed": [i[0] for i in items if not i[2]]}, ensure_ascii=False), file=sys.stderr)
