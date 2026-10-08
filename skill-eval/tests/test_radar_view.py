"""雷达图合并视图测试：雷达与结果明细列表（原明细表并入列表，无第二视图）。

与 test_detail_page_structure 同一方式：在 Node 中以 DOM 桩加载真实 app.js，
直接调用 caseComparisonData / comparisonMarkup 等函数，
对雷达与明细列表共用同一数据源、数值一致性（验收误差 ≤ 0.1）、
少于三个数值维度或无有效评分时只出列表、维度行覆盖全部 grader（含硬门禁）等做行为断言。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from test_detail_page_structure import (
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
        _scored_run("case-a", "no_skill", 1,
                    {"axis-1": 60, "axis-2": 70, "axis-3": 80}, quality=70),
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
    assert result["mode"] == "radar"  # 有雷达可用时渲染雷达图
    assert result["axisLines"] == 3  # 坐标轴只含 hard_gate=false 的 grader
    assert result["dimensionEntries"] == 4  # 明细列表覆盖全部 grader：3 数值维度 + 硬门禁
    assert result["gateInDimensions"] is True  # 硬门禁行并入明细列表（合并视图）
    assert result["gateStripPresent"] is True  # 硬门禁在图表上方状态条


def test_radar_point_values_are_completed_trial_means(tmp_path: Path):
    case = _radar_case(3)
    runs = [
        _scored_run("case-a", "no_skill", 1,
                    {"axis-1": 60, "axis-2": 70, "axis-3": 80}, quality=70),
        _scored_run("case-a", "no_skill", 2,
                    {"axis-1": 80, "axis-2": 60, "axis-3": 90}, quality=76.67),
        # 未完成的 trial 不参与均分
        _scored_run("case-a", "no_skill", 3,
                    {"axis-1": 10, "axis-2": 10, "axis-3": 10},
                    quality=None, status="infra_error"),
        _scored_run("case-a", "current", 1, {"axis-1": 75, "axis-2": 85, "axis-3": 95}, quality=85),
    ]
    scenario = f"""
    {_PRELUDE}
    const item = {_js(_experiment_with(case, runs, trials=3))};
    const markup = comparisonMarkup(item);
    const points = [...markup.matchAll(
      /data-group="(no_skill|current)" data-axis="(axis-\\d)" data-value="([0-9.]+)"/g)]
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


def test_radar_and_dimension_list_values_are_consistent(tmp_path: Path):
    """验收：雷达与明细列表数值一致误差 ≤ 0.1（同一数据源渲染两种呈现）。"""
    case = _radar_case(3)
    runs = [
        _scored_run("case-a", "no_skill", 1,
                    {"axis-1": 60, "axis-2": 70, "axis-3": 80}, quality=70),
        _scored_run("case-a", "no_skill", 2,
                    {"axis-1": 80, "axis-2": 60, "axis-3": 90}, quality=76.67),
        _scored_run("case-a", "current", 1, {"axis-1": 75, "axis-2": 85, "axis-3": 95}, quality=85),
    ]
    scenario = f"""
    {_PRELUDE}
    const item = {_js(_experiment_with(case, runs, trials=2))};
    const markup = comparisonMarkup(item);
    const radarValues = Object.fromEntries([...markup.matchAll(
      /data-group="(no_skill|current)" data-axis="(axis-\\d)" data-value="([0-9.]+)"/g)]
      .map(match => [match[1] + ":" + match[2], Number(match[3])]));
    // 明细列表按组顺序渲染数值列（GROUP_ORDER），逐行提取该维度的组内数值
    const listValues = {{}};
    const rowPattern = 'data-dimension-open="(axis-\\\\d)"([\\\\s\\\\S]*?)'
      + '(?=<li class="dimension-item|</ul>)';
    const rowRe = new RegExp(rowPattern, "g");
    let rowMatch;
    while ((rowMatch = rowRe.exec(markup))) {{
      const values = [...rowMatch[2].matchAll(/dimension-value[^"]*"><strong>([0-9.]+)/g)]
        .map(match => Number(match[1]));
      ["no_skill", "current"].forEach((group, index) => {{
        if (values[index] != null) listValues[group + ":" + rowMatch[1]] = values[index];
      }});
    }}
    console.log(JSON.stringify({{radarValues, listValues}}));
    """
    result = _run_scenario(tmp_path, scenario)
    radar_values = result["radarValues"]
    list_values = result["listValues"]
    assert set(radar_values) == set(list_values)
    for key, radar_value in radar_values.items():
        assert abs(radar_value - list_values[key]) <= 0.1, (key, radar_value, list_values[key])


