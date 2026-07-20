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
    timeRange: "7d",
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
  };

  const charts = {};
  const selects = {};
  const $ = (s) => document.querySelector(s);

  // ═══ FILTER CONTROLS ═══════════════════════════════════

  function buildMultiSelect(mountId, optionList, getSel, setSel, searchLabel) {
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
        setSel([]); closePop(); renderTrigger(); onFilterChange();
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
          renderTrigger(); syncPop(); onFilterChange();
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
    window.APP_CONFIG || {}
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
      git_user_email: params.persons || [],
    };
  }

  // trends 的粒度：契约只有 day / week。
  function granularityFor(timeRange) {
    return ["180d", "365d"].includes(timeRange) ? "week" : "day";
  }

  // 真实接口客户端：对外与 MockApi 同形状（返回 { code:0, data }）。
  const RealApi = {
    async filterOptions() {
      const d = await httpGet("/dashboard/filter-options");
      return {
        code: 0,
        data: {
          components: (d.projects || []).map((p) => ({
            id: p.project_key,
            name: p.project_key,
          })),
          persons: (d.git_users || []).map((u) => ({ id: u.git_user_email, name: u.git_user_name })),
          timeRanges: TIME_RANGES,
        },
      };
    },

    async statistics(params) {
      const filter = buildFilterParams(params);
      const [ov, tr, pj, us] = await Promise.all([
        httpGet("/dashboard/overview", filter),
        httpGet("/dashboard/trends", { ...filter, granularity: granularityFor(params.timeRange) }),
        httpGet("/dashboard/projects", { ...filter, page: params.componentPage || 1, page_size: params.componentPageSize || 10 }),
        httpGet("/dashboard/users", { ...filter, page: params.personPage || 1, page_size: params.personPageSize || 10 }),
      ]);

      const p = ov.period;
      const summary = {
        usageCount: p.workflow_runs,
        generatedLines: p.dev_effective_lines,
        mergedLines80: p.attributed_lines_80,
        mergedLines90: p.attributed_lines_90,
        adoptionRate80: p.attribution_rate_80,
        adoptionRate90: p.attribution_rate_90,
      };

      const byComponent = (pj.items || []).map((r) => ({
        componentId: r.project_key,
        componentName: r.project_key,
        usageCount: r.workflow_runs,
        generatedLines: r.dev_effective_lines,
        mergedLines80: r.attributed_lines_80,
        mergedLines90: r.attributed_lines_90,
        adoptionRate80: r.attribution_rate_80,
        adoptionRate90: r.attribution_rate_90,
      }));

      const byPerson = (us.items || []).map((r) => ({
        personId: r.git_user_email,
        personName: r.git_user_name,
        usageCount: r.workflow_runs,
        generatedLines: r.dev_effective_lines,
        mergedLines80: r.attributed_lines_80,
        mergedLines90: r.attributed_lines_90,
        adoptionRate80: r.attribution_rate_80,
        adoptionRate90: r.attribution_rate_90,
      }));

      // trends 点只有行数，采纳率前端按分母 dev_effective_lines 计算。
      const trend = (tr.points || []).map((pt) => ({
        date: pt.date,
        usageCount: pt.workflow_runs,
        generatedLines: pt.dev_effective_lines,
        mergedLines80: pt.attributed_lines_80,
        mergedLines90: pt.attributed_lines_90,
        adoptionRate80: rate(pt.attributed_lines_80, pt.dev_effective_lines),
        adoptionRate90: rate(pt.attributed_lines_90, pt.dev_effective_lines),
      }));

      // 实时运营块：overview 的 current 快照 + period 里未展示的字段（零新增请求）。
      const cur = ov.snapshot || {};
      const realtime = {
        activeWorkflows: cur.active_workflows,
        stalledWorkflows: cur.stalled_workflows,
        activityThresholdHours: cur.activity_threshold_hours,
        workflowRuns: p.workflow_runs,
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
          summary, byComponent, byPerson, trend, realtime,
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
      const res = await httpGet("/dashboard/steps", {
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
      const res = await httpGet("/dashboard/workflows", {
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
            gitUserEmail: r.git_user_email,
            gitUserName: r.git_user_name,
            sr: r.sr,
            ar: r.ar,
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
    const stepsP = StatsApi.steps({
      ...params,
      page: state.stepPage,
      pageSize: state.stepPageSize,
    })
      .catch((err) => { console.error("环节接口请求失败：", err); return null; });
    const wfP = StatsApi.workflows({
      ...params,
      state: state.wfState,
      page: state.workflowPage,
      pageSize: state.workflowPageSize,
    })
      .catch((err) => { console.error("工作流接口请求失败：", err); return null; });

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

    const [steps, wf] = await Promise.all([stepsP, wfP]);
    if (token !== reqToken) return;
    state.stepsFailed = steps == null;
    state.workflowsFailed = wf == null;
    state.steps = steps && steps.code === 0 ? steps.data : null;
    state.workflows = wf && wf.code === 0 ? wf.data : null;

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
    renderComponentPie();
    renderPersonBars();
    renderLedger();
    renderRealtime();
    renderSteps();
    renderWorkflows();
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
  function ensureChart(id) {
    if (!charts[id]) charts[id] = echarts.init(document.getElementById(id), null, { renderer: "canvas" });
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

  // ── component composition donut ────────────────────────
  function renderComponentPie() {
    const chart = ensureChart("componentChart");
    const rows = [...state.data.byComponent].sort((a, b) => b.generatedLines - a.generatedLines);
    const palette = [C.iris, C.grass, C.tangerine, C.magenta, C.sky, C.iris2, C.grass2, "#B26BFF"];

    chart.setOption({
      tooltip: {
        trigger: "item",
        ...tooltipBase(),
        formatter: (p) => `${p.name}<br/>生成代码量 <b>${fmtFull(p.value)}</b><br/>占比 ${p.percent}%`,
      },
      legend: {
        type: "scroll",
        orient: "vertical",
        right: 4, top: "center",
        itemWidth: 10, itemHeight: 10, itemGap: 12,
        icon: "roundRect",
        textStyle: { color: C.inkSoft, fontFamily: FONT_MONO, fontSize: 11 },
        pageTextStyle: { color: C.inkMute },
      },
      series: [{
        type: "pie",
        radius: ["48%", "76%"],
        center: ["36%", "50%"],
        itemStyle: { borderColor: "#fff", borderWidth: 3, borderRadius: 6 },
        label: { show: false },
        labelLine: { show: false },
        data: rows.map((r, i) => ({
          name: r.componentName,
          value: r.generatedLines,
          itemStyle: { color: palette[i % palette.length] },
        })),
      }],
      animationDuration: 600,
      animationEasing: "cubicOut",
    }, true);
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
    const chart = ensureChart("personChart");
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
      tr.innerHTML = `
        <td class="td-name" style="--dot:${DOTS[i % DOTS.length]}">${esc(r.componentName)}</td>
        <td>${fmtFull(r.usageCount)}</td>
        <td>${fmtFull(r.generatedLines)}</td>
        <td>${fmtFull(r.mergedLines80)}</td>
        <td>${fmtFull(r.mergedLines90)}</td>
        <td>${rateCell(r.adoptionRate80, "80")}</td>
        <td>${rateCell(r.adoptionRate90, "90")}</td>`;
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
      body.innerHTML = `<tr class="empty-row"><td colspan="6">${msg}</td></tr>`;
      return;
    }
    items.forEach((r) => {
      const rowMeta = workflowStateMeta(r);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="td-name">
          <span class="wf-id">
            <strong>${esc(r.sr || r.workflowRunId)}</strong>
            <span>${r.ar ? esc(r.ar) + " · " : ""}${esc(r.workflowRunId)}</span>
          </span>
        </td>
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

    $("#btnReset").addEventListener("click", () => {
      state.selComponents = [];
      state.selPersons = [];
      state.timeRange = "7d";
      closeAllPops();
      selects.fComponent.renderTrigger();
      selects.fPerson.renderTrigger();
      buildSegments();
      onFilterChange();
    });

    await onFilterChange();

    requestAnimationFrame(() => document.body.setAttribute("data-loading", "false"));
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
