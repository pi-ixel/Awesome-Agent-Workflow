/* ═══════════════════════════════════════════════════════════
   mock-data.js
   Contract-faithful mock backend for the dashboard.
   产出与 RealApi 相同的页面内部形状 { code:0, data:{ summary,
   byComponent, byPerson, trend } }，用于 useMock=true 的本地预览。
   Deterministic (seeded) so numbers stay stable across renders
   yet respond to component / person / timeRange filters.
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  const COMPONENTS = [
    { id: "comp-01", name: "代码生成服务" },
    { id: "comp-02", name: "智能补全" },
    { id: "comp-03", name: "代码评审助手" },
    { id: "comp-04", name: "单元测试生成" },
    { id: "comp-05", name: "重构建议" },
    { id: "comp-06", name: "注释与文档" },
    { id: "comp-07", name: "缺陷定位" },
  ];

  const PERSONS = [
    { id: "user-001", name: "张三" },
    { id: "user-002", name: "李四" },
    { id: "user-003", name: "王五" },
    { id: "user-004", name: "赵六" },
    { id: "user-005", name: "钱七" },
    { id: "user-006", name: "孙八" },
    { id: "user-007", name: "周九" },
    { id: "user-008", name: "吴十" },
  ];

  const TIME_RANGES = [
    { value: "1d",   label: "1天" },
    { value: "3d",   label: "3天" },
    { value: "7d",   label: "7天" },
    { value: "30d",  label: "30天" },
    { value: "60d",  label: "60天" },
    { value: "90d",  label: "90天" },
    { value: "180d", label: "半年" },
    { value: "365d", label: "一年" },
  ];

  const RANGE_DAYS = { "1d":1, "3d":3, "7d":7, "30d":30, "60d":60, "90d":90, "180d":180, "365d":365 };

  // AAW 工作流步骤目录 — 与 skills/aaw-workflow/scripts/cli/definitions/ 下的
  // 节点 yaml（step_type = 文件名）及 flow.yaml 的边顺序保持一致。
  // 展示名直接使用 step_type 原始值，与真实后端契约一致（后端不返回显示名）。
  // 唯一的门禁节点是 module-design-gate（choice 边，fail/blocked 原地拒绝）。
  // flow = 到达量相对每周 SR 流入的量级系数，按"上游完成量 ≥ 下游到达量"逐级递推。
  // 工作流不是单调漏斗：ar-split(foreach ars)、module-detail-design-split(foreach
  // module_groups)、task-split(foreach tasks) 三条 foreach 边会放大下游步骤数。
  const STEP_TYPES = [
    { key: "sr-init",                    flow: 1.0,  isGate: false },
    { key: "sr-design",                  flow: 0.9,  isGate: false },
    { key: "ar-split",                   flow: 0.8,  isGate: false },
    { key: "ar-init",                    flow: 0.35, isGate: false }, // 独立 AR 入口，量较少
    { key: "ar-clarify",                 flow: 2.5,  isGate: false }, // ar-split×3(foreach ars) + ar-init 汇入
    { key: "module-boundary-design",     flow: 2.25, isGate: false },
    { key: "module-detail-design-split", flow: 2.0,  isGate: false },
    { key: "module-asis-analysis",       flow: 3.6,  isGate: false }, // ×2(foreach module_groups)
    { key: "module-tobe-design",         flow: 3.25, isGate: false },
    { key: "module-test-design",         flow: 2.9,  isGate: false },
    { key: "module-design-gate",         flow: 2.6,  isGate: true  },
    { key: "task-split",                 flow: 1.85, isGate: false }, // 门禁 fail/blocked 卡掉一部分
    { key: "task-dev",                   flow: 6.7,  isGate: false }, // ×4(foreach tasks)
  ];
  // 工作流当前状态 → 活跃态映射，供明细列表使用。
  const WF_STATES = ["active", "stalled", "completed"];

  // deterministic hash → [0,1)
  function seed(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 100000) / 100000;
  }
  const round = (n) => Math.round(n);
  const rate  = (num, den) => den ? +(num / den).toFixed(3) : 0;

  // per-entity baseline "throughput" per day, scaled by a stable factor
  function dailyFor(entityId, kind) {
    const base = 40 + Math.floor(seed(entityId + kind) * 220);      // usage/day
    const linesPerUse = 24 + Math.floor(seed(entityId + "lp") * 30);
    const quality80 = 0.62 + seed(entityId + "q80") * 0.20;         // 0.62–0.82
    const quality90 = quality80 - (0.06 + seed(entityId + "q90") * 0.08);
    return { base, linesPerUse, quality80, quality90 };
  }

  function metricsFor(entityId, days, dayJitter) {
    const p = dailyFor(entityId, "e");
    const usage = round(p.base * days * dayJitter);
    const generated = round(usage * p.linesPerUse);
    const m80 = round(generated * p.quality80);
    const m90 = round(generated * p.quality90);
    return {
      usageCount: usage,
      generatedLines: generated,
      mergedLines80: m80,
      mergedLines90: m90,
      adoptionRate80: rate(m80, generated),
      adoptionRate90: rate(m90, generated),
    };
  }

  function accumulate(target, m) {
    target.usageCount     += m.usageCount;
    target.generatedLines += m.generatedLines;
    target.mergedLines80  += m.mergedLines80;
    target.mergedLines90  += m.mergedLines90;
  }
  function finalizeRates(t) {
    t.adoptionRate80 = rate(t.mergedLines80, t.generatedLines);
    t.adoptionRate90 = rate(t.mergedLines90, t.generatedLines);
    return t;
  }

  function resolve(ids, all) {
    if (!ids || !ids.length) return all;
    const set = new Set(ids);
    return all.filter((x) => set.has(x.id));
  }

  function paginate(items, page, pageSize) {
    const size = Math.max(1, Number(pageSize) || 10);
    const current = Math.max(1, Number(page) || 1);
    const start = (current - 1) * size;
    return {
      items: items.slice(start, start + size),
      total: items.length,
      page: current,
      pageSize: size,
    };
  }

  function granularityFor(timeRange, requested) {
    if (requested && requested !== "auto") return requested;
    // 契约只有 day / week 两档：长周期用 week，其余 day。
    return ["180d","365d"].includes(timeRange) ? "week" : "day";
  }

  function trendPoints(entities, timeRange, granularity) {
    const days = RANGE_DAYS[timeRange];
    let buckets, spanDays;
    if (granularity === "week") { buckets = Math.max(4, Math.round(days / 7)); spanDays = 7; }
    else { buckets = days; spanDays = 1; }               // day
    buckets = Math.min(buckets, 90);

    const now = new Date("2026-07-14T00:00:00");
    const points = [];
    for (let i = buckets - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i * (granularity === "week" ? 7 : 1));

      const label = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;

      const acc = { usageCount:0, generatedLines:0, mergedLines80:0, mergedLines90:0 };
      const jitter = 0.72 + seed(label + timeRange) * 0.56;   // 0.72–1.28 daily wobble
      entities.forEach((e) => accumulate(acc, metricsFor(e.id, spanDays, jitter)));
      finalizeRates(acc);
      points.push({ date: label, ...acc });
    }
    return points;
  }

  // ── mock endpoints ────────────────────────────────────
  const MockApi = {
    filterOptions() {
      return Promise.resolve({
        code: 0, message: "ok",
        data: { components: COMPONENTS, persons: PERSONS, timeRanges: TIME_RANGES },
      });
    },

    statistics(params = {}) {
      const timeRange = params.timeRange || "7d";
      const days = RANGE_DAYS[timeRange] || 7;
      const comps = resolve(params.components, COMPONENTS);
      const persons = resolve(params.persons, PERSONS);
      const granularity = granularityFor(timeRange, params.granularity);

      // component distribution: split each component's total across selected persons
      const personWeight = persons.reduce((s, p) => s + (0.5 + seed(p.id + "w")), 0);
      const jitter = 1;

      const byComponent = comps.map((c) => {
        // component total scaled by how many persons are in scope
        const share = personWeight / PERSONS.reduce((s,p)=>s+(0.5+seed(p.id+"w")),0);
        const m = metricsFor(c.id, days, jitter);
        const scaled = {
          componentId: c.id, componentName: c.name,
          usageCount: round(m.usageCount * share),
          generatedLines: round(m.generatedLines * share),
          mergedLines80: round(m.mergedLines80 * share),
          mergedLines90: round(m.mergedLines90 * share),
        };
        return finalizeRates(Object.assign(scaled, {
          adoptionRate80: rate(scaled.mergedLines80, scaled.generatedLines),
          adoptionRate90: rate(scaled.mergedLines90, scaled.generatedLines),
        }));
      });

      const compWeight = comps.reduce((s,c)=>s+(0.5+seed(c.id+"cw")),0) /
                         COMPONENTS.reduce((s,c)=>s+(0.5+seed(c.id+"cw")),0);
      const byPerson = persons.map((p) => {
        const m = metricsFor(p.id, days, jitter);
        const scaled = {
          personId: p.id, personName: p.name,
          usageCount: round(m.usageCount * compWeight),
          generatedLines: round(m.generatedLines * compWeight),
          mergedLines80: round(m.mergedLines80 * compWeight),
          mergedLines90: round(m.mergedLines90 * compWeight),
        };
        return Object.assign(scaled, {
          adoptionRate80: rate(scaled.mergedLines80, scaled.generatedLines),
          adoptionRate90: rate(scaled.mergedLines90, scaled.generatedLines),
        });
      });

      const summary = { usageCount:0, generatedLines:0, mergedLines80:0, mergedLines90:0 };
      byComponent.forEach((c) => accumulate(summary, c));
      finalizeRates(summary);

      const trend = trendPoints(comps, timeRange, granularity)
        .map(({ date, ...rest }) => ({ date, ...rest }));

      // 实时运营块：契约 overview 的 current + period 未展示字段。
      const totalUsage = summary.usageCount || 1;
      const completedWorkflows = round(totalUsage * (0.68 + seed(timeRange + "cw") * 0.22));
      const devRuns = round(totalUsage * (1.2 + seed(timeRange + "dr") * 0.4));
      const activeWorkflows = round(6 + seed(timeRange + comps.length + "aw") * 26);
      const stalledWorkflows = round(seed(timeRange + comps.length + "sw") * 9);
      const realtime = {
        activeWorkflows,
        stalledWorkflows,
        activityThresholdHours: 24,
        workflowRuns: summary.usageCount,
        completedWorkflows,
        workflowCompletionRate: rate(completedWorkflows, summary.usageCount),
        devRuns,
        pendingAttributionDevRuns: round(devRuns * (0.04 + seed(timeRange + "pa") * 0.08)),
        activeUsers: persons.length,
        activeProjects: comps.length,
      };
      const componentPagination = paginate(byComponent, params.componentPage, params.componentPageSize);
      const personPagination = paginate(byPerson, params.personPage, params.personPageSize);

      return Promise.resolve({
        code: 0, message: "ok",
        data: {
          summary,
          byComponent: componentPagination.items,
          byPerson: personPagination.items,
          trend,
          realtime,
          componentPagination,
          personPagination,
        },
      });
    },

    // 步骤汇总：固定按 step_type 聚合。
    steps(params = {}) {
      const timeRange = params.timeRange || "7d";
      const catalog = STEP_TYPES;
      const days = RANGE_DAYS[timeRange] || 7;
      const comps = resolve(params.components, COMPONENTS);
      const scale = 0.6 + comps.length / COMPONENTS.length * 0.4;

      // 抖动整条链共享：各步骤相对比例严格由 flow 系数决定，避免直连边上
      // 出现"下游到达量 > 上游到达量"的倒挂。
      const jitter = 0.85 + seed("steps" + timeRange) * 0.3;

      const items = catalog.map((s) => {
        // 到达量 = 每周 SR 流入基数 × 步骤量级系数（含 foreach 放大，见 STEP_TYPES 注释）。
        const reached = round(40 * s.flow * (days / 7) * scale * jitter);
        // 门禁按 choice 边原地拒绝，fail/blocked 显著高于普通步骤。
        const failRate = s.isGate ? 0.05 + seed(s.key + "f") * 0.07 : 0.02 + seed(s.key + "f") * 0.04;
        const blockRate = s.isGate ? 0.08 + seed(s.key + "b") * 0.08 : 0.01 + seed(s.key + "b") * 0.02;
        const failed = round(reached * failRate);
        const blocked = round(reached * blockRate);
        const completed = Math.max(0, reached - failed - blocked);
        const median = round(120 + seed(s.key + "md") * 640);
        return {
          key: s.key,
          displayName: s.key,
          reached,
          completed,
          failed,
          blocked,
          completionRate: rate(completed, reached),
          medianDurationSeconds: median,
          p90DurationSeconds: round(median * (1.8 + seed(s.key + "p9") * 1.2)),
        };
      });

      const pagination = paginate(items, params.page, params.pageSize);
      return Promise.resolve({ code: 0, message: "ok", data: pagination });
    },

    // 工作流明细列表（契约 §7.6）。state: active|stalled|completed。
    workflows(params = {}) {
      const timeRange = params.timeRange || "7d";
      const wantState = WF_STATES.includes(params.state) ? params.state : "active";
      const comps = resolve(params.components, COMPONENTS);
      const persons = resolve(params.persons, PERSONS);
      const count = wantState === "completed" ? 24 : wantState === "stalled" ? 6 : 14;

      const items = [];
      for (let i = 0; i < count; i++) {
        const c = comps[i % comps.length];
        const p = persons[i % persons.length];
        const s = seed(wantState + timeRange + i);
        const step = STEP_TYPES[Math.min(STEP_TYPES.length - 1, Math.floor(s * STEP_TYPES.length))];
        const gen = round(200 + seed("g" + i + timeRange) * 1400);
        const isDone = wantState === "completed";
        const started = new Date("2026-07-14T09:00:00");
        started.setHours(started.getHours() - round(s * (isDone ? 240 : 60)) - i);
        const lastAct = new Date(started);
        lastAct.setHours(lastAct.getHours() + round(seed("la" + i) * (isDone ? 20 : 40)));
        const rate80 = 0.5 + seed("r" + i) * 0.3;
        items.push({
          workflowRunId: `wf-${timeRange}-${wantState}-${String(i).padStart(3, "0")}`,
          projectKey: c.id,
          projectDisplayName: c.name,
          gitUserEmail: p.id.includes("@") ? p.id : `${p.id}@company.com`,
          gitUserName: p.name,
          sr: `SR-${1000 + round(s * 8000)}`,
          ar: `AR-${100 + round(seed("ar" + i) * 900)}`,
          status: isDone ? "completed" : "in_progress",
          activityState: wantState,
          furthestStepType: step.key,
          furthestStepName: step.key,
          startedAt: started.toISOString(),
          lastActivityAt: lastAct.toISOString(),
          devEffectiveLines: gen,
          attributedLines80: round(gen * rate80),
          attributedLines90: round(gen * (rate80 - 0.1)),
        });
      }
      const pagination = paginate(items, params.page, params.pageSize);
      return Promise.resolve({
        code: 0,
        message: "ok",
        data: { state: wantState, ...pagination },
      });
    },
  };

  // simulate network latency so the loading choreography is visible
  function withLatency(fn) {
    return (...args) => new Promise((res) =>
      setTimeout(() => fn(...args).then(res), 260 + Math.random() * 220));
  }

  global.MockApi = {
    filterOptions: withLatency(MockApi.filterOptions),
    statistics: withLatency(MockApi.statistics),
    steps: withLatency(MockApi.steps),
    workflows: withLatency(MockApi.workflows),
  };
})(window);
