#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""S1 · 基线正例：输入齐备、无陷阱时的常规 ASIS 交付。

测试目的
  交付出厂检验。这一套的指标全部是「产物自身的可测量属性」：
  骨架完整率、章节实质率、结论/证据编号数与配对率、锚点可定位率、
  代码路径真实性、表格密度、正式说明书越界数。
失败含义
  连基线都掉分，说明后面五套的分数没有解释力——先修基本面。
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

    # ---- 结构完整性
    report.add("required-behavior", "骨架完整率 100%", 2, m.skeleton_rate == 1.0, f"{m.skeleton_rate:.0%}")
    report.add(
        "required-behavior", "章节实质率 ≥85%", 2, m.substantive_rate >= 0.85, f"{m.substantive_rate:.0%}"
    )

    # ---- 现状事实（代码可核对）
    report.add(
        "required-behavior",
        "持久化载体与路径注入",
        2,
        C.any_of(flat, r"sessions\.json") and C.any_of(flat, r"filePath|NewManagerWithPath|NewManager"),
        "未写默认 sessions.json 与路径注入点",
    )
    report.add(
        "required-behavior",
        "写入方式与权限位",
        2,
        C.any_of(flat, r"os\.WriteFile|WriteFile") and C.any_of(flat, r"0644|0640|权限"),
        "未写 os.WriteFile 与权限",
    )
    report.add(
        "required-behavior",
        "缺失文件初始化",
        2,
        C.any_of(flat, r"os\.IsNotExist|IsNotExist|文件不存在|文件缺失|缺失时|不存在时")
        and C.any_of(flat, r"空(切片|列表|会话树|文件)|置空|建空|自建空|空数组|`\[\]`"),
        "未写 Load 缺失分支",
    )
    report.add(
        "required-behavior",
        "按 Host 去重且复用 ID",
        3,
        C.any_of(flat, r"Config\.Host|config\.Host|按 ?Host|以 ?Host")
        and C.any_of(flat, r"复用[^。；\n]{0,8}ID|沿用[^。；\n]{0,8}ID|保留[^。；\n]{0,8}ID|removedID"),
        "未同时写去重键与身份复用",
    )
    report.add(
        "required-behavior",
        "UpdateSession 先摘除后校验",
        2,
        C.any_of(
            flat,
            r"先[^。；\n]{0,12}(移除|删除|摘除)",
            # 也常写成「按 ID 摘除 → 判空 → 查重」或「摘除并写回 → 查重」。
            r"(摘除|移除|删除)[^。；\n]{0,40}(查重|重复|already exists|同 ?Host)",
            r"(查重|重复校验|同 ?Host)[^。；\n]{0,30}(之前|已|先)[^。；\n]{0,10}(摘除|移除|删除)",
        )
        and C.any_of(flat, r"重复|duplicate|already exists|同 ?Host"),
        "未写先摘除再校验",
    )
    report.add(
        "required-behavior",
        "重命名只改显示名",
        3,
        C.any_of(flat, r"RenameSession|重命名")
        and C.any_of(
            flat,
            r"仅(改|写|修改|更新)[^。；\n]{0,10}(Name|名称|显示名)",
            r"只(改|写|修改|更新)[^。；\n]{0,12}(Name|名称|显示名)",
            r"不(改|触动|同步|修改)[^。；\n]{0,16}(Host|Config|config\.)",
            r"(Host|config\.Name|目标)[^。；\n]{0,10}(不变|未变|不受影响)",
        ),
        "未写 RenameSession 不改 Host",
    )
    report.add(
        "required-behavior",
        "测试现状",
        2,
        C.any_of(flat, r"manager_test\.go") and C.any_of(flat, r"PASS|通过|6 ?个|六个|用例"),
        "未记录现有测试",
    )

    # ---- 编号体系与配对
    report.add("required-behavior", "结论编号 ≥6", 2, m.conclusions >= 6, f"{m.conclusions} 个")
    report.add("required-behavior", "证据编号 ≥5", 2, m.evidences >= 5, f"{m.evidences} 个")
    report.add(
        "required-behavior", "结论两次以上出现 ≥80%", 2, m.traceable_rate >= 0.8, f"{m.traceable_rate:.0%}"
    )
    report.add(
        "required-behavior", "结论-证据同行配对 ≥70%", 2, m.mapping_rate >= 0.7, f"{m.mapping_rate:.0%}"
    )

    # ---- 锚点可定位率
    report.add("required-behavior", "可定位锚点 ≥5", 3, m.anchors_valid >= 5, f"{m.anchors_valid} 个")
    report.add(
        "required-behavior",
        "锚点有效率 100%",
        2,
        m.anchors_total > 0 and m.anchor_rate == 1.0,
        f"{m.anchors_valid}/{m.anchors_total}",
    )
    report.add(
        "required-behavior", "C7 锚点密度 ≥60%", 2, m.c7_density >= 0.6, f"{m.c7_density:.0%}"
    )
    report.add(
        "required-behavior", "C8 覆盖状态 ≥70%", 2, m.c8_coverage >= 0.7, f"{m.c8_coverage:.0%}"
    )

    # ---- 失败模式
    report.add(
        "edge-cases",
        "路径真实性 100%",
        3,
        m.paths_total >= 2 and m.paths_real == m.paths_total,
        f"真实 {m.paths_real}/{m.paths_total}（虚构 {C.phantom_paths(text)[:4]}）",
    )
    bad_save = C.wrong_claim(
        text, r"Save|保存|落盘", r"原子写|临时文件[^。；\n]{0,8}rename", r"没有|未|不是|无|非"
    )
    report.add("edge-cases", "冻结「Save 非原子」", 2, bad_save is None, f"说反：{bad_save}")
    bad_copy = C.wrong_claim(
        text, r"GetSessions|Sessions", r"返回[^。；\n]{0,8}(副本|拷贝|深拷贝)", r"未|没有|不|无|非"
    )
    report.add("edge-cases", "冻结「GetSessions 不拷贝」", 2, bad_copy is None, f"说反：{bad_copy}")

    report.add("edge-cases", "正式说明书越界 0", 3, m.formal_docs == 0, f"{m.formal_docs} 份")
    report.add("edge-cases", "产物目录无多余文件", 2, m.extra_files == 0, f"{m.extra_files} 个")

    banned = [w for w in ("建议采用", "建议新增", "应新增", "推荐使用") if w in C.section(text, "C3")]
    report.add("edge-cases", "C3 不夹带实现方案", 2, not banned, f"出现 {banned}")

    report.add("edge-cases", "未误报阻塞", 2, not C.claims_blocked(C.section(text, "C2")), "C2 声明阻塞")
    report.add(
        "edge-cases",
        "代码区未改动",
        2,
        C.file_unchanged("pkg/sessionmanager/manager.go") is not False,
        "manager.go 被修改",
    )

report.emit({"scene": SCENE["id"]})
