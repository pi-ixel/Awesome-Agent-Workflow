/* ═══════════════════════════════════════════════════════════
   bright.js — Adoption Studio dashboard controller
   Bright/light variant. Wires the filter controls to the stats
   API and paints every chart. 数据源由 config.js 的 APP_CONFIG
   控制：useMock=true 用内建 mock，false 走真实后端
   telemetry-api-contract.md 的 /api/v1/dashboard/*。
   ═══════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  // ── palette (mirror of CSS custom props) ───────────────
  const C = {
    iris: "#4B3FE4", iris2: "#7C74FF",
    grass: "#12C46B", grass2: "#34E08A", grassDeep: "#0FA259",
    tangerine: "#FF7A1A",
    magenta: "#FF3D8B",
    sky: "#2BB3FF",
    paper: "#FBFAF7", paper2: "#FFFFFF",
    edge: "#ECE7DE", edge2: "#E0DACE",
    ink: "#16181D", inkSoft: "#565B66", inkMute: "#9AA0AC",
  };
  const FONT_MONO = '"Space Mono", ui-monospace, monospace';

  // 组件构成只展示头部组件，其余折叠为「其余 N 个组件」。
  const TOP_COMPONENTS = 7;

  // metric registry — single source of truth for labels/colors/format
  const METRICS = {
    usageCount:     { label: "使用次数",   color: C.iris,      kind: "int" },
    generatedLines: { label: "生成代码量", color: C.tangerine, kind: "int" },
    mergedLines80:  { label: "合入·80%",   color: C.grass,     kind: "int" },
    mergedLines90:  { label: "合入·90%",   color: C.magenta,   kind: "int" },
    adoptionRate80: { label: "采纳率·80%", color: C.grass,     kind: "pct" },
    adoptionRate90: { label: "采纳率·90%", color: C.magenta,   kind: "pct" },
  };

  // ── formatters ─────────────────────────────────────────
  const nf = new Intl.NumberFormat("en-US");
  function fmtInt(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + "M";
    if (n >= 10_000)    return (n / 1_000).toFixed(n >= 100_000 ? 0 : 1) + "k";
    return nf.format(n);
  }
  const fmtFull = (n) => nf.format(n);
  const fmtPct  = (r) => r == null ? "—" : (r * 100).toFixed(1) + "%";
  const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[ch]);
  function fmtDur(sec) {
    if (sec == null) return "—";
    if (sec < 60) return sec + "s";
    if (sec < 3600) return (sec / 60).toFixed(sec < 600 ? 1 : 0) + "m";
    return (sec / 3600).toFixed(1) + "h";
  }
  function fmtAgo(iso) {
    const then = new Date(iso).getTime();
    if (isNaN(then)) return "—";
    const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
    if (mins < 60) return mins + " 分钟前";
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + " 小时前";
    return Math.round(hrs / 24) + " 天前";
  }

  // ── state ──────────────────────────────────────────────
  const state = {
    options: { components: [], persons: [], timeRanges: [] },
    selComponents: [],
    selPersons: [],
    timeRange: "90d",
    trendMetric: "adoptionRate80",
    sortBy: "generatedLines",
    sortOrder: "desc",
    componentPage: 1,
    componentPageSize: 10,
    personPage: 1,
    personPageSize: 10,
    data: null,
    stepPage: 1,
    stepPageSize: 20,
    steps: null,
    stepsFailed: false,
    wfState: "active",
    workflowPage: 1,
    workflowPageSize: 10,
    workflows: null,
    workflowsFailed: false,
    activeTab: "overview",
    components: null,
    componentsFailed: false,
    compSort: "effectiveLines",
    compOrder: "desc",
    compQuery: "",
    compSe: [],
    compMaster: [],
    compUsed: "all",
    // AI Master 运营
    aiMasters: null,
    aiMastersFailed: false,
    assignments: null,
    amSummary: null,
    amSummaryFailed: false,
    amDetail: null,
    amDetailFailed: false,
    amSelectedMaster: null,
    amSubTab: "summary",
    // 名单管理弹窗
    amModalOpen: false,
    amModalTab: "roster",
    assignSearch: "",
    assignMaster: [],
    assignState: "all",
  };

  const charts = {};
  const selects = {};
  const $ = (s) => document.querySelector(s);
  // 测试看板与采纳看板共用采纳指标，但不加载运营、步骤和实例明细数据。
  const isTestDashboard = document.body.dataset.dashboard === "test";
  const dashboardApiPrefix = document.body.dataset.dashboardApiPrefix || "/dashboard";
  const dashboardPath = (suffix) => `${dashboardApiPrefix}${suffix}`;
  const adoptionRate = (row, threshold) => isTestDashboard
    ? row[`mr_adoption_rate_${threshold}`]
    : row[`attribution_rate_${threshold}`];

  // ═══ FILTER CONTROLS ═══════════════════════════════════

  // onChange 默认触发全局重新取数；表格级本地筛选可传入纯前端的重渲染函数。
  function buildMultiSelect(mountId, optionList, getSel, setSel, searchLabel, onChange = onFilterChange) {
    const mount = document.getElementById(mountId);
    const placeholder = mount.dataset.placeholder;
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "multi__trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    mount.innerHTML = "";
    mount.appendChild(trigger);
    let pop = null;

    function renderTrigger() {
      const sel = getSel();
      trigger.innerHTML = "";
      if (!sel.length) {
        const ph = document.createElement("span");
        ph.className = "multi__ph";
        ph.textContent = placeholder;
        trigger.appendChild(ph);
        return;
      }
      const names = sel.map((id) => optionList.find((o) => o.id === id)?.name).filter(Boolean);
      const label = document.createElement("span");
      label.className = "chip";
      label.textContent = names.length > 2 ? `${names.slice(0, 2).join("、")} +${names.length - 2}` : names.join("、");
      trigger.appendChild(label);
    }

    function syncPop() {
      if (!pop) return;
      const sel = new Set(getSel());
      pop.querySelectorAll(".pop__opt").forEach((el) => {
        const selected = el.dataset.id === "__all__" ? sel.size === 0 : sel.has(el.dataset.id);
        el.setAttribute("aria-selected", selected ? "true" : "false");
      });
    }

    function openPop() {
      closeAllPops();
      pop = document.createElement("div");
      pop.className = "pop";
      const listId = `${mountId}-options`;

      const searchWrap = document.createElement("div");
      searchWrap.className = "pop__search-wrap";
      const searchIcon = document.createElement("span");
      searchIcon.className = "pop__search-icon";
      searchIcon.setAttribute("aria-hidden", "true");
      const search = document.createElement("input");
      search.type = "search";
      search.className = "pop__search";
      search.placeholder = `搜索${searchLabel}`;
      search.setAttribute("aria-label", `搜索${searchLabel}`);
      search.setAttribute("autocomplete", "off");
      search.setAttribute("spellcheck", "false");
      searchWrap.append(searchIcon, search);

      const list = document.createElement("div");
      list.className = "pop__list";
      list.id = listId;
      list.setAttribute("role", "listbox");
      list.setAttribute("aria-multiselectable", "true");
      trigger.setAttribute("aria-controls", listId);

      const empty = document.createElement("div");
      empty.className = "pop__empty";
      empty.textContent = `没有匹配的${searchLabel}`;
      empty.hidden = true;

      const allOpt = document.createElement("button");
      allOpt.type = "button";
      allOpt.className = "pop__opt";
      allOpt.setAttribute("role", "option");
      allOpt.innerHTML = `<span class="box"></span><span>全部（不筛选）</span>`;
      allOpt.dataset.id = "__all__";
      allOpt.addEventListener("click", (event) => {
        event.stopPropagation();
        setSel([]); closePop(); renderTrigger(); onChange();
      });
      list.appendChild(allOpt);

      optionList.forEach((o) => {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "pop__opt";
        el.dataset.id = o.id;
        el.dataset.search = `${o.name} ${o.id}`.toLocaleLowerCase("zh-CN");
        el.setAttribute("role", "option");
        const box = document.createElement("span");
        box.className = "box";
        const label = document.createElement("span");
        label.textContent = o.name;
        el.append(box, label);
        el.addEventListener("click", (event) => {
          event.stopPropagation();
          const sel = getSel();
          setSel(sel.includes(o.id) ? sel.filter((x) => x !== o.id) : [...sel, o.id]);
          renderTrigger(); syncPop(); onChange();
        });
        list.appendChild(el);
      });

      list.appendChild(empty);
      pop.append(searchWrap, list);

      search.addEventListener("input", () => {
        const query = search.value.trim().toLocaleLowerCase("zh-CN");
        let matches = 0;
        list.querySelectorAll('.pop__opt:not([data-id="__all__"])').forEach((el) => {
          const visible = !query || el.dataset.search.includes(query);
          el.hidden = !visible;
          if (visible) matches += 1;
        });
        allOpt.hidden = Boolean(query);
        empty.hidden = matches > 0;
        list.scrollTop = 0;
      });
      search.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          closePop();
          trigger.focus();
        }
      });

      mount.appendChild(pop);
      mount.classList.add("is-open");
      trigger.setAttribute("aria-expanded", "true");
      syncPop();
      requestAnimationFrame(() => search.focus());
    }

    function closePop() {
      if (pop) { pop.remove(); pop = null; }
      mount.classList.remove("is-open");
      trigger.setAttribute("aria-expanded", "false");
      trigger.removeAttribute("aria-controls");
    }

    mount._close = closePop;
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      mount.classList.contains("is-open") ? closePop() : openPop();
    });
    trigger.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closePop();
    });

    renderTrigger();
    return { renderTrigger, closePop };
  }

  function closeAllPops() {
    document.querySelectorAll(".multi").forEach((m) => m._close && m._close());
  }
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".multi")) closeAllPops();
  });

  // 空态里的「重试」链接：只重取失败的那条线。
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".retry-link");
    if (!btn) return;
    if (btn.dataset.retry === "steps") refetchSteps();
    else if (btn.dataset.retry === "workflows") refetchWorkflows();
    else if (btn.dataset.retry === "components") refetchComponents();
    else if (btn.dataset.retry === "amSummary") refetchAmSummary();
  });

  function buildSegments() {
    const wrap = $("#fRange");
    wrap.innerHTML = "";
    state.options.timeRanges.forEach((t) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(t.value === state.timeRange));
      b.textContent = t.label;
      b.addEventListener("click", () => {
        state.timeRange = t.value;
        wrap.querySelectorAll("button").forEach((x) =>
          x.setAttribute("aria-checked", String(x === b)));
        onFilterChange();
      });
      wrap.appendChild(b);
    });
  }

  function buildTrendToggle() {
    const wrap = $("#trendToggle");
    wrap.innerHTML = "";
    const keys = ["adoptionRate80", "adoptionRate90", "generatedLines", "mergedLines80", "usageCount"];
    keys.forEach((k) => {
      const b = document.createElement("button");
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(k === state.trendMetric));
      b.textContent = METRICS[k].label;
      b.addEventListener("click", () => {
        state.trendMetric = k;
        wrap.querySelectorAll("button").forEach((x) =>
          x.setAttribute("aria-selected", String(x === b)));
        renderTrend();
      });
      wrap.appendChild(b);
    });
  }

  // ═══ API 层 ═══════════════════════════════════════════
  // 通过 config.js 的 window.APP_CONFIG 决定走 mock 还是真实后端。
  // 真实后端契约见 telemetry-api-contract.md 的 /api/v1/dashboard/*，
  // RealApi 负责把新契约的 { request_id, data / items } 信封与字段
  // 翻译成页面内部使用的 { code:0, data:{ summary, byComponent, byPerson, trend } }。
  const CFG = Object.assign(
    { apiBase: "/api/v1", useMock: true, timeout: 15000, credentials: "same-origin" },
    window.APP_CONFIG || {},
    new URLSearchParams(window.location.search).get("mock") === "1" ? { useMock: true } : {}
  );

  // 时间窗枚举 → 天数（页面固有维度，契约不返回）。
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
  const rate = (num, den) => (den ? +(num / den).toFixed(3) : null);

  // query 支持可重复参数：值为数组时逐项 append。
  async function httpGet(path, query) {
    const url = new URL(CFG.apiBase + path, window.location.origin);
    Object.entries(query || {}).forEach(([k, v]) => {
      if (Array.isArray(v)) {
        v.forEach((item) => { if (item !== "" && item != null) url.searchParams.append(k, item); });
      } else if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, v);
      }
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CFG.timeout);
    try {
      const resp = await fetch(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: CFG.credentials,
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function httpRequest(method, path, body) {
    const url = new URL(CFG.apiBase + path, window.location.origin);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CFG.timeout);
    try {
      const resp = await fetch(url.toString(), {
        method,
        headers: {
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        credentials: CFG.credentials,
        signal: ctrl.signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // 把页面筛选态翻译成契约公共过滤参数（§6.1）。
  function buildFilterParams(params) {
    const days = RANGE_DAYS[params.timeRange] || 7;
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const to = new Date();
    const from = new Date();
    from.setDate(to.getDate() - (days - 1));
    return {
      from: iso(from),
      to: iso(to),
      project_key: params.components || [],      // 组件 = 项目
      user_name: params.persons || [],
    };
  }

  // trends 的粒度：契约只有 day / week。
  function granularityFor(timeRange) {
    return ["180d", "365d"].includes(timeRange) ? "week" : "day";
  }

  // 真实接口客户端：对外与 MockApi 同形状（返回 { code:0, data }）。
  const RealApi = {
    async filterOptions() {
      const d = await httpGet(dashboardPath("/filter-options"));
      return {
        code: 0,
        data: {
          components: (d.projects || []).map((p) => ({
            id: p.project_key,
            name: p.project_key,
          })),
          persons: (d.users || []).map((u) => ({ id: u.user_name, name: u.user_name })),
          timeRanges: TIME_RANGES,
        },
      };
    },

    async statistics(params) {
      const filter = buildFilterParams(params);
      // projects 同时返回当前分页和按生成代码量排序的 TOP N，避免重复扫描。
      const [ov, tr, pj, us] = await Promise.all([
        httpGet(dashboardPath("/overview"), filter),
        httpGet(dashboardPath("/trends"), { ...filter, granularity: granularityFor(params.timeRange) }),
        httpGet(dashboardPath("/projects"), { ...filter, page: params.componentPage || 1, page_size: params.componentPageSize || 10, top_size: TOP_COMPONENTS }),
        httpGet(dashboardPath("/users"), { ...filter, page: params.personPage || 1, page_size: params.personPageSize || 10 }),
      ]);

      const p = ov.period;
      const summary = {
        usageCount: p.workflow_runs,
        generatedLines: p.dev_effective_lines,
        mergedLines80: p.attributed_lines_80,
        mergedLines90: p.attributed_lines_90,
        adoptionRate80: adoptionRate(p, 80),
        adoptionRate90: adoptionRate(p, 90),
      };

      const mapComponent = (r) => ({
        componentId: r.project_key,
        componentName: r.project_key,
        usageCount: r.workflow_runs,
        generatedLines: r.dev_effective_lines,
        mergedLines80: r.attributed_lines_80,
        mergedLines90: r.attributed_lines_90,
        adoptionRate80: adoptionRate(r, 80),
        adoptionRate90: adoptionRate(r, 90),
        includedInStatistics: r.included_in_statistics !== false,
      });
      const byComponent = (pj.items || []).map(mapComponent);

      const topRows = (pj.top_items || []).map(mapComponent);
      const totalComponents = pj.statistics_total ?? pj.total ?? topRows.length;
      const topGenerated = topRows.reduce((s, r) => s + r.generatedLines, 0);
      const composition = {
        top: topRows,
        totalCount: totalComponents,
        othersCount: Math.max(0, totalComponents - topRows.length),
        othersGenerated: Math.max(0, summary.generatedLines - topGenerated),
      };

      const byPerson = (us.items || []).map((r) => ({
        personId: r.git_user_name,
        personName: r.git_user_name,
        usageCount: r.workflow_runs,
        generatedLines: r.dev_effective_lines,
        mergedLines80: r.attributed_lines_80,
        mergedLines90: r.attributed_lines_90,
        adoptionRate80: adoptionRate(r, 80),
        adoptionRate90: adoptionRate(r, 90),
      }));

      const trend = (tr.points || []).map((pt) => ({
        date: pt.date,
        usageCount: pt.workflow_runs,
        generatedLines: pt.dev_effective_lines,
        mergedLines80: pt.attributed_lines_80,
        mergedLines90: pt.attributed_lines_90,
        adoptionRate80: isTestDashboard
          ? pt.mr_adoption_rate_80
          : rate(pt.attributed_lines_80, pt.dev_effective_lines),
        adoptionRate90: isTestDashboard
          ? pt.mr_adoption_rate_90
          : rate(pt.attributed_lines_90, pt.dev_effective_lines),
      }));

      // 实时运营块：overview 的 current 快照 + period 里未展示的字段（零新增请求）。
      const cur = ov.snapshot || {};
      const realtime = {
        activeWorkflows: cur.active_workflows,
        stalledWorkflows: cur.stalled_workflows,
        activityThresholdHours: cur.activity_threshold_hours,
        workflowRuns: p.workflow_runs,
        arEntryWorkflows: p.workflow_runs_by_entry?.ar ?? 0,
        srEntryWorkflows: p.workflow_runs_by_entry?.sr ?? 0,
        completedWorkflows: p.completed_workflows,
        workflowCompletionRate: p.workflow_completion_rate,
        devRuns: p.dev_runs,
        pendingAttributionDevRuns: p.pending_attribution_dev_runs,
        activeUsers: p.active_users,
        activeProjects: p.active_projects,
      };

      return {
        code: 0,
        data: {
          summary, byComponent, byPerson, trend, realtime, composition,
          componentPagination: {
            total: pj.total ?? byComponent.length,
            page: pj.page ?? 1,
            pageSize: pj.page_size ?? params.componentPageSize ?? 10,
          },
          personPagination: {
            total: us.total ?? byPerson.length,
            page: us.page ?? 1,
            pageSize: us.page_size ?? params.personPageSize ?? 10,
          },
        },
      };
    },

    // 步骤汇总：后端固定按 step_type 聚合。
    async steps(params) {
      const filter = buildFilterParams(params);
      const res = await httpGet(dashboardPath("/steps"), {
        ...filter,
        page: params.page || 1,
        page_size: params.pageSize || 10,
      });
      const d = res || {};
      return {
        code: 0,
        data: {
          total: d.total ?? (d.items || []).length,
          page: d.page ?? 1,
          pageSize: d.page_size ?? params.pageSize ?? 10,
          items: (d.items || []).map((r) => ({
            key: r.key,
            displayName: r.key,
            reached: r.reached_workflows,
            completed: r.completed_workflows,
            failed: r.failed_attempts,
            blocked: r.blocked_attempts,
            completionRate: r.completion_rate,
            medianDurationSeconds: r.duration_seconds && r.duration_seconds.p50,
            p90DurationSeconds: r.duration_seconds && r.duration_seconds.p90,
          })),
        },
      };
    },

    // 工作流明细列表（契约 §7.6）。
    async workflows(params) {
      const filter = buildFilterParams(params);
      const res = await httpGet(dashboardPath("/workflows"), {
        ...filter, state: params.state || "active",
        page: params.page || 1, page_size: params.pageSize || 10,
      });
      return {
        code: 0,
        data: {
          state: params.state || "active",
          total: res.total ?? (res.items || []).length,
          page: res.page ?? 1,
          pageSize: res.page_size ?? 50,
          items: (res.items || []).map((r) => ({
            workflowRunId: r.workflow_run_id,
            projectKey: r.project_key,
            projectDisplayName: r.project_key,
            gitUserName: r.git_user_name,
            sr: r.sr,
            ar: r.ar,
            workflowType: r.workflow_type,
            status: r.status,
            activityState: r.activity_state,
            furthestStepType: r.furthest_step_type,
            furthestStepName: r.furthest_step_type,
            startedAt: r.started_at,
            lastActivityAt: r.last_activity_at,
            devEffectiveLines: r.dev_effective_lines,
            attributedLines80: r.attributed_lines_80,
            attributedLines90: r.attributed_lines_90,
          })),
        },
      };
    },

    // 组件使用情况：全量组件 + 是否使用 AAW（契约 /dashboard/components）。
    async components(params) {
      const filter = buildFilterParams(params);
      const res = await httpGet(dashboardPath("/components"), filter);
      return {
        code: 0,
        data: {
          totalComponents: res.total_components ?? (res.items || []).length,
          usedComponents: res.used_components ?? 0,
          unassignedId: res.unassigned_component_id || "__unassigned__",
          items: (res.items || []).map((r) => ({
            componentId: r.component_id,
            componentName: r.name,
            se: r.se,
            usedAaw: Boolean(r.used_aaw),
            effectiveLines: r.effective_lines ?? 0,
            attributionRate80: r.attribution_rate_80,
          })),
        },
      };
    },

    // ── AI Master 运营 ─────────────────────────────
    async aiMasters() {
      const res = await httpGet("/ai-masters");
      return {
        code: 0,
        data: {
          items: (res.items || []).map((m) => ({
            id: m.id,
            name: m.name,
            componentCount: m.component_count ?? 0,
          })),
        },
      };
    },

    async assignments() {
      const res = await httpGet("/ai-masters/assignments");
      return {
        code: 0,
        data: { assignments: res.assignments || {} },
      };
    },

    async aiMasterOperations(params) {
      const filter = buildFilterParams(params);
      const res = await httpGet("/ai-masters/operations", filter);
      return {
        code: 0,
        data: {
          items: (res.items || []).map((c) => ({
            aiMasterId: c.ai_master_id,
            name: c.name,
            totalComponents: c.total_components ?? 0,
            tierCounts: c.tier_counts || { none: 0, three: 0, five: 0, no_data: 0 },
            lowestRequiredRate: c.lowest_required_rate ?? null,
          })),
        },
      };
    },

    async aiMasterDetail(id, params) {
      const filter = buildFilterParams(params);
      const res = await httpGet(`/ai-masters/${id}/components`, filter);
      return {
        code: 0,
        data: {
          aiMasterId: res.ai_master_id,
          name: res.name,
          items: (res.items || []).map((r) => ({
            componentId: r.component_id,
            componentName: r.name,
            se: r.se,
            usedAaw: Boolean(r.used_aaw),
            effectiveLines: r.effective_lines ?? 0,
            attributionRate80: r.attribution_rate_80,
            tier: r.tier,
          })),
        },
      };
    },

    async aiMasterCreate(name) {
      const res = await httpRequest("POST", "/ai-masters", { name });
      return { code: 0, data: { id: res.id, name: res.name } };
    },

    async aiMasterRename(id, name) {
      const res = await httpRequest("PATCH", `/ai-masters/${id}`, { name });
      return { code: 0, data: { id: res.id, name: res.name } };
    },

    async aiMasterDelete(id) {
      const res = await httpRequest("DELETE", `/ai-masters/${id}`);
      return { code: 0, data: { id: res.id, deleted: res.deleted } };
    },

    async assignComponent(componentId, aiMasterId) {
      const res = await httpRequest("PUT", `/ai-masters/assignments/${componentId}`, {
        ai_master_id: aiMasterId,
      });
      return { code: 0, data: { component_id: res.component_id, ai_master_id: res.ai_master_id } };
    },
  };

  const StatsApi = CFG.useMock ? MockApi : RealApi;

  // ═══ DATA FLOW ════════════════════════════════════════

  let reqToken = 0;
  async function onFilterChange({ resetPages = true } = {}) {
    if (resetPages) {
      state.componentPage = 1;
      state.personPage = 1;
      state.stepPage = 1;
      state.workflowPage = 1;
    }
    const token = ++reqToken;
    $(".stage").setAttribute("aria-busy", "true");
    const params = {
      components: state.selComponents,
      persons: state.selPersons,
      timeRange: state.timeRange,
      granularity: "auto",
      componentPage: state.componentPage,
      componentPageSize: state.componentPageSize,
      personPage: state.personPage,
      personPageSize: state.personPageSize,
    };

    // 三条线各自独立容错：任一接口失败只让对应段落显示空态，
    // 不牵连其它图表。主统计失败才算整页失败。
    const statsP = StatsApi.statistics(params);
    const stepsP = isTestDashboard ? Promise.resolve(null) : StatsApi.steps({
      ...params,
      page: state.stepPage,
      pageSize: state.stepPageSize,
    })
      .catch((err) => { console.error("环节接口请求失败：", err); return null; });
    const wfP = isTestDashboard ? Promise.resolve(null) : StatsApi.workflows({
      ...params,
      state: state.wfState,
      page: state.workflowPage,
      pageSize: state.workflowPageSize,
    })
      .catch((err) => { console.error("工作流接口请求失败：", err); return null; });
    const compP = isTestDashboard ? Promise.resolve(null) : StatsApi.components(params)
      .catch((err) => { console.error("组件接口请求失败：", err); return null; });
    const amMastersP = isTestDashboard ? Promise.resolve(null) : StatsApi.aiMasters()
      .catch((err) => { console.error("AI Master 名单请求失败：", err); return null; });
    const amAssignmentsP = isTestDashboard ? Promise.resolve(null) : StatsApi.assignments()
      .catch((err) => { console.error("AI Master 归属请求失败：", err); return null; });
    const amSummaryP = isTestDashboard ? Promise.resolve(null) : StatsApi.aiMasterOperations(params)
      .catch((err) => { console.error("AI Master 运营请求失败：", err); return null; });

    let res;
    try {
      res = await statsP;
    } catch (err) {
      if (token !== reqToken) return;
      console.error("统计接口请求失败：", err);
      $("#lastSync").textContent = "数据加载失败，请重试";
      $(".stage").setAttribute("aria-busy", "false");
      return;
    }
    if (token !== reqToken) return;
    if (res.code !== 0) { console.error(res.message); return; }
    state.data = res.data;

    const [steps, wf, comp, amMasters, amAssignments, amSummary] = await Promise.all([
      stepsP, wfP, compP, amMastersP, amAssignmentsP, amSummaryP,
    ]);
    if (token !== reqToken) return;
    state.stepsFailed = steps == null;
    state.workflowsFailed = wf == null;
    state.steps = steps && steps.code === 0 ? steps.data : null;
    state.workflows = wf && wf.code === 0 ? wf.data : null;
    state.componentsFailed = comp == null;
    state.components = comp && comp.code === 0 ? comp.data : null;
    state.aiMastersFailed = amMasters == null;
    state.aiMasters = amMasters && amMasters.code === 0 ? amMasters.data : null;
    state.assignments = amAssignments && amAssignments.code === 0 ? amAssignments.data.assignments : {};
    state.amSummaryFailed = amSummary == null;
    state.amSummary = amSummary && amSummary.code === 0 ? amSummary.data : null;
    // 明细视图依赖选中的 AI Master，换主过滤后让用户重新选择。
    state.amDetail = null;
    state.amDetailFailed = false;

    paintAll();
    $(".stage").setAttribute("aria-busy", "false");
    stampSync();
  }

  // 仅重取步骤数据（翻页或调整每页条数时用），不动其它区域。
  async function refetchSteps() {
    const token = reqToken;
    let steps;
    try {
      steps = await StatsApi.steps({
        components: state.selComponents,
        persons: state.selPersons,
        timeRange: state.timeRange,
        page: state.stepPage,
        pageSize: state.stepPageSize,
      });
    } catch (err) {
      console.error("环节接口请求失败：", err);
      steps = null;
    }
    if (token !== reqToken) return;
    state.stepsFailed = steps == null;
    state.steps = steps && steps.code === 0 ? steps.data : null;
    renderSteps();
  }

  // 仅重取工作流明细（切 active/stalled/completed 时用）。
  async function refetchWorkflows() {
    const token = reqToken;
    let wf;
    try {
      wf = await StatsApi.workflows({
        components: state.selComponents,
        persons: state.selPersons,
        timeRange: state.timeRange,
        state: state.wfState,
        page: state.workflowPage,
        pageSize: state.workflowPageSize,
      });
    } catch (err) {
      console.error("工作流接口请求失败：", err);
      wf = null;
    }
    if (token !== reqToken) return;
    state.workflowsFailed = wf == null;
    state.workflows = wf && wf.code === 0 ? wf.data : null;
    renderWorkflows();
  }

  // 仅重取组件使用情况（空态重试用）。
  async function refetchComponents() {
    const token = reqToken;
    let comp;
    try {
      comp = await StatsApi.components({
        components: state.selComponents,
        persons: state.selPersons,
        timeRange: state.timeRange,
      });
    } catch (err) {
      console.error("组件接口请求失败：", err);
      comp = null;
    }
    if (token !== reqToken) return;
    state.componentsFailed = comp == null;
    state.components = comp && comp.code === 0 ? comp.data : null;
    renderComponents();
  }

  // 仅重取 AI Master 名单 + 聚合（空态重试用）；明细在子逻辑里单独拉。
  async function refetchAmSummary() {
    const token = reqToken;
    const params = {
      components: state.selComponents,
      persons: state.selPersons,
      timeRange: state.timeRange,
    };
    let masters;
    let summary;
    try {
      [masters, summary] = await Promise.all([
        StatsApi.aiMasters(),
        StatsApi.aiMasterOperations(params),
      ]);
    } catch (err) {
      console.error("AI Master 运营请求失败：", err);
      masters = null;
      summary = null;
    }
    if (token !== reqToken) return;
    state.aiMastersFailed = masters == null;
    state.aiMasters = masters && masters.code === 0 ? masters.data : null;
    state.amSummaryFailed = summary == null;
    state.amSummary = summary && summary.code === 0 ? summary.data : null;
    renderAiMaster();
  }

  function stampSync() {
    const now = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const rangeLabel = (state.options.timeRanges.find((t) => t.value === state.timeRange) || {}).label || "";
    $("#lastSync").textContent = `窗口 ${rangeLabel} · 同步于 ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
  }

  // ═══ PAINT ════════════════════════════════════════════

  function paintAll() {
    paintHero();
    renderDial();
    renderTrend();
    renderComponentCompo();
    renderPersonBars();
    renderLedger();
    if (!isTestDashboard) {
      renderRealtime();
      renderSteps();
      renderWorkflows();
      renderComponents();
      renderAiMaster();
    }
  }

  function paintHero() {
    const s = state.data.summary;
    $("#factUse").textContent = fmtFull(s.usageCount);
    $("#factGen").textContent = fmtFull(s.generatedLines);
    $("#factM80").textContent = fmtFull(s.mergedLines80);
    $("#factM90").textContent = fmtFull(s.mergedLines90);
    $("#dialVal").textContent = fmtPct(s.adoptionRate80);
    $("#dialVal90").textContent = `90% 一致 ${fmtPct(s.adoptionRate90)}`;
  }

  // ── signature dial (bright "sprout" arc) ───────────────
  let dialAnim = null;
  function renderDial() {
    const canvas = $("#dialCanvas");
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const size = 340;
    canvas.width = size * dpr; canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cx = size / 2, cy = size / 2;
    const START = Math.PI * 0.75, SWEEP = Math.PI * 1.5;   // 270° arc
    const r80 = 128, r90 = 96;
    const target80 = state.data.summary.adoptionRate80 ?? 0;
    const target90 = state.data.summary.adoptionRate90 ?? 0;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let t = reduce ? 1 : 0;
    if (dialAnim) cancelAnimationFrame(dialAnim);

    function ring(r, frac, colorStops, width, trackColor) {
      // track shows the "not yet merged" remainder
      ctx.beginPath();
      ctx.strokeStyle = trackColor;
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      ctx.arc(cx, cy, r, START, START + SWEEP);
      ctx.stroke();
      // filled value
      const grad = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
      grad.addColorStop(0, colorStops[0]);
      grad.addColorStop(1, colorStops[1]);
      ctx.beginPath();
      ctx.strokeStyle = grad;
      ctx.shadowColor = colorStops[1];
      ctx.shadowBlur = 18;
      ctx.lineWidth = width;
      ctx.arc(cx, cy, r, START, START + SWEEP * Math.min(frac, 1));
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // soft tick dots every 10%
    function ticks(r) {
      for (let i = 0; i <= 10; i++) {
        const a = START + SWEEP * (i / 10);
        const rr = r + 24;
        ctx.beginPath();
        ctx.fillStyle = i % 5 === 0 ? C.inkMute : C.edge2;
        ctx.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, i % 5 === 0 ? 2.4 : 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function frame() {
      ctx.clearRect(0, 0, size, size);
      ticks(r80);
      ring(r80, target80 * t, [C.grass, C.grassDeep], 20, "rgba(255,122,26,.16)");
      ring(r90, target90 * t, [C.magenta, "#d81f6c"], 14, "rgba(255,61,139,.12)");
      if (t < 1) { t = Math.min(1, t + 0.045); dialAnim = requestAnimationFrame(frame); }
    }
    frame();
  }

  // ── trend line ─────────────────────────────────────────
  function ensureChart(id, renderer = "canvas") {
    if (!charts[id]) charts[id] = echarts.init(document.getElementById(id), null, { renderer });
    return charts[id];
  }
  const gridBase = { left: 8, right: 20, top: 28, bottom: 8, containLabel: true };
  const axisText = { color: C.inkMute, fontFamily: FONT_MONO, fontSize: 11 };
  const splitLine = { lineStyle: { color: "rgba(0,0,0,.06)" } };

  function tooltipBase() {
    return {
      backgroundColor: "#ffffff",
      borderColor: C.edge2,
      borderWidth: 1,
      padding: [10, 14],
      textStyle: { color: C.ink, fontFamily: FONT_MONO, fontSize: 12 },
      extraCssText: "border-radius:12px;box-shadow:0 18px 44px -18px rgba(30,26,60,.35);",
    };
  }

  function renderTrend() {
    const chart = ensureChart("trendChart");
    const m = state.trendMetric;
    const meta = METRICS[m];
    const pts = state.data.trend;
    const isPct = meta.kind === "pct";

    chart.setOption({
      grid: gridBase,
      tooltip: {
        trigger: "axis",
        ...tooltipBase(),
        axisPointer: { type: "line", lineStyle: { color: C.edge2 } },
        valueFormatter: (v) => (isPct ? fmtPct(v) : fmtFull(v)),
      },
      xAxis: {
        type: "category",
        data: pts.map((p) => p.date),
        boundaryGap: false,
        axisLine: { lineStyle: { color: C.edge2 } },
        axisTick: { show: false },
        axisLabel: { ...axisText, hideOverlap: true },
      },
      yAxis: {
        type: "value",
        axisLabel: { ...axisText, formatter: (v) => (isPct ? (v * 100).toFixed(0) + "%" : fmtInt(v)) },
        splitLine,
      },
      series: [{
        name: meta.label,
        type: "line",
        smooth: 0.35,
        symbol: "circle",
        symbolSize: 7,
        showSymbol: false,
        data: pts.map((p) => p[m]),
        lineStyle: { width: 3, color: meta.color },
        itemStyle: { color: meta.color, borderColor: "#fff", borderWidth: 2 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: hexA(meta.color, 0.24) },
            { offset: 1, color: hexA(meta.color, 0.01) },
          ]),
        },
      }],
      animationDuration: 600,
    }, true);
  }

  // ── component composition: strip + TOP ranking ─────────
  // 100+ 组件时饼图会退化成噪声，这里改为「构成带 + TOP 排名 + 其余折叠」。
  const OTHERS_COLOR = "#C6CBD6";
  function renderComponentCompo() {
    const mount = document.getElementById("componentCompo");
    const palette = [C.iris, C.grass, C.tangerine, C.magenta, C.sky, C.iris2, C.grass2];
    const compo = state.data.composition || { top: [], totalCount: 0, othersCount: 0, othersGenerated: 0 };
    const total = state.data.summary.generatedLines || 0;

    $("#compoHint").textContent = compo.othersCount > 0
      ? `按生成代码量 · TOP ${compo.top.length} / 共 ${compo.totalCount} 个组件`
      : `按生成代码量占比 · 共 ${compo.totalCount} 个组件`;

    if (!compo.top.length || !total) {
      mount.innerHTML = `<p class="compo__empty">当前筛选下暂无组件数据</p>`;
      return;
    }

    const segs = compo.top.map((r, i) => ({
      name: r.componentName, value: r.generatedLines, color: palette[i % palette.length],
    }));
    if (compo.othersCount > 0 && compo.othersGenerated > 0) {
      segs.push({
        name: `其余 ${compo.othersCount} 个组件`,
        value: compo.othersGenerated,
        color: OTHERS_COLOR,
        others: true,
      });
    }

    const share = (v) => {
      const p = (v / total) * 100;
      return p > 0 && p < 0.1 ? "<0.1%" : p.toFixed(1) + "%";
    };
    const max = Math.max(...segs.map((s) => s.value), 1);

    mount.innerHTML = `
      <div class="compo__strip" aria-hidden="true">
        ${segs.map((s, i) =>
          `<span class="compo__seg" data-idx="${i}" style="flex-grow:${s.value};background:${s.color}" title="${esc(s.name)} · ${share(s.value)}"></span>`
        ).join("")}
      </div>
      <ol class="compo__rows">
        ${segs.map((s, i) => `
          <li class="compo__row${s.others ? " compo__row--others" : ""}" data-idx="${i}">
            <span class="compo__rank">${s.others ? "···" : String(i + 1).padStart(2, "0")}</span>
            <span class="compo__name" title="${esc(s.name)}">${esc(s.name)}</span>
            <span class="compo__meter"><i style="width:${((s.value / max) * 100).toFixed(2)}%;background:${s.color}"></i></span>
            <span class="compo__share">${share(s.value)}</span>
            <span class="compo__lines">${fmtInt(s.value)}</span>
          </li>`).join("")}
      </ol>`;

    // strip ↔ row hover sync（委托绑定一次即可）
    if (!mount.dataset.hoverBound) {
      mount.dataset.hoverBound = "1";
      const setHot = (idx) => {
        mount.querySelectorAll(".is-hot").forEach((el) => el.classList.remove("is-hot"));
        if (idx != null) mount.querySelectorAll(`[data-idx="${idx}"]`).forEach((el) => el.classList.add("is-hot"));
      };
      mount.addEventListener("mouseover", (e) => {
        const el = e.target.closest("[data-idx]");
        setHot(el ? el.dataset.idx : null);
      });
      mount.addEventListener("mouseleave", () => setHot(null));
    }
  }

  // ── person output: generated vs merged stacked bars ────
  function renderPagination(containerId, pagination, onPage, onPageSize) {
    const wrap = document.getElementById(containerId);
    if (!wrap) return;
    const total = Math.max(0, Number(pagination && pagination.total) || 0);
    const pageSize = Math.max(1, Number(pagination && pagination.pageSize) || 10);
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(pageCount, Math.max(1, Number(pagination && pagination.page) || 1));
    wrap.innerHTML = `
      <button type="button" class="pager__btn" data-page="prev" ${page <= 1 ? "disabled" : ""}>上一页</button>
      <span class="pager__summary">第 ${page} / ${pageCount} 页 · 共 ${total} 条</span>
      <button type="button" class="pager__btn" data-page="next" ${page >= pageCount ? "disabled" : ""}>下一页</button>
      <label>每页
        <select class="pager__size" aria-label="每页条数">
          ${[10, 20, 50].map((size) => `<option value="${size}" ${size === pageSize ? "selected" : ""}>${size}</option>`).join("")}
        </select>
      </label>`;
    wrap.querySelector('[data-page="prev"]').addEventListener("click", () => onPage(page - 1));
    wrap.querySelector('[data-page="next"]').addEventListener("click", () => onPage(page + 1));
    wrap.querySelector(".pager__size").addEventListener("change", (event) => {
      onPageSize(Number(event.target.value));
    });
  }

  function renderPersonBars() {
    // SVG keeps person names as real text nodes so users can select and copy them.
    const chart = ensureChart("personChart", "svg");
    const rows = [...state.data.byPerson]
      .sort((a, b) => b.generatedLines - a.generatedLines)
      .reverse();

    renderPagination("personPager", state.data.personPagination, (page) => {
      state.personPage = page;
      onFilterChange({ resetPages: false });
    }, (pageSize) => {
      state.personPage = 1;
      state.personPageSize = pageSize;
      onFilterChange({ resetPages: false });
    });

    chart.setOption({
      grid: { ...gridBase, left: 8, right: 30 },
      tooltip: {
        trigger: "axis",
        ...tooltipBase(),
        axisPointer: { type: "shadow", shadowStyle: { color: "rgba(75,63,228,.06)" } },
        formatter: (arr) => {
          const name = arr[0].axisValue;
          const line = (s) => `${s.marker}${s.seriesName} <b>${fmtFull(s.value)}</b>`;
          return `${name}<br/>${arr.map(line).join("<br/>")}`;
        },
      },
      legend: {
        top: 0, right: 0,
        itemWidth: 11, itemHeight: 11,
        icon: "roundRect",
        textStyle: { color: C.inkSoft, fontFamily: FONT_MONO, fontSize: 11 },
        data: ["合入·80%", "仅生成未合入"],
      },
      xAxis: {
        type: "value",
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { ...axisText, formatter: fmtInt },
        splitLine,
      },
      yAxis: {
        type: "category",
        data: rows.map((r) => r.personName),
        axisLine: { lineStyle: { color: C.edge2 } },
        axisTick: { show: false },
        axisLabel: { color: C.inkSoft, fontFamily: FONT_MONO, fontSize: 12 },
      },
      series: [
        {
          name: "合入·80%",
          type: "bar",
          stack: "out",
          barWidth: "58%",
          data: rows.map((r) => r.mergedLines80),
          itemStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
              { offset: 0, color: C.grassDeep }, { offset: 1, color: C.grass2 },
            ]),
            borderRadius: [6, 0, 0, 6],
          },
        },
        {
          name: "仅生成未合入",
          type: "bar",
          stack: "out",
          data: rows.map((r) => Math.max(0, r.generatedLines - r.mergedLines80)),
          itemStyle: {
            color: "rgba(255,122,26,.22)",
            borderColor: hexA(C.tangerine, 0.55),
            borderWidth: 1,
            borderRadius: [0, 6, 6, 0],
          },
        },
      ],
      animationDuration: 600,
    }, true);
  }

  // ── ledger table ───────────────────────────────────────
  const DOTS = ["#4B3FE4", "#12C46B", "#FF7A1A", "#FF3D8B", "#2BB3FF", "#7C74FF", "#34E08A", "#B26BFF"];
  function renderLedger() {
    const body = $("#ledgerBody");
    const rows = [...state.data.byComponent].sort((a, b) => {
      const dir = state.sortOrder === "asc" ? 1 : -1;
      return (a[state.sortBy] - b[state.sortBy]) * dir;
    });
    const pagination = state.data.componentPagination || {};
    $("#tableCount").textContent = `${pagination.total ?? rows.length} 个组件`;
    renderPagination("componentPager", pagination, (page) => {
      state.componentPage = page;
      onFilterChange({ resetPages: false });
    }, (pageSize) => {
      state.componentPage = 1;
      state.componentPageSize = pageSize;
      onFilterChange({ resetPages: false });
    });

    body.innerHTML = "";
    rows.forEach((r, i) => {
      const tr = document.createElement("tr");
      const included = r.includedInStatistics !== false;
      if (!included) tr.className = "ledger-row--not-statistic";
      const status = included
        ? ""
        : '<span class="statistics-badge">未纳入统计</span>';
      tr.innerHTML = `
        <td class="td-name" style="--dot:${DOTS[i % DOTS.length]}">
          <span class="component-label">${esc(r.componentName)}${status}</span>
        </td>
        <td>${fmtFull(r.usageCount)}</td>
        <td>${fmtFull(r.generatedLines)}</td>
        <td>${fmtFull(r.mergedLines80)}</td>
        <td>${fmtFull(r.mergedLines90)}</td>
        <td>${included ? rateCell(r.adoptionRate80, "80") : excludedRateCell()}</td>
        <td>${included ? rateCell(r.adoptionRate90, "90") : excludedRateCell()}</td>`;
      body.appendChild(tr);
    });

    document.querySelectorAll(".ledger .th-num").forEach((th) => {
      th.removeAttribute("data-active");
      if (th.dataset.sort === state.sortBy) {
        th.setAttribute("data-active", state.sortOrder === "asc" ? "↑" : "↓");
      }
    });
  }
  function rateCell(rate, which) {
    if (rate == null) return '<span class="rate rate--na">—</span>';
    const cls = which === "90" ? "rate rate--90" : "rate";
    return `<span class="${cls}">
      <span class="rate__bar"><i style="--w:${(rate * 100).toFixed(1)}%"></i></span>
      <span class="rate__v">${fmtPct(rate)}</span></span>`;
  }
  function excludedRateCell() {
    return '<span class="rate rate--na" title="未纳入统计">—</span>';
  }

  function bindSort() {
    document.querySelectorAll(".ledger .th-num[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (state.sortBy === key) {
          state.sortOrder = state.sortOrder === "asc" ? "desc" : "asc";
        } else {
          state.sortBy = key; state.sortOrder = "desc";
        }
        renderLedger();
      });
    });
  }

  // ══ ① NOW · realtime operations ════════════════════════
  function renderRealtime() {
    const rt = state.data.realtime;
    if (!rt) return;
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set("#stActive", fmtFull(rt.activeWorkflows ?? 0));
    set("#stActiveSub", `${fmtFull(rt.activeUsers ?? 0)} 人 · ${fmtFull(rt.activeProjects ?? 0)} 组件在跑`);
    set("#stStalled", fmtFull(rt.stalledWorkflows ?? 0));
    set("#stStalledSub", `超过 ${rt.activityThresholdHours ?? 24}h 无活动`);
    set("#stPending", fmtFull(rt.pendingAttributionDevRuns ?? 0));
    set("#stComplete", fmtPct(rt.workflowCompletionRate ?? 0));
    set("#stCompleteSub", `${fmtFull(rt.completedWorkflows ?? 0)} / ${fmtFull(rt.workflowRuns ?? 0)} 已完成`);
    set("#stArEntry", fmtFull(rt.arEntryWorkflows ?? 0));
    set("#stSrEntry", fmtFull(rt.srEntryWorkflows ?? 0));

    // 仅在停滞>0 时点亮琥珀告警——平时保持安静。
    const stone = $("#stStalledStone");
    if (stone) stone.classList.toggle("stone--alert", (rt.stalledWorkflows ?? 0) > 0);
  }

  // ══ ② PIPELINE · step efficiency ════════════════════════
  function renderSteps() {
    renderStepFunnel();
    renderStepLedger();
    renderPagination("stepPager", state.steps, (page) => {
      state.stepPage = page;
      refetchSteps();
    }, (pageSize) => {
      state.stepPage = 1;
      state.stepPageSize = pageSize;
      refetchSteps();
    });
  }

  function renderStepFunnel() {
    const chart = ensureChart("stepFunnel");
    const items = (state.steps && state.steps.items) || [];
    if (!items.length) {
      const msg = state.stepsFailed ? "步骤数据加载失败" : "暂无步骤数据";
      chart.clear();
      chart.setOption({
        graphic: {
          type: "text", left: "center", top: "center",
          style: { text: msg, fill: C.inkMute, fontFamily: FONT_MONO, fontSize: 13 },
        },
      });
      return;
    }
    // y 轴自上而下按流程顺序，故反转（echarts category 底部为首项）。
    const rows = [...items].reverse();
    // 高度随步骤数自适应：漏斗承载完整流程序列，行数增多时保持每行呼吸感。
    const dom = chart.getDom();
    const wantHeight = Math.max(300, rows.length * 30 + 70);
    if (dom.clientHeight !== wantHeight) {
      dom.style.height = wantHeight + "px";
      chart.resize();
    }
    chart.setOption({
      grid: { ...gridBase, left: 8, right: 24, top: 16 },
      tooltip: {
        trigger: "axis",
        ...tooltipBase(),
        axisPointer: { type: "shadow", shadowStyle: { color: "rgba(75,63,228,.06)" } },
        formatter: (arr) => {
          const name = arr[0].axisValue;
          return `${name}<br/>${arr.map((s) => `${s.marker}${s.seriesName} <b>${fmtFull(s.value)}</b>`).join("<br/>")}`;
        },
      },
      legend: {
        top: 0, right: 0,
        itemWidth: 11, itemHeight: 11, icon: "roundRect",
        textStyle: { color: C.inkSoft, fontFamily: FONT_MONO, fontSize: 11 },
        data: ["完成", "阻塞", "失败"],
      },
      xAxis: {
        type: "value",
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { ...axisText, formatter: fmtInt }, splitLine,
      },
      yAxis: {
        type: "category",
        data: rows.map((r) => r.displayName),
        axisLine: { lineStyle: { color: C.edge2 } }, axisTick: { show: false },
        axisLabel: { color: C.inkSoft, fontFamily: FONT_MONO, fontSize: 11.5 },
      },
      series: [
        {
          name: "完成", type: "bar", stack: "s", barWidth: "56%",
          data: rows.map((r) => r.completed),
          itemStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
              { offset: 0, color: C.grassDeep }, { offset: 1, color: C.grass2 },
            ]),
            borderRadius: [6, 0, 0, 6],
          },
        },
        {
          name: "阻塞", type: "bar", stack: "s",
          data: rows.map((r) => r.blocked),
          itemStyle: { color: hexA(C.tangerine, 0.55) },
        },
        {
          name: "失败", type: "bar", stack: "s",
          data: rows.map((r) => r.failed),
          itemStyle: { color: hexA(C.magenta, 0.6), borderRadius: [0, 6, 6, 0] },
        },
      ],
      animationDuration: 600,
    }, true);
  }

  function renderStepLedger() {
    const body = $("#stepBody");
    if (!body) return;
    const items = (state.steps && state.steps.items) || [];
    body.innerHTML = "";
    if (!items.length) {
      const msg = state.stepsFailed
        ? `步骤数据加载失败，<button type="button" class="retry-link" data-retry="steps">重试</button>`
        : "当前筛选下暂无步骤数据";
      body.innerHTML = `<tr class="empty-row"><td colspan="5">${msg}</td></tr>`;
      return;
    }
    items.forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="td-name">${esc(r.displayName)}</td>
        <td>${fmtFull(r.reached)}</td>
        <td>${fmtPct(r.completionRate)}</td>
        <td class="dur">${fmtDur(r.medianDurationSeconds)}</td>
        <td class="dur">${fmtDur(r.p90DurationSeconds)}</td>`;
      body.appendChild(tr);
    });
  }

  // ══ ③ RUNS · workflow instances ════════════════════════
  const WF_STATE_META = {
    active:    { label: "进行中",   heading: "进行中的工作流", badge: "badge--active" },
    stalled:   { label: "已停滞",   heading: "停滞的工作流",   badge: "badge--stalled" },
    completed: { label: "已完成",   heading: "已完成的工作流", badge: "badge--completed" },
  };

  const WF_ENTRY_META = {
    ar:      { label: "AR入口", badge: "badge--entry-ar" },
    sr:      { label: "SR入口", badge: "badge--entry-sr" },
    unknown: { label: "未知",   badge: "badge--entry-unknown" },
  };

  function workflowEntryMeta(value) {
    return WF_ENTRY_META[value] || WF_ENTRY_META.unknown;
  }

  function workflowStateMeta(row) {
    const stateFromBackend = row.activityState
      || (row.status === "completed" ? "completed" : null)
      || (row.status === "in_progress" ? "active" : null);
    return WF_STATE_META[stateFromBackend] || WF_STATE_META.active;
  }

  function renderWorkflows() {
    const body = $("#wfBody");
    if (!body) return;
    const items = (state.workflows && state.workflows.items) || [];
    const meta = WF_STATE_META[state.wfState] || WF_STATE_META.active;
    $("#wfHeading").textContent = meta.heading;
    const total = state.workflows && state.workflows.total;
    $("#wfCount").textContent = state.workflowsFailed
      ? "—"
      : `${total ?? items.length} 条`;
    renderPagination("wfPager", state.workflows, (page) => {
      state.workflowPage = page;
      refetchWorkflows();
    }, (pageSize) => {
      state.workflowPage = 1;
      state.workflowPageSize = pageSize;
      refetchWorkflows();
    });

    body.innerHTML = "";
    if (!items.length) {
      const msg = state.workflowsFailed
        ? `工作流数据加载失败，<button type="button" class="retry-link" data-retry="workflows">重试</button>`
        : `当前筛选下暂无${meta.label}工作流`;
      body.innerHTML = `<tr class="empty-row"><td colspan="7">${msg}</td></tr>`;
      return;
    }
    items.forEach((r) => {
      const rowMeta = workflowStateMeta(r);
      const entryMeta = workflowEntryMeta(r.workflowType);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="td-name">
          <span class="wf-id">
            <strong>${esc(r.sr || r.workflowRunId)}</strong>
            <span>${r.ar ? esc(r.ar) + " · " : ""}${esc(r.workflowRunId)}</span>
          </span>
        </td>
        <td><span class="badge ${entryMeta.badge}">${entryMeta.label}</span></td>
        <td class="td-name">
          <span class="wf-who">
            <strong>${esc(r.gitUserName || "—")}</strong>
            <span>${esc(r.projectDisplayName || r.projectKey || "—")}</span>
          </span>
        </td>
        <td class="td-name"><span class="step-chip">${esc(r.furthestStepName || r.furthestStepType || "—")}</span></td>
        <td>${fmtFull(r.devEffectiveLines)}</td>
        <td>${fmtFull(r.attributedLines80)}</td>
        <td class="wf-time">
          <span class="badge ${rowMeta.badge}">${rowMeta.label}</span>
          <span style="display:block;margin-top:4px">${fmtAgo(r.lastActivityAt)}</span>
        </td>`;
      body.appendChild(tr);
    });
  }

  function buildWfStateToggle() {
    const wrap = $("#wfStateToggle");
    if (!wrap) return;
    wrap.innerHTML = "";
    ["active", "stalled", "completed"].forEach((s) => {
      const b = document.createElement("button");
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(s === state.wfState));
      b.textContent = WF_STATE_META[s].label;
      b.addEventListener("click", () => {
        if (state.wfState === s) return;
        state.wfState = s;
        state.workflowPage = 1;
        wrap.querySelectorAll("button").forEach((x) =>
          x.setAttribute("aria-selected", String(x === b)));
        refetchWorkflows();
      });
      wrap.appendChild(b);
    });
  }

  // ══ COMPONENTS · 组件使用情况 ═══════════════════════════
  // SE 选项来自当前数据（配置全量组件，集合恒定）；每次渲染重建，
  // 已选值与新选项取交集，避免配置变更后残留失效选项。
  function syncCompSeOptions() {
    const mount = document.getElementById("fCompSe");
    if (!mount) return;
    const data = state.components;
    const names = [...new Set((data && data.items || [])
      .map((r) => r.se)
      .filter((se) => se != null && se !== ""))]
      .sort((a, b) => a.localeCompare(b, "zh-CN"));
    const signature = names.join("\u0001");
    if (mount.dataset.signature === signature) return;   // 选项未变则不重建 DOM
    mount.dataset.signature = signature;
    state.compSe = state.compSe.filter((se) => names.includes(se));   // 交集保留
    buildMultiSelect(
      "fCompSe",
      names.map((se) => ({ id: se, name: se })),
      () => state.compSe,
      (v) => { state.compSe = v; },
      "SE",
      renderComponents      // 纯前端过滤，不触发 onFilterChange
    );
  }

  const COMP_USED_OPTIONS = [
    { value: "all", label: "全部" },
    { value: "used", label: "已使用" },
    { value: "unused", label: "未使用" },
  ];

  function buildCompUsedSegs() {
    const wrap = document.getElementById("fCompUsed");
    if (!wrap) return;
    wrap.innerHTML = "";
    COMP_USED_OPTIONS.forEach((opt) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(opt.value === state.compUsed));
      b.textContent = opt.label;
      b.addEventListener("click", () => {
        state.compUsed = opt.value;
        wrap.querySelectorAll("button").forEach((x) =>
          x.setAttribute("aria-checked", String(x === b)));
        renderComponents();
      });
      wrap.appendChild(b);
    });
  }

  // 未归类组件恒定沉底，不参与排序；其余按当前列排序，空值排最后。
  function componentRows() {
    const data = state.components;
    if (!data) return { rows: [], unassigned: null };
    const unassignedId = data.unassignedId || "__unassigned__";
    const q = state.compQuery.trim().toLocaleLowerCase("zh-CN");
    const seSel = state.compSe;
    const masterSel = state.compMaster;
    const used = state.compUsed;
    // SE 未归类行（se 为 null）在 SE 筛选生效时天然被排除。
    const match = (r) => {
      if (q && !String(r.componentName ?? "").toLocaleLowerCase("zh-CN").includes(q)) return false;
      if (seSel.length && !seSel.includes(r.se)) return false;
      if (masterSel.length && !masterSel.includes(masterOf(r.componentId).masterName)) return false;
      if (used === "used" && !r.usedAaw) return false;
      if (used === "unused" && r.usedAaw) return false;
      return true;
    };

    const all = (data.items || []).filter(match);
    const unassigned = all.find((r) => r.componentId === unassignedId) || null;
    const rows = all.filter((r) => r.componentId !== unassignedId);

    const key = state.compSort;
    const dir = state.compOrder === "asc" ? 1 : -1;
    const val = (r) => {
      let v = r[key];
      if (key === "masterName") v = masterOf(r.componentId).masterName;
      if (v == null) return null;
      if (typeof v === "string") return v;
      return typeof v === "boolean" ? (v ? 1 : 0) : Number(v);
    };
    const cmp = (a, b) => {
      const va = val(a), vb = val(b);
      if (va == null && vb == null) return byName(a, b);
      if (va == null) return 1;          // 空值恒排最后
      if (vb == null) return -1;
      if (typeof va === "string" || typeof vb === "string") {
        return String(va).localeCompare(String(vb), "zh-CN") * dir;
      }
      if (va === vb) return byName(a, b);
      return (va - vb) * dir;
    };
    rows.sort(cmp);
    return { rows, unassigned };
  }
  const byName = (a, b) =>
    String(a.componentName ?? "").localeCompare(String(b.componentName ?? ""), "zh-CN");

  function renderComponents() {
    const body = $("#compBody");
    if (!body) return;

    const data = state.components;
    const note = $("#compUsageNote");
    if (note) {
      if (!data) {
        note.textContent = "—";
      } else {
        const total = data.totalComponents ?? 0;
        const used = data.usedComponents ?? 0;
        note.textContent = `已使用 ${fmtFull(used)} / 全量 ${fmtFull(total)} 个组件（覆盖率 ${fmtPct(total ? used / total : null)}）`;
      }
    }

    // 先同步 SE 选项（可能裁剪失效的已选值），再据最终筛选态计算行。
    syncCompSeOptions();

    const { rows, unassigned } = componentRows();
    const list = unassigned ? [...rows, unassigned] : rows;

    body.innerHTML = "";
    if (!list.length) {
      const hasFilter = !!state.compQuery.trim() || state.compSe.length > 0 || state.compMaster.length > 0 || state.compUsed !== "all";
      let msg;
      if (state.componentsFailed) {
        msg = `组件数据加载失败，<button type="button" class="retry-link" data-retry="components">重试</button>`;
      } else if (hasFilter) {
        msg = "没有匹配的组件";
      } else {
        msg = "当前筛选下暂无组件数据";
      }
      body.innerHTML = `<tr class="empty-row"><td colspan="6">${msg}</td></tr>`;
      syncCompSortIndicator();
      return;
    }

    const unassignedId = (data && data.unassignedId) || "__unassigned__";
    list.forEach((r) => {
      const tr = document.createElement("tr");
      const isUnassignedRow = r.componentId === unassignedId;
      if (isUnassignedRow) tr.className = "comp-row--unassigned";
      const used = r.usedAaw
        ? '<span class="used-yes">是</span>'
        : '<span class="used-no">否</span>';
      tr.innerHTML = `
        <td class="td-name">${esc(r.componentName)}</td>
        <td class="td-name">${r.se ? esc(r.se) : "—"}</td>
        <td class="td-name">${masterNameText(r, isUnassignedRow)}</td>
        <td>${used}</td>
        <td>${fmtFull(r.effectiveLines ?? 0)}</td>
        <td>${rateCell(r.attributionRate80, "80")}</td>`;
      body.appendChild(tr);
    });
    syncCompSortIndicator();
  }

  // 组件表格的归属列为只读展示（不可编辑）；归属调整统一在名单管理弹窗里做。
  function masterNameText(r, isUnassignedRow) {
    if (isUnassignedRow) return "—";
    const { masterName } = masterOf(r.componentId);
    return masterName ? esc(masterName) : "未分配";
  }

  // 推导某组件的所属 AI Master（归属映射 + 名单合并；组件表格用）。
  function masterOf(componentId) {
    const masterId = (state.assignments || {})[componentId] || null;
    const master = (state.aiMasters && state.aiMasters.items || [])
      .find((m) => m.id === masterId) || null;
    return { masterId: master ? master.id : (masterId || null), masterName: master ? master.name : null };
  }

  // AI Master 单元格：已加载名单时渲染下拉（可直接改挂），否则仅纯文本展示。
  // 已分配组件只能改挂到其它 AI Master，不能清空回"未分配"；
  // 未分配组件（含首挂）用禁用占位项提示，选中任一 AI Master 即完成首挂。
  function masterCell(r, isUnassignedRow) {
    const masters = (state.aiMasters && state.aiMasters.items) || [];
    const { masterId, masterName } = masterOf(r.componentId);
    if (isUnassignedRow || !masters.length) {
      return masterName ? esc(masterName) : "未分配";
    }
    const opts = masters.map((m) =>
      `<option value="${esc(m.id)}" ${masterId === m.id ? "selected" : ""}>${esc(m.name)}</option>`
    );
    if (!masterId) {
      opts.unshift('<option value="" disabled>未分配</option>');   // 不可回选，仅占位
    }
    return `<select class="comp-master-select" data-component-id="${esc(r.componentId)}" data-previous="${esc(masterId || "")}" aria-label="所属 AI Master">${opts.join("")}</select>`;
  }

  function syncCompSortIndicator() {
    document.querySelectorAll(".ledger--comp th[data-comp-sort]").forEach((th) => {
      th.removeAttribute("data-active");
      if (th.dataset.compSort === state.compSort) {
        th.setAttribute("data-active", state.compOrder === "asc" ? "↑" : "↓");
      }
    });
  }

  // ══ AI MASTER · 运营 ═════════════════════════════════╗
  const AM_TIER_LABEL = {
    none: "无要求",
    three: "需≥3",
    five: "需≥5",
    no_data: "无数据",
  };

  function tierBadge(tier) {
    const label = AM_TIER_LABEL[tier] || "无数据";
    return `<span class="am-tier am-tier--${tier}">${esc(label)}</span>`;
  }

  // 组件表格的 AI Master 筛选项（多选），来自名单，按名字排序。
  function syncCompMasterOptions() {
    const mount = document.getElementById("fCompMaster");
    if (!mount) return;
    const masters = (state.aiMasters && state.aiMasters.items) || [];
    const names = masters.map((m) => m.name).sort((a, b) => a.localeCompare(b, "zh-CN"));
    const signature = names.join("\u0001");
    if (mount.dataset.signature === signature) return;
    mount.dataset.signature = signature;
    state.compMaster = state.compMaster.filter((name) => names.includes(name));
    buildMultiSelect(
      "fCompMaster",
      masters.map((m) => ({ id: m.name, name: m.name })),
      () => state.compMaster,
      (v) => { state.compMaster = v; },
      "AI Master",
      renderComponents      // 纯前端过滤，不触发 onFilterChange
    );
  }

  // 运营页总入口：渲染聚合卡/明细、弹窗名单与归属列表，并在子 tab 间切换。
  function renderAiMaster() {
    renderAmMasterList();
    syncCompMasterOptions();
    syncAmMasterSelect();
    syncAssignFilters();
    renderAssignList();
    const note = $("#amNote");
    if (note) {
      const masters = (state.aiMasters && state.aiMasters.items) || [];
      const summary = state.amSummary && state.amSummary.items || [];
      const handled = summary.filter((c) => c.aiMasterId).length;
      const unassigned = summary.find((c) => !c.aiMasterId);
      let parts = `${fmtFull(masters.length)} 位 AI Master`;
      if (summary.length) parts += ` · 已分配 ${fmtFull(handled)} 个组件`;
      if (unassigned && unassigned.totalComponents > 0) {
        parts += ` · 未分配 ${fmtFull(unassigned.totalComponents)} 个`;
      }
      note.textContent = parts;
    }
    applyAmSubTab();
    if (state.amSubTab === "summary") {
      renderAmSummary();
    } else {
      renderAmDetail();
    }
  }

  function applyAmSubTab() {
    document.querySelectorAll("[data-am-panel]").forEach((el) => {
      el.hidden = el.dataset.amPanel !== state.amSubTab;
    });
    document.querySelectorAll("#amSubTabs button[data-amtab]").forEach((b) => {
      b.setAttribute("aria-selected", String(b.dataset.amtab === state.amSubTab));
    });
  }

  function renderAmMasterList() {
    const wrap = document.getElementById("amMasterList");
    if (!wrap) return;
    const masters = (state.aiMasters && state.aiMasters.items) || [];
    wrap.innerHTML = "";
    if (!masters.length) {
      wrap.innerHTML = '<p class="am-empty">暂无 AI Master，请在右侧输入名称新增。</p>';
      return;
    }
    masters.forEach((m) => {
      const row = document.createElement("div");
      row.className = "am-master-row";
      row.innerHTML = `
        <span class="am-master-name">${esc(m.name)}</span>
        <span class="am-master-count">${fmtFull(m.componentCount ?? 0)} 个组件</span>
        <span class="am-master-actions">
          <button type="button" class="am-btn" data-am-action="rename" data-id="${esc(m.id)}" data-name="${esc(m.name)}">改名</button>
          <button type="button" class="am-btn am-btn--danger" data-am-action="delete" data-id="${esc(m.id)}" data-name="${esc(m.name)}">删除</button>
        </span>`;
      wrap.appendChild(row);
    });
  }

  function renderAmSummary() {
    const wrap = document.getElementById("amCards");
    if (!wrap) return;
    const items = (state.amSummary && state.amSummary.items) || [];
    wrap.innerHTML = "";
    if (state.amSummaryFailed) {
      wrap.innerHTML = `<div class="am-empty"><button type="button" class="retry-link" data-retry="amSummary">重试</button>（聚合数据加载失败）</div>`;
      return;
    }
    if (!items.length) {
      wrap.innerHTML = '<p class="am-empty">暂无 AI Master，请先在名单管理里新增。</p>';
      return;
    }
    items.forEach((c) => {
      const t = c.tierCounts || {};
      const lowest = c.lowestRequiredRate == null
        ? "—"
        : fmtPct(c.lowestRequiredRate);
      const card = document.createElement("button");
      card.type = "button";
      card.className = "am-card" + (c.aiMasterId ? "" : " am-card--unassigned");
      card.setAttribute("data-am-master-id", c.aiMasterId || "");
      card.addEventListener("click", () => {
        if (!c.aiMasterId) return;   // 未分配卡不可下钻
        setAmTab("detail");
        setAmMaster(c.aiMasterId, c.name);
      });
      card.innerHTML = `
        <span class="am-card__name">${c.aiMasterId ? esc(c.name) : "未分配（待分配）"}</span>
        <span class="am-card__total">${fmtFull(c.totalComponents)} 个组件</span>
        <span class="am-card__tiers">
          <span class="am-chip am-chip--none"><span class="am-chip__label">无要求</span><span class="am-chip__sep"></span><span class="am-chip__num">${fmtFull(t.none || 0)}</span></span>
          <span class="am-chip am-chip--three"><span class="am-chip__label">需≥3</span><span class="am-chip__sep"></span><span class="am-chip__num">${fmtFull(t.three || 0)}</span></span>
          <span class="am-chip am-chip--five"><span class="am-chip__label">需≥5</span><span class="am-chip__sep"></span><span class="am-chip__num">${fmtFull(t.five || 0)}</span></span>
          <span class="am-chip am-chip--no_data"><span class="am-chip__label">无数据</span><span class="am-chip__sep"></span><span class="am-chip__num">${fmtFull(t.no_data || 0)}</span></span>
        </span>
        <span class="am-card__lowest">需处理组件最低采纳率 <strong>${lowest}</strong></span>`;
      wrap.appendChild(card);
    });
  }

  // 明细页：选中 AI Master 后懒加载其组件明细。
  function syncAmMasterSelect() {
    const sel = document.getElementById("amMasterSelect");
    if (!sel) return;
    const masters = (state.aiMasters && state.aiMasters.items) || [];
    const current = state.amSelectedMaster;
    if (sel.dataset.signature === masters.map((m) => m.id).join("\u0001") &&
        sel.value === (current || "")) return;
    sel.innerHTML = '<option value="">请选择 AI Master</option>'
      .concat('', ...masters.map((m) =>
        `<option value="${esc(m.id)}" ${m.id === current ? "selected" : ""}>${esc(m.name)}</option>`
      ));
    sel.dataset.signature = masters.map((m) => m.id).join("\u0001");
  }

  function loadAmDetail(masterId) {
    if (!masterId) {
      state.amDetail = null;
      renderAmDetail();
      return;
    }
    const token = reqToken;
    const params = {
      components: state.selComponents,
      persons: state.selPersons,
      timeRange: state.timeRange,
    };
    StatsApi.aiMasterDetail(masterId, params)
      .then((res) => {
        if (token !== reqToken) return;
        state.amDetailFailed = res == null;
        state.amDetail = res && res.code === 0 ? res.data : null;
        renderAmDetail();
      })
      .catch((err) => {
        console.error("AI Master 明细请求失败：", err);
        if (token !== reqToken) return;
        state.amDetailFailed = true;
        state.amDetail = null;
        renderAmDetail();
      });
  }

  function setAmTab(tab) {
    if (state.amSubTab === tab) return;
    state.amSubTab = tab;
    applyAmSubTab();
    if (tab === "summary") {
      renderAmSummary();
    } else {
      renderAmDetail();
    }
  }

  function setAmMaster(masterId, name) {
    state.amSelectedMaster = masterId;
    syncAmMasterSelect();
    loadAmDetail(masterId);
  }

  function renderAmDetail() {
    const body = document.getElementById("amDetailBody");
    if (!body) return;
    syncAmMasterSelect();
    const detail = state.amDetail;
    body.innerHTML = "";
    if (!state.amSelectedMaster) {
      body.innerHTML = '<tr class="empty-row"><td colspan="6">请选择上方 AI Master 查看其组件明细</td></tr>';
      return;
    }
    if (state.amDetailFailed) {
      body.innerHTML = '<tr class="empty-row"><td colspan="6">组件明细加载失败</td></tr>';
      return;
    }
    if (!detail || !detail.items || !detail.items.length) {
      body.innerHTML = '<tr class="empty-row"><td colspan="6">该 AI Master 名下暂无组件</td></tr>';
      return;
    }
    detail.items.forEach((r) => {
      const tr = document.createElement("tr");
      const used = r.usedAaw
        ? '<span class="used-yes">是</span>'
        : '<span class="used-no">否</span>';
      tr.innerHTML = `
        <td class="td-name">${esc(r.componentName)}</td>
        <td class="td-name">${r.se ? esc(r.se) : "—"}</td>
        <td>${used}</td>
        <td>${fmtFull(r.effectiveLines ?? 0)}</td>
        <td>${rateCell(r.attributionRate80, "80")}</td>
        <td class="td-name">${tierBadge(r.tier)}</td>`;
      body.appendChild(tr);
    });
  }

  // ══ 名单管理弹窗 ═════════════════════════════════════
  const ASSIGN_STATE_OPTIONS = [
    { value: "all", label: "全部" },
    { value: "assigned", label: "已分配" },
    { value: "unassigned", label: "未分配" },
  ];

  function buildAssignStateSegs() {
    const wrap = document.getElementById("fAssignState");
    if (!wrap) return;
    wrap.innerHTML = "";
    ASSIGN_STATE_OPTIONS.forEach((opt) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(opt.value === state.assignState));
      b.textContent = opt.label;
      b.addEventListener("click", () => {
        state.assignState = opt.value;
        wrap.querySelectorAll("button").forEach((x) =>
          x.setAttribute("aria-checked", String(x === b)));
        renderAssignList();
      });
      wrap.appendChild(b);
    });
  }

  function syncAssignFilters() {
    buildAssignStateSegs();
    // 组件归属的 AI Master 多选筛选。
    const mount = document.getElementById("fAssignMaster");
    if (mount) {
      const masters = (state.aiMasters && state.aiMasters.items) || [];
      const names = masters.map((m) => m.name).sort((a, b) => a.localeCompare(b, "zh-CN"));
      const signature = names.join("\u0001");
      if (mount.dataset.signature !== signature) {
        mount.dataset.signature = signature;
        state.assignMaster = state.assignMaster.filter((n) => names.includes(n));
        buildMultiSelect(
          "fAssignMaster",
          masters.map((m) => ({ id: m.name, name: m.name })),
          () => state.assignMaster,
          (v) => { state.assignMaster = v; },
          "AI Master",
          renderAssignList              // 纯前端过滤
        );
      }
    }
    // 同步搜索框值。
    const search = document.getElementById("assignSearch");
    if (search && search.value !== state.assignSearch) search.value = state.assignSearch;
  }

  // 弹窗归属列表：按搜索 / AI Master / 分配状态过滤，每行一个下拉改挂。
  function renderAssignList() {
    const body = document.getElementById("assignBody");
    if (!body) return;
    const data = state.components;
    if (!data) {
      body.innerHTML = '<tr class="empty-row"><td colspan="2">暂无组件数据</td></tr>';
      return;
    }
    const unassignedId = data.unassignedId || "__unassigned__";
    const q = state.assignSearch.trim().toLocaleLowerCase("zh-CN");
    const masterSel = state.assignMaster;
    const st = state.assignState;
    const rows = (data.items || []).filter((r) => {
      if (r.componentId === unassignedId) return false;   // 未归类组件不可分配
      if (q && !String(r.componentName ?? "").toLocaleLowerCase("zh-CN").includes(q)) return false;
      const { masterName } = masterOf(r.componentId);
      if (masterSel.length && !masterSel.includes(masterName)) return false;
      const assigned = !!masterName;
      if (st === "assigned" && !assigned) return false;
      if (st === "unassigned" && assigned) return false;
      return true;
    }).sort((a, b) => String(a.componentName ?? "").localeCompare(String(b.componentName ?? ""), "zh-CN"));

    body.innerHTML = "";
    if (!rows.length) {
      body.innerHTML = '<tr class="empty-row"><td colspan="2">没有匹配的组件</td></tr>';
      return;
    }
    rows.forEach((r) => {
      const tr = document.createElement("tr");
      const isUnassignedRow = r.componentId === unassignedId;
      tr.innerHTML = `
        <td class="td-name">${esc(r.componentName)}</td>
        <td class="td-name">${isUnassignedRow ? "—" : masterCell(r, false)}</td>`;
      body.appendChild(tr);
    });
  }

  function openAmModal() {
    state.amModalOpen = true;
    const mask = $("#amModalMask");
    if (mask) mask.hidden = false;
    applyAmModalTab();
    renderAmMasterList();
    syncAssignFilters();
    renderAssignList();
  }

  function closeAmModal() {
    state.amModalOpen = false;
    const mask = $("#amModalMask");
    if (mask) mask.hidden = true;
  }

  function applyAmModalTab() {
    document.querySelectorAll("[data-amm-panel]").forEach((el) => {
      el.hidden = el.dataset.ammPanel !== state.amModalTab;
    });
    document.querySelectorAll("#amModalTabs button[data-ammtab]").forEach((b) => {
      b.setAttribute("aria-selected", String(b.dataset.ammtab === state.amModalTab));
    });
  }

  function buildTabs() {
    const wrap = $("#boardTabs");
    if (!wrap) return;
    wrap.querySelectorAll("button[data-tab]").forEach((b) => {
      b.addEventListener("click", () => {
        if (state.activeTab === b.dataset.tab) return;
        state.activeTab = b.dataset.tab;
        wrap.querySelectorAll("button[data-tab]").forEach((x) =>
          x.setAttribute("aria-selected", String(x === b)));
        applyTab();
      });
    });
    applyTab();
  }

  function applyTab() {
    document.querySelectorAll("[data-panel]").forEach((el) => {
      el.hidden = el.dataset.panel !== state.activeTab;
    });
    // 隐藏期间容器宽度为 0，切回概览必须重算图表尺寸。
    if (state.activeTab === "overview" && state.data) {
      Object.values(charts).forEach((c) => c.resize());
      renderDial();
    }
  }

  function bindComponentControls() {
    buildCompUsedSegs();
    const search = $("#compSearch");
    if (search) {
      search.addEventListener("input", () => {
        state.compQuery = search.value || "";
        renderComponents();
      });
    }
    document.querySelectorAll(".ledger--comp th[data-comp-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.compSort;
        if (state.compSort === key) {
          state.compOrder = state.compOrder === "asc" ? "desc" : "asc";
        } else {
          state.compSort = key;
          state.compOrder = "desc";
        }
        renderComponents();
      });
    });
    // 组件表格里行内改挂 AI Master：change 后调接口并刷新组件与运营视图。
    document.addEventListener("change", async (e) => {
      const sel = e.target.closest(".comp-master-select");
      if (!sel) return;
      const componentId = sel.dataset.componentId;
      const aiMasterId = sel.value || null;
      const previous = sel.dataset.previous || "";
      sel.disabled = true;
      try {
        await StatsApi.assignComponent(componentId, aiMasterId);
        sel.dataset.previous = aiMasterId || "";
        await refreshAmData();
      } catch (err) {
        console.error("AI Master 归属保存失败：", err);
        sel.value = previous;
      } finally {
        sel.disabled = false;
      }
    });
  }

  // AI Master 运营页交互：名单增删改、子 tab、明细下拉选择。
  function bindAiMasterControls() {
    const addBtn = $("#amAddBtn");
    const newName = $("#amNewName");
    if (addBtn && newName) {
      const doAdd = async () => {
        const name = (newName.value || "").trim();
        if (!name) return;
        addBtn.disabled = true;
        try {
          await StatsApi.aiMasterCreate(name);
          newName.value = "";
          await refreshAmData();
        } catch (err) {
          console.error("新增 AI Master 失败：", err);
          alert("新增 AI Master 失败，请重试");
        } finally {
          addBtn.disabled = false;
        }
      };
      addBtn.addEventListener("click", doAdd);
      newName.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); doAdd(); }
      });
    }

    // 名单增删改（事件委托）。
    document.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-am-action]");
      if (!btn) return;
      const id = btn.dataset.id;
      const name = btn.dataset.name || "";
      try {
        if (btn.dataset.amAction === "rename") {
          const next = prompt("重命名 AI Master：", name);
          if (next == null || !next.trim()) return;
          await StatsApi.aiMasterRename(id, next.trim());
          await refreshAmData();
        } else if (btn.dataset.amAction === "delete") {
          if (!confirm(`确认删除 AI Master「${name}」？其名下组件将变为未分配。`)) return;
          await StatsApi.aiMasterDelete(id);
          if (state.amSelectedMaster === id) setAmMaster(null, null);
          await refreshAmData();
        }
      } catch (err) {
        console.error("AI Master 操作失败：", err);
        alert("操作失败，请重试");
      }
    });

    // 运营子 tab 切换。
    const subTabs = $("#amSubTabs");
    if (subTabs) {
      subTabs.querySelectorAll("button[data-amtab]").forEach((b) => {
        b.addEventListener("click", () => setAmTab(b.dataset.amtab));
      });
    }

    // 明细页：下拉选择 AI Master。
    const masterSelect = $("#amMasterSelect");
    if (masterSelect) {
      masterSelect.addEventListener("change", () => {
        setAmMaster(masterSelect.value || null, null);
      });
    }

    // 名单管理弹窗：开关、Tab 切换、搜索。
    const openBtn = $("#amOpenBtn");
    if (openBtn) openBtn.addEventListener("click", openAmModal);
    const closeBtn = $("#amCloseBtn");
    if (closeBtn) closeBtn.addEventListener("click", closeAmModal);
    const mask = $("#amModalMask");
    if (mask) {
      mask.addEventListener("click", (e) => {
        if (e.target === mask) closeAmModal();   // 点遮罩关闭
      });
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeAmModal();
    });
    const modalTabs = $("#amModalTabs");
    if (modalTabs) {
      modalTabs.querySelectorAll("button[data-ammtab]").forEach((b) => {
        b.addEventListener("click", () => {
          state.amModalTab = b.dataset.ammtab;
          applyAmModalTab();
        });
      });
    }
    const assignSearch = $("#assignSearch");
    if (assignSearch) {
      assignSearch.addEventListener("input", () => {
        state.assignSearch = assignSearch.value || "";
        renderAssignList();
      });
    }
  }

  // 名单/归属变更后，重取名单 + 归属 + 聚合 + 组件（保持三处一致）。
  async function refreshAmData() {
    const params = {
      components: state.selComponents,
      persons: state.selPersons,
      timeRange: state.timeRange,
    };
    try {
      const [masters, assignments, summary, comp] = await Promise.all([
        StatsApi.aiMasters(),
        StatsApi.assignments(),
        StatsApi.aiMasterOperations(params),
        StatsApi.components(params),
      ]);
      state.aiMastersFailed = masters == null;
      state.aiMasters = masters && masters.code === 0 ? masters.data : null;
      state.assignments = assignments && assignments.code === 0 ? assignments.data.assignments : {};
      state.amSummaryFailed = summary == null;
      state.amSummary = summary && summary.code === 0 ? summary.data : null;
      state.componentsFailed = comp == null;
      state.components = comp && comp.code === 0 ? comp.data : null;
    } catch (err) {
      console.error("刷新数据失败：", err);
      return;
    }
    renderAiMaster();
    renderComponents();
    // 若明细页已选中某 AI Master，归属变化可能影响其组件，重新拉取。
    if (state.amSelectedMaster) loadAmDetail(state.amSelectedMaster);
  }

  // ── util: hex + alpha ──────────────────────────────────
  function hexA(hex, a) {
    const h = hex.replace("#", "");
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  // ── resize ─────────────────────────────────────────────
  let rz;
  window.addEventListener("resize", () => {
    clearTimeout(rz);
    rz = setTimeout(() => {
      Object.values(charts).forEach((c) => c.resize());
      if (state.data) renderDial();
    }, 140);
  });

  // ═══ BOOT ═════════════════════════════════════════════
  async function boot() {
    let opt;
    try {
      opt = await StatsApi.filterOptions();
    } catch (err) {
      console.error("筛选项接口请求失败：", err);
      $("#lastSync").textContent = "筛选项加载失败，请刷新重试";
      document.body.setAttribute("data-loading", "false");
      return;
    }
    if (!opt || opt.code !== 0) {
      console.error("筛选项返回异常：", opt && opt.message);
      $("#lastSync").textContent = "筛选项加载失败，请刷新重试";
      document.body.setAttribute("data-loading", "false");
      return;
    }
    state.options = opt.data;

    selects.fComponent = buildMultiSelect("fComponent",
      state.options.components,
      () => state.selComponents,
      (v) => (state.selComponents = v),
      "组件");
    selects.fPerson = buildMultiSelect("fPerson",
      state.options.persons,
      () => state.selPersons,
      (v) => (state.selPersons = v),
      "人员");
    buildSegments();
    buildTrendToggle();
    buildWfStateToggle();
    bindSort();
    if (!isTestDashboard) { buildTabs(); bindComponentControls(); bindAiMasterControls(); }

    $("#btnReset").addEventListener("click", () => {
      state.selComponents = [];
      state.selPersons = [];
      state.timeRange = "90d";
      state.compQuery = "";
      state.compSe = [];
      state.compMaster = [];
      state.compUsed = "all";
      const compSearch = $("#compSearch");
      if (compSearch) compSearch.value = "";
      closeAllPops();
      selects.fComponent.renderTrigger();
      selects.fPerson.renderTrigger();
      buildSegments();
      // 清掉 signature 强制 SE 多选下次重建（trigger 由 buildMultiSelect 内部
      // renderTrigger 渲染，外部改 state 不会自动刷新），并刷新使用状态分段。
      const compSeMount = document.getElementById("fCompSe");
      if (compSeMount) delete compSeMount.dataset.signature;
      const compMasterMount = document.getElementById("fCompMaster");
      if (compMasterMount) delete compMasterMount.dataset.signature;
      buildCompUsedSegs();
      onFilterChange();
    });

    await onFilterChange();

    requestAnimationFrame(() => document.body.setAttribute("data-loading", "false"));
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
