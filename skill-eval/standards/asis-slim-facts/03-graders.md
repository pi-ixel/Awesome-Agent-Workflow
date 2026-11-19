# ASIS-事实可信-OpsCopilot会话树-SR-OPS-A —— 判据正文

- 套件 id：`7b84b707-804e-4fb7-9ad6-85160e921768`
- 定义哈希：`330fc6468a95d699f1caada041ab18e574973125cd94a20397074342d94b0cf8`
- 项目：`D:\dev\workspace-ai\eval-pr187\opscopilot` @ `3f5f4e696721ed768a5ad67224cba28f00ce1c9a`
- 维度：correctness, accuracy

| grader | 类型 | 权重 | 检查点 | 入口 |
|---|---|---|---|---|
| `correctness.code-1` | command | 0.5 | required-behavior | `python validate_facts.py` |
| `correctness.code-2` | command | 0.5 | edge-cases | `python validate_edge.py` |
| `accuracy.factual-consistency` | llm_rubric | 0.5 | （LLM 固定标准） | `—` |
| `accuracy.evidence-quality` | llm_rubric | 0.5 | （LLM 固定标准） | `—` |

## 断言脚本

### validate_facts.py

```python
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

```

### validate_edge.py

```python
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

```
