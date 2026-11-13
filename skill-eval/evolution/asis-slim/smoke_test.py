#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""在合成工作区上跑三套断言，验证「合格产物得分高、冗余/失真产物得分低」。

用法：python smoke_test.py <opscopilot 仓库路径>
只读仓库、只写临时目录，不修改任何仓库内容。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

HERE = Path(__file__).resolve().parent
ASSETS = HERE / "assets"
REPO = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path()

KEEP = [
    "pkg/sessionmanager/manager.go",
    "pkg/sessionmanager/manager_test.go",
    "pkg/session/manager.go",
    "pkg/sshclient/client.go",
    "go.mod",
]

GOOD = """# 详细设计上下文（ASIS）

## C1. ASIS 状态与阅读说明

| 项目 | 内容 |
|---|---|
| 本次需求/AR | SR-OPS-A / AR-1，已保存会话树持久化与定位 |
| 变更类型 | 既有行为改造（只读分析，不改代码） |
| 目标模块 | 已保存会话管理 `pkg/sessionmanager/manager.go` |
| 模块边界来源 | `.sdd/software_architecture.md`，类型 declared |
| 分析范围 | 持久化、按主机去重与更新、递归查找、名称语义 |
| ASIS 状态 | 完成 |
| 分析置信度 | 高（结论均有代码位置） |

## C2. 模块边界确认

边界来源：declared by software_architecture.md。`pkg/sessionmanager/manager.go` 属于「已保存会话管理」模块；
相邻的 `pkg/session/manager.go`（活跃终端会话注册表）不属于本模块，仅在对照语义时引用。

## C3. 关键 ASIS 事实

| 编号 | 结论 | 类型 | 证据 |
|---|---|---|---|
| A1 | 会话树以 JSON 数组持久化到默认文件 `sessions.json`，路径由 `NewManagerWithPath` 注入。 | 事实 | E1 |
| A2 | `Save` 使用 `os.WriteFile` 直接覆盖写入，权限 0644，没有临时文件与 rename。 | 事实 | E2 |
| A3 | `Load` 遇到文件不存在（`os.IsNotExist`）时把会话树初始化为空切片并立即落盘。 | 事实 | E3 |
| A4 | `Upsert` 以 `config.Host` 作为身份键，全树递归移除同 Host 节点并沿用原 ID。 | 事实 | E4 |
| A5 | `UpdateSession` 先按 ID 移除节点，再做重复 Host 校验，最后重新插入。 | 事实 | E5 |
| A6 | `RenameSession` 只改节点 `Name`，不同步 `config.Host`，连接目标保持不变。 | 事实 | E6 |
| A7 | `GetSessions` 直接返回内部切片，调用方可修改底层数组。 | 事实 | E7 |
| A8 | `CreateFolder` 的同名校验只在根层进行，嵌套文件夹同名不会被拒；`Upsert`/`UpdateSession` 的 `groupName` 也只在根级匹配，放入嵌套文件夹会被压平为根级同名文件夹。 | 事实 | E8 |
| A9 | 删除不存在的 ID 时 `DeleteSession` 不报错，仍返回成功并覆盖落盘。 | 事实 | E9 |
| A10 | 会话树查找只能靠遍历，没有索引；模块暴露的具体查找 API 只有 Upsert/UpdateSession/DeleteSession/RenameSession。 | 事实 | E10 |

## C4. 调用链与数据流

`Upsert` → 递归 `removeByHost` → 构造节点 → `Save`（`os.WriteFile`）。删除、重命名、建文件夹走同一条落盘路径。
单一函数内完成，无跨模块调用。

## C5. 配置、数据、测试与依赖现状

| 项目 | 现状 | 证据 |
|---|---|---|
| 数据文件 | `sessions.json`，节点字段 `id/name/type/children/config` | E1 |
| 依赖 | 仅 `pkg/sshclient`（`ConnectConfig`）与 `github.com/google/uuid` | E10 |
| 测试 | `pkg/sessionmanager/manager_test.go` 覆盖增改删、重命名、持久化、递归删除，现有 6 个用例全部通过 | E11 |

## C6. 规格漂移、待确认与阻塞

无阻塞。`GetSessions` 的返回值语义、以及是否需要按 Host 建立索引，属于 TOBE 决策输入，ASIS 不预设方案。

## C7. 证据索引

| 编号 | 位置 | 说明 |
|---|---|---|
| E1 | `pkg/sessionmanager/manager.go#NewManagerWithPath` | 默认文件与字段注入 |
| E2 | `pkg/sessionmanager/manager.go#Save` | `os.WriteFile`，0644 |
| E3 | `pkg/sessionmanager/manager.go#Load` | `os.IsNotExist` 分支 |
| E4 | `pkg/sessionmanager/manager.go#Upsert` | Host 去重与 ID 复用 |
| E5 | `pkg/sessionmanager/manager.go#UpdateSession` | 先移除后校验 |
| E6 | `pkg/sessionmanager/manager.go#RenameSession` | 只改 Name |
| E7 | `pkg/sessionmanager/manager.go#GetSessions` | 返回内部切片 |
| E8 | `pkg/sessionmanager/manager.go#CreateFolder` | 根层同名校验 |
| E9 | `pkg/sessionmanager/manager.go#DeleteSession` | 无命中检查 |
| E10 | `pkg/sessionmanager/manager.go#Manager` | 结构体与依赖 |
| E11 | `pkg/sessionmanager/manager_test.go` | 现有测试覆盖 |

## C8. 需求/AR 追溯矩阵

| 需求项 | ASIS 结论 | 证据 | 覆盖状态 |
|---|---|---|---|
| 持久化与顺序保持 | A1、A2 | E1、E2 | 已覆盖 |
| 同主机不得重复、身份稳定 | A4、A5 | E4、E5 | 已覆盖 |
| 重命名语义明确 | A6 | E6 | 已覆盖 |
| 落盘失败可见 | A2、A3 | E2、E3 | 部分覆盖（无错误包装策略） |
| 嵌套查找 | A8、A9、A10 | E8、E9、E10 | 已覆盖 |
"""

