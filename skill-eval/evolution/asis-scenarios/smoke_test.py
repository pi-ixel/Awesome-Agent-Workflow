#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""场景矩阵断言的本地冒烟：每个场景一对「合格 / 定向失真」产物。

用法：python smoke_test.py <opscopilot 仓库路径>

目的不是证明断言完备，而是证明每个场景的断言真的在测它自己那一类失效模式：
合格产物应当接近满分；只在该场景关键点说反的产物应当明显掉分。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ASSETS = HERE / "assets"
REPO = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path()

KEEP = [
    "pkg/sessionmanager/manager.go",
    "pkg/sessionmanager/manager_test.go",
    "pkg/session/manager.go",
    "pkg/session/manager_test.go",
    "pkg/sshclient/client.go",
    "pkg/core/ops/exec.go",
    "go.mod",
]

ARCH = ASSETS / "scenes" / "_shared" / "software_architecture.md"


def skeleton(sr: str, c2: str, c3: str, c4: str, c5: str, c6: str, c7: str, c8: str) -> str:
    return f"""# 详细设计上下文（ASIS）

## C1. ASIS 状态与阅读说明

| 项目 | 内容 |
|---|---|
| 需求/AR | {sr} / AR-1 |
| 变更类型 | 既有行为改造 |
| 分析范围 | 见需求文件 |
| ASIS 状态 | 完成 |
| 分析置信度 | 高 |

## C2. 模块边界确认

{c2}

## C3. 关键 ASIS 事实

{c3}

## C4. 调用链与数据流

{c4}

## C5. 配置、数据、测试与依赖现状

{c5}

## C6. 规格漂移、待确认与阻塞

{c6}

## C7. 证据索引

{c7}

## C8. 需求/AR 追溯矩阵

{c8}
"""


C2_OK = (
    "边界来源：declared by software_architecture.md。目标模块 `pkg/sessionmanager/` "
    "属于「已保存会话管理」模块；相邻的 `pkg/session/manager.go` 是活跃终端会话注册表，"
    "不属于本模块。"
)

S1_GOOD = skeleton(
    "SR-OPS-A",
    C2_OK,
    """| 编号 | 结论 | 类型 | 证据 |
|---|---|---|---|
| A1 | 会话树以 JSON 数组持久化到默认文件 `sessions.json`，路径由 `NewManagerWithPath` 注入。 | 事实 | E1 |
| A2 | `Save` 使用 `os.WriteFile` 直接覆盖写入，权限 0644，没有临时文件与 rename。 | 事实 | E2 |
| A3 | `Load` 遇到文件不存在（`os.IsNotExist`）时把会话树初始化为空切片并立即落盘。 | 事实 | E3 |
| A4 | `Upsert` 以 `config.Host` 作为身份键，全树递归移除同 Host 节点并沿用原 ID。 | 事实 | E4 |
| A5 | `UpdateSession` 先按 ID 移除节点，再做重复 Host 校验，最后重新插入。 | 事实 | E5 |
| A6 | `RenameSession` 只改节点 `Name`，不同步 `config.Host`，连接目标保持不变。 | 事实 | E6 |
| A7 | `GetSessions` 直接返回内部切片，未做拷贝。 | 事实 | E7 |""",
    "`Upsert` → 递归 `removeByHost` → 构造节点 → `Save`。删除、重命名、建文件夹走同一条落盘路径。",
    """| 项目 | 现状 | 证据 |
|---|---|---|
| 数据文件 | `sessions.json` | E1 |
| 依赖 | `pkg/sshclient` 的 `ConnectConfig` 与 uuid | E8 |
| 测试 | `pkg/sessionmanager/manager_test.go` 现有 6 个用例全部通过 | E9 |""",
    "无阻塞。是否需要按 Host 建索引属于 TOBE 决策输入。",
    """| 编号 | 位置 | 说明 |
|---|---|---|
| E1 | `pkg/sessionmanager/manager.go#NewManagerWithPath` | 路径注入 |
| E2 | `pkg/sessionmanager/manager.go#Save` | os.WriteFile 0644 |
| E3 | `pkg/sessionmanager/manager.go#Load` | IsNotExist 分支 |
| E4 | `pkg/sessionmanager/manager.go#Upsert` | Host 去重与 ID 复用 |
| E5 | `pkg/sessionmanager/manager.go#UpdateSession` | 先移除后校验 |
| E6 | `pkg/sessionmanager/manager.go#RenameSession` | 只改 Name |
| E7 | `pkg/sessionmanager/manager.go#GetSessions` | 返回内部切片 |
| E8 | `pkg/sessionmanager/manager.go#Manager` | 结构体与依赖 |
| E9 | `pkg/sessionmanager/manager_test.go` | 现有测试 |""",
    """| 需求项 | 结论 | 证据 | 覆盖状态 |
|---|---|---|---|
| 持久化 | A1、A2 | E1、E2 | 已覆盖 |
| 按主机去重 | A4、A5 | E4、E5 | 已覆盖 |
| 重命名语义 | A6 | E6 | 已覆盖 |
| 递归查找 | A7 | E7 | 部分覆盖 |""",
)

