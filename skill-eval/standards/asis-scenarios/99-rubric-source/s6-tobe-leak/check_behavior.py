#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""S6 · 目标状态污染：需求把「重命名同步 Host」当要达成的目标。

测试目的
  现状是「重命名只改 Name」，需求要求「显示名与连接目标一致」。
  指标上要求：现状结论正确、差距被识别、目标状态归入决策输入、
  并指出 Host 是 CLI 定位键（这是改造的真实连带影响）。
失败含义
  判低说明模型被需求措辞带跑，把「应该怎样」写成「现在怎样」。
"""

import json
from pathlib import Path

import common as C

SCENE = json.loads(Path(__file__).with_name("scene.json").read_text(encoding="utf-8"))
SR = SCENE["sr"]
PREFIXES = ["pkg/sessionmanager/manager.go", "pkg/core/ops/exec.go"]

path, text, m = C.measure(SR, PREFIXES)
report = C.Report(["required-behavior", "edge-cases"], "" if text else f"未找到 {SR} 的 ASIS 产物")
report.attach(m)
flat = C.flat(text)

if text:
    report.add("required-behavior", "产物存在", 2, True, path.relative_to(C.WORKSPACE).as_posix())

    report.add(
        "required-behavior",
        "现状：重命名只改显示名",
        4,
        C.any_of(
            flat,
            r"RenameSession[^。；\n]{0,60}(只|仅)[^。；\n]{0,10}(改|写|修改|更新)[^。；\n]{0,10}(Name|名称|显示名)",
            r"(只|仅)[^。；\n]{0,10}(改|写|修改)[^。；\n]{0,10}(Name|显示名)[^。；\n]{0,40}(不|未)[^。；\n]{0,16}(Host|Config|连接目标)",
            r"(不|未)[^。；\n]{0,14}(同步|修改|更新)[^。；\n]{0,10}(Host|连接目标)",
        ),
        "未写明现状只改 Name",
    )
    report.add(
        "required-behavior",
        "识别需求与现状差距",
        3,
        C.any_of(
            flat,
            r"(需求|期望|目标)[^。；\n]{0,40}(现状|当前|实现)[^。；\n]{0,20}(不一致|不符|冲突|差距|背离)",
            r"(现状|当前)[^。；\n]{0,30}(不满足|未满足|无法满足)[^。；\n]{0,20}需求",
            # 「需求要求的行为当前不存在」「目标能力尚未实现」也是差距陈述。
            r"(需求|期望|目标)[^。；\n]{0,60}(不存在|未实现|未提供|缺少|缺失|尚未)",
            r"差距|gap|差异",
            # 「既有行为需改造」= 现状达不到需求；排除「无需改造」。
            r"(?<![无不未])(既有|现有|当前|现状)[^。；\n]{0,24}(需|待)[^。；\n]{0,6}(改造|调整|修改)",
        ),
        "未说清需求目标与现状差异",
    )
    report.add(
        "required-behavior",
        "目标状态记为决策输入",
        3,
        C.any_of(flat, r"决策输入|TOBE ?决策|待确认|需前置确认"),
        "未把目标状态归入决策输入",
    )
    report.add(
        "required-behavior",
        "指出 Host 是定位键",
        3,
        C.any_of(
            flat,
            r"findSessionConfig|CLI[^。；\n]{0,30}(按|以)[^。；\n]{0,10}(Host|IP)[^。；\n]{0,10}(定位|查找)",
            r"Host[^。；\n]{0,20}(唯一键|主键|定位键|1:1)",
        ),
        "未指出 Host 是 CLI 定位依据",
    )
    report.add(
        "required-behavior",
        "关联去重约束",
        2,
        C.any_of(flat, r"重复[^。；\n]{0,20}(Host|节点)|去重|same host|同 ?Host"),
        "未把改动与去重规则关联",
    )
    report.add(
        "required-behavior",
        "锚点有效率 100%",
        2,
        m.anchors_total > 0 and m.anchor_rate == 1.0,
        f"{m.anchors_valid}/{m.anchors_total}",
    )
    report.add(
        "required-behavior",
        "结论-证据配对 ≥60%",
        2,
        m.mapping_rate >= 0.6,
        f"{m.mapping_rate:.0%}",
    )

    wrong = C.wrong_claim(
        text,
        r"RenameSession|重命名",
        r"(会|将|同时|一并)[^。；\n]{0,12}(同步|修改|更新)[^。；\n]{0,10}(Host|连接目标)",
        r"不|未|没有|需|应|待|目标|决策|现状是",
    )
    report.add("edge-cases", "不把目标状态写成现状", 4, wrong is None, f"现状写反：{wrong}")
    banned = [
        w
        for w in ("建议采用", "建议新增", "应新增", "推荐使用", "优先采用", "应当把", "需改为")
        if w in C.section(text, "C3")
    ]
    report.add("edge-cases", "C3 不夹带实现方案", 3, not banned, f"出现 {banned}")
    report.add(
        "edge-cases",
        "路径真实性 100%",
        2,
        m.paths_total > 0 and m.paths_real == m.paths_total,
        f"真实 {m.paths_real}/{m.paths_total}",
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
