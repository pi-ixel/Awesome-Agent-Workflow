const state = {
  config: null,
  selectedNode: null,
  selectedEdge: null,
  positions: new Map(),
  dragging: null,
  activeEdgeId: null,
};

const NODE_LABELS = {
  "sr-init": "初始化项目上下文",
  "sr-design": "SR 设计",
  "ar-init": "AR 入口准备",
  "ar-split": "判断是否拆分 AR",
  "ar-clarify": "AR 范围澄清",
  "module-boundary-design": "模块边界设计",
  "module-detail-design-split": "模块分组",
  "module-asis-analysis": "模块现状分析",
  "module-tobe-design": "模块实现设计",
  "module-test-design": "模块测试设计",
  "module-design-gate": "模块设计门禁",
  "task-split": "开发任务拆分",
  "task-dev": "代码实现",
  "refresh-long-term-docs": "刷新长期文档",
};

const KIND_LABELS = {
  direct: "顺序",
  choice: "分支",
  foreach: "批量",
  terminal: "结束",
  loose: "未接入",
};

const EXECUTION_OPTIONS = [
  {
    value: "skill",
    label: "Skill",
    hint: "调用一个或多个 skill，适合已经沉淀成可复用能力的环节。",
  },
  {
    value: "prompt",
    label: "Prompt",
    hint: "使用 prompt 模板或步骤说明推进，适合需要用户判断或整理数据的环节。",
  },
  {
    value: "manual",
    label: "Manual",
    hint: "人工处理，不自动调用 skill 或 prompt。",
  },
  {
    value: "noop",
    label: "Noop",
    hint: "占位节点，不执行动作，通常只用于流程结构占位。",
  },
];

const NODE_TYPE_PATTERN = /^[a-z][a-z0-9-]*$/;

const els = {
  nodeCount: document.querySelector("#nodeCount"),
  edgeCount: document.querySelector("#edgeCount"),
  issueCount: document.querySelector("#issueCount"),
  nodeDrawer: document.querySelector("#nodeDrawer"),
  inspectorDrawer: document.querySelector("#inspectorDrawer"),
  toggleNodes: document.querySelector("#toggleNodes"),
  closeNodes: document.querySelector("#closeNodes"),
  closeInspector: document.querySelector("#closeInspector"),
  nodeSearch: document.querySelector("#nodeSearch"),
  nodeList: document.querySelector("#nodeList"),
  flowCanvas: document.querySelector("#flowCanvas"),
  flowOverview: document.querySelector("#flowOverview"),
  edgeLayer: document.querySelector("#edgeLayer"),
  nodeLayer: document.querySelector("#nodeLayer"),
  edgeControls: document.querySelector("#edgeControls"),
  reloadConfig: document.querySelector("#reloadConfig"),
  showIssues: document.querySelector("#showIssues"),
  focusGate: document.querySelector("#focusGate"),
  resetLayout: document.querySelector("#resetLayout"),
  quickGateInsert: document.querySelector("#quickGateInsert"),
  inspectorTitle: document.querySelector("#inspectorTitle"),
  emptyInspector: document.querySelector("#emptyInspector"),
  nodeEditor: document.querySelector("#nodeEditor"),
  editType: document.querySelector("#editType"),
  editName: document.querySelector("#editName"),
  editExecution: document.querySelector("#editExecution"),
  editExecutionHint: document.querySelector("#editExecutionHint"),
  editSkillField: document.querySelector("#editSkillField"),
  editSkill: document.querySelector("#editSkill"),
  editPromptField: document.querySelector("#editPromptField"),
  editPrompt: document.querySelector("#editPrompt"),
  editPromptSummary: document.querySelector("#editPromptSummary"),
  editInputs: document.querySelector("#editInputs"),
  editOutputs: document.querySelector("#editOutputs"),
  editDataPrompt: document.querySelector("#editDataPrompt"),
  editNodeContext: document.querySelector("#editNodeContext"),
  removeNode: document.querySelector("#removeNode"),
  deleteNode: document.querySelector("#deleteNode"),
  deleteHint: document.querySelector("#deleteHint"),
  insertDialog: document.querySelector("#insertDialog"),
  insertForm: document.querySelector("#insertForm"),
  insertTarget: document.querySelector("#insertTarget"),
  closeInsert: document.querySelector("#closeInsert"),
  fillLongTermDocs: document.querySelector("#fillLongTermDocs"),
  newType: document.querySelector("#newType"),
  newName: document.querySelector("#newName"),
  newExecution: document.querySelector("#newExecution"),
  newExecutionHint: document.querySelector("#newExecutionHint"),
  newSkillField: document.querySelector("#newSkillField"),
  newSkill: document.querySelector("#newSkill"),
  newPromptField: document.querySelector("#newPromptField"),
  newPrompt: document.querySelector("#newPrompt"),
  newInputs: document.querySelector("#newInputs"),
  newOutputs: document.querySelector("#newOutputs"),
  newDataPrompt: document.querySelector("#newDataPrompt"),
  skillOptions: document.querySelector("#skillOptions"),
  issuesDialog: document.querySelector("#issuesDialog"),
  closeIssues: document.querySelector("#closeIssues"),
  issuesContent: document.querySelector("#issuesContent"),
  toast: document.querySelector("#toast"),
};