S1_BAD = skeleton(
    "SR-OPS-A",
    "边界来源：按代码目录结构推断，`pkg/sessionmanager` 显然是会话模块。",
    """| 编号 | 结论 | 类型 | 证据 |
|---|---|---|---|
| A1 | 会话数据保存在 `sessions.json`，`Save` 使用临时文件 + rename 保证原子写。 | 事实 | E1 |
| A2 | `GetSessions` 返回深拷贝副本，调用方无法修改内部状态。 | 事实 | E2 |
| A3 | `RenameSession` 会同步修改 Host，保证显示名与连接目标一致。 | 事实 | E3 |
| A4 | 建议采用索引结构优化查找性能。 | 事实 | E4 |
| A5 | 会话树持久化在 `pkg/sessionmanager/nonexistent.go`。 | 事实 | E5 |
| A6 | `Upsert` 使用命名匹配去重。 | 事实 | E6 |""",
    "待补充。",
    "| 项目 | 现状 |\n|---|---|\n| 测试 | 未确认 |",
    "无阻塞。",
    """| 编号 | 位置 | 说明 |
|---|---|---|
| E1 | `pkg/sessionmanager/manager.go` | 保存 |
| E2 | `pkg/sessionmanager/manager.go` | 读取 |
| E3 | `pkg/sessionmanager/manager.go` | 重命名 |
| E4 | `pkg/sessionmanager/manager.go` | 索引 |
| E5 | `pkg/sessionmanager/nonexistent.go` | 虚构文件 |
| E6 | `pkg/sessionmanager/manager.go` | 去重 |""",
    "| 需求项 | 结论 | 证据 | 覆盖状态 |\n|---|---|---|---|\n| 持久化 | A1 | E1 | 已覆盖 |",
)

S2_GOOD = skeleton(
    "SR-OPS-B",
    C2_OK,
    """| 编号 | 结论 | 类型 | 证据 |
|---|---|---|---|
| A1 | 导入/导出能力当前不存在：`rg -n "ImportSessions|ExportSessions" pkg/` 命中 0 处。 | 事实 | E1 |
| A2 | 现有落盘入口只有 `Save`，使用 `os.WriteFile` 直接覆盖 `sessions.json`，可复用为导出后的写回路径。 | 事实 | E2 |
| A3 | 会话树序列化为 JSON 数组，节点字段 `id/name/type/children/config`，可作为导出格式的既有形状。 | 事实 | E3 |
| A4 | 导入必须对齐现有按 `config.Host` 去重规则，否则会产生重复节点。 | 事实 | E4 |
| A5 | `Upsert` 全树递归查找同 Host 并复用原 ID，是导入合并可复用的约束。 | 事实 | E5 |
| A6 | 导入失败时的错误传播现状：`Save` 返回 error，调用方在 `app.go` 转成字符串。 | 事实 | E6 |""",
    "导入需要遍历目标树；导出走 `GetSessions` + JSON 序列化。",
    """| 项目 | 现状 | 证据 |
|---|---|---|
| 序列化 | `json.MarshalIndent` | E3 |
| 去重 | 按 Host | E4 |
| 测试 | `manager_test.go` 6 个用例通过 | E7 |""",
    "无阻塞。导入/导出的接口形态、文件格式与合并策略均为 TOBE 决策输入，ASIS 不预设方案。",
    """| 编号 | 位置 | 说明 |
|---|---|---|
| E1 | `pkg/sessionmanager/manager.go#Manager` | 无导入导出方法 |
| E2 | `pkg/sessionmanager/manager.go#Save` | os.WriteFile |
| E3 | `pkg/sessionmanager/manager.go#Session` | 节点字段 |
| E4 | `pkg/sessionmanager/manager.go#Upsert` | 按 Host 去重 |
| E5 | `pkg/sessionmanager/manager.go#UpdateSession` | ID 复用 |
| E6 | `pkg/sessionmanager/manager.go#DeleteSession` | 错误传播 |
| E7 | `pkg/sessionmanager/manager_test.go` | 现有测试 |""",
    """| 需求项 | 结论 | 证据 | 覆盖状态 |
|---|---|---|---|
| 导出能力 | A1、A3 | E1、E3 | 已覆盖 |
| 导入能力 | A1、A4 | E1、E4 | 已覆盖 |
| 去重规则 | A4、A5 | E4、E5 | 已覆盖 |
| 失败可见性 | A6 | E6 | 部分覆盖 |""",
)

