"""雷达图方案测试（用户方案三）与结果对照区视图切换（方案一.5）。

与 test_detail_page_structure 同一方式：在 Node 中以 DOM 桩加载真实 app.js，
直接调用 caseComparisonData / comparisonMarkup / comparisonViewMode 等函数，
对雷达与明细表共用同一数据源、数值一致性（验收误差 ≤ 0.1）、
少于三个数值维度自动切换、视图模式记忆、无 baseline 图例等做行为断言。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from test_detail_page_structure import (
    HARNESS_PREAMBLE,
    STATIC_DIR,
    _case,
    _js,
    _node_available,
    _run_scenario,
)

pytestmark = pytest.mark.skipif(not _node_available(), reason="node is required to load app.js")


def _axis_graders(count: int) -> list[dict]:
    return [
        {
            "id": f"axis-{index + 1}",
            "type": "llm_rubric",
            "name": f"数值维度 {index + 1}",
            "weight": 10,
            "hard_gate": False,
            "rubric": "rubric",
            "timeout_seconds": 300,
        }
        for index in range(count)
    ]


def _gate_grader() -> dict:
    return {
        "id": "gate-1",
        "type": "command",
        "name": "硬门禁校验",
        "weight": 0,
        "hard_gate": True,
        "command": "uv run pytest -q",
        "patterns": [],
        "timeout_seconds": 300,
    }


def _radar_case(axes: int) -> dict:
    case = _case("case-a", "用例甲", "占位")
    case["graders"] = _axis_graders(axes) + [_gate_grader()]
    return case


def _scored_run(case_id: str, group: str, trial: int, scores: dict[str, float],
                *, quality: float, status: str = "completed", gates=(1, 1)) -> dict:
    return {
        "id": f"run-{case_id}-{group}-{trial}",
        "case_id": case_id,
        "group": group,
        "trial": trial,
        "status": status,
        "quality_score": quality if status == "completed" else None,
        "hard_gates": {"passed": gates[0], "total": gates[1]},
        "reviews": [],
        "scores": {
            "components": [
                {"grader_id": grader_id, "score": score, "hard_gate": False}
                for grader_id, score in scores.items()
            ]
        },
    }


def _experiment_with(case: dict, runs: list[dict], *, trials: int = 1) -> dict:
    from test_detail_page_structure import _experiment

    item = _experiment([case], [])
    item["trials"] = trials
    item["runs"] = runs
    return item


_PRELUDE = """
state.detailCaseFor = "exp-1"; state.detailCaseId = "case-a"; state.caseSnapshotOpen = false;
"""


def test_radar_axes_exclude_hard_gate_graders(tmp_path: Path):
    case = _radar_case(3)
    runs = [
        _scored_run("case-a", "no_skill", 1, {"axis-1": 60, "axis-2": 70, "axis-3": 80}, quality=70),
        _scored_run("case-a", "current", 1, {"axis-1": 75, "axis-2": 85, "axis-3": 95}, quality=85),
    ]
    scenario = f"""
    {_PRELUDE}
    const item = {_js(_experiment_with(case, runs))};
    const markup = comparisonMarkup(item);
    console.log(JSON.stringify({{
      mode: markup.includes("radar-svg") ? "radar" : "table",
      axisLines: (markup.match(/class="radar-axis-line"/g) || []).length,
      dimensionEntries: (markup.match(/data-dimension-open=/g) || []).length,
      gateInDimensions: markup.includes('data-dimension-open="gate-1"'),
      gateStripPresent: markup.includes("radar-gates")
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["mode"] == "radar"  # 首次进入默认雷达图
    assert result["axisLines"] == 3  # 坐标轴只含 hard_gate=false 的 grader
    assert result["dimensionEntries"] == 3
    assert result["gateInDimensions"] is False
    assert result["gateStripPresent"] is True  # 硬门禁在图表上方状态条


def test_radar_point_values_are_completed_trial_means(tmp_path: Path):
    case = _radar_case(3)
    runs = [
        _scored_run("case-a", "no_skill", 1, {"axis-1": 60, "axis-2": 70, "axis-3": 80}, quality=70),
        _scored_run("case-a", "no_skill", 2, {"axis-1": 80, "axis-2": 60, "axis-3": 90}, quality=76.67),
        # 未完成的 trial 不参与均分
        _scored_run("case-a", "no_skill", 3, {"axis-1": 10, "axis-2": 10, "axis-3": 10}, quality=None, status="infra_error"),
        _scored_run("case-a", "current", 1, {"axis-1": 75, "axis-2": 85, "axis-3": 95}, quality=85),
    ]
    scenario = f"""
    {_PRELUDE}
    const item = {_js(_experiment_with(case, runs, trials=3))};
    const markup = comparisonMarkup(item);
    const points = [...markup.matchAll(/data-group="(no_skill|current)" data-axis="(axis-\\d)" data-value="([0-9.]+)"/g)]
      .map(match => ({{group: match[1], axis: match[2], value: Number(match[3])}}));
    const lookup = Object.fromEntries(points.map(p => [p.group + ":" + p.axis, p.value]));
    console.log(JSON.stringify({{lookup, pointCount: points.length}}));
    """
    result = _run_scenario(tmp_path, scenario)
    lookup = result["lookup"]
    assert result["pointCount"] == 6
    # no_skill 取已完成 trial 均值：axis-1 = (60+80)/2
    assert abs(lookup["no_skill:axis-1"] - 70.0) < 1e-6
    assert abs(lookup["no_skill:axis-2"] - 65.0) < 1e-6
    assert abs(lookup["no_skill:axis-3"] - 85.0) < 1e-6
    assert abs(lookup["current:axis-1"] - 75.0) < 1e-6


def test_radar_and_table_values_are_consistent(tmp_path: Path):
    """验收：雷达与明细表数据一致误差 ≤ 0.1（同一数据源渲染两种视图）。"""
    case = _radar_case(3)
    runs = [
        _scored_run("case-a", "no_skill", 1, {"axis-1": 60, "axis-2": 70, "axis-3": 80}, quality=70),
        _scored_run("case-a", "no_skill", 2, {"axis-1": 80, "axis-2": 60, "axis-3": 90}, quality=76.67),
        _scored_run("case-a", "current", 1, {"axis-1": 75, "axis-2": 85, "axis-3": 95}, quality=85),
    ]
    item = _js(_experiment_with(case, runs, trials=2))
    scenario = f"""
    {_PRELUDE}
    const item = {item};
    state.detailViewMode = "radar";
    const radar = comparisonMarkup(item);
    state.detailViewMode = "table";
    const table = comparisonMarkup(item);
    const radarValues = Object.fromEntries([...radar.matchAll(/data-group="(no_skill|current)" data-axis="(axis-\\d)" data-value="([0-9.]+)"/g)]
      .map(match => [match[1] + ":" + match[2], Number(match[3])]));
    // 明细表按组顺序渲染单元格（GROUP_ORDER: no_skill, baseline, current），
    // 每行提取全部 cell-value（如 "70.0（均值 2 trial）"）后按列对位
    const tableValues = {{}};
    const rowRe = /data-grader-row="(axis-\\d)"([\\s\\S]*?)(?=data-grader-row=|<\\/tbody>)/g;
    let rowMatch;
    while ((rowMatch = rowRe.exec(table))) {{
      const values = [...rowMatch[2].matchAll(/cell-value">([0-9.]+)/g)].map(m => Number(m[1]));
      ["no_skill", "current"].forEach((group, index) => {{
        if (values[index] != null) tableValues[group + ":" + rowMatch[1]] = values[index];
      }});
    }}
    console.log(JSON.stringify({{radarValues, tableValues}}));
    """
    result = _run_scenario(tmp_path, scenario)
    radar_values = result["radarValues"]
    table_values = result["tableValues"]
    assert set(radar_values) == set(table_values)
    for key, radar_value in radar_values.items():
        assert abs(radar_value - table_values[key]) <= 0.1, (key, radar_value, table_values[key])


def test_fewer_than_three_axes_forces_table_view(tmp_path: Path):
    case = _radar_case(2)
    runs = [
        _scored_run("case-a", "no_skill", 1, {"axis-1": 60, "axis-2": 70}, quality=65),
        _scored_run("case-a", "current", 1, {"axis-1": 75, "axis-2": 85}, quality=80),
    ]
    scenario = f"""
    {_PRELUDE}
    state.detailViewMode = "radar";  // 用户偏好雷达，但维度不足
    const item = {_js(_experiment_with(case, runs))};
    const markup = comparisonMarkup(item);
    console.log(JSON.stringify({{
      showsRadar: markup.includes("radar-svg"),
      showsTable: markup.includes("comparison-table"),
      notice: markup.includes("数值维度少于 3 个"),
      radarDisabled: markup.includes('data-view-mode="radar"') && markup.includes("disabled")
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["showsRadar"] is False
    assert result["showsTable"] is True
    assert result["notice"] is True
    assert result["radarDisabled"] is True


def test_no_valid_scores_forces_table_view(tmp_path: Path):
    """R1P2：所有参与组均无有效评分（如全部 run 超时）时不渲染空雷达网格。"""
    case = _radar_case(5)

    def timed_out(group: str) -> dict:
        # 超时 run：无 components，仅创建时的 execution_order 占位 score_json
        return {
            "id": f"run-case-a-{group}-1",
            "case_id": "case-a",
            "group": group,
            "trial": 1,
            "status": "timeout",
            "quality_score": None,
            "hard_gates": {"passed": 0, "total": 0},
            "reviews": [],
            "scores": {"execution_order": 1},
        }

    scenario = f"""
    {_PRELUDE}
    state.detailViewMode = "radar";  // 全局偏好雷达
    const item = {_js(_experiment_with(case, [timed_out("no_skill"), timed_out("current")]))};
    const markup = comparisonMarkup(item);
    const data = caseComparisonData(item, item.suite_snapshot.cases[0], runsByCaseAndGroup(item).get("case-a") || {{}});
    console.log(JSON.stringify({{
      showsRadar: markup.includes("radar-svg"),
      showsTable: markup.includes("comparison-table"),
      notice: markup.includes("暂无有效评分结果"),
      radarDisabled: markup.includes('data-view-mode="radar"') && markup.includes("disabled"),
      axisCount: data.axes.length,
      anyValue: data.series.some(entry => entry.hasAnyValue),
      unscoredCells: (markup.match(/未评分/g) || []).length
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["axisCount"] == 5  # 轴定义存在（来自套件快照）
    assert result["anyValue"] is False  # 但没有任何有效分数
    assert result["showsRadar"] is False  # 不再渲染空雷达网格
    assert result["showsTable"] is True
    assert result["notice"] is True
    assert result["radarDisabled"] is True
    assert result["unscoredCells"] >= 2  # 表格以“未评分”占位说明情况


def test_partial_scores_still_allow_radar(tmp_path: Path):
    """部分组有有效分数时雷达仍可用（只画有结果的组，另一组标注未绘制）。"""
    case = _radar_case(3)
    runs = [
        _scored_run("case-a", "no_skill", 1, {"axis-1": 60, "axis-2": 70, "axis-3": 80}, quality=70),
        {**_scored_run("case-a", "current", 1, {"axis-1": 0, "axis-2": 0, "axis-3": 0}, quality=None, status="timeout"),
         "scores": {"execution_order": 1}},
    ]
    scenario = f"""
    {_PRELUDE}
    state.detailViewMode = "radar";
    const item = {_js(_experiment_with(case, runs))};
    const markup = comparisonMarkup(item);
    console.log(JSON.stringify({{
      showsRadar: markup.includes("radar-svg"),
      radarEnabled: !markup.includes('data-view-mode="radar"') || !markup.includes("disabled"),
      noNotice: !markup.includes("已自动显示明细表"),
      emptyNote: markup.includes("未绘制曲线")
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["showsRadar"] is True
    assert result["radarEnabled"] is True
    assert result["noNotice"] is True
    assert result["emptyNote"] is True


def test_radar_focus_listeners_use_capture_phase():
    """R1P1：键盘聚焦走捕获态 focus/blur（Chromium 对 SVG focus 不派发 focusin）。"""
    app = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    assert 'addEventListener("focus"' in app
    assert 'addEventListener("blur"' in app
    assert "}, true)" in app  # 捕获态监听（第三个参数 true）
    assert 'addEventListener("focusin"' not in app  # 已被捕获态 focus/blur 替代


def test_view_mode_defaults_to_radar_and_is_remembered(tmp_path: Path):
    scenario = f"""
    const store = {{}};
    globalThis.localStorage = {{
      getItem: key => store[key] ?? null,
      setItem: (key, value) => {{ store[key] = String(value); }},
      removeItem: key => {{ delete store[key]; }}
    }};
    state.detailViewMode = null;
    const firstEntry = comparisonViewMode();
    setComparisonViewMode("table");
    const afterToggle = comparisonViewMode();
    state.detailViewMode = null;  // 模拟下次进入页面：从 localStorage 恢复
    const nextVisit = comparisonViewMode();
    console.log(JSON.stringify({{firstEntry, afterToggle, nextVisit, stored: store["aaw-skill-eval.comparison-view.v1"]}}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["firstEntry"] == "radar"  # 首次进入默认雷达图
    assert result["afterToggle"] == "table"
    assert result["nextVisit"] == "table"  # 之后记住用户选择
    assert result["stored"] == "table"


def test_radar_legend_without_baseline_and_negative_delta(tmp_path: Path):
    case = _radar_case(3)
    runs = [
        _scored_run("case-a", "no_skill", 1, {"axis-1": 70, "axis-2": 70, "axis-3": 70}, quality=70),
        _scored_run("case-a", "current", 1, {"axis-1": 55, "axis-2": 60, "axis-3": 50}, quality=55),
    ]
    scenario = f"""
    {_PRELUDE}
    state.detailViewMode = "radar";
    const item = {_js(_experiment_with(case, runs))};
    const markup = comparisonMarkup(item);
    const legend = markup.slice(markup.indexOf("radar-legend"));
    const currentScore = Number((legend.match(/当前候选<\\/span><strong>([0-9.]+)/) || [])[1]);
    const noSkillScore = Number((legend.match(/无 Skill<\\/span><strong>([0-9.]+)/) || [])[1]);
    console.log(JSON.stringify({{
      hasBaselineLegend: markup.includes("上一基准"),
      legendGroups: (legend.match(/legend-group">/g) || []).length,
      currentScore, noSkillScore,
      negativeDelta: currentScore < noSkillScore
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["hasBaselineLegend"] is False  # 无 baseline 不显示空图例
    assert result["legendGroups"] == 2
    assert result["currentScore"] == 55.0 and result["noSkillScore"] == 70.0
    assert result["negativeDelta"] is True  # 负差值场景：雷达如实呈现低分曲线


def test_provisional_marker_when_trials_incomplete(tmp_path: Path):
    case = _radar_case(3)
    runs = [
        _scored_run("case-a", "no_skill", 1, {"axis-1": 60, "axis-2": 70, "axis-3": 80}, quality=70),
        _scored_run("case-a", "current", 1, {"axis-1": 75, "axis-2": 85, "axis-3": 95}, quality=85),
    ]
    scenario = f"""
    {_PRELUDE}
    state.detailViewMode = "radar";
    const item = {_js(_experiment_with(case, runs, trials=3))};  // 期望 3 trial，仅完成 1
    const markup = comparisonMarkup(item);
    console.log(JSON.stringify({{
      provisionalMarked: (markup.match(/临时结果/g) || []).length,
      trialCount: markup.includes("1/1 trial") || markup.includes("1/3 trial")
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["provisionalMarked"] >= 2  # 两组均标“临时结果”
    assert result["trialCount"] is True


def test_gates_strip_sits_above_chart_and_marks_failure(tmp_path: Path):
    case = _radar_case(3)
    runs = [
        _scored_run("case-a", "no_skill", 1, {"axis-1": 60, "axis-2": 70, "axis-3": 80}, quality=70),
        _scored_run("case-a", "current", 1, {"axis-1": 75, "axis-2": 85, "axis-3": 95}, quality=85, gates=(0, 1)),
    ]
    scenario = f"""
    {_PRELUDE}
    state.detailViewMode = "radar";
    const item = {_js(_experiment_with(case, runs))};
    const markup = comparisonMarkup(item);
    console.log(JSON.stringify({{
      gatesBeforeChart: markup.indexOf("radar-gates") > -1 && markup.indexOf("radar-gates") < markup.indexOf("radar-svg"),
      failedMarked: markup.includes("门禁 0/1 · 未通过"),
      passedMarked: markup.includes("门禁 1/1 · 通过")
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["gatesBeforeChart"] is True
    assert result["failedMarked"] is True
    assert result["passedMarked"] is True


def test_group_without_valid_results_is_not_drawn(tmp_path: Path):
    case = _radar_case(3)
    runs = [
        _scored_run("case-a", "no_skill", 1, {"axis-1": 60, "axis-2": 70, "axis-3": 80}, quality=70),
        _scored_run("case-a", "current", 1, {"axis-1": 0, "axis-2": 0, "axis-3": 0}, quality=None, status="timeout"),
    ]
    scenario = f"""
    {_PRELUDE}
    state.detailViewMode = "radar";
    const item = {_js(_experiment_with(case, runs))};
    const markup = comparisonMarkup(item);
    console.log(JSON.stringify({{
      currentDrawn: markup.includes('data-group="current"'),
      noSkillDrawn: markup.includes('data-group="no_skill"'),
      emptyNote: markup.includes("当前候选") && markup.includes("未绘制曲线")
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["currentDrawn"] is False  # 无有效结果的组不绘制曲线
    assert result["noSkillDrawn"] is True
    assert result["emptyNote"] is True


def test_dimension_list_links_and_table_row_targets(tmp_path: Path):
    case = _radar_case(3)
    runs = [
        _scored_run("case-a", "no_skill", 1, {"axis-1": 60, "axis-2": 70, "axis-3": 80}, quality=70),
        _scored_run("case-a", "current", 1, {"axis-1": 75, "axis-2": 85, "axis-3": 95}, quality=85),
    ]
    scenario = f"""
    {_PRELUDE}
    const item = {_js(_experiment_with(case, runs))};
    state.detailViewMode = "radar";
    const radar = comparisonMarkup(item);
    state.detailViewMode = "table";
    const table = comparisonMarkup(item);
    console.log(JSON.stringify({{
      dimensionOpens: [...radar.matchAll(/data-dimension-open="(axis-\\d)"/g)].map(m => m[1]),
      tableRowTargets: [...table.matchAll(/data-grader-row="([a-z\\d-]+)"/g)].map(m => m[1]),
      togglePresent: radar.includes('data-view-mode="radar"') && radar.includes('data-view-mode="table"'),
      tableTogglePresent: table.includes('data-view-mode="radar"') && table.includes('data-view-mode="table"')
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["dimensionOpens"] == ["axis-1", "axis-2", "axis-3"]
    assert "axis-1" in result["tableRowTargets"] and "gate-1" in result["tableRowTargets"]
    assert result["togglePresent"] is True and result["tableTogglePresent"] is True


def test_baseline_group_participates_with_third_series(tmp_path: Path):
    """baseline 参与时同图展示第三条曲线（方案三：仅参与时）。"""
    case = _radar_case(3)
    runs = [
        _scored_run("case-a", "no_skill", 1, {"axis-1": 60, "axis-2": 70, "axis-3": 80}, quality=70),
        _scored_run("case-a", "baseline", 1, {"axis-1": 65, "axis-2": 75, "axis-3": 85}, quality=75),
        _scored_run("case-a", "current", 1, {"axis-1": 75, "axis-2": 85, "axis-3": 95}, quality=85),
    ]
    scenario = f"""
    {_PRELUDE}
    state.detailViewMode = "radar";
    const item = {_js(_experiment_with(case, runs))};
    const markup = comparisonMarkup(item);
    const legend = markup.slice(markup.indexOf("radar-legend"));
    console.log(JSON.stringify({{
      baselinePoints: (markup.match(/data-group="baseline"/g) || []).length,
      baselineInLegend: legend.includes("上一基准"),
      legendGroups: (legend.match(/legend-group">/g) || []).length,
      baselineStyle: markup.includes('stroke="#33507e"') && markup.includes('stroke-dasharray="8 5"')
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["baselinePoints"] == 3
    assert result["baselineInLegend"] is True
    assert result["legendGroups"] == 3
    assert result["baselineStyle"] is True  # 颜色 + 独立线型双编码


def test_radar_points_are_keyboard_focusable_with_exact_scores(tmp_path: Path):
    case = _radar_case(3)
    runs = [
        _scored_run("case-a", "no_skill", 1, {"axis-1": 60, "axis-2": 70, "axis-3": 80}, quality=70),
        _scored_run("case-a", "current", 1, {"axis-1": 75, "axis-2": 85, "axis-3": 95}, quality=85),
    ]
    scenario = f"""
    {_PRELUDE}
    state.detailViewMode = "radar";
    const item = {_js(_experiment_with(case, runs))};
    const markup = comparisonMarkup(item);
    const focusable = [...markup.matchAll(/<g class="radar-point" tabindex="0" role="img" aria-label="([^"]+)" data-radar-point data-tooltip="([^"]+)"/g)];
    console.log(JSON.stringify({{
      focusableCount: focusable.length,
      allHaveAria: focusable.every(m => m[1].includes("：") && /\\d+\\.\\d/.test(m[1])),
      ariaMatchesTooltip: focusable.every(m => m[1] === m[2])
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["focusableCount"] == 6
    assert result["allHaveAria"] is True  # 精确分数进入 aria-label / tooltip
    assert result["ariaMatchesTooltip"] is True