function populateExecutionSelect(select) {
  select.innerHTML = EXECUTION_OPTIONS.map(
    (item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`
  ).join("");
}

function executionMeta(value) {
  return EXECUTION_OPTIONS.find((item) => item.value === value) || EXECUTION_OPTIONS[0];
}

function executionLabel(value) {
  return executionMeta(value).label;
}

function syncExecutionFields(prefix) {
  const isEdit = prefix === "edit";
  const execution = isEdit ? els.editExecution.value : els.newExecution.value;
  const hint = isEdit ? els.editExecutionHint : els.newExecutionHint;
  const skillField = isEdit ? els.editSkillField : els.newSkillField;
  const promptField = isEdit ? els.editPromptField : els.newPromptField;
  const skillInput = isEdit ? els.editSkill : els.newSkill;
  const promptInput = isEdit ? els.editPrompt : els.newPrompt;
  const meta = executionMeta(execution);

  hint.textContent = meta.hint;
  skillField.classList.toggle("hidden", execution !== "skill");
  promptField.classList.toggle("hidden", execution !== "prompt");
  skillInput.required = execution === "skill";
  promptInput.required = execution === "prompt";
}

function renderSkillOptions() {
  const skills = new Set();
  for (const node of state.config?.nodes || []) {
    for (const skill of node.summary.skill || []) {
      skills.add(skill);
    }
  }
  els.skillOptions.innerHTML = [...skills]
    .sort((a, b) => a.localeCompare(b))
    .map((skill) => `<option value="${escapeHtml(skill)}"></option>`)
    .join("");
}

async function api(path, options = {}) {
  const token = sessionStorage.getItem("aawStudioToken");
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (token) {
    headers["X-AAW-Studio-Token"] = token;
  }
  const response = await fetch(path, {
    ...options,
    headers,
  });
  const data = await response.json();
  if (response.status === 401 && data.requires_token) {
    const nextToken = window.prompt("请输入 AAW Workflow Studio 访问令牌");
    if (nextToken) {
      sessionStorage.setItem("aawStudioToken", nextToken);
      return api(path, options);
    }
  }
  if (!response.ok) {
    throw new Error(data.error || "请求失败");
  }
  return data;
}

async function loadConfig(keepSelection = true) {
  state.config = await api("/api/config");
  if (!keepSelection || !nodeByType(state.selectedNode)) {
    state.selectedNode = null;
  }
  render();
}

function nodeByType(type) {
  if (!state.config || !type) return null;
  return state.config.nodes.find((node) => node.type === type);
}

function render() {
  if (!state.config) return;
  renderSummary();
  renderSkillOptions();
  renderNodeList();
  renderGraph();
  renderOverview();
  renderInspector();
}

function renderSummary() {
  const validation = state.config.validation || { errors: [], warnings: [] };
  els.nodeCount.textContent = state.config.nodes.length;
  els.edgeCount.textContent = state.config.edges.length;
  els.issueCount.textContent = validation.errors.length + validation.warnings.length;
}

function renderNodeList() {
  const query = els.nodeSearch.value.trim().toLowerCase();
  const nodes = state.config.nodes.filter((node) => {
    const haystack = [
      node.type,
      node.summary.name,
      node.summary.execution,
      ...(node.summary.skill || []),
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  });

  els.nodeList.innerHTML = "";
  for (const node of nodes) {
    const button = document.createElement("button");
    button.className = `node-list-item ${state.selectedNode === node.type ? "active" : ""}`;
    button.type = "button";
    button.innerHTML = `
      <strong>${escapeHtml(humanNodeName(node.type))}</strong>
      <span>${escapeHtml(node.type)}</span>
      <div class="node-list-meta">
        <em>${escapeHtml(executionLabel(node.summary.execution))}</em>
        <em>${escapeHtml(KIND_LABELS[outgoingKind(node.type)] || KIND_LABELS.loose)}</em>
      </div>
    `;
    button.addEventListener("click", () => selectNode(node.type, true));
    els.nodeList.appendChild(button);
  }
}

function renderGraph() {
  const layout = calculateGraphLayout();
  state.positions = layout.positions;
  els.flowCanvas.style.minWidth = `${layout.width}px`;
  els.flowCanvas.style.minHeight = `${layout.height}px`;
  els.edgeLayer.setAttribute("width", layout.width);
  els.edgeLayer.setAttribute("height", layout.height);
  els.nodeLayer.innerHTML = "";
  els.edgeLayer.innerHTML = "";
  els.edgeControls.innerHTML = "";
  els.flowCanvas.classList.remove("board-mode");
  els.flowCanvas.classList.add("graph-mode");

  for (const node of layout.nodes) {
    els.nodeLayer.appendChild(createGraphNode(node));
  }
  renderGraphEdges();
}

function renderGraphEdges() {
  els.edgeLayer.innerHTML = "";
  els.edgeControls.innerHTML = "";
  ensureArrowMarker();
  renderLaneLabels({ positions: state.positions });
  for (const edge of state.config.edges) {
    drawGraphEdge(edge);
  }
}

function renderLaneLabels(layout) {
  const laneMap = [
    { lane: -1, label: "AR 直接入口" },
    { lane: 0, label: "SR 主流程" },
  ];
  for (const item of laneMap) {
    const lanePositions = [...layout.positions.values()].filter((position) => position.lane === item.lane);
    if (!lanePositions.length) continue;
    const y = Math.min(...lanePositions.map((position) => position.y));
    const label = document.createElement("div");
    label.className = "graph-lane-label";
    label.textContent = item.label;
    label.style.left = "18px";
    label.style.top = `${y - 30}px`;
    els.edgeControls.appendChild(label);
  }
}

function renderOverview() {
  els.flowOverview.innerHTML = "";
  const orderedNodes = orderNodesForGraph();

  for (const node of orderedNodes) {
    const kind = outgoingKind(node.type);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `overview-chip ${state.selectedNode === node.type ? "active" : ""}`;
    button.title = node.type;
    button.innerHTML = `
      <span class="kind-dot ${escapeHtml(kind)}"></span>
      <span>${escapeHtml(humanNodeName(node.type))}</span>
    `;
    button.addEventListener("click", () => selectNode(node.type, true));
    els.flowOverview.appendChild(button);
  }
}

function orderNodesForGraph() {
  const byType = new Map(state.config.nodes.map((node) => [node.type, node]));
  const ordered = [];
  const seen = new Set();
  const visit = (type) => {
    if (!type || seen.has(type) || !byType.has(type)) return;
    seen.add(type);
    ordered.push(byType.get(type));
    for (const edge of state.config.edges.filter((item) => item.source === type)) {
      visit(edge.target);
    }
  };

  const starts = Object.values(state.config.flow.entrypoints || {})
    .map((entry) => entry && entry.start)
    .filter(Boolean);
  for (const start of starts) {
    visit(start);
  }
  for (const node of [...state.config.nodes].sort((a, b) => a.type.localeCompare(b.type))) {
    visit(node.type);
  }
  return ordered;
}

function calculateGraphLayout() {
  const orderedNodes = orderNodesForGraph();
  const depth = calculateDepths();
  const lanes = new Map();
  const explicitLane = {
    "ar-init": -1,
    "ar-clarify": -1,
  };
  const positions = new Map();
  const nodeWidth = 216;
  const nodeHeight = 132;
  const colGap = 286;
  const laneGap = 190;
  const marginX = 72;
  const baseY = 270;
  const laneCounters = new Map();

  for (const node of orderedNodes) {
    const lane = explicitLane[node.type] ?? 0;
    const col = depth.get(node.type) ?? 0;
    const key = `${col}:${lane}`;
    const stackIndex = laneCounters.get(key) || 0;
    laneCounters.set(key, stackIndex + 1);
    lanes.set(node.type, lane);
    positions.set(node.type, {
      x: marginX + col * colGap,
      y: baseY + lane * laneGap + stackIndex * 140,
      width: nodeWidth,
      height: nodeHeight,
      lane,
      col,
    });
  }

  const maxX = Math.max(...[...positions.values()].map((item) => item.x + item.width), 900);
  const maxY = Math.max(...[...positions.values()].map((item) => item.y + item.height), 560);
  const minY = Math.min(...[...positions.values()].map((item) => item.y), 40);
  if (minY < 40) {
    const delta = 40 - minY;
    for (const item of positions.values()) {
      item.y += delta;
    }
  }

  const saved = loadSavedLayout();
  for (const [type, savedPosition] of Object.entries(saved)) {
    if (!positions.has(type)) continue;
    const current = positions.get(type);
    positions.set(type, {
      ...current,
      x: Number.isFinite(savedPosition.x) ? savedPosition.x : current.x,
      y: Number.isFinite(savedPosition.y) ? savedPosition.y : current.y,
    });
  }

  return {
    nodes: orderedNodes,
    positions,
    lanes,
    width: maxX + 120,
    height: maxY + 120,
  };
}

function layoutStorageKey() {
  const scope = state.config?.definitions_dir || "default";
  return `aaw-studio-layout:${scope}`;
}

function loadSavedLayout() {
  try {
    return JSON.parse(localStorage.getItem(layoutStorageKey()) || "{}");
  } catch {
    return {};
  }
}

function saveNodeLayout(type, position) {
  const saved = loadSavedLayout();
  saved[type] = { x: Math.round(position.x), y: Math.round(position.y) };
  localStorage.setItem(layoutStorageKey(), JSON.stringify(saved));
}

function resetSavedLayout() {
  localStorage.removeItem(layoutStorageKey());
  render();
  showToast("已恢复自动布局");
}

function calculateDepths() {
  const nodeTypes = state.config.nodes.map((node) => node.type);
  const depth = new Map(nodeTypes.map((type) => [type, Number.NEGATIVE_INFINITY]));
  const starts = Object.values(state.config.flow.entrypoints || {})
    .map((entry) => entry && entry.start)
    .filter(Boolean);
  for (const start of starts) {
    depth.set(start, 0);
  }

  for (let i = 0; i < nodeTypes.length * 2; i += 1) {
    let changed = false;
    for (const edge of state.config.edges) {
      const sourceDepth = depth.get(edge.source);
      if (sourceDepth === undefined || sourceDepth === Number.NEGATIVE_INFINITY) continue;
      const nextDepth = sourceDepth + 1;
      if ((depth.get(edge.target) ?? Number.NEGATIVE_INFINITY) < nextDepth) {
        depth.set(edge.target, nextDepth);
        changed = true;
      }
    }
    if (!changed) break;
  }

  let fallback = Math.max(0, ...[...depth.values()].filter(Number.isFinite)) + 1;
  for (const type of nodeTypes) {
    if (!Number.isFinite(depth.get(type))) {
      depth.set(type, fallback);
      fallback += 1;
    }
  }
  return depth;
}

function createGraphNode(node) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `flow-node flow-card graph-node ${state.selectedNode === node.type ? "selected" : ""}`;
  button.dataset.nodeType = node.type;
  const position = state.positions.get(node.type);
  button.style.left = `${position.x}px`;
  button.style.top = `${position.y}px`;
  button.style.width = `${position.width}px`;
  button.style.minHeight = `${position.height}px`;
  const edgeKind = outgoingKind(node.type);
  const runner = runnerSummary(node);
  const inputText = node.summary.inputs ? `${node.summary.inputs} 入` : "无输入";
  const outputText = node.summary.outputs ? `${node.summary.outputs} 出` : "无输出";
  const dataBadge = node.summary.has_data_prompt ? `<span class="mini-badge">data</span>` : "";
  button.innerHTML = `
    <div class="card-head">
      <span class="pill ${edgeKind}">${escapeHtml(KIND_LABELS[edgeKind] || KIND_LABELS.loose)}</span>
      <span class="node-type">${escapeHtml(node.type)}</span>
    </div>
    <strong>${escapeHtml(humanNodeName(node.type))}</strong>
    <div class="node-runner">
      <span>${escapeHtml(executionLabel(node.summary.execution))}</span>
      <strong>${escapeHtml(runner)}</strong>
    </div>
    <div class="card-foot">
      <span>${escapeHtml(inputText)} / ${escapeHtml(outputText)}</span>
      ${dataBadge}
    </div>
  `;
  button.addEventListener("pointerdown", (event) => startNodeDrag(event, node.type));
  button.addEventListener("click", () => {
    if (button.dataset.dragged === "true") {
      button.dataset.dragged = "false";
      return;
    }
    selectNode(node.type);
  });
  return button;
}

function startNodeDrag(event, type) {
  if (event.button !== 0) return;
  const target = event.currentTarget;
  const position = state.positions.get(type);
  if (!position) return;
  target.setPointerCapture(event.pointerId);
  state.dragging = {
    type,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originalX: position.x,
    originalY: position.y,
    moved: false,
  };
  target.classList.add("dragging");
  target.addEventListener("pointermove", onNodeDrag);
  target.addEventListener("pointerup", endNodeDrag);
  target.addEventListener("pointercancel", endNodeDrag);
}

function onNodeDrag(event) {
  const drag = state.dragging;
  if (!drag || drag.pointerId !== event.pointerId) return;
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  if (Math.abs(dx) + Math.abs(dy) > 4) {
    drag.moved = true;
  }
  const position = state.positions.get(drag.type);
  if (!position) return;
  position.x = Math.max(24, drag.originalX + dx);
  position.y = Math.max(36, drag.originalY + dy);
  const node = document.querySelector(`.flow-card[data-node-type="${CSS.escape(drag.type)}"]`);
  if (node) {
    node.style.left = `${position.x}px`;
    node.style.top = `${position.y}px`;
    node.dataset.dragged = drag.moved ? "true" : "false";
  }
  renderGraphEdges();
}

function endNodeDrag(event) {
  const drag = state.dragging;
  const target = event.currentTarget;
  target.classList.remove("dragging");
  target.releasePointerCapture?.(event.pointerId);
  target.removeEventListener("pointermove", onNodeDrag);
  target.removeEventListener("pointerup", endNodeDrag);
  target.removeEventListener("pointercancel", endNodeDrag);
  if (drag && drag.pointerId === event.pointerId) {
    const position = state.positions.get(drag.type);
    if (drag.moved && position) {
      saveNodeLayout(drag.type, position);
      showToast("节点位置已保存到当前浏览器");
    }
  }
  state.dragging = null;
}

function drawGraphEdge(edge) {
  const source = state.positions.get(edge.source);
  const target = state.positions.get(edge.target);
  if (!source || !target) return;
  const x1 = source.x + source.width;
  const y1 = source.y + source.height / 2;
  const x2 = target.x;
  const y2 = target.y + target.height / 2;
  const midX = x1 + Math.max(38, (x2 - x1) / 2);
  const d = `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`;
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  path.setAttribute("class", `graph-edge-path ${edge.kind}`);
  if (state.activeEdgeId === edge.id) {
    path.classList.add("active");
  }
  path.setAttribute("marker-end", "url(#arrow)");
  els.edgeLayer.appendChild(path);

  const hitPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  hitPath.setAttribute("d", d);
  hitPath.setAttribute("class", "graph-edge-hit");
  hitPath.dataset.edgeId = edge.id;
  hitPath.addEventListener("mouseenter", () => activateEdge(edge.id));
  hitPath.addEventListener("click", () => activateEdge(edge.id));
  els.edgeLayer.appendChild(hitPath);

  if (edge.kind !== "direct") {
    const label = document.createElement("div");
    label.className = `graph-edge-label ${edge.kind}`;
    label.textContent = humanConnectionLabel(edge);
    label.style.left = `${Math.min(midX - 76, Math.max(x1 + 10, x2 - 190))}px`;
    label.style.top = `${Math.min(y1, y2) + Math.abs(y2 - y1) / 2 - 20}px`;
    els.edgeControls.appendChild(label);
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = `edge-add graph-insert ${state.activeEdgeId === edge.id ? "visible" : ""}`;
  button.textContent = "插入节点";
  button.dataset.edgeId = edge.id;
  button.title = `在 ${edge.source} 和 ${edge.target} 之间插入节点`;
  button.style.left = `${midX - 24}px`;
  button.style.top = `${Math.min(y1, y2) + Math.abs(y2 - y1) / 2 + 12}px`;
  button.addEventListener("mouseenter", () => activateEdge(edge.id));
  button.addEventListener("click", () => openInsertDialog(edge));
  els.edgeControls.appendChild(button);
}

function activateEdge(edgeId) {
  state.activeEdgeId = edgeId;
  for (const button of document.querySelectorAll(".graph-insert")) {
    button.classList.toggle("visible", button.dataset.edgeId === edgeId);
  }
  for (const path of document.querySelectorAll(".graph-edge-path")) {
    path.classList.remove("active");
  }
  const index = state.config.edges.findIndex((edge) => edge.id === edgeId);
  const visiblePath = document.querySelectorAll(".graph-edge-path")[index];
  visiblePath?.classList.add("active");
}

function ensureArrowMarker() {
  if (els.edgeLayer.querySelector("#arrow")) return;
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML = `
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#8e8372"></path>
    </marker>
  `;
  els.edgeLayer.appendChild(defs);
}

function humanNodeName(type) {
  return NODE_LABELS[type] || type;
}

function runnerSummary(node) {
  const execution = node.summary.execution;
  if (execution === "skill") {
    return (node.summary.skill || []).join(", ") || "未配置 skill";
  }
  if (execution === "prompt") {
    return node.summary.prompt || "未配置 prompt";
  }
  if (execution === "manual") {
    return "人工处理";
  }
  if (execution === "noop") {
    return "仅占位";
  }
  return execution || "未配置执行方式";
}

function humanConnectionLabel(edge) {
  const label = String(edge.label || "");
  if (edge.source === "ar-split" && label.includes("data.ars")) {
    return "拆分出多个 AR 时，为每个 AR 继续";
  }
  if (edge.source === "ar-split" && label.includes("no_split")) {
    return "不拆分 AR，按 SR 整体继续";
  }
  if (edge.source === "module-detail-design-split") {
    return "每个模块组各执行一次";
  }
  if (edge.source === "module-design-gate" && label.includes("pass")) {
    return "门禁通过后继续";
  }
  if (edge.source === "task-split") {
    return "每个开发任务各执行一次";
  }
  if (edge.kind === "direct") {
    return "完成后自动进入下一步";
  }
  if (edge.kind === "foreach") {
    return "按列表批量生成后续节点";
  }
  if (edge.kind === "choice") {
    return "按结果选择后续路径";
  }
  return edge.label || edge.kind;
}

function outgoingKind(type) {
  const flowEdge = state.config.flow.edges && state.config.flow.edges[type];
  if (!flowEdge) return "";
  if (flowEdge.kind === "1to1") return "direct";
  if (flowEdge.kind === "1toN") return "foreach";
  return flowEdge.kind || "";
}

function selectNode(type, shouldScroll = false) {
  state.selectedNode = type;
  els.nodeDrawer.classList.remove("open");
  render();
  els.inspectorDrawer.classList.add("open");
  if (shouldScroll) {
    requestAnimationFrame(() => scrollCanvasToNode(type));
  }
}

function scrollCanvasToNode(type) {
  const card = document.querySelector(`.flow-card[data-node-type="${CSS.escape(type)}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
}

function renderInspector() {
  const node = nodeByType(state.selectedNode);
  if (!node) {
    els.inspectorTitle.textContent = "选择一个节点";
    els.emptyInspector.classList.remove("hidden");
    els.nodeEditor.classList.add("hidden");
    els.inspectorDrawer.classList.remove("open");
    return;
  }

  els.inspectorTitle.textContent = node.type;
  els.inspectorDrawer.classList.add("open");
  els.emptyInspector.classList.add("hidden");
  els.nodeEditor.classList.remove("hidden");

  const config = node.config;
  els.editType.value = node.type;
  els.editName.value = config.name || node.type;
  els.editExecution.value = node.summary.execution || "noop";
  els.editSkill.value = (node.summary.skill || []).join(", ");
  els.editPrompt.value = promptTemplateToText(config.prompt);
  els.editInputs.value = ioToText(config.input || []);
  els.editOutputs.value = ioToText(config.output || []);
  els.editDataPrompt.value = dataPromptToText(config.data_prompt);
  renderPromptReadout(node);
  renderNodeContext(node);
  syncExecutionFields("edit");

  const referenced = isReferenced(node.type);
  const removable = isSimpleRemovable(node.type);
  els.removeNode.disabled = !removable;
  els.deleteNode.disabled = referenced;
  if (removable) {
    els.deleteHint.textContent = "该节点是简单中间节点，可用“移除并接回”撤销插入。";
  } else if (referenced) {
    els.deleteHint.textContent = "该节点仍在流程中使用。复杂节点请先调整 flow.yaml 连接，再删除。";
  } else {
    els.deleteHint.textContent = "该节点未被当前流程引用，可以删除。";
  }
}

function isReferenced(type) {
  const entryStarts = Object.values(state.config.flow.entrypoints || {})
    .map((entry) => entry && entry.start)
    .filter(Boolean);
  return (
    entryStarts.includes(type) ||
    Boolean(state.config.flow.edges && state.config.flow.edges[type]) ||
    state.config.edges.some((edge) => edge.target === type)
  );
}

function isSimpleRemovable(type) {
  const entryStarts = Object.values(state.config.flow.entrypoints || {})
    .map((entry) => entry && entry.start)
    .filter(Boolean);
  if (entryStarts.includes(type)) return false;
  const edge = state.config.flow.edges && state.config.flow.edges[type];
  if (!edge || normalizeKind(edge.kind) !== "direct" || !edge.to) return false;
  return incomingRefs(type).length === 1;
}

function incomingRefs(type) {
  const refs = [];
  for (const [source, edge] of Object.entries(state.config.flow.edges || {})) {
    const kind = normalizeKind(edge.kind);
    if ((kind === "direct" || kind === "foreach") && edge.to === type) {
      refs.push({ source, kind });
    }
    if (kind === "choice") {
      (edge.choices || []).forEach((choice, index) => {
        if (choice && choice.to === type) refs.push({ source, kind, index });
      });
    }
  }
  return refs;
}

function normalizeKind(kind) {
  if (kind === "1to1") return "direct";
  if (kind === "1toN") return "foreach";
  return kind || "";
}

function ioToText(items) {
  return items
    .map((item) => {
      if (item.value) return `value: ${item.value}`;
      if (!item.path) return "";
      return `${item.path}${item.required === false ? "|required=false" : ""}`;
    })
    .filter(Boolean)
    .join("\n");
}

function dataPromptToText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.description || JSON.stringify(value, null, 2);
}

function promptTemplateToText(value) {
  if (!value || typeof value !== "object") return "";
  return value.template || "";
}

function promptDescriptor(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value.template) return `模板：${value.template}`;
  if (value.inline) return "内联说明";
  if (Array.isArray(value.steps)) return `步骤清单：${value.steps.length} 项`;
  return "复杂 prompt 配置";
}

function renderPromptReadout(node) {
  const descriptor = promptDescriptor(node.config.prompt);
  const template = promptTemplateToText(node.config.prompt);
  const shouldShow = descriptor && !template;
  els.editPromptSummary.classList.toggle("hidden", !shouldShow);
  els.editPromptSummary.textContent = shouldShow
    ? `当前节点已有 ${descriptor}，保存时会继续保留；填写 Prompt 模板会改为模板模式。`
    : "";
}

function renderNodeContext(node) {
  const incoming = incomingRefs(node.type);
  const outgoing = state.config.edges.filter((edge) => edge.source === node.type);
  const incomingText = incoming.length
    ? incoming.map((ref) => `${ref.source}（${KIND_LABELS[ref.kind] || ref.kind}）`).join("、")
    : "入口或未接入";
  const outgoingText = outgoing.length
    ? outgoing
        .map((edge) => `${humanConnectionLabel(edge)} → ${edge.target}`)
        .join("；")
    : "结束节点或尚未配置后继";
  const promptText = promptDescriptor(node.config.prompt) || "无";
  const dataText = node.summary.has_data_prompt ? "需要 data 说明" : "无 data 说明";

  els.editNodeContext.innerHTML = `
    <div>
      <span>节点文件</span>
      <strong>${escapeHtml(node.path)}</strong>
    </div>
    <div>
      <span>上游</span>
      <strong>${escapeHtml(incomingText)}</strong>
    </div>
    <div>
      <span>下游</span>
      <strong>${escapeHtml(outgoingText)}</strong>
    </div>
    <div>
      <span>Prompt</span>
      <strong>${escapeHtml(promptText)}</strong>
    </div>
    <div>
      <span>Data</span>
      <strong>${escapeHtml(dataText)}</strong>
    </div>
  `;
}

function validateNodePayload(payload, options = {}) {
  if (!options.editing && !NODE_TYPE_PATTERN.test(payload.node_type)) {
    return "节点 ID 只能小写字母开头，并包含小写字母、数字、中划线。";
  }
  if (!payload.name.trim()) {
    return "请填写显示名称。";
  }
  const legalExecutions = new Set(EXECUTION_OPTIONS.map((item) => item.value));
  if (!legalExecutions.has(payload.execution)) {
    return "执行方式只能是 skill、prompt、manual 或 noop。";
  }
  if (payload.execution === "skill" && !payload.skill.trim()) {
    return "Skill 执行方式需要填写至少一个 skill 名称。";
  }
  if (payload.execution === "prompt" && !payload.prompt_template.trim()) {
    const current = options.editing ? nodeByType(payload.node_type) : null;
    if (!current?.config?.prompt) {
      return "Prompt 执行方式需要填写 Prompt 模板。";
    }
  }
  return "";
}

function openInsertDialog(edge, useLongTermDefaults = false) {
  state.selectedEdge = edge;
  els.insertTarget.innerHTML = `
    <strong>插入位置</strong>
    <span>${escapeHtml(edge.source)} → 新节点 → ${escapeHtml(edge.target)}</span>
    <em>${escapeHtml(humanConnectionLabel(edge))}</em>
  `;
  clearInsertForm();
  if (useLongTermDefaults) fillLongTermDocsExample();
  syncExecutionFields("new");
  els.insertDialog.showModal();
  els.newType.focus();
}

function clearInsertForm() {
  els.newType.value = "";
  els.newName.value = "";
  els.newExecution.value = "skill";
  els.newSkill.value = "";
  els.newPrompt.value = "";
  els.newInputs.value = "";
  els.newOutputs.value = "";
  els.newDataPrompt.value = "";
  syncExecutionFields("new");
}

function fillLongTermDocsExample() {
  els.newType.value = "refresh-long-term-docs";
  els.newName.value = "{模块组名}-refresh-long-term-docs";
  els.newExecution.value = "skill";
  els.newSkill.value = "refresh-long-term-docs";
  els.newPrompt.value = "";
  els.newInputs.value = [
    ".sdd/{SR}/{AR}/{AR}-{需求短名}-{模块组名}模块详细设计说明书.md",
    ".sdd/{SR}/{AR}/{AR}-{需求短名}-{模块组名}模块测试用例设计.md",
    ".sdd/{SR}/{AR}/{AR}-{需求短名}-{模块组名}模块设计门禁结果.md",
  ].join("\n");
  els.newOutputs.value = ".sdd/{SR}/{AR}/{AR}-{需求短名}-{模块组名}长期文档刷新记录.md";
  els.newDataPrompt.value = "刷新长期文档后生成刷新记录；该节点无需分支数据，交付件存在后即可 done。";
  syncExecutionFields("new");
}

async function submitInsert(event) {
  event.preventDefault();
  if (!state.selectedEdge) {
    showToast("请先选择一条连线");
    return;
  }
  const payload = {
    edge_id: state.selectedEdge.id,
    node_type: els.newType.value.trim(),
    name: els.newName.value.trim(),
    execution: els.newExecution.value,
    skill: els.newSkill.value.trim(),
    prompt_template: els.newPrompt.value.trim(),
    input_text: els.newInputs.value,
    output_text: els.newOutputs.value,
    data_prompt: els.newDataPrompt.value,
  };
  if (payload.execution !== "skill") payload.skill = "";
  if (payload.execution !== "prompt") payload.prompt_template = "";
  const invalid = validateNodePayload(payload);
  if (invalid) {
    showToast(invalid);
    return;
  }
  const result = await api("/api/insert-node", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  state.config = result.config;
  state.selectedNode = payload.node_type;
  els.insertDialog.close();
  render();
  requestAnimationFrame(() => scrollCanvasToNode(payload.node_type));
  showToast(result.message);
}

async function saveSelectedNode(event) {
  event.preventDefault();
  const payload = {
    node_type: els.editType.value,
    name: els.editName.value,
    execution: els.editExecution.value,
    skill: els.editSkill.value,
    prompt_template: els.editPrompt.value.trim(),
    input_text: els.editInputs.value,
    output_text: els.editOutputs.value,
    data_prompt: els.editDataPrompt.value,
  };
  if (payload.execution !== "skill") payload.skill = "";
  const invalid = validateNodePayload(payload, { editing: true });
  if (invalid) {
    showToast(invalid);
    return;
  }
  const result = await api("/api/update-node", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  state.config = result.config;
  render();
  showToast(result.message);
}

async function deleteSelectedNode() {
  const nodeType = els.editType.value;
  if (!nodeType) return;
  const confirmed = await askConfirm(`删除 ${nodeType}.yaml？`);
  if (!confirmed) return;
  const result = await api("/api/delete-node", {
    method: "POST",
    body: JSON.stringify({ node_type: nodeType }),
  });
  state.config = result.config;
  state.selectedNode = null;
  render();
  showToast(result.message);
}

function openGateInsertShortcut() {
  const existing = nodeByType("refresh-long-term-docs");
  if (existing) {
    selectNode("refresh-long-term-docs");
    showToast("refresh-long-term-docs 已存在，已切换到节点配置");
    return;
  }
  const gateEdge = state.config.edges.find(
    (edge) => edge.source === "module-design-gate" && edge.target === "task-split"
  );
  if (!gateEdge) {
    showToast("没有找到 module-design-gate -> task-split 连接，可能已经插入过或流程已调整");
    return;
  }
  openInsertDialog(gateEdge, true);
}

async function removeSelectedNode() {
  const nodeType = els.editType.value;
  if (!nodeType) return;
  const confirmed = await askConfirm(`从流程中移除 ${nodeType}，并把上游接回下游？`);
  if (!confirmed) return;
  const result = await api("/api/remove-node", {
    method: "POST",
    body: JSON.stringify({ node_type: nodeType }),
  });
  state.config = result.config;
  state.selectedNode = null;
  render();
  showToast(result.message);
}

function askConfirm(message) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "confirm-dialog";
    dialog.innerHTML = `
      <form method="dialog">
        <div class="dialog-head">
          <div>
            <p class="eyebrow">Confirm</p>
            <h2>确认操作</h2>
          </div>
        </div>
        <p class="confirm-message">${escapeHtml(message)}</p>
        <div class="dialog-actions">
          <button value="cancel" type="submit">取消</button>
          <button class="danger-btn" value="ok" type="submit">确认</button>
        </div>
      </form>
    `;
    dialog.addEventListener("close", () => {
      const ok = dialog.returnValue === "ok";
      dialog.remove();
      resolve(ok);
    });
    document.body.appendChild(dialog);
    dialog.showModal();
  });
}