S2_BAD = skeleton(
    "SR-OPS-B",
    C2_OK,
    """| 编号 | 结论 | 类型 | 证据 |
|---|---|---|---|
| A1 | 导入导出逻辑位于 `pkg/sessionmanager/import_export.go`，使用临时文件完成合并。 | 事实 | E1 |
| A2 | 现有 `Save` 使用原子写保证不损坏数据。 | 事实 | E2 |
| A3 | 建议新增 `ImportSessions` 方法，直接复用现有去重逻辑。 | 事实 | E3 |
| A4 | 导入时可以忽略同 Host 检查，因为业务上不会重复。 | 事实 | E4 |""",
    "待补充。",
    "| 项目 | 现状 |\n|---|---|\n| 测试 | 未确认 |",
    "ASIS 阻塞：目标对象不存在，无法继续分析。",
    """| 编号 | 位置 | 说明 |
|---|---|---|
| E1 | `pkg/sessionmanager/import_export.go` | 虚构文件 |
| E2 | `pkg/sessionmanager/manager.go` | 保存 |
| E3 | `pkg/sessionmanager/manager.go` | 导入 |
| E4 | `pkg/sessionmanager/manager.go` | 去重 |""",
    "| 需求项 | 结论 | 证据 | 覆盖状态 |\n|---|---|---|---|\n| 导出 | A1 | E1 | 已覆盖 |",
)

S3_GOOD = skeleton(
    "SR-OPS-C",
    """边界来源：declared by software_architecture.md。`pkg/session/` 被声明为「终端会话注册表」，
不负责会话持久化；会话树持久化属于相邻的「已保存会话管理」模块 `pkg/sessionmanager/`。
因此需求中“只需在 pkg/session 补恢复入口”的前提不成立，标记为需前置确认。""",
    """| 编号 | 结论 | 类型 | 证据 |
|---|---|---|---|
| A1 | `pkg/session/` 只在内存中维护 `map[string]*Session`，进程退出即丢失，不落盘。 | 事实 | E1 |
| A2 | 注册表持有 `sshclient.Client`、`stdin` 与 `*ssh.Session` 句柄，是运行时对象而非可序列化配置。 | 事实 | E2 |
| A3 | 持久化与会话树的读写由 `pkg/sessionmanager/` 负责，持久化归属判给该模块。 | 事实 | E3 |
| A4 | `AddWithID` 支持按指定 ID 登记，这是恢复流程可复用的重连钩子。 | 事实 | E4 |
| A5 | `Resize` 对不存在的会话 ID 直接返回 nil，静默忽略，不报错。 | 事实 | E5 |
| A6 | `List` 新建切片并复制元素指针，切片本身是拷贝，但元素仍指向同一 `Session`。 | 事实 | E6 |""",
    "恢复流程需要先由持久化模块读出配置，再重建 SSH 连接，最后调用 `AddWithID` 登记。",
    """| 项目 | 现状 | 证据 |
|---|---|---|
| 存储 | 仅内存 map | E1 |
| 句柄 | Client / Stdin / SSHSession | E2 |
| 测试 | `pkg/session/manager_test.go` 通过 | E7 |""",
    "需求前提与架构基线冲突，标记为需前置确认；恢复流程的落点属于 TOBE 决策输入。",
    """| 编号 | 位置 | 说明 |
|---|---|---|
| E1 | `pkg/session/manager.go#Manager` | 内存 map |
| E2 | `pkg/session/manager.go#Session` | 运行时句柄 |
| E3 | `pkg/sessionmanager/manager.go#Manager` | 持久化归属 |
| E4 | `pkg/session/manager.go#AddWithID` | 指定 ID 登记 |
| E5 | `pkg/session/manager.go#Resize` | 未知 ID 静默 |
| E6 | `pkg/session/manager.go#List` | 切片拷贝 |
| E7 | `pkg/session/manager_test.go` | 现有测试 |""",
    """| 需求项 | 结论 | 证据 | 覆盖状态 |
|---|---|---|---|
| 重启恢复 | A1、A3 | E1、E3 | 待确认 |
| 重建连接 | A2、A4 | E2、E4 | 已覆盖 |
| 窗口尺寸 | A5 | E5 | 已覆盖 |
| 现有行为保持 | A6 | E6 | 已覆盖 |""",
)

