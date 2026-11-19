"""构建并提交三套 ASIS 测试套：契约基线 / 事实可信 / 产出经济性。

用法（Windows，仓库根）：
    skill-eval/.venv/Scripts/python.exe skill-eval/evolution/asis-slim/build_suites.py

流程：POST 草稿 → POST validate（隔离克隆并试跑断言）→ POST save（锁定）。
"""

from __future__ import annotations

import base64
import json
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ASSETS = HERE / "assets"
ROOT = HERE.parents[1]  # skill-eval/
sys.path.insert(0, str(ROOT / "src"))

from aaw_skill_eval.modules.designer.packages import package_from_documents  # noqa: E402

BASE = "http://127.0.0.1:18110"
PROJECT = Path(r"D:\dev\workspace-ai\eval-pr187\opscopilot")
SKILL = ROOT.parent / "skills" / "module-asis-analysis"
MODEL = "03b919c5c576"
SR = "SR-OPS-A"
MODULE_DIR = "pkg-sessionmanager"

REQUIREMENT = (ASSETS / "A-contract" / "requirement.md").read_text(encoding="utf-8")
ARCHITECTURE = (ASSETS / "A-contract" / "software_architecture.md").read_text(encoding="utf-8")

CASE_INPUT = f"""你使用 module-asis-analysis skill，对目标模块做 {SR} 的 ASIS 现状分析。

【工作目录】当前目录（OpsCopilot，Go 项目，模块名 opscopilot）。

【输入（已就位，直接读取，不要修改）】
- 需求与范围：.sdd/{SR}/requirement.md
- 架构基线（模块边界唯一来源）：.sdd/software_architecture.md

【本次分析任务】
- 目标模块：已保存会话管理（pkg/sessionmanager/）
- 分析切片：会话树的持久化、按主机去重与更新、递归查找、名称语义
- SR={SR}，AR=AR-1，模块组名={MODULE_DIR}

【本次执行方式（重要，请严格遵守）】
1. 你是无头执行，由评测平台调用，没有人类在旁。前置的工作流确认环节跳过，
   不要回调 aaw-workflow；执行中需要用户或上游确认的问题，按 skill 规定处理，
   不要等待回答。
2. 本环境无法启动 SubAgent——按 skill 对该情形的规定处理并留痕。
3. 本环境不提供任何 MCP 工具。网络不可用。
4. 严格按 skill 正文规定的阶段流水线与产物契约执行；只读分析，不修改代码。

【输出要求】
1. 按 skill 的产物契约产出到对应路径（SR={SR}，AR=AR-1，模块组名={MODULE_DIR}）。
2. 最后回复：给出产物路径、整体状态、主要结论与阻塞/待确认项清单。"""

CASE_EXPECTED = f"""产出 .sdd/{SR}/AR-1/{MODULE_DIR}/.context/详细设计上下文.md，且：

- 含 C1–C8 全部固定目录标题（无内容的章节保留标题并写明原因）。
- C2 边界来源标记为 declared，并指向 .sdd/software_architecture.md。
- 结论有稳定编号（A1、A2……），证据有编号（E1、E2……），且正文与映射均有引用。
- 产出的现状结论与 pkg/sessionmanager/manager.go 真实行为一致，不臆造未实现的行为。
- 未创建《模块详细设计说明书.md》；实现方案只记为 TOBE 决策输入。
- 产物信息密度高：不重述 skill 自身的流程规则，不重复同一事实。"""

SETUP = {"commands": [], "preflight": ["go version"], "network": False, "timeout_seconds": 900}

SCENE = {
    "id": "sr-ops-a-session-tree-asis",
    "name": "OpsCopilot 已保存会话树 ASIS 分析",
    "input": CASE_INPUT,
    "expected": CASE_EXPECTED,
    "weight": 1,
    "agent_context": "",
    "followups": [],
    "max_turns": 30,
    "files": {
        f".sdd/{SR}/requirement.md": "scene/requirement.md",
        ".sdd/software_architecture.md": "scene/software_architecture.md",
    },
    "output_paths": [f".sdd/{SR}/AR-1/{MODULE_DIR}/.context/详细设计上下文.md"],
}

SCENE_ASSETS = {
    "scene/requirement.md": REQUIREMENT,
    "scene/software_architecture.md": ARCHITECTURE,
}


def script(relative: str) -> str:
    return (ASSETS / relative).read_text(encoding="utf-8")


def code_grader(name: str, checkpoint_ids: list[str], script_path: str, relative: str) -> dict:
    return {
        "type": "command",
        "command": f"python {script_path}",
        "result_format": "json",
        "checkpoint_ids": checkpoint_ids,
        "files": [script_path],
        "setup_commands": [],
        "timeout_seconds": 300,
    }, {script_path: script(relative)}