function focusGateNode() {
  selectNode("module-design-gate", true);
}

function deactivateEdge() {
  state.activeEdgeId = null;
  for (const button of document.querySelectorAll(".graph-insert")) {
    button.classList.remove("visible");
  }
  for (const path of document.querySelectorAll(".graph-edge-path")) {
    path.classList.remove("active");
  }
}

function toggleNodeDrawer() {
  els.nodeDrawer.classList.toggle("open");
}

function closeInspectorDrawer() {
  els.inspectorDrawer.classList.remove("open");
}

function showIssues() {
  const validation = state.config.validation || { errors: [], warnings: [] };
  const groups = [
    ["错误", validation.errors],
    ["提醒", validation.warnings],
  ];
  els.issuesContent.innerHTML = groups
    .map(([title, items]) => {
      const list = items.length
        ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
        : "<p>没有发现问题。</p>";
      return `<section class="issue-group"><h3>${title}</h3>${list}</section>`;
    })
    .join("");
  els.issuesDialog.showModal();
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove("visible"), 2800);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

els.nodeSearch.addEventListener("input", renderNodeList);
populateExecutionSelect(els.editExecution);
populateExecutionSelect(els.newExecution);
syncExecutionFields("edit");
syncExecutionFields("new");
els.editExecution.addEventListener("change", () => syncExecutionFields("edit"));
els.newExecution.addEventListener("change", () => syncExecutionFields("new"));
els.toggleNodes.addEventListener("click", toggleNodeDrawer);
els.closeNodes.addEventListener("click", () => els.nodeDrawer.classList.remove("open"));
els.closeInspector.addEventListener("click", closeInspectorDrawer);
els.reloadConfig.addEventListener("click", () => loadConfig(true).then(() => showToast("配置已刷新")));
els.showIssues.addEventListener("click", showIssues);
els.focusGate.addEventListener("click", focusGateNode);
els.resetLayout.addEventListener("click", resetSavedLayout);
els.quickGateInsert.addEventListener("click", openGateInsertShortcut);
els.flowCanvas.addEventListener("click", (event) => {
  if (event.target === els.flowCanvas || event.target === els.nodeLayer || event.target === els.edgeLayer) {
    deactivateEdge();
  }
});
els.closeInsert.addEventListener("click", () => els.insertDialog.close());
els.closeIssues.addEventListener("click", () => els.issuesDialog.close());
els.fillLongTermDocs.addEventListener("click", fillLongTermDocsExample);
els.insertForm.addEventListener("submit", submitInsert);
els.nodeEditor.addEventListener("submit", saveSelectedNode);
els.deleteNode.addEventListener("click", deleteSelectedNode);
els.removeNode.addEventListener("click", removeSelectedNode);

loadConfig(false).catch((error) => {
  showToast(error.message);
  console.error(error);
});