S3_BAD = skeleton(
    "SR-OPS-C",
    """边界来源：declared by software_architecture.md。目标模块 `pkg/session/` 负责会话管理，
包括会话持久化到 `sessions.json`。""",
    """| 编号 | 结论 | 类型 | 证据 |
|---|---|---|---|
| A1 | `pkg/session/` 已实现持久化，把会话写入 `sessions.json`。 | 事实 | E1 |
| A2 | `Resize` 对不存在的 ID 返回明确错误，调用方可感知。 | 事实 | E2 |
| A3 | `List` 返回深拷贝，元素也完全独立。 | 事实 | E3 |
| A4 | 恢复只需把 `sessions.json` 读进内存即可，无需重建连接。 | 事实 | E4 |
| A5 | `Add` 不支持指定 ID，需要新增参数。 | 事实 | E5 |""",
    "待补充。",
    "| 项目 | 现状 |\n|---|---|\n| 存储 | sessions.json |",
    "无阻塞，需求前提正确。",
    """| 编号 | 位置 | 说明 |
|---|---|---|
| E1 | `pkg/session/manager.go` | 持久化 |
| E2 | `pkg/session/manager.go` | Resize |
| E3 | `pkg/session/manager.go` | List |
| E4 | `pkg/session/manager.go` | 恢复 |
| E5 | `pkg/session/manager.go` | Add |""",
    """| 需求项 | 结论 | 证据 | 覆盖状态 |
|---|---|---|---|
| 重启恢复 | A1、A4 | E1、E4 | 已覆盖 |
| 窗口尺寸 | A2 | E2 | 已覆盖 |""",
)