CONTRACT = code_grader(
    "A", ["output-constraints"], "validate_contract.py", "A-contract/validate_contract.py"
)
FACTS = code_grader(
    "B1", ["required-behavior"], "validate_facts.py", "B-truth/validate_facts.py"
)
EDGE = code_grader(
    "B2", ["edge-cases"], "validate_edge.py", "B-truth/validate_edge.py"
)
ECONOMY = code_grader(
    "C", ["output-constraints"], "validate_economy.py", "C-economy/validate_economy.py"
)

SUITES = [
    {
        "name": f"ASIS-契约基线-OpsCopilot会话树-{SR}",
        "requirement": "module-asis-analysis 产物契约能否稳定复现：骨架、边界来源、编号体系、路径真实性、职责边界。",
        "dimensions": ["completeness"],
        "package": lambda dim: _pack(dim, [CONTRACT]),
    },
    {
        "name": f"ASIS-事实可信-OpsCopilot会话树-{SR}",
        "requirement": "ASIS 结论是否锚定真实代码：核心现状事实与反直觉边界行为，同时用 LLM 维度核对事实一致性。",
        "dimensions": ["correctness", "accuracy"],
        "package": lambda dim: _pack(dim, [FACTS, EDGE] if dim == "correctness" else []),
    },
    {
        "name": f"ASIS-产出经济性-OpsCopilot会话树-{SR}",
        "requirement": "同样信息量下的冗余成本：产物规模、正文重复、Skill 元指令重述、证据定位密度；并用清晰度维度核对表达。",
        "dimensions": ["completeness", "clarity"],
        "package": lambda dim: _pack(dim, [ECONOMY] if dim == "completeness" else []),
    },
]


def _pack(dimension: str, graders: list[tuple[dict, dict[str, str]]]) -> dict:
    manifest = {"cases": [{**SCENE, "graders": [g for g, _ in graders]}]}
    assets = dict(SCENE_ASSETS)
    for _, extra in graders:
        assets.update(extra)
    return package_from_documents(dimension, manifest, assets)


def post(path: str, payload: dict | None = None) -> dict:
    body = json.dumps(payload).encode("utf-8") if payload is not None else b"{}"
    request = urllib.request.Request(
        f"{BASE}{path}", data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"POST {path} -> {exc.code}: {detail[:1200]}") from exc


def get(path: str) -> dict:
    with urllib.request.urlopen(f"{BASE}{path}", timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def build(suite: dict) -> str:
    data = {
        "name": suite["name"],
        "project_path": str(PROJECT),
        "skill_path": str(SKILL),
        "requirement": suite["requirement"],
        "generator_provider": "chrys",
        "generator_model": MODEL,
        "case_mode": "single",
        "setup": SETUP,
        "dimensions": [{"id": dim} for dim in suite["dimensions"]],
        "packages": {dim: suite["package"](dim) for dim in suite["dimensions"]},
    }
    created = post("/api/v1/benchmark/drafts", {"data": data})
    draft_id = created["id"]
    print(f"  draft {draft_id} status={created['status']}")
    if created.get("preview_error"):
        raise SystemExit(f"  预览失败：{created['preview_error']}")

    post(f"/api/v1/benchmark/drafts/{draft_id}/validate", {"revision": created["revision"]})
    for _ in range(600):
        time.sleep(2)
        current = get(f"/api/v1/benchmark/drafts/{draft_id}")
        if current["status"] in {"ready", "failed"}:
            break
    else:
        raise SystemExit("  校验超时")
    validation = current.get("validation") or {}
    print(
        f"  校验 status={current['status']} runnable={validation.get('scripts_runnable')} "
        f"cases={validation.get('case_count')} project={str(validation.get('project_commit'))[:8]}"
    )
    if current["status"] != "ready":
        raise SystemExit(f"  校验未通过：{current.get('error') or validation}")

    saved = post(
        f"/api/v1/benchmark/drafts/{draft_id}/save", {"revision": current["revision"]}
    )
    print(f"  suite {saved['id']} {saved['name']}")
    return saved["id"]


def main() -> int:
    print(f"project={PROJECT}")
    print(f"skill={SKILL}")
    existing = {
        item["name"]: item["id"]
        for item in get("/api/v1/benchmark/suites")["items"]
        if not item.get("archived")
    }
    ids = {}
    for suite in SUITES:
        print(f"\n== {suite['name']}")
        if suite["name"] in existing:
            print(f"  已存在，跳过：{existing[suite['name']]}")
            ids[suite["name"]] = existing[suite["name"]]
            continue
        ids[suite["name"]] = build(suite)
    out = HERE / "suites.json"
    out.write_text(json.dumps(ids, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nwritten {out}")
    for name, suite_id in ids.items():
        print(f"{suite_id}  {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