BAD = """# 详细设计上下文

## 思考过程

我首先阅读了本 skill 的说明，按照阶段流水线执行。本 skill 要求先建立探索任务清单，
再分派 SubAgent 查证。由于环境限制，我改为自己查证。阶段产出必须写入详细设计上下文，
固定目录必须保留，模板中的 C1–C8 标题不得删除。本 skill 的工作流程强调边查边写。

## C1

会话管理模块是系统的核心模块之一，负责管理所有的会话数据，承担着非常重要的职责。
会话管理模块是系统的核心模块之一，负责管理所有的会话数据，承担着非常重要的职责。
在实际工程中，良好的会话管理可以显著提升系统的可维护性和可扩展性。

## C2

边界来源为代码结构推断，主要看目录划分。

## C3

| 编号 | 结论 |
|---|---|
| A1 | 会话数据保存在 sessions.json 中，使用了原子写保证安全。 |
| A2 | GetSessions 返回的是副本，调用方无法修改内部状态。 |
| A3 | RenameSession 会同步修改 Host，保证显示名与连接目标一致。 |
| A4 | CreateFolder 会递归检查所有层级的同名文件夹。 |
| A5 | 删除不存在的 ID 会返回明确的错误。 |
| A6 | 建议采用索引结构优化查找性能。 |

## C4

待补充。

## C5

待补充。

## C6

待补充。

## C7

| 编号 | 位置 |
|---|---|
| E1 | pkg/sessionmanager/manager.go |
| E2 | pkg/sessionmanager/nonexistent.go |

## C8

待补充。

## 质量自检

本 skill 要求的检查清单已全部完成，阶段产出齐全，固定目录保留，SubAgent 使用情况已说明，
工作流程符合要求，模板要求已满足，检查清单逐条核对完毕。
"""


def build_workspace(root: Path, artifact: str) -> Path:
    if not REPO.is_dir():
        raise SystemExit("用法：python smoke_test.py <opscopilot 仓库路径>")
    for relative in KEEP:
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO / relative, target)
    arch = root / ".sdd" / "software_architecture.md"
    arch.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ASSETS / "A-contract" / "software_architecture.md", arch)
    out = root / ".sdd" / "SR-OPS-A" / "AR-1" / "pkg-sessionmanager" / ".context"
    out.mkdir(parents=True, exist_ok=True)
    (out / "详细设计上下文.md").write_text(artifact, encoding="utf-8")
    return root


def run(script: Path, root: Path) -> dict:
    env = {**os.environ, "AAW_WORKSPACE": str(root), "PYTHONIOENCODING": "utf-8"}
    result = subprocess.run(
        [sys.executable, str(script)],
        cwd=str(script.parent),
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=300,
    )
    if result.returncode != 0:
        return {"error": result.returncode, "stdout": result.stdout[-1500:], "stderr": result.stderr[-1500:]}
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    return {item["id"]: item["score"] for item in payload["checks"]}


def main() -> int:
    cases = {
        "A-contract": ASSETS / "A-contract" / "validate_contract.py",
        "B-truth": ASSETS / "B-truth" / "validate_facts.py",
        "B-truth-edge": ASSETS / "B-truth" / "validate_edge.py",
        "C-economy": ASSETS / "C-economy" / "validate_economy.py",
    }
    counters: dict[str, list[float]] = {name: [] for name in cases}
    with tempfile.TemporaryDirectory() as temp:
        base = Path(temp)
        for label, artifact in (("good", GOOD), ("bad", BAD), ("empty", "")):
            root = build_workspace(base / label, artifact)
            print(f"== {label}")
            for name, script in cases.items():
                outcome = run(script, root)
                scores = ", ".join(f"{k}={v}" for k, v in outcome.items())
                print(f"   {name:14} {scores}")
                if outcome and "error" not in outcome:
                    counters[name].append(sum(outcome.values()) / len(outcome))
                else:
                    print("      ", outcome)

    print("\n== 均值")
    for name, values in counters.items():
        if values:
            print(f"   {name:14} good={values[0]:.1f} bad={values[1]:.1f} empty={values[2]:.1f}")

    ok = True
    if counters["A-contract"][0] < 90 or counters["A-contract"][1] > 40:
        ok = False
    if counters["B-truth"][0] < 90 or counters["B-truth"][1] > 50:
        ok = False
    if counters["B-truth-edge"][0] < 90 or counters["B-truth-edge"][1] > 50:
        ok = False
    if counters["C-economy"][0] < 90 or counters["C-economy"][1] > 50:
        ok = False
    print("\nSMOKE-" + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