S4_GOOD = skeleton(
    "SR-OPS-D",
    C2_OK,
    """| 编号 | 结论 | 类型 | 证据 |
|---|---|---|---|
| A1 | `Save` 使用 `os.WriteFile` 直接覆盖 `sessions.json`，没有临时文件与 rename，写入非原子。 | 事实 | E1 |
| A2 | `CreateFolder` 只在根层扫描同名文件夹，嵌套层同名不会被拒；任意层级唯一的说法不成立。 | 事实 | E2 |
| A3 | `GetSessions` 直接返回内部切片，未做深拷贝，调用方修改会影响内部状态。 | 事实 | E3 |
| A4 | `Load` 在文件不存在时把会话树置空并立即落盘，会覆盖原文件。 | 事实 | E4 |
| A5 | 持久化入口只有 `Save`，没有写前备份。 | 事实 | E5 |""",
    "`Upsert` / `UpdateSession` / `DeleteSession` / `RenameSession` 都走 `Save`，因此非原子写影响所有变更路径。",
    """| 项目 | 现状 | 证据 |
|---|---|---|
| 写入 | os.WriteFile 直接覆盖 | E1 |
| 判重 | 仅根层 | E2 |
| 返回 | 内部切片 | E3 |""",
    """规格漂移（以代码为准）：

| 文档位置 | 文档承诺 | 代码现状 | 结论 |
|---|---|---|---|
| `docs/session-storage.md` 第 2 节 | Save 先写临时文件再 rename，保证原子 | `pkg/sessionmanager/manager.go#Save` 用 `os.WriteFile` 直接覆盖 | 文档过时，以代码为准 |
| `docs/session-storage.md` 第 3 节 | 文件夹名任意层级唯一 | `pkg/sessionmanager/manager.go#CreateFolder` 只查根层 | 文档过时，以代码为准 |
| `docs/session-storage.md` 第 4 节 | GetSessions 返回深拷贝 | `pkg/sessionmanager/manager.go#GetSessions` 返回内部切片 | 文档过时，以代码为准 |

冲突时以代码为准，依据是可执行行为与现有测试。""",
    """| 编号 | 位置 | 说明 |
|---|---|---|
| E1 | `pkg/sessionmanager/manager.go#Save` | os.WriteFile 直接覆盖 |
| E2 | `pkg/sessionmanager/manager.go#CreateFolder` | 仅根层判重 |
| E3 | `pkg/sessionmanager/manager.go#GetSessions` | 返回内部切片 |
| E4 | `pkg/sessionmanager/manager.go#Load` | IsNotExist 置空落盘 |
| E5 | `pkg/sessionmanager/manager.go#Upsert` | 变更统一走 Save |
| E6 | `docs/session-storage.md` | 团队设计说明 |""",
    """| 需求项 | 结论 | 证据 | 覆盖状态 |
|---|---|---|---|
| 写入可靠性 | A1、A5 | E1、E5 | 已覆盖 |
| 命名约束一致 | A2 | E2 | 已覆盖 |
| 读取语义一致 | A3 | E3 | 已覆盖 |
| 数据保全 | A4 | E4 | 已覆盖 |""",
)

S4_BAD = skeleton(
    "SR-OPS-D",
    C2_OK,
    """| 编号 | 结论 | 类型 | 证据 |
|---|---|---|---|
| A1 | `Save` 采用临时文件 + rename 的原子写方式，符合设计说明。 | 事实 | E1 |
| A2 | `CreateFolder` 递归检查任意层级同名文件夹。 | 事实 | E2 |
| A3 | `GetSessions` 返回深拷贝副本，GUI 与 CLI 各自持有独立副本。 | 事实 | E3 |
| A4 | 设计与实现一致，无漂移。 | 事实 | E4 |""",
    "待补充。",
    "| 项目 | 现状 | 证据 |\n|---|---|---|\n| 写入 | 原子写 | E1 |",
    "无漂移，文档与实现一致。",
    """| 编号 | 位置 | 说明 |
|---|---|---|
| E1 | `pkg/sessionmanager/manager.go` | 保存 |
| E2 | `pkg/sessionmanager/manager.go` | 创建文件夹 |
| E3 | `pkg/sessionmanager/manager.go` | 读取 |
| E4 | `pkg/sessionmanager/manager.go` | 一致性 |""",
    """| 需求项 | 结论 | 证据 | 覆盖状态 |
|---|---|---|---|
| 写入 | A1 | E1 | 已覆盖 |
| 命名 | A2 | E2 | 已覆盖 |
| 读取 | A3 | E3 | 已覆盖 |""",
)

S5_GOOD = """# 详细设计上下文（ASIS）

## C1. ASIS 状态与阅读说明

| 项目 | 内容 |
|---|---|
| 需求/AR | SR-OPS-E / AR-1 |
| ASIS 状态 | 阻塞 |
| 阻塞原因 | 缺少 `.sdd/software_architecture.md` |

## C2. 模块边界确认

ASIS 阻塞：工作区中不存在 `.sdd/software_architecture.md`，模块边界来源缺失。
边界来源标记为 blocked，未用代码结构或目录划分推断边界。

## C3. 关键 ASIS 事实

未开始事实查证：模块边界无法确认，继续查证会产出边界来路不明的结论。

## C4. 调用链与数据流

未完成，原因：缺少模块边界。影响：无法确定分析切片。下一步需要：提供架构基线。

## C5. 配置、数据、测试与依赖现状

未完成，原因同上。

## C6. 规格漂移、待确认与阻塞

ASIS 阻塞项：缺少 `.sdd/software_architecture.md`。
继续推进需要：由上游补充该文件，或明确指定替代的边界来源。

## C7. 证据索引

| 编号 | 位置 | 说明 |
|---|---|---|
| E1 | `.sdd/`（不存在） | 已检查，目录下无 software_architecture.md |

## C8. 需求/AR 追溯矩阵

| 需求项 | 结论 | 证据 | 覆盖状态 |
|---|---|---|---|
| 写入失败可见性 | 未分析 | E1 | 阻塞 |
| 读取失败 | 未分析 | E1 | 阻塞 |
"""

