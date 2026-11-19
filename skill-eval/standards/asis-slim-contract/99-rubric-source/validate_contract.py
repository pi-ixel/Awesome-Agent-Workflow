#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""A 套：ASIS 产物契约基线（output-constraints 代码检查）。

只读 workspace 与产物文件，不 import 被测评 skill 的任何代码。
协议：退出码 0，stdout 输出 {"checks": [{"id":"output-constraints", ...}]}。

判据出处（SKILL.md）：
- 阶段 1：加载 asis-output-template.md，创建 C1–C8 全骨架并保留标题
- 阶段 5/6：稳定结论编号 A\\d 与证据编号 E\\d
- 模块边界规则：边界来源必须标记 declared / blocked，且只能来自 software_architecture.md
- 职责边界：ASIS 不得创建正式说明书，不得把实现方案写成结论
- 质量标准：重要结论有证据；不适用的章节保留标题并写明原因
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

SR = "SR-OPS-A"
WORKSPACE = Path(os.environ.get("AAW_WORKSPACE") or ".").resolve()
ARTIFACT_GLOB = f".sdd/{SR}/*/*/.context/详细设计上下文.md"

items: list[tuple[str, int, bool, str]] = []


def check(label: str, weight: int, ok: bool, detail: str = "") -> None:
    items.append((label, weight, bool(ok), detail))


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return ""


def normalize(path: str) -> str:
    value = path.strip().strip("`").replace("\\", "/")
    while value.startswith("./"):
        value = value[2:]
    return value.rstrip(".,;:，。；：）)")


def index_files(root: Path) -> set[str]:
    found: set[str] = set()
    for base, dirs, names in os.walk(root):
        dirs[:] = [d for d in dirs if d not in {".git", "node_modules", "build", "vendor"}]
        for name in names:
            found.add((Path(base) / name).relative_to(root).as_posix())
        relative = Path(base).relative_to(root).as_posix()
        if relative != ".":
            found.add(relative + "/")
    return found


candidates = sorted(WORKSPACE.glob(ARTIFACT_GLOB))
text = read(candidates[0]) if candidates else ""
files = index_files(WORKSPACE)

check("产物存在", 4, bool(candidates), f"{ARTIFACT_GLOB} 命中 {len(candidates)} 个")
if candidates:
    check("唯一产物", 1, len(candidates) == 1, f"存在 {len(candidates)} 份 ASIS 上下文")

# ---------------------------------------------------------------- 固定骨架
sections = [
    ("C1", "ASIS 状态"),
    ("C2", "模块边界"),
    ("C3", "关键 ASIS 事实"),
    ("C4", "调用链"),
    ("C5", "配置、数据、测试"),
    ("C6", "规格漂移"),
    ("C7", "证据索引"),
    ("C8", "追溯矩阵"),
]
missing = [f"{tag}.{kw}" for tag, kw in sections if not (tag in text and kw in text)]
check("C1–C8 骨架", 3, bool(text) and not missing, f"缺失：{missing}")

# ---------------------------------------------------------------- 边界来源
c2 = re.search(r"##\s*C2[^\n]*\n(.*?)(?=\n##\s*C3|\Z)", text, re.S)
c2_body = c2.group(1) if c2 else ""
declared = "declared" in c2_body.lower() and "software_architecture.md" in c2_body
check("边界来源标记", 2, declared, "C2 未同时出现 declared 与 software_architecture.md")

# ---------------------------------------------------------------- 编号体系
conclusions = sorted(set(re.findall(r"\bA\d{1,3}\b", text)))
evidences = sorted(set(re.findall(r"\bE\d{1,3}\b", text)))
check("结论编号", 2, len(conclusions) >= 6, f"A 编号 {len(conclusions)} 个（要求 ≥6）")
check("证据编号", 2, len(evidences) >= 5, f"E 编号 {len(evidences)} 个（要求 ≥5）")

counts = {cid: len(re.findall(rf"\b{cid}\b", text)) for cid in conclusions}
traceable = [cid for cid, n in counts.items() if n >= 2]
ratio = len(traceable) / len(conclusions) if conclusions else 0.0
check("结论可追溯", 2, ratio >= 0.8, f"正文与映射双次出现的结论占比 {ratio:.0%}（要求 ≥80%）")