def test_fewer_than_three_axes_hides_chart_keeps_list(tmp_path: Path):
    case = _radar_case(2)
    runs = [
        _scored_run("case-a", "no_skill", 1, {"axis-1": 60, "axis-2": 70}, quality=65),
        _scored_run("case-a", "current", 1, {"axis-1": 75, "axis-2": 85}, quality=80),
    ]
    scenario = f"""
    {_PRELUDE}
    const item = {_js(_experiment_with(case, runs))};
    const markup = comparisonMarkup(item);
    console.log(JSON.stringify({{
      showsRadar: markup.includes("radar-svg"),
      showsList: markup.includes("radar-dimensions"),
      notice: markup.includes("数值维度少于 3 个"),
      toggleRemoved: !markup.includes("data-view-mode") && !markup.includes("view-toggle")
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["showsRadar"] is False  # 维度不足：不渲染雷达图
    assert result["showsList"] is True  # 明细列表始终可用
    assert result["notice"] is True
    assert result["toggleRemoved"] is True  # 合并视图后无第二视图切换


def test_no_valid_scores_hides_chart_keeps_list(tmp_path: Path):
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
    const item = {_js(_experiment_with(case, [timed_out("no_skill"), timed_out("current")]))};
    const markup = comparisonMarkup(item);
    const data = caseComparisonData(item, item.suite_snapshot.cases[0],
      runsByCaseAndGroup(item).get("case-a") || {{}});
    console.log(JSON.stringify({{
      showsRadar: markup.includes("radar-svg"),
      showsList: markup.includes("radar-dimensions"),
      notice: markup.includes("暂无有效评分结果"),
      toggleRemoved: !markup.includes("data-view-mode"),
      axisCount: data.axes.length,
      anyValue: data.series.some(entry => entry.hasAnyValue),
      unscoredCells: (markup.match(/未评分/g) || []).length
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["axisCount"] == 5  # 轴定义存在（来自套件快照）
    assert result["anyValue"] is False  # 但没有任何有效分数
    assert result["showsRadar"] is False  # 不再渲染空雷达网格
    assert result["showsList"] is True  # 明细列表以"未评分"占位说明情况
    assert result["notice"] is True
    assert result["toggleRemoved"] is True
    assert result["unscoredCells"] >= 2


def test_partial_scores_still_allow_radar(tmp_path: Path):
    """部分组有有效分数时雷达仍可用（只画有结果的组，另一组标注未绘制）。"""
    case = _radar_case(3)
    runs = [
        _scored_run("case-a", "no_skill", 1,
                    {"axis-1": 60, "axis-2": 70, "axis-3": 80}, quality=70),
        {**_scored_run("case-a", "current", 1,
                        {"axis-1": 0, "axis-2": 0, "axis-3": 0},
                        quality=None, status="timeout"),
         "scores": {"execution_order": 1}},
    ]
    scenario = f"""
    {_PRELUDE}
    const item = {_js(_experiment_with(case, runs))};
    const markup = comparisonMarkup(item);
    console.log(JSON.stringify({{
      showsRadar: markup.includes("radar-svg"),
      noToggle: !markup.includes("data-view-mode"),
      noNotice: !markup.includes("已自动显示明细表"),
      emptyNote: markup.includes("未绘制曲线")
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["showsRadar"] is True
    assert result["noToggle"] is True
    assert result["noNotice"] is True
    assert result["emptyNote"] is True


def test_radar_focus_listeners_use_capture_phase():
    """R1P1：键盘聚焦走捕获态 focus/blur（Chromium 对 SVG focus 不派发 focusin）。"""
    app = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    assert 'addEventListener("focus"' in app
    assert 'addEventListener("blur"' in app
    assert "}, true)" in app  # 捕获态监听（第三个参数 true）
    assert 'addEventListener("focusin"' not in app  # 已被捕获态 focus/blur 替代


def test_second_view_toggle_is_removed(tmp_path: Path):
    """合并视图：不再有雷达图/明细表双视图切换，表格内容并入明细列表。"""
    case = _radar_case(3)
    runs = [
        _scored_run("case-a", "no_skill", 1,
                    {"axis-1": 60, "axis-2": 70, "axis-3": 80}, quality=70),
        _scored_run("case-a", "current", 1, {"axis-1": 75, "axis-2": 85, "axis-3": 95}, quality=85),
    ]
    scenario = f"""
    {_PRELUDE}
    const item = {_js(_experiment_with(case, runs))};
    const markup = comparisonMarkup(item);
    console.log(JSON.stringify({{
      noToggleButtons: !markup.includes("data-view-mode") && !markup.includes("view-toggle"),
      noLegacyTable: !markup.includes("comparison-table") && !markup.includes("data-grader-row"),
      mergedListPresent: markup.includes("radar-dimensions") && markup.includes("quality-item"),
      weightedNotePresent: markup.includes("加权均值 · 硬门禁不计入"),
      radarPresent: markup.includes("radar-svg")
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["noToggleButtons"] is True
    assert result["noLegacyTable"] is True
    assert result["mergedListPresent"] is True
    assert result["weightedNotePresent"] is True  # 质量分行携带加权说明
    assert result["radarPresent"] is True


def test_view_mode_machinery_is_removed_from_source():
    app = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    assert "COMPARISON_VIEW_KEY" not in app
    assert "detailViewMode" not in app
    assert "data-view-mode" not in app
    assert "comparisonViewMode" not in app


def test_radar_legend_without_baseline_and_negative_delta(tmp_path: Path):
    case = _radar_case(3)
    runs = [
        _scored_run("case-a", "no_skill", 1,
                    {"axis-1": 70, "axis-2": 70, "axis-3": 70}, quality=70),
        _scored_run("case-a", "current", 1, {"axis-1": 55, "axis-2": 60, "axis-3": 50}, quality=55),
    ]
    scenario = f"""
    {_PRELUDE}
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
        _scored_run("case-a", "no_skill", 1,
                    {"axis-1": 60, "axis-2": 70, "axis-3": 80}, quality=70),
        _scored_run("case-a", "current", 1, {"axis-1": 75, "axis-2": 85, "axis-3": 95}, quality=85),
    ]
    scenario = f"""
    {_PRELUDE}
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
        _scored_run("case-a", "no_skill", 1,
                    {"axis-1": 60, "axis-2": 70, "axis-3": 80}, quality=70),
        _scored_run("case-a", "current", 1,
                    {"axis-1": 75, "axis-2": 85, "axis-3": 95}, quality=85, gates=(0, 1)),
    ]
    scenario = f"""
    {_PRELUDE}
    const item = {_js(_experiment_with(case, runs))};
    const markup = comparisonMarkup(item);
    console.log(JSON.stringify({{
      gatesBeforeChart: markup.indexOf("radar-gates") > -1
        && markup.indexOf("radar-gates") < markup.indexOf("radar-svg"),
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
        _scored_run("case-a", "no_skill", 1,
                    {"axis-1": 60, "axis-2": 70, "axis-3": 80}, quality=70),
        _scored_run("case-a", "current", 1,
                    {"axis-1": 0, "axis-2": 0, "axis-3": 0}, quality=None, status="timeout"),
    ]
    scenario = f"""
    {_PRELUDE}
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


def test_dimension_list_covers_all_graders_with_weights(tmp_path: Path):
    case = _radar_case(3)
    runs = [
        _scored_run("case-a", "no_skill", 1,
                    {"axis-1": 60, "axis-2": 70, "axis-3": 80}, quality=70),
        _scored_run("case-a", "current", 1, {"axis-1": 75, "axis-2": 85, "axis-3": 95}, quality=85),
    ]
    scenario = f"""
    {_PRELUDE}
    const item = {_js(_experiment_with(case, runs))};
    const markup = comparisonMarkup(item);
    console.log(JSON.stringify({{
      dimensionOpens: [...markup.matchAll(/data-dimension-open="([a-z\\d-]+)"/g)].map(m => m[1]),
      gateRowMarked: markup.includes('dimension-item is-gate'),
      gateTypeLabel: markup.includes("硬门禁（必须通过）"),
      weightVisible: markup.includes("权重 10"),
      groupHeadPresent: markup.includes('dimension-head')
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["dimensionOpens"] == ["axis-1", "axis-2", "axis-3", "gate-1"]
    assert result["gateRowMarked"] is True
    assert result["gateTypeLabel"] is True
    assert result["weightVisible"] is True  # 权重随行可见（总分可对账）
    assert result["groupHeadPresent"] is True  # 按组分列的表头


def test_execution_time_component_forms_extra_axis(tmp_path: Path):
    """服务端按 time_scoring 合成的「执行效率」分量：追加轴参与雷达与明细列表。"""
    case = _radar_case(3)
    runs = [
        _scored_run("case-a", "no_skill", 1,
                    {"axis-1": 60, "axis-2": 70, "axis-3": 80}, quality=70),
        _scored_run("case-a", "current", 1, {"axis-1": 75, "axis-2": 85, "axis-3": 95}, quality=85),
    ]
    # 注入服务端合成的执行效率分量（_scored_run 只写 axis 分量，这里逐 run 补一条）
    for run, score in zip(runs, [50.0, 90.0], strict=True):
        run["scores"]["components"].append(
            {"grader_id": "__execution_time__", "score": score, "hard_gate": False, "weight": 10}
        )
    scenario = f"""
    {_PRELUDE}
    const item = {_js(_experiment_with(case, runs))};
    const markup = comparisonMarkup(item);
    const data = caseComparisonData(item, item.suite_snapshot.cases[0],
      runsByCaseAndGroup(item).get("case-a") || {{}});
    console.log(JSON.stringify({{
      axisCount: data.axes.length,
      timeAxisLast: data.axes[data.axes.length - 1]?.id === "__execution_time__",
      timeAxisWeight: data.axes[data.axes.length - 1]?.weight,
      radarPoints: (markup.match(/data-axis="__execution_time__"/g) || []).length,
      listRowPresent: markup.includes('data-dimension-open="__execution_time__"'),
      labelPresent: markup.includes("执行效率（按总耗时折算） · 权重 10")
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["axisCount"] == 4  # 3 个数值维度 + 执行效率追加轴
    assert result["timeAxisLast"] is True
    assert result["timeAxisWeight"] == 10
    assert result["radarPoints"] == 2  # 两组各一个雷达点
    assert result["listRowPresent"] is True
    assert result["labelPresent"] is True


def test_no_time_component_keeps_axes_unchanged(tmp_path: Path):
    """未配置 time_scoring 的历史实验：run 无执行效率分量，轴与明细行不变化。"""
    case = _radar_case(3)
    runs = [
        _scored_run("case-a", "no_skill", 1,
                    {"axis-1": 60, "axis-2": 70, "axis-3": 80}, quality=70),
        _scored_run("case-a", "current", 1, {"axis-1": 75, "axis-2": 85, "axis-3": 95}, quality=85),
    ]
    scenario = f"""
    {_PRELUDE}
    const item = {_js(_experiment_with(case, runs))};
    const markup = comparisonMarkup(item);
    const data = caseComparisonData(item, item.suite_snapshot.cases[0],
      runsByCaseAndGroup(item).get("case-a") || {{}});
    console.log(JSON.stringify({{
      axisCount: data.axes.length,
      timeRowAbsent: !markup.includes("__execution_time__")
    }}));
    """
    result = _run_scenario(tmp_path, scenario)
    assert result["axisCount"] == 3
    assert result["timeRowAbsent"] is True


def test_baseline_group_participates_with_third_series(tmp_path: Path):
    """baseline 参与时同图展示第三条曲线（方案三：仅参与时）。"""
    case = _radar_case(3)
    runs = [
        _scored_run("case-a", "no_skill", 1,
                    {"axis-1": 60, "axis-2": 70, "axis-3": 80}, quality=70),
        _scored_run("case-a", "baseline", 1,
                    {"axis-1": 65, "axis-2": 75, "axis-3": 85}, quality=75),
        _scored_run("case-a", "current", 1, {"axis-1": 75, "axis-2": 85, "axis-3": 95}, quality=85),
    ]
    scenario = f"""
    {_PRELUDE}
    const item = {_js(_experiment_with(case, runs))};
    const markup = comparisonMarkup(item);
    const legend = markup.slice(markup.indexOf("radar-legend"));
    console.log(JSON.stringify({{
      baselinePoints: (markup.match(/data-group="baseline"/g) || []).length,
      baselineInLegend: legend.includes("上一基准"),
      legendGroups: (legend.match(/legend-group">/g) || []).length,
      baselineStyle: markup.includes('stroke="#33507e"')
        && markup.includes('stroke-dasharray="8 5"')
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
        _scored_run("case-a", "no_skill", 1,
                    {"axis-1": 60, "axis-2": 70, "axis-3": 80}, quality=70),
        _scored_run("case-a", "current", 1, {"axis-1": 75, "axis-2": 85, "axis-3": 95}, quality=85),
    ]
    scenario = f"""
    {_PRELUDE}
    const item = {_js(_experiment_with(case, runs))};
    const markup = comparisonMarkup(item);
    const focusable = [...markup.matchAll(new RegExp(
      '<g class="radar-point" tabindex="0" role="img" aria-label="([^"]+)"'
        + ' data-radar-point data-tooltip="([^"]+)"', "g"))];
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