S5_BAD = skeleton(
    "SR-OPS-E",
    "边界来源：按代码目录结构判断，`pkg/sessionmanager` 就是会话管理模块，属于本次范围。",
    """| 编号 | 结论 | 类型 | 证据 |
|---|---|---|---|
| A1 | `Save` 使用 `os.WriteFile` 直接覆盖，权限 0644。 | 事实 | E1 |
| A2 | `Load` 在文件不存在时置空并落盘。 | 事实 | E2 |
| A3 | 写前没有备份，失败会影响原文件。 | 事实 | E3 |""",
    "变更路径统一走 `Save`。",
    "| 项目 | 现状 | 证据 |\n|---|---|---|\n| 写入 | WriteFile | E1 |",
    "无阻塞。架构基线按代码结构推断得出。",
    """| 编号 | 位置 | 说明 |
|---|---|---|
| E1 | `pkg/sessionmanager/manager.go#Save` | 写入 |
| E2 | `pkg/sessionmanager/manager.go#Load` | 初始化 |
| E3 | `pkg/sessionmanager/manager.go#Upsert` | 变更 |""",
    """| 需求项 | 结论 | 证据 | 覆盖状态 |
|---|---|---|---|
| 写入失败可见 | A1、A3 | E1、E3 | 已覆盖 |
| 读取失败 | A2 | E2 | 已覆盖 |""",
)

S6_GOOD = skeleton(
    "SR-OPS-F",
    C2_OK,
    """| 编号 | 结论 | 类型 | 证据 |
|---|---|---|---|
| A1 | `RenameSession` 只改节点 `Name`，不同步 `config.Host`，连接目标保持不变。 | 事实 | E1 |
| A2 | 需求要求“显示名与连接目标一致”，与现状不一致，属于需求与现状的差距。 | 事实 | E2 |
| A3 | CLI 通过 `findSessionConfig` 按 Host 定位服务器，Host 是唯一键，改名不同步会让显示名与定位依据分裂。 | 事实 | E3 |
| A4 | `UpdateSession` 会把同 Host 视为重复并拒绝，因此同步 Host 会牵动去重规则。 | 事实 | E4 |
| A5 | `Upsert` 以 Host 为身份键并复用原 ID。 | 事实 | E5 |""",
    "`RenameSession` → 修改 `node.Name` → `Save`；不触碰 `Config`。",
    "| 项目 | 现状 | 证据 |\n|---|---|---|\n| 名称 | 节点 Name | E1 |\n| 定位 | findSessionConfig 按 Host | E3 |",
    """现状与需求的差距已记录。是否让重命名同步 Host、是否需要迁移既有别名，
以及由此产生的去重规则调整，均为 TOBE 决策输入，需上游对需求语义给出确认。""",
    """| 编号 | 位置 | 说明 |
|---|---|---|
| E1 | `pkg/sessionmanager/manager.go#RenameSession` | 只改 Name |
| E2 | `pkg/sessionmanager/manager.go#Session` | Name 与 Config 分离 |
| E3 | `pkg/core/ops/exec.go#findSessionConfig` | 按 Host 定位 |
| E4 | `pkg/sessionmanager/manager.go#UpdateSession` | 同 Host 拒绝 |
| E5 | `pkg/sessionmanager/manager.go#Upsert` | Host 为身份键 |""",
    """| 需求项 | 结论 | 证据 | 覆盖状态 |
|---|---|---|---|
| 显示名与连接目标一致 | A2 | E2 | 待确认 |
| 不产生重复节点 | A4、A5 | E4、E5 | 已覆盖 |
| 现状确认 | A1、A3 | E1、E3 | 已覆盖 |""",
)

