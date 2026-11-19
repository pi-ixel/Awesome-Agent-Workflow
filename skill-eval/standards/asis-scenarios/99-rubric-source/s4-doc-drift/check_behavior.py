#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""S4 · 文档漂移：设计说明与实现相反。

测试目的
  文档在写入原子性、文件夹判重范围、GetSessions 返回值三处与代码相反。
  指标上要求：C6 漂移项数 ≥3、三处漂移逐项命中、锚定文档与代码双方、
  且三处都不得被抄成现状。
失败含义
  判低说明「规格漂移」是走过场笔记，模型实际把现成文档当事实来源。
"""

import json
from pathlib import Path

import common as C

SCENE = json.loads(Path(__file__).with_name("scene.json").read_text(encoding="utf-8"))
SR = SCENE["sr"]
PREFIXES = ["pkg/sessionmanager/manager.go", "docs/session-storage.md"]
DOC = "docs/session-storage.md"

path, text, m = C.measure(SR, PREFIXES)
report = C.Report(["required-behavior", "edge-cases"], "" if text else f"未找到 {SR} 的 ASIS 产物")
report.attach(m)
flat = C.flat(text)

if text:
    report.add("required-behavior", "产物存在", 2, True, path.relative_to(C.WORKSPACE).as_posix())

    report.add(
        "required-behavior",
        "写入原子性漂移",
        4,
        C.any_of(
            flat,
            r"(临时文件|rename)[^。；\n]{0,30}(不存在|没有|未实现|并未|实为|实际)",
            r"不写[^。；\n]{0,6}(临时文件|tmp)[^。；\n]{0,20}(rename|原子)",
            r"不(做|使用|采用)?[^。；\n]{0,4}rename[^。；\n]{0,20}(替换|原子|覆盖)?",
            r"无[^。；\n]{0,8}(临时文件|tmp|写前备份)",
            r"文档[^。；\n]{0,30}原子[^。；\n]{0,40}(代码|实际)[^。；\n]{0,30}(直接覆盖|非原子|未实现|不成立)",
            r"(文档|说明)[^。；\n]{0,40}承诺[^。；\n]{0,20}(不成立|未实现|与实现不符|相反)",
            r"Save[^。；\n]{0,20}(直接覆盖|非原子)[^。；\n]{0,30}文档",
            # 「实现直接截断重写 / 原地重写」「包内无临时文件、os.Rename、fsync」都成立。
            r"(直接|原地)[^。；\n]{0,6}(截断|重写|覆盖)",
            r"(不存在|没有|无)[^。；\n]{0,10}(临时文件|Rename|os\.Rename|fsync)",
        ),
        "未指出原子写承诺未实现",
    )
    report.add(
        "required-behavior",
        "文件夹判重漂移",
        4,
        C.any_of(
            flat,
            # 「根层」「顶层」「最外层」都是同一范围的合法写法。
            r"(根(层|级)|顶层|最外层|非递归|不递归)[^。；\n]{0,40}(任意层级|递归|全树)",
            r"任意层级[^。；\n]{0,40}(根(层|级)|顶层|最外层|只查根|非递归|不递归)",
            r"CreateFolder[^。；\n]{0,40}(根(层|级)|顶层|最外层|不递归)",
        ),
        "未指出嵌套同名文件夹不会被拒",
    )
    report.add(
        "required-behavior",
        "读取语义漂移",
        4,
        C.any_of(
            flat,
            r"(深拷贝|副本|独立副本)[^。；\n]{0,40}(内部切片|未拷贝|同一底层|直接返回)",
            r"GetSessions[^。；\n]{0,40}(内部切片|未拷贝|共享底层|直接返回)",
        ),
        "未指出 GetSessions 未做拷贝",
    )
    # 需求只要求「写明以哪一方为准及判断依据」，不规定必须选代码还是文档：
    # 选文档（实现偏离）与选代码（文档过时）都是合法裁决，只要有依据。
    report.add(
        "required-behavior",
        "声明冲突裁决依据",
        3,
        C.any_of(
            flat,
            r"以\s*\*{0,2}\s*(代码|实现|源码|文档|设计说明)\s*\*{0,2}\s*为准",
            r"(代码|实现|源码)\s*\*{0,2}\s*(是|为)\s*\*{0,2}\s*(事实来源|唯一依据|行为事实)",
            r"实现未落地文档要求|文档要求未落地|代码与文档不符",
            r"权威归属|裁决|以.{0,14}为(基准|依据)",
        ),
        "未说明冲突时以哪一方为准",
    )
    report.add(
        "required-behavior",
        "C6 漂移项 ≥3",
        2,
        m.drift_items >= 3,
        f"C6 漂移项 {m.drift_items}",
    )
    report.add(
        "required-behavior",
        "锚定文档与代码双方",
        2,
        DOC in flat
        and C.any_of(
            flat,
            r"#Save|#CreateFolder|#GetSessions",
            r"`Save`|`CreateFolder`|`GetSessions`|Save\s*\(|CreateFolder\s*\(|GetSessions\s*\(",
        ),
        "未同时给文档位置与代码符号",
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

    # ---- 失败模式：把文档承诺抄成现状
    report.add(
        "edge-cases",
        "不把原子写当现状",
        4,
        C.wrong_claim(
            text,
            r"Save|保存|落盘",
            r"原子写|临时文件[^。；\n]{0,10}rename",
            r"文档|说明|原设计|未|没有|不|非|实为|实际|但",
        )
        is None,
        "抄成现状",
    )
    report.add(
        "edge-cases",
        "不把深拷贝当现状",
        3,
        C.wrong_claim(
            text,
            r"GetSessions|Sessions",
            r"返回[^。；\n]{0,10}(深拷贝|副本|独立副本)",
            r"文档|说明|未|没有|不|非|实为|实际|但|仅|只",
        )
        is None,
        "抄成现状",
    )
    report.add(
        "edge-cases",
        "不把任意层级判重当现状",
        3,
        C.wrong_claim(
            text,
            r"CreateFolder|文件夹",
            r"(任意层级|递归)[^。；\n]{0,10}(唯一|判重|校验)",
            r"文档|说明|未|没有|不|非|实为|实际|但|仅|只",
        )
        is None,
        "抄成现状",
    )
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
    report.add(
        "edge-cases",
        "未改写设计文档",
        2,
        C.file_unchanged(DOC) is not False,
        "设计文档被改写",
    )

report.emit({"scene": SCENE["id"]})