# ---------------------------------------------------------------- 代码路径真实性
# 两类合法提及不算虚构：
#   1. 明确标注「已不存在 / 已删除」的陈旧引用（这是有价值的发现）；
#   2. 明确标注「临时副本 / 探针 / 新建」的自建验证文件（未落工作区）。
STALE_MARK = re.compile(r"不存在|已删除|已移除|缺失|no longer|stale|过时")
TEMP_MARK = re.compile(r"临时|副本|探针|probe|新建|自建|未改动|未落盘|工作区外")
tokens: dict[str, bool] = {}
for line in text.splitlines():
    if STALE_MARK.search(line):
        continue
    exempt = bool(TEMP_MARK.search(line))
    for raw in re.findall(r"[A-Za-z0-9_./\-]*pkg/[A-Za-z0-9_./\-]+", line):
        token = normalize(raw)
        if not (token.endswith((".go", ".md", ".json", ".yaml", ".yml")) or token.endswith("/")):
            continue
        tokens[token] = tokens.get(token, False) or exempt
phantom = sorted(
    token
    for token, exempt in tokens.items()
    if not exempt and token not in files and (token.rstrip("/") + "/") not in files
)
real = sorted(token for token in tokens if token not in phantom)
check("引用真实代码路径", 3, len(real) >= 2, f"真实存在的代码路径 {len(real)} 条（要求 ≥2）")
check("无虚构路径", 3, bool(tokens) and not phantom, f"虚构路径：{phantom[:6]}")

# ---------------------------------------------------------------- 不越界
formal = sorted(p.as_posix() for p in WORKSPACE.glob(".sdd/**/模块详细设计说明书.md"))
check("不创建正式说明书", 3, bool(text) and not formal, f"创建了正式说明书：{formal[:3]}")

c3 = re.search(r"##\s*C3[^\n]*\n(.*?)(?=\n##\s*C4|\Z)", text, re.S)
c3_body = c3.group(1) if c3 else ""
banned = [p for p in ("建议采用", "建议新增", "应新增", "可以复用", "推荐使用", "优先采用") if p in c3_body]
check("现状与方案分离", 2, bool(text) and not banned, f"C3 出现 TOBE 拍板表述：{banned}")
check("标注决策输入", 1, "决策输入" in text or "TOBE 决策" in text, "全文缺少「决策输入 / TOBE 决策」标记")

# ---------------------------------------------------------------- 有架构文档不得阻塞
# 「无 ASIS 阻塞项」「未触发阻塞条件」是对状态的正确描述，不算自相矛盾的阻塞声明。
header = text[:1500]
blocking_lines = [
    line
    for line in header.splitlines()
    if re.search(r"\bblocked\b|ASIS 阻塞|状态[：:]\s*阻塞", line, re.I)
    and not re.search(r"无|未|不是|没有|不适用|非", line)
]
check("有架构不得阻塞", 1, bool(text) and not blocking_lines, f"架构文档已就位却声明阻塞：{blocking_lines[:2]}")

weight_total = sum(weight for _, weight, _, _ in items)
weight_passed = sum(weight for _, weight, ok, _ in items if ok)
score = round(100.0 * weight_passed / weight_total, 1) if weight_total else 0.0
failed = [f"{label}（{detail}）" for label, _, ok, detail in items if not ok]
evidence = f"契约子项 {weight_passed}/{weight_total} 权重通过，得分 {score}。"
if failed:
    evidence += "未通过：" + "；".join(failed[:6])
print(
    json.dumps(
        {"checks": [{"id": "output-constraints", "score": score, "weight": 1, "evidence": evidence[:2000]}]},
        ensure_ascii=False,
    )
)
print(
    "NOTES: "
    + json.dumps(
        {
            "artifact": bool(candidates),
            "failed": [i[0] for i in items if not i[2]],
            "conclusions": conclusions[:14],
            "evidences": len(evidences),
            "cited": real[:8],
        },
        ensure_ascii=False,
    ),
    file=sys.stderr,
)
