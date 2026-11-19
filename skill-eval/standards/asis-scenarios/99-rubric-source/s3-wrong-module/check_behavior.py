#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""S3 · 模块误归属：需求把「持久化」挂在 pkg/session 上。

测试目的
  检验边界判定是否真的来自架构基线，而指标上体现为：
  归属结论是否指向 sessionmanager、锚点是否全部落在 pkg/session、路径真实性、
  以及是否出现「把内存注册表说成持久化」的失真断言。
失败含义
  判低说明模型顺需求措辞认定归属，架构基线的约束力形同虚设。
"""

import json
from pathlib import Path

import common as C

SCENE = json.loads(Path(__file__).with_name("scene.json").read_text(encoding="utf-8"))
SR = SCENE["sr"]
TARGET = "pkg/session/manager.go"
PREFIXES = [TARGET, "pkg/sessionmanager/manager.go"]

path, text, m = C.measure(SR, PREFIXES)
report = C.Report(["required-behavior", "edge-cases"], "" if text else f"未找到 {SR} 的 ASIS 产物")
report.attach(m)
flat = C.flat(text)

if text:
    report.add("required-behavior", "产物存在", 2, True, path.relative_to(C.WORKSPACE).as_posix())
    report.add("required-behavior", "骨架完整率 100%", 2, m.skeleton_rate == 1.0, f"{m.skeleton_rate:.0%}")
    report.add(
        "required-behavior",
        "边界来源 declared",
        2,
        C.boundary_source(text) == "declared",
        f"判定为 {C.boundary_source(text)}",
    )

    report.add(
        "required-behavior",
        "持久化归属判给 sessionmanager",
        4,
        C.any_of(
            flat,
            r"持久化[^。；\n]{0,40}(sessionmanager|已保存会话)",
            r"(sessionmanager|已保存会话)[^。；\n]{0,40}(持久化|落盘|sessions\.json)",
            r"(不属于|不由|不在)[^。；\n]{0,30}pkg/session",
        ),
        "未把持久化归属判给相邻模块",
    )
    report.add(
        "edge-cases",
        "显式质疑需求前提",
        3,
        C.any_of(
            flat,
            r"需前置确认|待确认|决策输入|需求[^。；\n]{0,20}(前提|假设)[^。；\n]{0,20}(不成立|需|待|错误)",
            r"归属[^。；\n]{0,20}(冲突|不一致|需确认|应为)",
            r"不应[^。；\n]{0,20}(在|于)[^。；\n]{0,10}pkg/session[^。；\n]{0,20}(补|新增|加)",
        ),
        "直接接受“只需补恢复入口”",
    )

    # ---- 被分析模块的真实语义
    report.add(
        "required-behavior",
        "识别内存注册表语义",
        3,
        C.any_of(flat, r"map\[string\]\*Session|内存(中|里|态)|进程内|不落盘|无持久化"),
        "未指出注册表只在内存",
    )
    report.add(
        "required-behavior",
        "识别运行时句柄",
        2,
        C.any_of(flat, r"Client|Stdin|SSHSession|句柄|指针"),
        "未记录持有的运行时对象",
    )
    report.add(
        "required-behavior",
        "指出可复用重连钩子",
        2,
        C.any_of(flat, r"AddWithID|指定 ?ID|复用 ?ID|重连"),
        "未指出 AddWithID 支持指定 ID",
    )

    # ---- 反直觉边界
    report.add(
        "edge-cases",
        "识别 Resize 静默忽略",
        2,
        C.any_of(
            flat,
            r"Resize[^。；\n]{0,60}(不存在|未找到|找不到|未知)[^。；\n]{0,30}(nil|静默|不报错|忽略)",
            # 「对未知会话与 nil PTY 两种情况都静默 return nil」是同一事实的完整表述。
            r"Resize[^。；\n]{0,60}静默[^。；\n]{0,20}(return\s*nil|返回 ?nil|不报错|忽略)",
            r"(不存在|未知)[^。；\n]{0,20}ID[^。；\n]{0,30}(静默|返回 ?nil|忽略)",
            r"未知会话[^。；\n]{0,30}(静默|返回 ?nil|不返回错误)",
        ),
        "未识别 Resize 对未知 ID 不报错",
    )
    report.add(
        "edge-cases",
        "识别 List 浅拷贝语义",
        2,
        C.any_of(
            flat,
            r"List[^。；\n]{0,80}(新 ?(切片|slice)|复制[^。；\n]{0,8}切片|构造[^。；\n]{0,8}切片)[^。；\n]{0,50}(指针|元素|Session|共享|无拷贝)",
            r"List[^。；\n]{0,60}(返回|每次返回)[^。；\n]{0,10}新[^。；\n]{0,8}(切片|slice)",
            r"List[^。；\n]{0,80}元素[^。；\n]{0,12}(仍是|仍为|指向)[^。；\n]{0,10}(内部|底层)[^。；\n]{0,8}指针",
            # 「Get/List 直接返回内部 *Session 指针」也是同一事实的合法表述：
            # 集合容器是否新建切片并非重点，调用方可改内部对象才是。
            r"(Get|List)`?[^。；\n]{0,20}(直接)?返回[^。；\n]{0,12}内部[^。；\n]{0,12}(指针|切片)",
            r"(Get|List)[^。；\n]{0,30}内部[^。；\n]{0,6}(指针|切片)[^。；\n]{0,30}(锁外|共享|可变|数据竞争)",
            r"(切片|slice)[^。；\n]{0,20}(拷贝|复制)[^。；\n]{0,20}(指针|元素)[^。；\n]{0,10}(相同|共享)",
        ),
        "未区分切片拷贝与指针共享",
    )

    # ---- 指标
    report.add(
        "required-behavior",
        f"{TARGET} 锚点 ≥3",
        2,
        m.anchors_valid >= 3,
        f"{m.anchors_valid} 个",
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
        "C7 锚点密度 ≥60%",
        2,
        m.c7_density >= 0.6,
        f"{m.c7_density:.0%}",
    )
    report.add(
        "required-behavior",
        "C8 覆盖状态 ≥70%",
        2,
        m.c8_coverage >= 0.7,
        f"{m.c8_coverage:.0%}",
    )

    # ---- 失败模式
    bad_persist = C.wrong_claim(
        text,
        r"pkg/session(?!/manager\.go)[^。；\n]{0,40}|终端会话注册表[^。；\n]{0,30}",
        r"(持久化|落盘)[^。；\n]{0,16}sessions\.json|负责[^。；\n]{0,12}持久化",
        r"不|无|未|没有|非|仅|只|归|由 ?sessionmanager",
    )
    report.add("edge-cases", "不臆造 pkg/session 持久化", 3, bad_persist is None, f"说反：{bad_persist}")
    report.add(
        "edge-cases",
        "路径真实性 100%",
        2,
        m.paths_total > 0 and m.paths_real == m.paths_total,
        f"真实 {m.paths_real}/{m.paths_total}",
    )
    report.add(
        "edge-cases",
        "不虚构 pkg/session 新文件",
        2,
        not [t for t in C.phantom_paths(text) if t.startswith("pkg/session/")],
        f"虚构 {[t for t in C.phantom_paths(text) if t.startswith('pkg/session/')][:4]}",
    )
    report.add("edge-cases", "正式说明书越界 0", 2, m.formal_docs == 0, f"{m.formal_docs} 份")
    report.add(
        "edge-cases",
        "代码区未改动",
        2,
        C.file_unchanged(TARGET) is not False,
        f"{TARGET} 被修改",
    )

report.emit({"scene": SCENE["id"]})
