const state = {
  config: null,
  selectedNode: null,
  selectedEdge: null,
  positions: new Map(),
};

const els = {
  nodeCount: document.querySelector("#nodeCount"),
  edgeCount: document.querySelector("#edgeCount"),
  issueCount: document.querySelector("#issueCount"),
  nodeSearch: document.querySelector("#nodeSearch"),
  nodeList: document.querySelector("#nodeList"),
  flowCanvas: document.querySelector("#flowCanvas"),
  edgeLayer: document.querySelector("#edgeLayer"),
  nodeLayer: document.querySelector("#nodeLayer"),
  edgeControls: document.querySelector("#edgeControls"),
  reloadConfig: document.querySelector("#reloadConfig"),
  showIssues: document.querySelector("#showIssues"),
  quickGateInsert: document.querySelector("#quickGateInsert"),
  inspectorTitle: document.querySelector("#inspectorTitle"),
  emptyInspector: document.querySelector("#emptyInspector"),
  nodeEditor: document.querySelector("#nodeEditor"),
  editType: document.querySelector("#editType"),
  editName: document.querySelector("#editName"),
  editExecution: document.querySelector("#editExecution"),
  editSkill: document.querySelector("#editSkill"),
  editInputs: document.querySelector("#editInputs"),
  editOutputs: document.querySelector("#editOutputs"),
  editDataPrompt: document.querySelector("#editDataPrompt"),
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
  newSkill: document.querySelector("#newSkill"),
  newInputs: document.querySelector("#newInputs"),
  newOutputs: document.querySelector("#newOutputs"),
  newDataPrompt: document.querySelector("#newDataPrompt"),
  issuesDialog: document.querySelector("#issuesDialog"),
  closeIssues: document.querySelector("#closeIssues"),
  issuesContent: document.querySelector("#issuesContent"),
  toast: document.querySelector("#toast"),
};

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
  renderNodeList();
  renderGraph();
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
      <strong>${escapeHtml(node.type)}</strong>
      <span>${escapeHtml(node.summary.execution)} · ${escapeHtml((node.summary.skill || []).join(", ") || "no skill")}</span>
    `;
    button.addEventListener("click", () => selectNode(node.type));
    els.nodeList.appendChild(button);
  }
}

function renderGraph() {
  const layout = calculateLayout();
  state.positions = layout.positions;
  els.flowCanvas.style.minWidth = `${layout.width}px`;
  els.flowCanvas.style.minHeight = `${layout.height}px`;
  els.edgeLayer.setAttribute("width", layout.width);
  els.edgeLayer.setAttribute("height", layout.height);
  els.nodeLayer.innerHTML = "";
  els.edgeLayer.innerHTML = "";
  els.edgeControls.innerHTML = "";

  for (const edge of state.config.edges) {
    drawEdge(edge);
  }

  for (const node of state.config.nodes) {
    const position = state.positions.get(node.type);
    if (!position) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `flow-node ${state.selectedNode === node.type ? "selected" : ""}`;
    button.style.left = `${position.x}px`;
    button.style.top = `${position.y}px`;
    const edgeKind = outgoingKind(node.type);
    button.innerHTML = `
      <span class="node-type">${escapeHtml(node.type)}</span>
      <strong>${escapeHtml(node.summary.name)}</strong>
      <span class="node-meta">
        <span class="pill">${escapeHtml(node.summary.execution)}</span>
        <span class="pill ${edgeKind}">${escapeHtml(edgeKind || "loose")}</span>
      </span>
    `;
    button.addEventListener("click", () => selectNode(node.type));
    els.nodeLayer.appendChild(button);
  }
}

function calculateLayout() {
  const nodes = state.config.nodes;
  const edges = state.config.edges;
  const adjacency = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    adjacency.get(edge.source).push(edge.target);
  }

  const starts = Object.values(state.config.flow.entrypoints || {})
    .map((entry) => entry && entry.start)
    .filter(Boolean);
  const depth = new Map();
  const queue = [];
  for (const start of starts) {
    depth.set(start, 0);
    queue.push(start);
  }

  while (queue.length) {
    const current = queue.shift();
    const currentDepth = depth.get(current) || 0;
    for (const next of adjacency.get(current) || []) {
      const nextDepth = currentDepth + 1;
      if (!depth.has(next) || nextDepth > depth.get(next)) {
        depth.set(next, nextDepth);
        queue.push(next);
      }
    }
  }

  let fallbackDepth = Math.max(0, ...depth.values()) + 1;
  for (const node of nodes) {
    if (!depth.has(node.type)) {
      depth.set(node.type, fallbackDepth);
      fallbackDepth += 1;
    }
  }

  const columns = new Map();
  for (const node of nodes) {
    const col = depth.get(node.type) || 0;
    if (!columns.has(col)) columns.set(col, []);
    columns.get(col).push(node.type);
  }

  const positions = new Map();
  const nodeWidth = 196;
  const nodeHeight = 86;
  const columnGap = 260;
  const rowGap = 122;
  const marginX = 38;
  const marginY = 62;
  let maxX = 0;
  let maxY = 0;

  for (const [col, nodeTypes] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    nodeTypes.sort();
    nodeTypes.forEach((type, index) => {
      const x = marginX + col * columnGap;
      const y = marginY + index * rowGap;
      positions.set(type, { x, y, width: nodeWidth, height: nodeHeight });
      maxX = Math.max(maxX, x + nodeWidth);
      maxY = Math.max(maxY, y + nodeHeight);
    });
  }

  return {
    positions,
    width: Math.max(1100, maxX + 120),
    height: Math.max(720, maxY + 120),
  };
}

function drawEdge(edge) {
  const from = state.positions.get(edge.source);
  const to = state.positions.get(edge.target);
  if (!from || !to) return;

  const x1 = from.x + from.width;
  const y1 = from.y + from.height / 2;
  const x2 = to.x;
  const y2 = to.y + to.height / 2;
  const midX = x1 + (x2 - x1) / 2;
  const control = Math.max(80, Math.abs(x2 - x1) * 0.42);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", `M ${x1} ${y1} C ${x1 + control} ${y1}, ${x2 - control} ${y2}, ${x2} ${y2}`);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", edge.kind === "choice" ? "#b86e00" : edge.kind === "foreach" ? "#386b9a" : "#9f927f");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  els.edgeLayer.appendChild(path);

  const label = document.createElement("div");
  label.className = "edge-label";
  label.textContent = edge.label || edge.kind;
  label.style.left = `${midX - 60}px`;
  label.style.top = `${(y1 + y2) / 2 - 28}px`;
  els.edgeControls.appendChild(label);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "edge-add";
  button.textContent = "+";
  button.title = `在 ${edge.source} 和 ${edge.target} 之间插入节点`;
  button.style.left = `${midX - 13}px`;
  button.style.top = `${(y1 + y2) / 2 - 13}px`;
  button.addEventListener("click", () => openInsertDialog(edge));
  els.edgeControls.appendChild(button);
}

function outgoingKind(type) {
  const flowEdge = state.config.flow.edges && state.config.flow.edges[type];
  if (!flowEdge) return "";
  if (flowEdge.kind === "1to1") return "direct";
  if (flowEdge.kind === "1toN") return "foreach";
  return flowEdge.kind || "";
}

function selectNode(type) {
  state.selectedNode = type;
  render();
}

function renderInspector() {
  const node = nodeByType(state.selectedNode);
  if (!node) {
    els.inspectorTitle.textContent = "选择一个节点";
    els.emptyInspector.classList.remove("hidden");
    els.nodeEditor.classList.add("hidden");
    return;
  }

  els.inspectorTitle.textContent = node.type;
  els.emptyInspector.classList.add("hidden");
  els.nodeEditor.classList.remove("hidden");

  const config = node.config;
  els.editType.value = node.type;
  els.editName.value = config.name || node.type;
  els.editExecution.value = node.summary.execution || "noop";
  els.editSkill.value = (node.summary.skill || []).join(", ");
  els.editInputs.value = ioToText(config.input || []);
  els.editOutputs.value = ioToText(config.output || []);
  els.editDataPrompt.value = dataPromptToText(config.data_prompt);

  const referenced = isReferenced(node.type);
  els.deleteNode.disabled = referenced;
  els.deleteHint.textContent = referenced
    ? "该节点仍在流程中使用。为避免断链，删除前需要先调整 flow.yaml 连接。"
    : "该节点未被当前流程引用，可以删除。";
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

function openInsertDialog(edge, useLongTermDefaults = false) {
  state.selectedEdge = edge;
  els.insertTarget.textContent = `${edge.source} -> ${edge.target} (${edge.label || edge.kind})`;
  clearInsertForm();
  if (useLongTermDefaults) fillLongTermDocsExample();
  els.insertDialog.showModal();
  els.newType.focus();
}

function clearInsertForm() {
  els.newType.value = "";
  els.newName.value = "";
  els.newExecution.value = "skill";
  els.newSkill.value = "";
  els.newInputs.value = "";
  els.newOutputs.value = "";
  els.newDataPrompt.value = "";
}

function fillLongTermDocsExample() {
  els.newType.value = "refresh-long-term-docs";
  els.newName.value = "{模块组名}-refresh-long-term-docs";
  els.newExecution.value = "skill";
  els.newSkill.value = "refresh-long-term-docs";
  els.newInputs.value = [
    ".sdd/{SR}/{AR}/{AR}-{需求短名}-{模块组名}模块详细设计说明书.md",
    ".sdd/{SR}/{AR}/{AR}-{需求短名}-{模块组名}模块测试用例设计.md",
    ".sdd/{SR}/{AR}/{AR}-{需求短名}-{模块组名}模块设计门禁结果.md",
  ].join("\n");
  els.newOutputs.value = ".sdd/{SR}/{AR}/{AR}-{需求短名}-{模块组名}长期文档刷新记录.md";
  els.newDataPrompt.value = "刷新长期文档后生成刷新记录；该节点无需分支数据，交付件存在后即可 done。";
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
    input_text: els.newInputs.value,
    output_text: els.newOutputs.value,
    data_prompt: els.newDataPrompt.value,
  };
  const result = await api("/api/insert-node", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  state.config = result.config;
  state.selectedNode = payload.node_type;
  els.insertDialog.close();
  render();
  showToast(result.message);
}

async function saveSelectedNode(event) {
  event.preventDefault();
  const payload = {
    node_type: els.editType.value,
    name: els.editName.value,
    execution: els.editExecution.value,
    skill: els.editSkill.value,
    input_text: els.editInputs.value,
    output_text: els.editOutputs.value,
    data_prompt: els.editDataPrompt.value,
  };
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
  const confirmed = window.confirm(`删除 ${nodeType}.yaml？`);
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
els.reloadConfig.addEventListener("click", () => loadConfig(true).then(() => showToast("配置已刷新")));
els.showIssues.addEventListener("click", showIssues);
els.quickGateInsert.addEventListener("click", openGateInsertShortcut);
els.closeInsert.addEventListener("click", () => els.insertDialog.close());
els.closeIssues.addEventListener("click", () => els.issuesDialog.close());
els.fillLongTermDocs.addEventListener("click", fillLongTermDocsExample);
els.insertForm.addEventListener("submit", submitInsert);
els.nodeEditor.addEventListener("submit", saveSelectedNode);
els.deleteNode.addEventListener("click", deleteSelectedNode);

loadConfig(false).catch((error) => {
  showToast(error.message);
  console.error(error);
});
