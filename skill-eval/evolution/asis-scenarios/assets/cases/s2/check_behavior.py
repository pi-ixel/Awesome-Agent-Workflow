#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""S2 · 纯新增：导入/导出当前不存在。

测试目的
  检验「纯新增」分支的能力，而不仅是措辞：必须（a）用检索证据证明对象不存在，
  （b）把现有落盘/序列化/去重约束作为可复用输入记录下来，（c）不因“没找到”
  就阻塞或编造入口。
失败含义
  判低说明 skill 只能做既有行为分析，遇到空对象就退化成猜。
"""

import json
from pathlib import Path

import common as C

SCENE = json.loads(Path(__file__).with_name("scene.json").read_text(encoding="utf-8"))
SR = SCENE["sr"]
PREFIXES = ["pkg/sessionmanager/manager.go", "pkg/sessionmanager/manager_test.go"]

path, text, m = C.measure(SR, PREFIXES)
report = C.Report(["required-behavior", "edge-cases"], "" if text else f"未找到 {SR} 的 ASIS 产物")
report.attach(m)
flat = C.flat(text)

if text:
    report.add("required-behavior", "产物存在", 2, True, path.relative_to(C.WORKSPACE).as_posix())

    # ---- 存在性判定必须有证据
    report.add(
        "required-behavior",
        "覆盖导入/导出诉求",
        2,
        C.any_of(flat, r"导入|导出|import|export"),
        "未涉及导入/导出",
    )
    report.add(
        "required-behavior",
        "判定新增对象不存在",
        3,
        C.any_of(
            flat,
            r"(导入|导出|import|export)[^。；\n]{0,40}(不存在|未实现|尚未|没有|缺失|未提供)",
            r"(不存在|未实现|尚未|缺失)[^。；\n]{0,30}(导入|导出)",
            r"新增对象[^。；\n]{0,20}不存在",
        ),
        "未给出“当前不存在”的现状结论",
    )
    report.add(
        "required-behavior",
        "附检索证据",
        3,
        C.any_of(
            flat,
            r"rg\s+-|grep\s+-|git grep|检索词|搜索词|检索范围|已检索",
            r"\b0\s*(处|条|个)?\s*命中|未命中|无命中|no matches|not found",
        ),
        "只给结论未给检索范围",
    )

    # ---- 可复用约束（纯新增场景的核心产出）
    report.add(
        "required-behavior",
        "可复用落盘机制",
        2,
        C.any_of(flat, r"os\.WriteFile|json\.Marshal(Indent)?|sessions\.json|Save\("),
        "未记录可复用落盘机制",
    )
    report.add(
        "required-behavior",
        "可复用去重规则",
        2,
        C.any_of(flat, r"按 ?Host|Config\.Host|同 ?Host|主机去重"),
        "未指出按 Host 去重约束",
    )
    report.add(
        "required-behavior",
        "可复用身份复用逻辑",
        2,
        C.any_of(
            flat,
            r"复用[^。；\n]{0,10}ID|removedID|沿用[^。；\n]{0,8}ID|保留[^。；\n]{0,8}ID",
            # 也可写成「被删节点的 ID 会复用到新节点」：ID 在前、复用在后。
            r"ID[^。；\n]{0,14}(复用|沿用|保留|不变)",
            r"身份[^。；\n]{0,10}(稳定|不变|复用)",
        ),
        "未指出 ID 复用现状",
    )

    # ---- 指标：结构不塌、锚点可查、路径真实
    report.add("required-behavior", "骨架完整率 100%", 2, m.skeleton_rate == 1.0, f"{m.skeleton_rate:.0%}")
    report.add(
        "required-behavior",
        "锚点有效率 100% 且 ≥2",
        2,
        m.anchors_valid >= 2 and m.anchor_rate == 1.0,
        f"{m.anchors_valid}/{m.anchors_total}",
    )
    report.add(
        "required-behavior",
        "编号体系成立",
        2,
        m.conclusions >= 4 and m.evidences >= 4 and m.mapping_rate >= 0.6,
        f"A={m.conclusions} E={m.evidences} 配对={m.mapping_rate:.0%}",
    )

    # ---- 失败模式
    # 「未找到」本身不构成阻塞理由。产物可以因需求口径缺口写 `部分完成` 并列出
    # 阻塞项——那是需求侧待确认，属合法降级；这里只禁止把「能力不存在」当阻塞原因。
    report.add(
        "edge-cases",
        "不以“对象不存在”为由阻塞",
        3,
        not C.blocked_on_missing(text, r"导入|导出|import|export|目标对象|该能力|所需能力"),
        "把“对象不存在”当作 ASIS 阻塞理由",
    )
    fake = [
        token
        for token in C.phantom_paths(text)
        if C.any_of(token, r"import|export|transfer|backup|restore")
    ]
    report.add("edge-cases", "不虚构新增入口文件", 3, not fake, f"虚构 {fake[:4]}")
    report.add("edge-cases", "路径真实性 100%", 2, m.paths_total > 0 and m.paths_real == m.paths_total,
               f"真实 {m.paths_real}/{m.paths_total}")
    banned = [
        w
        for w in ("建议新增", "建议采用", "应新增", "推荐使用", "优先采用", "建议实现")
        if w in C.section(text, "C3")
    ]
    report.add("edge-cases", "C3 不夹带实现方案", 3, not banned, f"出现 {banned}")
    report.add(
        "edge-cases",
        "实现选择归入决策输入",
        2,
        C.any_of(text, r"决策输入|TOBE ?决策|待确认"),
        "缺少决策输入/待确认标记",
    )
    report.add("edge-cases", "正式说明书越界 0", 2, m.formal_docs == 0, f"{m.formal_docs} 份")
    report.add(
        "edge-cases",
        "代码区未改动",
        2,
        C.file_unchanged("pkg/sessionmanager/manager.go") is not False,
        "manager.go 被修改",
    )

report.emit({"scene": SCENE["id"]})
