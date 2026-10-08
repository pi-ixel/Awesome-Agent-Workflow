"""详情页结构测试（用户方案一 1-4、8 与方案二）。

两类验证：
1. 静态结构断言 —— 与 test_conclusion.py 的详情页测试同风格，读取
   index.html / app.js 源文本确认关键标记；
2. 行为断言 —— 在 Node 中用 DOM 桩加载真实 app.js，直接调用
   defaultCaseId / selectedCase / comparisonMarkup / caseSectionMarkup /
   conclusionMarkup 等纯渲染函数验证选择与渲染逻辑。
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

STATIC_DIR = Path(__file__).resolve().parents[1] / "src" / "aaw_skill_eval" / "static"

# Node 桩：app.js 顶层只注册 DOMContentLoaded 监听器，不会触碰真实 DOM。
# 部分内置全局（如新版 Node 的 navigator）只有 getter，用 defineProperty 兜底。
HARNESS_PREAMBLE = """'use strict';
const stubGlobal = (name, value) => {
  try { globalThis[name] = value; }
  catch { try { Object.defineProperty(globalThis, name,
    {value, configurable: true, writable: true}); } catch {} }
};
stubGlobal("document", {addEventListener() {}, querySelector() {return null;},
  querySelectorAll() {return [];}});
stubGlobal("window", {addEventListener() {}, confirm() {return true;}, open() {}});
stubGlobal("location", {hash: ""});
stubGlobal("localStorage", {getItem() {return null;}, setItem() {}, removeItem() {}});
stubGlobal("sessionStorage", {getItem() {return null;}, setItem() {}});
stubGlobal("fetch", async () => ({ok: true, json: async () => ({})}));
"""


def _node_available() -> bool:
    return shutil.which("node") is not None


def _run_scenario(tmp_path: Path, scenario: str) -> dict:
    app_source = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    harness = tmp_path / "app-harness.js"
    harness.write_text(
        HARNESS_PREAMBLE + "\n" + app_source + "\n" + scenario, encoding="utf-8"
    )
    result = subprocess.run(
        ["node", str(harness)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip(), "scenario produced no output"
    return json.loads(result.stdout)


def _js(value) -> str:
    return json.dumps(value, ensure_ascii=False)


def _case(case_id: str, name: str, grader_name: str) -> dict:
    return {
        "id": case_id,
        "name": name,
        "input": f"input for {case_id}",
        "expected": f"expected for {case_id}",
        "weight": 1,
        "agent_context": "",
        "followups": [],
        "max_turns": 6,
        "graders": [
            {
                "id": "result-file",
                "type": "file_exists",
                "name": "Result file exists",
                "weight": 0,
                "hard_gate": True,
                "path": "result.md",
                "patterns": [],
                "timeout_seconds": 300,
            },
            {
                "id": "quality",
                "type": "llm_rubric",
                "name": grader_name,
                "weight": 100,
                "hard_gate": False,
                "rubric": "Judge quality",
                "timeout_seconds": 300,
            },
        ],
    }


def _run(case_id: str, group: str, score, gates=(1, 1), status: str = "completed") -> dict:
    return {
        "id": f"run-{case_id}-{group}",
        "case_id": case_id,
        "group": group,
        "trial": 1,
        "status": status,
        "quality_score": score,
        "hard_gates": {"passed": gates[0], "total": gates[1]},
        "reviews": [],
    }


def _experiment(cases: list[dict], runs: list[dict]) -> dict:
    groups = {
        group: {
            "missing": not any(run["group"] == group for run in runs),
            "score": None,
            "completed_trials": sum(
                1 for run in runs if run["group"] == group and run["status"] == "completed"
            ),
            "expected_trials": len(cases),
            "provisional": False,
            "gates_passed": 1,
            "gates_total": 1,
            "gates_failed": False,
        }
        for group in ("no_skill", "baseline", "current")
    }
    groups["current"]["score"] = 88
    groups["no_skill"]["score"] = 55
    return {
        "id": "exp-1",
        "suite_name": "Fixture suite",
        "status": "completed",
        "mode": "quick",
        "trials": 1,
        "project_commit": "c" * 12,
        "execution_mode": "pair_parallel_v1",
        "concurrency_limit": 2,
        "profile": {
            "hash": "h" * 12,
            "runner": {
                "provider": "codex",
                "model": "m",
                "model_name": "m",
                "isolation": "workspace-write",
                "network_policy": "disabled",
            },
            "judge": {
                "provider": "codex",
                "model": "m",
                "model_name": "m",
                "isolation": "read-only",
                "network_policy": "disabled",
            },
            "self_judge": True,
        },
        "conclusion": {
            "verdict": "solid",
            "expected_trials_per_group": 1,
            "groups": groups,
            "formal_deltas": {"no_skill": True, "baseline": False},
        },
        "delta_no_skill": 33,
        "delta_baseline": None,
        "suite_snapshot": {"cases": cases},
        "runs": runs,
        "error_message": None,
    }


pytestmark = pytest.mark.skipif(not _node_available(), reason="node is required to load app.js")


# ------------------------------------------------- Case 选择器默认顺序（方案一.3）


def test_default_case_prefers_hard_gate_failure(tmp_path: Path):
    cases = [_case("case-ok", "正常用例", "质量"), _case("case-gate", "门禁用例", "质量")]
    runs = [
        _run("case-ok", "no_skill", 55),
        _run("case-ok", "current", 88),
        _run("case-gate", "no_skill", 55),
        _run("case-gate", "current", 90, gates=(0, 1)),
    ]
    scenario = f"""
    const item = {_js(_experiment(cases, runs))};
    const grouped = runsByCaseAndGroup(item);
    state.detailCaseFor = item.id; state.detailCaseId = null;
    console.log(JSON.stringify({{
      picked: defaultCaseId(item, grouped),
      statsGate: caseRunStats(grouped.get("case-gate") || {{}}),
      statsOk: caseRunStats(grouped.get("case-ok") || {{}})
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["picked"] == "case-gate"
    assert result["statsGate"]["gateFailed"] is True
    assert result["statsOk"]["gateFailed"] is False


def test_default_case_then_worst_delta_then_first(tmp_path: Path):
    cases = [
        _case("case-a", "用例甲", "甲维度"),
        _case("case-b", "用例乙", "乙维度"),
        _case("case-c", "用例丙", "丙维度"),
    ]
    runs = [
        _run("case-a", "no_skill", 60),
        _run("case-a", "current", 70),
        _run("case-b", "no_skill", 60),
        _run("case-b", "current", 55),
        _run("case-c", "no_skill", 60),
        _run("case-c", "current", 62),
    ]
    scenario = f"""
    const item = {_js(_experiment(cases, runs))};
    const worst = defaultCaseId(item, runsByCaseAndGroup(item));
    item.runs = [];
    const fallback = defaultCaseId(item, runsByCaseAndGroup(item));
    console.log(JSON.stringify({{worst, fallback}}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["worst"] == "case-b"  # 差值最差（55-60 = -5）
    assert result["fallback"] == "case-a"  # 无完成 run 时回落到第一个 case


def test_selected_case_is_preserved_and_revalidated(tmp_path: Path):
    cases = [_case("case-a", "用例甲", "甲维度"), _case("case-b", "用例乙", "乙维度")]
    scenario = f"""
    const item = {_js(_experiment(cases, []))};
    const grouped = runsByCaseAndGroup(item);
    state.detailCaseFor = item.id;
    state.detailCaseId = "case-b";
    const kept = selectedCase(item, grouped).id;
    state.detailCaseId = "no-longer-exists";
    const reset = selectedCase(item, grouped).id;
    console.log(JSON.stringify({{kept, reset}}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["kept"] == "case-b"
    assert result["reset"] == "case-a"


# ------------------------------------------------- 一次只呈现一个 case（方案二）


def test_comparison_renders_only_the_selected_case(tmp_path: Path):
    cases = [_case("case-a", "用例甲", "甲维度"), _case("case-b", "用例乙", "乙维度")]
    runs = [
        _run("case-a", "no_skill", 55),
        _run("case-a", "current", 88),
        _run("case-b", "no_skill", 55),
        _run("case-b", "current", 88),
    ]
    scenario = f"""
    const item = {_js(_experiment(cases, runs))};
    state.detailCaseFor = item.id; state.detailCaseId = "case-b";
    const markup = comparisonMarkup(item);
    console.log(JSON.stringify({{
      tables: (markup.match(/<table/g) || []).length,
      listPresent: markup.includes("radar-dimensions"),
      hasSelectedGrader: markup.includes("乙维度"),
      hasOtherGrader: markup.includes("甲维度"),
      hasReviewsModule: markup.includes("case-reviews")
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["tables"] == 0  # 合并视图：原明细表已移除，不再渲染任何表格
    assert result["listPresent"] is True  # 明细列表承载全部维度信息
    assert result["hasSelectedGrader"] is True
    assert result["hasOtherGrader"] is False
    assert result["hasReviewsModule"] is False  # 无人工复核不显示空白模块（方案二）


# ------------------------------------- 用例查看区（方案一.4）与 Case 选择器（方案一.3）


def test_case_section_renders_selector_and_collapsed_snapshot(tmp_path: Path):
    two_cases = [_case("case-a", "用例甲", "甲维度"), _case("case-b", "用例乙", "乙维度")]
    single_case = [_case("case-a", "用例甲", "甲维度")]
    scenario = f"""
    const item = {_js(_experiment(two_cases, []))};
    state.detailCaseFor = item.id; state.detailCaseId = "case-b"; state.caseSnapshotOpen = false;
    const section = caseSectionMarkup(item);
    const single = {_js(_experiment(single_case, []))};
    const singleSection = caseSectionMarkup(single);
    state.caseSnapshotOpen = true;
    const openSection = caseSectionMarkup(item);
    console.log(JSON.stringify({{
      selectorChips: (section.match(/data-case-select=/g) || []).length,
      activeChip: section.includes('data-case-select="case-b"')
        && section.includes('aria-selected="true"'),
      snapshotPresent: section.includes('id="caseSnapshot"'),
      snapshotBadge: section.includes("本次实验快照"),
      collapsedFields: ["用例 ID", "权重", "评分维度", "最大对话轮数"]
        .every(label => section.includes(label)),
      collapsedByDefault: !section.includes('id="caseSnapshot" open'),
      openWhenStateSet: openSection.includes('id="caseSnapshot" open'),
      singleCaseHasSelector: singleSection.includes("case-selector"),
      singleCaseHasSnapshot: singleSection.includes('id="caseSnapshot"')
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["selectorChips"] == 2
    assert result["activeChip"] is True
    assert result["snapshotPresent"] is True
    assert result["snapshotBadge"] is True
    assert result["collapsedFields"] is True
    assert result["collapsedByDefault"] is True
    assert result["openWhenStateSet"] is True
    assert result["singleCaseHasSelector"] is False  # 单 case 不显示选择器
    assert result["singleCaseHasSnapshot"] is True


def test_case_snapshot_expanded_shows_full_snapshot_with_scrollable_text(tmp_path: Path):
    case_spec = _case("case-a", "用例甲", "甲维度")
    case_spec["agent_context"] = "Agent 可见补充上下文"
    case_spec["followups"] = [{"when_output_contains": "继续", "reply": "第二轮流回复"}]
    case_spec["graders"].append(
        {
            "id": "cmd",
            "type": "command",
            "name": "命令校验",
            "weight": 10,
            "hard_gate": False,
            "command": "uv run pytest -q",
            "patterns": [],
            "timeout_seconds": 120,
        }
    )
    case_spec["graders"].append(
        {
            "id": "forbidden",
            "type": "forbidden_changes",
            "name": "禁改检查",
            "weight": 0,
            "hard_gate": True,
            "patterns": ["src/core/**"],
            "timeout_seconds": 60,
        }
    )
    scenario = f"""
    const item = {_js(_experiment([case_spec], []))};
    state.detailCaseFor = item.id; state.detailCaseId = "case-a"; state.caseSnapshotOpen = true;
    const section = caseSectionMarkup(item);
    console.log(JSON.stringify({{
      agentInput: section.includes("Agent 输入"),
      expected: section.includes("预期效果"),
      agentContext: section.includes("Agent context"),
      followup: section.includes("触发条件") && section.includes("继续")
        && section.includes("回复"),
      maxTurns: section.includes("最大轮数"),
      graderCommand: section.includes("uv run pytest -q"),
      graderPath: section.includes("result.md"),
      graderPatterns: section.includes("src/core/**"),
      graderRubric: section.includes("rubric"),
      graderTimeout: section.includes("300s") && section.includes("120s"),
      hardGateMarked: section.includes("硬门禁（必须通过）"),
      scrollableTexts: (section.match(/class="snapshot-text"/g) || []).length
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["agentInput"] is True
    assert result["expected"] is True
    assert result["agentContext"] is True
    assert result["followup"] is True
    assert result["maxTurns"] is True
    assert result["graderCommand"] is True
    assert result["graderPath"] is True
    assert result["graderPatterns"] is True
    assert result["graderRubric"] is True
    assert result["graderTimeout"] is True
    assert result["hardGateMarked"] is True
    assert result["scrollableTexts"] >= 3  # input/expected/context/followup 均为内部滚动文本


def test_case_snapshot_marks_missing_snapshot_for_legacy_experiments(tmp_path: Path):
    scenario = f"""
    const item = {_js(_experiment([_case("case-a", "用例甲", "甲维度")], []))};
    item.suite_snapshot = {{}};  // 旧版实验缺少固化快照
    state.detailCaseFor = item.id; state.detailCaseId = "case-a"; state.caseSnapshotOpen = true;
    const section = caseSectionMarkup(item);
    console.log(JSON.stringify({{missing: section.includes("缺少固化的套件快照")}}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["missing"] is True


# ------------------------------------------------- 紧凑结论带（方案一.2 / 方案二）


def test_conclusion_band_is_compact_and_states_each_fact_once(tmp_path: Path):
    runs = [_run("case-a", "no_skill", 55), _run("case-a", "current", 88)]
    scenario = f"""
    const item = {_js(_experiment([_case("case-a", "用例甲", "甲维度")], runs))};
    const markup = conclusionMarkup(item);
    console.log(JSON.stringify({{
      band: markup.includes("conclusion-band"),
      groupChips: (markup.match(/class="group-chip/g) || []).length,
      deltas: markup.includes("当前 vs 无 Skill") && markup.includes("当前 vs 基准"),
      verdict: markup.includes("verdict-badge"),
      gatesInChip: markup.includes("门禁 1/1"),
      currentScoreCount: (markup.match(/88\\.0/g) || []).length,
      legacyCardsGone: !markup.includes("detail-score")
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["band"] is True
    assert result["groupChips"] == 3  # no_skill / baseline / current 各一个紧凑 chip
    assert result["deltas"] is True
    assert result["verdict"] is True
    assert result["gatesInChip"] is True
    assert result["currentScoreCount"] == 1  # 每项实验级信息只出现一次
    assert result["legacyCardsGone"] is True


# ------------------------------------------------- 静态结构断言（含诊断日志默认收起）


def test_detail_page_static_structure_markers():
    app = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    index = (STATIC_DIR / "index.html").read_text(encoding="utf-8")

    # 方案一.1 紧凑标题栏：状态/模式/Runner·Judge·模型 + 次要信息一行 + 重试/取消保留
    assert "detail-titlebar" in app
    assert "titlebar-mode" in app and "titlebar-models" in app
    assert "titlebar-meta" in app
    assert "重试实验" in app and "cancelExperimentButton" in app

    # 方案一.8 诊断日志默认收起：diagnosticSection 不再随运行状态默认展开
    assert 'id="diagnosticSection"><summary' in app
    assert 'id="diagnosticSection"${' not in app

    # 方案二 轮询时保留选中 case 与展开状态（详情页状态模型）
    assert "state.detailCaseId" in app and "state.caseSnapshotOpen" in app
    assert "state.lastCaseSection" in app
    assert "detailCaseFor" in app  # 切换实验才重置视图状态

    # 方案一.3 Case 选择器 + 单 case 呈现
    assert "case-selector" in app and "data-case-select" in app
    assert "defaultCaseId" in app and "selectedCase" in app

    # 方案一.4 用例查看区：默认收起 + 本次实验快照
    assert "case-snapshot" in app and "本次实验快照" in app
    assert "查看用例定义" in app and "收起" in app

    # 资源带版本参数，浏览器不会继续使用旧缓存
    assert 'app.js?v=' in index and 'styles.css?v=' in index
