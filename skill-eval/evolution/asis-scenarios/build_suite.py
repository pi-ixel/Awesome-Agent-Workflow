"""构建「ASIS 场景矩阵」测试套：一个套件、六个场景、每个场景一个测试目的。

用法（在 skill-eval/ 目录）：
    .venv/Scripts/python.exe evolution/asis-scenarios/build_suite.py [--rebuild]

流程：POST 草稿 → POST validate（隔离克隆并试跑断言）→ POST save（锁定）。
已存在同名未归档套件时默认跳过；--rebuild 会先归档旧套件再新建。
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ASSETS = HERE / "assets"
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "src"))

from aaw_skill_eval.modules.designer.packages import package_from_documents  # noqa: E402

BASE = "http://127.0.0.1:18110"
PROJECT = Path(r"D:\dev\workspace-ai\eval-pr187\opscopilot")
SKILL = ROOT.parent / "skills" / "module-asis-analysis"
MODEL = "03b919c5c576"
SUITE_NAME = "ASIS-场景矩阵-OpsCopilot会话树"

COMMON = (ASSETS / "lib" / "common.py").read_text(encoding="utf-8")
SHARED_ARCH = (ASSETS / "scenes" / "_shared" / "software_architecture.md").read_text(encoding="utf-8")

# 每个场景：测试目的 → 夹具 → 期望 → 断言脚本
SCENES = [
    {
        "id": "s1-baseline",
        "name": "S1 基线正例：常规 ASIS 交付",
        "purpose": "交付基本面（骨架/边界/编号/证据/职责）是否稳定复现",
        "sr": "SR-OPS-A",
        "module": "pkg/sessionmanager",
        "dir": "s1",
        "architecture": True,
        "extra_files": [],
        "expected": (
            "产出一份完整的 ASIS 上下文：固定骨架齐全，边界来源标记为 declared，"
            "结论与证据成编号体系且可追溯；关键现状事实与 pkg/sessionmanager/manager.go 一致；"
            "未创建正式说明书，未把实现方案写成现状。"
        ),
    },
    {
        "id": "s2-pure-new",
        "name": "S2 纯新增：导入/导出当前不存在",
        "purpose": "「纯新增」分支是否走通：给出不存在的检索证据，并记录可复用的现状约束",
        "sr": "SR-OPS-B",
        "module": "pkg/sessionmanager",
        "dir": "s2",
        "architecture": True,
        "extra_files": [],
        "expected": (
            "明确判定导入/导出能力当前不存在，并给出检索命令或检索范围；"
            "记录可复用的落盘/序列化现状与按 Host 去重约束；"
            "不把「未找到」写成 ASIS 阻塞，不虚构新增入口文件，实现方案归入 TOBE 决策输入。"
        ),
    },
    {
        "id": "s3-wrong-module",
        "name": "S3 模块误归属：需求把持久化挂到 pkg/session",
        "purpose": "边界来源是否真的来自架构基线，而不是需求措辞",
        "sr": "SR-OPS-C",
        "module": "pkg/session",
        "dir": "s3",
        "architecture": True,
        "extra_files": [],
        "expected": (
            "按架构基线把持久化归属判给 pkg/sessionmanager，并指出 pkg/session 只是内存注册表；"
            "显式质疑「只需在 pkg/session 补恢复入口」的前提；识别 Resize 静默忽略与 List 浅拷贝；"
            "证据锚点落在 pkg/session/manager.go 的真实符号上。"
        ),
    },
    {
        "id": "s4-doc-drift",
        "name": "S4 文档漂移：设计说明与实现相反",
        "purpose": "规格漂移是否以代码为准，而不是把现成文档抄成结论",
        "sr": "SR-OPS-D",
        "module": "pkg/sessionmanager",
        "dir": "s4",
        "architecture": True,
        "extra_files": [("docs/session-storage.md", "s4/docs/session-storage.md")],
        "expected": (
            "指出 docs/session-storage.md 的三处错误承诺（原子写、任意层级判重、深拷贝），"
            "逐项给出代码侧真实行为并声明以代码为准；不把这些承诺写成现状；"
            "漂移结论锚定文档位置与代码符号双方。"
        ),
    },
    {
        "id": "s5-missing-architecture",
        "name": "S5 前置缺失：架构基线不存在",
        "purpose": "边界唯一来源是硬约束：缺失时必须阻塞，而不是自行推断",
        "sr": "SR-OPS-E",
        "module": "pkg/sessionmanager",
        "dir": "s5",
        "architecture": False,
        "extra_files": [],
        "expected": (
            "点名缺少 .sdd/software_architecture.md，标记 ASIS 阻塞，并说明继续所需输入；"
            "不得改用代码目录结构推断边界，不得宣称边界已 declared，不得假装分析完成。"
        ),
    },
    {
        "id": "s6-tobe-leak",
        "name": "S6 目标污染：需求把「重命名同步 Host」当目标",
        "purpose": "ASIS 与 TOBE 边界：现状事实与目标状态是否分开",
        "sr": "SR-OPS-F",
        "module": "pkg/sessionmanager",
        "dir": "s6",
        "architecture": True,
        "extra_files": [],
        "expected": (
            "写明现状是 RenameSession 只改 Name、不同步 Host/Config；"
            "把「显示名与连接目标一致」识别为需求与现状的差距，并归入 TOBE 决策输入；"
            "指出 Host 是 CLI 的定位键；不得把目标状态写成现状。"
        ),
    },
]

INPUT_TEMPLATE = """你使用 module-asis-analysis skill，对目标模块做 {sr} 的 ASIS 现状分析。

