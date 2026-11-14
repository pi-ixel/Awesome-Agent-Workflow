#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""B 套（事实项）：ASIS 产出的核心现状结论是否与代码一致。

checkpoint: required-behavior
只读 workspace 与产物文件，不 import 被测评 skill 的任何代码。

判据按「结论语义」而非特定措辞匹配：同一事实的多种表述都接受，
但把行为说反、或只给文件名不给符号/行号锚点的，判为未达标。
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

SR = "SR-OPS-A"
WORKSPACE = Path(os.environ.get("AAW_WORKSPACE") or ".").resolve()
TARGET_REL = "pkg/sessionmanager/manager.go"

items: list[tuple[str, bool, str]] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    items.append((label, bool(ok), detail))


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return ""


def flat(text: str) -> str:
    return re.sub(r"[ \t]+", " ", text)


def any_of(text: str, *patterns: str) -> bool:
    return any(re.search(pattern, text) for pattern in patterns)


candidates = sorted(WORKSPACE.glob(f".sdd/{SR}/*/*/.context/详细设计上下文.md"))
raw = read(candidates[0]) if candidates else ""
text = flat(raw)

if not text:
    labels = [
        "产物存在",
        "F1 持久化载体",
        "F2 写入方式",
        "F3 缺失文件处理",
        "F4 去重键与身份复用",
        "F5 UpdateSession 顺序",
        "F6 重命名语义",
        "F7 GetSessions 返回",
        "F8 CreateFolder 范围",
        "F9 嵌套查找归属",
        "F10 测试现状",
        "证据锚点",
    ]
    for name in labels:
        check(name, False, "未找到 ASIS 产物")
else:
    check("产物存在", True, candidates[0].relative_to(WORKSPACE).as_posix())

    check(
        "F1 持久化载体",
        any_of(text, r"sessions\.json") and any_of(text, r"filePath|NewManagerWithPath|NewManager"),
        "需说明默认文件 sessions.json 与路径注入点",
    )
    check(
        "F2 写入方式",
        any_of(text, r"os\.WriteFile|WriteFile") and any_of(text, r"0644|权限"),
        "需写明 Save 使用 os.WriteFile 且权限 0644",
    )
    check(
        "F3 缺失文件处理",
        any_of(text, r"os\.IsNotExist|IsNotExist|文件不存在|缺文件")
        and any_of(text, r"空(文件|树|列表|切片|会话树)|置空|建空"),
        "需写明文件不存在时置空并落盘（或建空文件）",
    )
    check(
        "F4 去重键与身份复用",
        any_of(text, r"Config\.Host|config\.Host|按 Host|以 Host|Host 作为|targetName")
        and any_of(text, r"复用.{0,10}ID|沿用.{0,10}ID|保留.{0,10}ID|removedID")
        and any_of(text, r"递归|任意层级|全树|整棵树"),
        "需写明按 Host 去重、递归查找并复用原 ID",
    )
    check(
        "F5 UpdateSession 顺序",
        any_of(text, r"先(按 ID)?[^。；\n]{0,8}(移除|删除|摘除)")
        and any_of(text, r"重复|duplicate|already exists|同 Host"),
        "需写明先按 ID 摘除再做重复 Host 校验",
    )
    check(
        "F6 重命名语义",
        any_of(text, r"RenameSession|重命名")
        and any_of(
            text,
            r"只(改|写|修改)[^。；\n]{0,12}Name",
            r"仅(改|写|修改)[^。；\n]{0,12}Name",
            r"不(改|触碰|修改|同步)[^。；\n]{0,16}(Host|Config)",
            r"Host[^。；\n]{0,6}(不变|不受影响)",
        ),
        "需写明重命名只改节点 Name，不改 Host/Config",
    )
    check(
        "F7 GetSessions 返回",
        any_of(text, r"GetSessions|Sessions 字段")
        and any_of(
            text,
            r"返回[^。；\n]{0,20}(内部|底层|原始)?(切片|slice)",
            r"未(做)?(拷贝|复制)",
            r"共享底层",
            r"导出字段",
        ),
        "需写明 GetSessions 直接暴露内部切片（未拷贝）",
    )
    check(
        "F8 CreateFolder 范围",
        any_of(text, r"CreateFolder|创建(根级)?文件夹")
        and any_of(
            text,
            r"(仅|只)[^。；\n]{0,8}根(层|级)",
            r"无父节点|没有父节点|无 parent",
            r"不递归[^。；\n]{0,6}(创建|检查)",
        ),
        "需写明 CreateFolder 只在根级创建并只在根级判重",
    )
    check(
        "F9 嵌套查找归属",
        any_of(text, r"findSessionConfig") or any_of(text, r"递归[^。；\n]{0,12}查找"),
        "需指出递归定位不在本模块，或指出现有递归查找入口",
    )
    check(
        "F10 测试现状",
        any_of(text, r"manager_test\.go") and any_of(text, r"PASS|通过|6 个|六个|用例"),
        "需记录现有测试文件与执行结论",
    )

    # 证据锚点：必须给到行号或符号，且能在真实文件里定位。
    target = WORKSPACE / TARGET_REL
    body = read(target)
    total_lines = len(body.splitlines())
    valid, invalid = [], []
    for raw_token in re.findall(
        r"pkg/sessionmanager/manager\.go(?::\d+(?:-\d+)?|#[A-Za-z][A-Za-z0-9_]*)", text
    ):
        token = raw_token.strip("`")
        if "#" in token:
            symbol = token.split("#", 1)[1]
            if symbol in body:
                valid.append(token)
            else:
                invalid.append(token)
            continue
        span = token.split(":", 1)[1]
        first, _, last = span.partition("-")
        numbers = [int(first)] + ([int(last)] if last else [])
        if all(1 <= number <= total_lines for number in numbers):
            valid.append(token)
        else:
            invalid.append(token)
    check(
        "证据锚点",
        len(valid) >= 5 and not invalid,
        f"可定位锚点 {len(valid)} 个（要求 ≥5）；无效 {invalid[:4]}",
    )

passed = sum(1 for _, ok, _ in items if ok)
score = round(100.0 * passed / len(items), 1)
failed = [f"{name}（{detail}）" for name, ok, detail in items if not ok]
evidence = f"现状事实子项 {passed}/{len(items)} 通过。"
if failed:
    evidence += "未通过：" + "；".join(failed[:6])
print(
    json.dumps(
        {"checks": [{"id": "required-behavior", "score": score, "weight": 1, "evidence": evidence[:2000]}]},
        ensure_ascii=False,
    )
)
print(
    "NOTES: " + json.dumps({"artifact": bool(text), "items": [i[0] for i in items if not i[1]]}, ensure_ascii=False),
    file=sys.stderr,
)
