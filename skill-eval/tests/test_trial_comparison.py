"""Trial 联动展开（用户方案四）与运行状态（方案一.6-7）测试。

与 test_detail_page_structure 同一方式：在 Node 中以 DOM 桩加载真实 app.js，
直接调用 comparisonMarkup / activeRunsStripMarkup 等函数，
对“每个维度单一入口、按 Trial 对齐、组并排、占位、非完成 Run 语义、
展开状态在重渲染间保留、活动 Run 状态条”做行为断言。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from test_detail_page_structure import (
    _case,
    _js,
    _node_available,
    _run_scenario,
)
from test_radar_view import _gate_grader

pytestmark = pytest.mark.skipif(not _node_available(), reason="node is required to load app.js")


def _axis_case(axes: int = 2) -> dict:
    case = _case("case-a", "用例甲", "占位")
    case["graders"] = [
        {
            "id": f"axis-{index + 1}",
            "type": "llm_rubric",
            "name": f"数值维度{'一二三'[index]}",
            "weight": 10,
            "hard_gate": False,
            "rubric": "rubric",
            "timeout_seconds": 300,
        }
        for index in range(axes)
    ] + [_gate_grader()]
    return case


def _trial_run(case_id: str, group: str, trial: int, score, *, status: str = "completed",
               quality=None, gates=(1, 1), artifact=True, error=None, attempt: int = 1) -> dict:
    run = {
        "id": f"run-{case_id}-{group}-{trial}",
        "case_id": case_id,
        "group": group,
        "trial": trial,
        "status": status,
        "quality_score": quality if quality is not None and status == "completed" else None,
        "hard_gates": {"passed": gates[0], "total": gates[1]},
        "reviews": [],
        "current_attempt": attempt,
        "artifact_available": artifact,
        "error_kind": error,
        "error_message": f"{error} message" if error else None,
        "current_stage": (
            "runner" if status == "running" else ("queued" if status == "queued" else "completed")
        ),
        "started_at": "2026-09-30T08:00:00Z" if status != "queued" else None,
        "activity_age_seconds": 12,
        "heartbeat_age_seconds": 5,
        "stalled": False,
    }
    if status == "completed" or error == "infra_error":
        run["scores"] = {"components": [
            {"grader_id": "axis-1", "score": score, "hard_gate": False,
             "reasoning": f"reasoning {group} t{trial}", "evidence": f"evidence {group} t{trial}",
             "passed": True},
            {"grader_id": "axis-2", "score": score, "hard_gate": False, "passed": True},
            {"grader_id": "gate-1", "score": 100 if gates[0] else 0,
             "hard_gate": True, "passed": bool(gates[0])},
        ]}
    return run


def _experiment_with(cases: list[dict], runs: list[dict], *, trials: int = 1) -> dict:
    from test_detail_page_structure import _experiment

    item = _experiment(cases, [])
    item["trials"] = trials
    item["runs"] = runs
    return item


_PRELUDE = """
state.detailCaseFor = "exp-1"; state.detailCaseId = "case-a"; state.caseSnapshotOpen = false;
state.expandedDimensions.clear();
"""


def test_single_entry_per_dimension_and_no_cell_details(tmp_path: Path):
    case = _axis_case()
    runs = [
        _trial_run("case-a", "no_skill", 1, 60, quality=60),
        _trial_run("case-a", "current", 1, 80, quality=80),
    ]
    scenario = f"""
    {_PRELUDE}
    const item = {_js(_experiment_with([case], runs))};
    const markup = comparisonMarkup(item);
    console.log(JSON.stringify({{
      hasCellDetails: markup.includes("cell-trials"),
      dimensionEntries: (markup.match(/data-dimension-open="/g) || []).length,
      legacyTableRowRemoved: !markup.includes("data-grader-row"),
      expandLabel: markup.includes("展开该维度的 Trial 对照"),
      collapsedByDefault: !markup.includes("trial-comparison-grid")
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["hasCellDetails"] is False  # 删除每个分组单元格的独立 details
    assert result["dimensionEntries"] == 3  # 明细列表中每个评分维度恰好一个入口（2 轴 + 门禁）
    assert result["legacyTableRowRemoved"] is True  # 原明细表已并入列表
    assert result["expandLabel"] is True
    assert result["collapsedByDefault"] is True


def test_trial_comparison_aligns_groups_by_trial(tmp_path: Path):
    case = _axis_case()
    runs = [
        _trial_run("case-a", "no_skill", 1, 60, quality=60),
        _trial_run("case-a", "no_skill", 2, 70, quality=70),
        _trial_run("case-a", "current", 1, 80, quality=80),
        _trial_run("case-a", "current", 2, 90, quality=90),
    ]
    scenario = f"""
    {_PRELUDE}
    const item = {_js(_experiment_with([case], runs, trials=2))};
    state.expandedDimensions.add("axis-1");
    const markup = comparisonMarkup(item);
    const block = markup.slice(markup.indexOf('data-trial-comparison="axis-1"'));
    const row1 = block.slice(
      block.indexOf("trial-comparison-grid trial-comparison-head"), block.indexOf("Trial 2"));
    const row2 = block.slice(block.indexOf("Trial 2"));
    console.log(JSON.stringify({{
      hasTrial1: block.includes("Trial 1"), hasTrial2: block.includes("Trial 2"),
      row1Order: ["无 Skill", "当前候选"].every(label => row1.includes(label)),
      row1NoSkillFirst: row1.indexOf("run-case-a-no_skill-1") > -1
        && row1.indexOf("run-case-a-no_skill-1") < row1.indexOf("run-case-a-current-1"),
      row2Aligned: row2.includes("run-case-a-no_skill-2") && row2.includes("run-case-a-current-2"),
      scoresShown: block.includes("60.0") && block.includes("70.0")
        && block.includes("80.0") && block.includes("90.0"),
      reasoning: block.includes("reasoning no_skill t1") && block.includes("reasoning current t1"),
      evidence: block.includes("evidence no_skill t1"),
      judgeLogs: (block.match(/data-judge-log="run-case-a-(no_skill|current)-\\d"/g) || []).length,
      headGroups: (block.slice(0, block.indexOf("Trial 1")).match(/trial-group-label">/g)
        || []).length
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["hasTrial1"] and result["hasTrial2"]
    assert result["row1Order"] is True
    assert result["row1NoSkillFirst"] is True  # 组列顺序 no_skill → current
    assert result["row2Aligned"] is True  # 按 trial_index 对齐
    assert result["scoresShown"] is True
    assert result["reasoning"] is True and result["evidence"] is True
    assert result["judgeLogs"] == 4  # 每组每 Trial 一个 Judge 对话入口
    assert result["headGroups"] == 2


def test_placeholders_for_missing_queued_running_failed_sides(tmp_path: Path):
    case = _axis_case()
    runs = [
        _trial_run("case-a", "no_skill", 1, 60, quality=60),
        _trial_run("case-a", "no_skill", 2, 70, quality=70),
        _trial_run("case-a", "current", 1, 80, quality=80, status="running"),
        # current 的 trial 2 完全没有 run 记录 → 缺失占位
        _trial_run("case-a", "baseline", 1, 65, quality=65, status="queued", artifact=False),
        _trial_run("case-a", "baseline", 2, 0,
                   quality=None, status="infra_error", error="infra_error"),
    ]
    scenario = f"""
    {_PRELUDE}
    const item = {_js(_experiment_with([case], runs, trials=2))};
    state.expandedDimensions.add("axis-1");
    const markup = comparisonMarkup(item);
    const block = markup.slice(markup.indexOf('data-trial-comparison="axis-1"'));
    console.log(JSON.stringify({{
      missing: block.includes("缺失（该组没有此 Trial 的 run 记录）"),
      queued: block.includes("排队中"),
      running: block.includes("运行中 · 暂无评分"),
      failedVisible: block.includes("infra_error message"),
      failedNotScored: block.includes("未评分"),
      columns: block.slice(0, block.indexOf("Trial 1")).match(/trial-group-label">[^<]+/g)
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["missing"] is True
    assert result["queued"] is True
    assert result["running"] is True
    assert result["failedVisible"] is True  # 非完成 Run 可查看状态和错误
    assert result["failedNotScored"] is True
    assert [entry.split(">")[1] for entry in result["columns"]] == [
        "无 Skill", "上一基准", "当前候选"]


def test_expansion_persists_across_rerender_and_toggles_all_groups(tmp_path: Path):
    case = _axis_case()
    runs = [
        _trial_run("case-a", "no_skill", 1, 60, quality=60),
        _trial_run("case-a", "current", 1, 80, quality=80),
    ]
    scenario = f"""
    {_PRELUDE}
    const item = {_js(_experiment_with([case], runs))};
    state.expandedDimensions.add("axis-1");
    const first = comparisonMarkup(item);
    const expandedOnce = first.includes('data-trial-comparison="axis-1"');
    // 模拟轮询刷新：同一 state 再次渲染，展开不关闭（方案四）
    const second = comparisonMarkup(item);
    const stillExpanded = second.includes('data-trial-comparison="axis-1"');
    const bothGroupsAtOnce = (second.slice(
      second.indexOf('data-trial-comparison="axis-1"')
    ).match(/run-case-a-(no_skill|current)-1"/g) || []).length >= 2;
    state.expandedDimensions.delete("axis-1");
    const collapsed = comparisonMarkup(item);
    console.log(JSON.stringify({{
      expandedOnce, stillExpanded, bothGroupsAtOnce,
      collapsed: !collapsed.includes("trial-comparison-grid")}}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["expandedOnce"] is True
    assert result["stillExpanded"] is True  # 轮询更新时不关闭已展开的对照区
    assert result["bothGroupsAtOnce"] is True  # 一次展开即同时呈现所有参与组
    assert result["collapsed"] is True


def test_non_completed_runs_do_not_count_toward_means(tmp_path: Path):
    case = _axis_case()
    runs = [
        _trial_run("case-a", "no_skill", 1, 60, quality=60),
        _trial_run("case-a", "current", 1, 80, quality=80),
        # 未完成 run 带有干扰分数，不应影响均值
        _trial_run("case-a", "current", 2, 5,
                   quality=None, status="infra_error", error="infra_error"),
    ]
    scenario = f"""
    {_PRELUDE}
    const item = {_js(_experiment_with([case], runs, trials=2))};
    const stats = graderScoreStats(item.suite_snapshot.cases[0].graders[0],
      item.runs.filter(run => run.group === "current"));
    console.log(JSON.stringify({{mean: stats.mean, count: stats.count}}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["count"] == 1  # 只有完成 Run 参与均分
    assert abs(result["mean"] - 80.0) < 1e-6  # 干扰分数 5 不影响


def test_baseline_adds_third_aligned_column(tmp_path: Path):
    case = _axis_case()
    runs = [
        _trial_run("case-a", "no_skill", 1, 60, quality=60),
        _trial_run("case-a", "baseline", 1, 65, quality=65),
        _trial_run("case-a", "current", 1, 80, quality=80),
    ]
    scenario = f"""
    {_PRELUDE}
    const item = {_js(_experiment_with([case], runs))};
    state.expandedDimensions.add("axis-1");
    const block = comparisonMarkup(item).slice(
      comparisonMarkup(item).indexOf('data-trial-comparison="axis-1"'));
    console.log(JSON.stringify({{
      groups: block.slice(0, block.indexOf("Trial 1"))
        .match(/trial-group-label">[^<]+/g).map(entry => entry.split(">")[1]),
      allThreeRuns: ["run-case-a-no_skill-1", "run-case-a-baseline-1", "run-case-a-current-1"]
        .every(id => block.includes(id)),
      order: block.indexOf("run-case-a-no_skill-1") < block.indexOf("run-case-a-baseline-1")
        && block.indexOf("run-case-a-baseline-1") < block.indexOf("run-case-a-current-1")
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["groups"] == ["无 Skill", "上一基准", "当前候选"]  # baseline 第三列
    assert result["allThreeRuns"] is True
    assert result["order"] is True


def test_active_runs_strip_shows_both_parallel_runs(tmp_path: Path):
    case = _axis_case()
    running = [
        {**_trial_run("case-a", "no_skill", 1, None, status="running", artifact=False),
         "id": "run-live-1", "current_stage": "runner", "stalled": False},
        {**_trial_run("case-a", "current", 1, None, status="running", artifact=True),
         "id": "run-live-2", "current_stage": "judge", "stalled": True,
         "activity_age_seconds": 240},
    ]
    scenario = f"""
    const item = {_js(_experiment_with([case], running))};
    const strip = activeRunsStripMarkup(item);
    const idle = activeRunsStripMarkup({_js(_experiment_with(
      [case], [_trial_run("case-a", "current", 1, 80, quality=80)]))});
    console.log(JSON.stringify({{
      cards: (strip.match(/data-active-run="/g) || []).length,
      groups: ["无 Skill", "当前候选"].every(label => strip.includes(label)),
      stages: strip.includes("Runner 执行") && strip.includes("Judge 评分"),
      elapsed: strip.includes("已运行"),
      lastActivity: strip.includes("最后有效活动"),
      stalledMarked: strip.includes("活动停滞"),
      cancelEntries: (strip.match(/data-cancel-run="run-live-\\d"/g) || []).length,
      acpEntry: strip.includes('data-conversation="run-live-2"'),
      logEntries: (strip.match(/data-log="run-live-\\d"/g) || []).length,
      noConversationUntilStarted: strip.includes("对话将在运行开始后可用"),
      idleEmpty: idle === ""
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["cards"] == 2  # 同时展示两个活动 Run
    assert result["groups"] is True
    assert result["stages"] is True
    assert result["elapsed"] is True
    assert result["lastActivity"] is True
    assert result["stalledMarked"] is True
    assert result["cancelEntries"] == 2
    assert result["acpEntry"] is True
    assert result["logEntries"] == 2
    assert result["noConversationUntilStarted"] is True
    assert result["idleEmpty"] is True  # 无活动 Run 时不显示


def test_dimension_row_click_expands_trial_comparison_in_place(tmp_path: Path):
    """明细列表维度行点击：原地展开/收起该维度的 Trial 对照（合并视图，无视图切换）。"""
    case = _axis_case(axes=3)
    runs = [
        _trial_run("case-a", "no_skill", 1, 60, quality=60),
        _trial_run("case-a", "current", 1, 80, quality=80),
    ]
    scenario = f"""
    {_PRELUDE}
    const item = {_js(_experiment_with([case], runs))};
    const before = comparisonMarkup(item);
    const hasEntry = before.includes('data-dimension-open="axis-1"');
    // 点击维度后的状态操作（与 bindDetailActions 的处理器一致）
    state.expandedDimensions.add("axis-1");
    const after = comparisonMarkup(item);
    state.expandedDimensions.delete("axis-1");
    const collapsed = comparisonMarkup(item);
    console.log(JSON.stringify({{
      hasEntry,
      noViewSwitch: after.includes("radar-svg"),
      dimensionExpanded: after.includes('data-trial-comparison="axis-1"'),
      collapsedAgain: !collapsed.includes('data-trial-comparison="axis-1"')
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["hasEntry"] is True
    assert result["noViewSwitch"] is True  # 合并视图：展开不再切换视图
    assert result["dimensionExpanded"] is True
    assert result["collapsedAgain"] is True