【工作目录】当前目录（OpsCopilot，Go 项目，模块名 opscopilot）。

【输入（已就位，直接读取，不要修改）】
- 需求与范围：.sdd/{sr}/requirement.md
{arch_line}
【本次分析任务】
- 目标模块：{module}
- SR={sr}，AR=AR-1，模块组名={module_dir}

【本次执行方式（重要，请严格遵守）】
1. 你是无头执行，由评测平台调用，没有人类在旁。前置的工作流确认环节跳过，
   不要回调 aaw-workflow；执行中需要用户或上游确认的问题，按 skill 规定处理，
   不要等待回答。
2. 本环境无法启动 SubAgent——按 skill 对该情形的规定处理并留痕。
3. 本环境不提供任何 MCP 工具。网络不可用。
4. 按 skill 正文规定的阶段流水线与产物契约执行；只读分析，不修改代码。

【输出要求】
1. 按 skill 的产物契约产出到 .sdd/{sr}/AR-1/{module_dir}/.context/详细设计上下文.md。
2. 最后回复：给出产物路径（若无法产出则说明原因）、整体状态、主要结论与阻塞/待确认项清单。"""

ARCH_LINE = "- 架构基线（模块边界唯一来源）：.sdd/software_architecture.md\n"
ARCH_ABSENT = "- 本工作区未提供架构基线文件。\n"


def post(path: str, payload: dict | None = None) -> dict:
    body = json.dumps(payload).encode("utf-8") if payload is not None else b"{}"
    request = urllib.request.Request(
        f"{BASE}{path}", data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"POST {path} -> {exc.code}: {detail[:2000]}") from exc


def get(path: str) -> dict:
    with urllib.request.urlopen(f"{BASE}{path}", timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def build_case(scene: dict) -> tuple[dict, dict[str, str]]:
    module_dir = f"pkg-{scene['module'].split('/')[-1]}"
    files = {
        f".sdd/{scene['sr']}/requirement.md": f"scenes/{scene['dir']}/requirement.md",
    }
    assets = {
        f"scenes/{scene['dir']}/requirement.md": (
            ASSETS / "scenes" / scene["dir"] / "requirement.md"
        ).read_text(encoding="utf-8")
    }
    if scene["architecture"]:
        files[".sdd/software_architecture.md"] = "scenes/_shared/software_architecture.md"
        assets["scenes/_shared/software_architecture.md"] = SHARED_ARCH
    for target, source in scene["extra_files"]:
        files[target] = f"scenes/{source}"
        assets[f"scenes/{source}"] = (ASSETS / "scenes" / source).read_text(encoding="utf-8")

    check_rel = f"checks/{scene['id']}/check_behavior.py"
    common_rel = f"checks/{scene['id']}/common.py"
    scene_rel = f"checks/{scene['id']}/scene.json"
    assets[check_rel] = (ASSETS / "cases" / scene["dir"] / "check_behavior.py").read_text(
        encoding="utf-8"
    )
    assets[common_rel] = COMMON
    assets[scene_rel] = json.dumps(
        {"id": scene["id"], "sr": scene["sr"]}, ensure_ascii=False
    )

    case = {
        "id": scene["id"],
        "name": scene["name"],
        "input": INPUT_TEMPLATE.format(
            sr=scene["sr"],
            module=scene["module"],
            module_dir=module_dir,
            arch_line=ARCH_LINE if scene["architecture"] else ARCH_ABSENT,
        ),
        "expected": scene["expected"],
        "weight": 1,
        "agent_context": "",
        "followups": [],
        "max_turns": 30,
        "files": files,
        "output_paths": [f".sdd/{scene['sr']}/AR-1/{module_dir}/.context/详细设计上下文.md"],
        "graders": [
            {
                "type": "command",
                "command": f"python {check_rel}",
                "result_format": "json",
                "checkpoint_ids": ["required-behavior", "edge-cases"],
                "files": [check_rel, common_rel, scene_rel],
                "setup_commands": [],
                "timeout_seconds": 300,
            }
        ],
    }
    return case, assets


def build_package() -> dict:
    cases, assets = [], {}
    for scene in SCENES:
        case, extra = build_case(scene)
        cases.append(case)
        assets.update(extra)
    manifest = {"cases": cases}
    return package_from_documents("correctness", manifest, assets)


def existing_suite() -> dict | None:
    for item in get("/api/v1/benchmark/suites")["items"]:
        if item["name"] == SUITE_NAME and not item.get("archived"):
            return item
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rebuild", action="store_true", help="归档同名旧套件后重建")
    args = parser.parse_args()

    print(f"project={PROJECT}\nskill={SKILL}")
    current = existing_suite()
    if current and not args.rebuild:
        print(f"已存在，跳过：{current['id']}")
        return 0
    if current:
        post(f"/api/v1/benchmark/suites/{current['id']}/archive", {"archived": True})
        print(f"已归档旧套件 {current['id']}")

    data = {
        "name": SUITE_NAME,
        "project_path": str(PROJECT),
        "skill_path": str(SKILL),
        "requirement": (
            "按测试目的划分的 ASIS 场景矩阵：每个场景检验一类真实失效模式"
            "（基线交付、纯新增、模块误归属、文档漂移、前置缺失、目标污染），"
            "而不是对同一产物换不同维度打分。"
        ),
        "generator_provider": "chrys",
        "generator_model": MODEL,
        "case_mode": "single",
        "setup": {"commands": [], "preflight": ["go version"], "network": False, "timeout_seconds": 900},
        "dimensions": [{"id": "correctness"}],
        "packages": {"correctness": build_package()},
    }

    created = post("/api/v1/benchmark/drafts", {"data": data})
    draft_id = created["id"]
    print(f"draft {draft_id} status={created['status']}")
    if created.get("preview_error"):
        raise SystemExit(f"预览失败：{created['preview_error']}")

    post(f"/api/v1/benchmark/drafts/{draft_id}/validate", {"revision": created["revision"]})
    for _ in range(900):
        time.sleep(2)
        state = get(f"/api/v1/benchmark/drafts/{draft_id}")
        if state["status"] in {"ready", "failed"}:
            break
    else:
        raise SystemExit("校验超时")

    validation = state.get("validation") or {}
    print(
        f"校验 status={state['status']} runnable={validation.get('scripts_runnable')} "
        f"cases={validation.get('case_count')} commit={str(validation.get('project_commit'))[:8]}"
    )
    if state["status"] != "ready":
        raise SystemExit(json.dumps(validation, ensure_ascii=False, indent=2)[:6000])

    saved = post(f"/api/v1/benchmark/drafts/{draft_id}/save", {"revision": state["revision"]})
    (HERE / "suite.json").write_text(
        json.dumps(
            {"name": saved["name"], "id": saved["id"], "cases": [s["id"] for s in SCENES]},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"suite {saved['id']} {saved['name']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