S6_BAD = skeleton(
    "SR-OPS-F",
    C2_OK,
    """| 编号 | 结论 | 类型 | 证据 |
|---|---|---|---|
| A1 | `RenameSession` 会同步修改 Host，保证显示名与连接目标一致。 | 事实 | E1 |
| A2 | 重命名后 CLI 可以直接按新名字定位服务器。 | 事实 | E2 |
| A3 | `Upsert` 以 Name 为身份键去重。 | 事实 | E3 |
| A4 | 应当把 Host 与 Name 合并为一个字段。 | 事实 | E4 |""",
    "待补充。",
    "| 项目 | 现状 | 证据 |\n|---|---|---|\n| 名称 | 同步 Host | E1 |",
    "无漂移，现状已满足需求。",
    """| 编号 | 位置 | 说明 |
|---|---|---|
| E1 | `pkg/sessionmanager/manager.go` | 重命名 |
| E2 | `pkg/sessionmanager/manager.go` | 定位 |
| E3 | `pkg/sessionmanager/manager.go` | 去重 |
| E4 | `pkg/sessionmanager/manager.go` | 合并 |""",
    """| 需求项 | 结论 | 证据 | 覆盖状态 |
|---|---|---|---|
| 名称一致 | A1 | E1 | 已覆盖 |
| 不重复 | A3 | E3 | 已覆盖 |""",
)

CASES = {
    "s1": (S1_GOOD, S1_BAD, "SR-OPS-A"),
    "s2": (S2_GOOD, S2_BAD, "SR-OPS-B"),
    "s3": (S3_GOOD, S3_BAD, "SR-OPS-C"),
    "s4": (S4_GOOD, S4_BAD, "SR-OPS-D"),
    "s5": (S5_GOOD, S5_BAD, "SR-OPS-E"),
    "s6": (S6_GOOD, S6_BAD, "SR-OPS-F"),
}


def build_workspace(root: Path, scene: str, sr: str, artifact: str, with_arch: bool) -> Path:
    if not (REPO / "pkg/sessionmanager/manager.go").is_file():
        raise SystemExit(f"用法：python smoke_test.py <opscopilot 仓库路径>（当前：{REPO}）")
    for relative in KEEP:
        source = REPO / relative
        if not source.is_file():
            continue
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    if with_arch:
        arch = root / ".sdd" / "software_architecture.md"
        arch.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ARCH, arch)
    if scene == "s4":
        target = root / "docs" / "session-storage.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ASSETS / "scenes" / "s4" / "docs" / "session-storage.md", target)
    module_dir = "pkg-session" if scene == "s3" else "pkg-sessionmanager"
    out = root / ".sdd" / sr / "AR-1" / module_dir / ".context"
    out.mkdir(parents=True, exist_ok=True)
    (out / "详细设计上下文.md").write_text(artifact, encoding="utf-8")
    return root


def run(scene: str, root: Path) -> dict:
    script = ASSETS / "cases" / scene / "check_behavior.py"
    env = {
        **os.environ,
        "AAW_WORKSPACE": str(root),
        "PYTHONIOENCODING": "utf-8",
        "AAW_FINAL_RESPONSE": str(root / ".final-response.md"),
        # 平台会把 lib 与脚本一起物化到 grader 目录；本地冒烟用 PYTHONPATH 等价模拟。
        "PYTHONPATH": str(ASSETS / "lib"),
    }
    (root / ".final-response.md").write_text("", encoding="utf-8")
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
        return {"error": result.returncode, "stderr": result.stderr[-2000:]}
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    return {item["id"]: item["score"] for item in payload["checks"]}


def main() -> int:
    ok = True
    with tempfile.TemporaryDirectory() as temp:
        base = Path(temp)
        for scene, (good, bad, sr) in CASES.items():
            with_arch = scene != "s5"
            print(f"== {scene}")
            for label, artifact in (("good", good), ("bad", bad)):
                root = build_workspace(base / f"{scene}-{label}", scene, sr, artifact, with_arch)
                outcome = run(scene, root)
                if "error" in outcome:
                    print(f"   {label:5} ERROR {outcome['error']} {outcome.get('stderr', '')[:600]}")
                    ok = False
                    continue
                avg = sum(outcome.values()) / len(outcome)
                detail = ", ".join(f"{k}={v}" for k, v in outcome.items())
                print(f"   {label:5} {detail}  avg={avg:.1f}")
                if label == "good" and avg < 85:
                    ok = False
                if label == "bad" and avg > 65:
                    ok = False
    print("\nSMOKE-" + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
