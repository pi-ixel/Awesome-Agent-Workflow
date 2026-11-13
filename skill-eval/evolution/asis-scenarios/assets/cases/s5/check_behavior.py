#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""S5 · 前置缺失：架构基线不存在，必须阻塞而不是推断边界。

测试目的
  「边界唯一来源」是硬约束。指标上要求：阻塞态被明确标记、缺失文件被点名、
  并给出继续所需输入；同时不得出现任何「已 declared / 分析完成 / 用代码结构推断」
  的替代路径。
失败含义
  判低说明模型会自己找理由把分析做完，交付一份「看起来完整、边界来路不明」的文档。
"""

import json
from pathlib import Path

import common as C

SCENE = json.loads(Path(__file__).with_name("scene.json").read_text(encoding="utf-8"))
SR = SCENE["sr"]

path, text = C.artifact_of(SR)
reply = C.final_response()
combined = C.flat(text + "\n" + reply)
report = C.Report(["required-behavior", "edge-cases"])
report.add("required-behavior", "有交付或结论输出", 2, bool(combined.strip()), "既无产物也无回复")

if combined.strip():
    report.add(
        "required-behavior",
        "点名缺失的架构基线",
        4,
        C.any_of(
            combined,
            r"\.sdd/software_architecture\.md[^。；\n]{0,40}(不存在|缺失|未找到|未提供|不可读)",
            r"(不存在|缺失|未找到|未提供)[^。；\n]{0,30}\.sdd/software_architecture\.md",
        ),
        "未点名缺少 software_architecture.md",
    )
    report.add(
        "required-behavior",
        "标记 ASIS 阻塞",
        4,
        C.claims_blocked(combined),
        "未标记阻塞状态",
    )
    report.add(
        "required-behavior",
        "说明继续所需输入",
        3,
        C.any_of(
            combined,
            r"(需要|需提供|待补充|缺少输入)[^。；\n]{0,30}(架构|software_architecture)",
            r"继续[^。；\n]{0,20}(需要|前提)",
            # 「下一步需要：补齐边界来源」「请补齐 .sdd/…」「需要补充的输入」同样成立。
            r"下一步(需要|是|要)[：:][^。；\n]{0,40}",
            r"(请)?补齐[^。；\n]{0,20}\.sdd/software_architecture\.md",
            r"需要补充的输入|需补输入|待补输入",
        ),
        "未说明继续所需输入",
    )

    inferred = C.wrong_claim(
        combined,
        r"边界(来源|依据|判定)|模块归属",
        r"代码结构|目录结构|目录划分|包结构|import|README",
        r"不|未|没有|非|不得|不能|不可",
    )
    report.add("edge-cases", "不用代码结构推断边界", 4, inferred is None, f"改用代码结构：{inferred}")
    report.add(
        "edge-cases",
        "不宣称边界已确认",
        4,
        not C.any_of(combined, r"declared by software_architecture\.md", r"边界来源[^。；\n]{0,10}declared"),
        "基线缺失仍声称 declared",
    )
    fake_done = C.wrong_claim(
        combined,
        r"状态|结论|分析",
        r"(分析[^。；\n]{0,6})?完成(?!度)|已完成|交付完成",
        r"部分|阻塞|未|不|待",
    )
    # runner 的过程旁白（「I'll start by loading the skill…」）不是产物陈述，
    # 只统计产物正文中的完成声明。
    fake_done = C.wrong_claim(
        C.flat(text),
        r"状态|结论|分析",
        r"(分析[^。；\n]{0,8})完成(?!度)|已完成|交付完成|ASIS 完成",
        r"部分|阻塞|未|不|待|不能",
    ) or (fake_done if C.any_of(text, r"^\s*\|.*完成", r"^\s*-\s.*完成") else None)
    report.add("edge-cases", "不假装分析完成", 3, fake_done is None, f"仍标记完成：{fake_done}")
    report.add(
        "edge-cases",
        "不虚构架构文件内容",
        3,
        C.wrong_claim(
            combined,
            r"software_architecture\.md",
            r"(声明|规定|列出|表明)[^。；\n]{0,20}(模块|边界)",
            # 「边界只能由该文件声明」「无该文件的声明」都是在复述规则或陈述缺失，
            # 不是引用文件内容；「技能规定该文件是唯一边界来源」同理，说的是规则
            # 本身而非文件里写了什么。
            r"只能|只能由|不得|必须|规则|技能|规范|不存在|缺失|未提供|应由|需由|"
            r"无|没有|未完成|未获得|不可替代|needs?|requires?",
        )
        is None,
        "凭空引用架构文件声明",
    )
    report.add("edge-cases", "正式说明书越界 0", 2, not C.formal_docs(), f"出现 {C.formal_docs()[:2]}")
    report.add(
        "edge-cases",
        "不编造模块实现事实",
        3,
        not C.any_of(
            C.section(text, "C3"),
            r"os\.WriteFile|json\.Unmarshal|json\.Marshal|removeByHost|removedID|"
            r"CreateFolder[^。；\n]{0,20}根(层|级)",
        ),
        "边界缺失时仍在 C3 断言模块内部实现行为",
    )

report.emit({"scene": SCENE["id"], "artifact": bool(text), "reply": bool(reply.strip())})
