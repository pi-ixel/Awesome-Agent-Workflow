const state = {
  suites: [], experiments: [], draft: null, poller: null,
  runtime: null, controlsInitialized: false, detail: null, detailPoller: null, routeId: null, lastComparison: "",
  experimentsRequestSeq: 0,
  runEvents: {}, eventCursors: {}, runLogs: {}, expandedRuns: {}, retryingExperiments: new Set(),
  logConsole: null, logPoller: null, conversations: {},
  // 共享对话查看器：同一时间只展示一个对话，位于运行卡下方（方案对齐结论 1/3/5）。
  // open + activeGroup 决定当前展示；groups[group] 记录该组选中的 run 与来源，
  // sources[source] 保存各自的展开 Turn、展开项与滚动位置——Runner/Judge 互不串联。
  convViewer: {open: false, activeGroup: null, groups: {}},
  // 各 run 的证据条展开状态（scores.json / 改动 patch / 最终回复），独立于时间线。
  evidenceOpen: {},
  // 工作区现场占用（懒加载，按实验缓存；清理/重试后失效）
  workspaceUsage: null,
  // detail view state (方案二)：选中 case、快照展开在轮询刷新时保留，
  // 仅在切换到另一个实验时重置（detailCaseFor 记录状态所属实验）。
  detailCaseFor: null, detailCaseId: null, caseSnapshotOpen: false, lastCaseSection: "",
  // 方案四：已展开 Trial 对照的评分维度（grader id 集合）——轮询重渲染不关闭，
  // 切换实验或切换 case 时清空。
  expandedDimensions: new Set()
};
const RUNTIME_CACHE_KEY = "aaw-skill-eval.runtime.v1";
const ROUTE_EXPERIMENT = /^#\/experiments\/([0-9a-f-]{36})$/i;
const GROUP_ORDER = ["no_skill", "baseline", "current"];
const GROUP_LABELS = {no_skill: "无 Skill", baseline: "上一基准", current: "当前候选"};
// 服务端按 time_scoring 合成的「执行效率」分量 grader_id（不在 case.graders 里）
const EXECUTION_TIME_GRADER_ID = "__execution_time__";
// 雷达图组样式（方案三）：颜色之外同时使用不同线型与点型做双编码
const RADAR_GROUP_STYLES = {
  no_skill: {color: "#68716d", dash: "2 4", point: "triangle"},
  baseline: {color: "#33507e", dash: "8 5", point: "square"},
  current: {color: "#1d8061", dash: "", point: "circle"},
};
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[ch]);
}
function fmtScore(value) { return value == null ? "—" : Number(value).toFixed(1); }
function fmtDelta(value) {
  if (value == null) return '<span class="delta">—</span>';
  const cls = value > 0 ? "up" : value < 0 ? "down" : "";
  return `<span class="delta ${cls}">${value > 0 ? "+" : ""}${Number(value).toFixed(1)}</span>`;
}
function fmtTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}).format(new Date(value));
}
function providerName(value) { return value === "chrys" ? "Chrys" : "Codex"; }
function modelName(role) { return role.model_name || role.model || "—"; }
function errorText(value) {
  if (!value) return value;
  let message = value;
  try { message = JSON.parse(value).error || value; } catch {}
  if (typeof message !== "string") message = String(value);
  if (message.includes("output token limit while reasoning")) {
    return "Chrys 在推理阶段耗尽 Max Output Tokens，未产生可见回答。请提高该 Model Profile 的 Max Output Tokens 后重试。";
  }
  if (message.includes("[WinError 3]") && message.includes("skill-snapshots") && message.includes(".aaw-eval")) {
    return "Skill 快照复制失败：Windows 工作区路径过长。新实验已改用较短的工作区路径。";
  }
  return message;
}
function toast(message) {
  const node = $("#toast"); node.textContent = message; node.classList.add("show");
  clearTimeout(node._timer); node._timer = setTimeout(() => node.classList.remove("show"), 2600);
}
async function api(path, options = {}) {
  const response = await fetch(path, {headers:{"Content-Type":"application/json",...(options.headers||{})},...options});
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
  return body;
}
function lines(value) { return value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean); }

function restoreRuntimeCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(RUNTIME_CACHE_KEY) || "null");
    if (!cached?.value || Date.now() - cached.savedAt > 24 * 60 * 60 * 1000) return;
    state.runtime = cached.value;
    renderRuntime();
    renderProviderControls();
  } catch {
    localStorage.removeItem(RUNTIME_CACHE_KEY);
  }
}
function fmtDuration(seconds) {
  if (seconds == null) return "—";
  const value=Math.max(0,Math.floor(seconds));
  if(value<60)return `${value}s`;
  const minutes=Math.floor(value/60),remaining=value%60;
  return `${minutes}m ${remaining}s`;
}
function fmtBytes(value) {
  if (value == null) return "—";
  if (value < 1024) return value + " B";
  const units = ["KB", "MB", "GB"];
  let size = value / 1024, i = 0;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return size.toFixed(1) + " " + units[i];
}
function usageTotal(item) {
  return state.workspaceUsage && state.workspaceUsage.for === item.id ? state.workspaceUsage.total_bytes : 0;
}
function elapsedSince(value) { return value ? Math.max(0,(Date.now()-new Date(value).getTime())/1000) : null; }
function persistRuntimeCache(value) {
  try { localStorage.setItem(RUNTIME_CACHE_KEY, JSON.stringify({savedAt:Date.now(),value})); } catch {}
}

async function loadAll({refreshRuntime = false} = {}) {
  const runtimeRequest = api(`/api/v1/runtime${refreshRuntime ? "?refresh=true" : ""}`);
  const [suites] = await Promise.all([
    api("/api/v1/suites"), refreshExperiments()
  ]);
  state.suites = suites.items;
  renderSuites();

  try {
    state.runtime = await runtimeRequest;
    persistRuntimeCache(state.runtime);
    renderRuntime();
    renderProviderControls();
  } catch (error) {
    const badge = $("#runtimeBadge");
    badge.classList.remove("ok");
    badge.innerHTML = `<i></i>Runner 探测失败`;
    throw error;
  }
}
async function refreshExperiments() {
  const requestSeq = ++state.experimentsRequestSeq;
  const result = await api("/api/v1/experiments?limit=50");
  if (requestSeq !== state.experimentsRequestSeq) return;
  state.experiments = result.items;
  renderExperimentFilters(); renderExperiments(); updatePolling();
}
function upsertExperiment(item) {
  ++state.experimentsRequestSeq;
  state.experiments = [item, ...state.experiments.filter(existing => existing.id !== item.id)]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  $("#experimentStatusFilter").value = "";
  $("#experimentModeFilter").value = "";
  renderExperimentFilters(); renderExperiments(); updatePolling();
}
function renderRuntime() {
  const providers = state.runtime.providers || {};
  const ready = Object.entries(providers).filter(([,item])=>item.available);
  const badge = $("#runtimeBadge"); badge.classList.toggle("ok", ready.length > 0);
  badge.innerHTML = `<i></i>${ready.length ? ready.map(([name,item])=>`${providerName(name)} ${escapeHtml(item.version || "已就绪")}`).join(" · ") : "未找到可用 Agent"}`;
}
function optionMarkup(items, selected) {
  return items.map(item=>`<option value="${escapeHtml(item.value)}"${item.value===selected?' selected':''}>${escapeHtml(item.label)}</option>`).join("");
}
function availableProviders() {
  const providers = state.runtime?.providers || {};
  return ["chrys","codex"].filter(name=>providers[name]?.available);
}
function renderProviderControls() {
  const providers = availableProviders();
  const runner = $("#runnerProvider"), judge = $("#judgeProvider");
  const previousRunner = runner.value, previousJudge = judge.value;
  const options = providers.map(value=>({value,label:providerName(value)}));
  runner.innerHTML = optionMarkup(options, providers.includes(previousRunner) ? previousRunner : providers[0]);
  judge.innerHTML = optionMarkup(options, providers.includes(previousJudge) ? previousJudge : providers[0]);
  const models = state.runtime?.providers?.chrys?.models || [];
  const sortedModels = [...models].sort((a,b)=>Number(b.active)-Number(a.active)||String(a.name).localeCompare(String(b.name)));
  ["#runnerChrysModel","#judgeChrysModel"].forEach(selector=>{
    const select=$(selector), previous=select.value;
    select.innerHTML=optionMarkup(sortedModels.map(item=>({value:item.id,label:`${item.name}${item.active?" · active":""}`})),previous);
  });
  renderCodexModelOptions();
  if (!state.controlsInitialized) {
    const preferred = providers.includes("chrys") ? "chrys" : providers[0];
    if (preferred) { runner.value=preferred; judge.value=preferred; }
    state.controlsInitialized = true;
  }
  syncProviderControls();
}
function renderCodexModelOptions() {
  const models = state.runtime?.providers?.codex?.models || [];
  const datalist = $("#codexModelOptions");
  if (datalist) datalist.innerHTML = models.map(item=>`<option value="${escapeHtml(item.id)}">${escapeHtml(item.name || item.id)}</option>`).join("");
  const active = models.find(item=>item.active) || models[0];
  ["#runnerCodexModel","#judgeCodexModel"].forEach(selector=>{
    const input=$(selector);
    if (!input) return;
    if (active && !input.value.trim()) input.value = active.id;
    if (active && input.placeholder) input.placeholder = `请选择或输入模型 ID（如 ${active.id}）`;
  });
  const hint = $("#runnerCodexModelHint");
  if (hint) hint.textContent = models.length
    ? `候选模型读取自本机 Codex 配置（${models.map(item=>item.id).join("、")}），也可手动输入其他模型 ID。`
    : "本机 Codex 配置中未找到模型；可手动输入模型 ID（如 gpt-6-sol）。";
}
function syncProviderControls() {
  const runnerProvider=$("#runnerProvider").value, judgeProvider=$("#judgeProvider").value;
  $("#runnerCodexConfig").classList.toggle("hidden",runnerProvider!=="codex");
  $("#runnerChrysConfig").classList.toggle("hidden",runnerProvider!=="chrys");
  const same=$("#judgeSame").checked;
  $("#judgeConfig").classList.toggle("hidden",same);
  $("#judgeCodexConfig").classList.toggle("hidden",judgeProvider!=="codex");
  $("#judgeChrysConfig").classList.toggle("hidden",judgeProvider!=="chrys");
  const isolation=runnerProvider==="chrys"?"Chrys 软隔离 · 网络未强制隔离":"Codex workspace-write · 网络按 Profile 控制";
  $("#profileHint").textContent=`${isolation}。实验会固化 Runner、Judge、模型、版本与评分配置。`;
}
function setFilterOptions(selector, values, allLabel, labelFn=x=>x) {
  const select=$(selector), previous=select.value;
  const options=[{value:"",label:allLabel},...values.map(value=>({value,label:labelFn(value)}) )];
  select.innerHTML=optionMarkup(options,values.includes(previous)?previous:"");
}
function experimentStatusLabel(status) {
  return ({queued:"排队中",preparing:"准备中",running:"运行中",completed:"已完成",completed_with_failures:"完成但有失败",cancelled:"已取消",failed:"失败",invalid:"无效",grader_invalid:"评分无效",infra_error:"环境错误",agent_error:"Agent 错误",timeout:"超时"})[status] || status;
}
function stageLabel(stage) {
  return ({queued:"排队",creating_workspace:"创建工作区",installing_skill:"安装 Skill",runner:"Runner 执行",collecting_changes:"收集改动",validators:"执行验证器",judge:"Judge 评分",scoring:"汇总评分",persisting:"保存结果",completed:"完成",cancelled:"取消",infra_error:"环境错误",agent_error:"Agent 错误",timeout:"超时",grader_invalid:"评分无效"})[stage] || stage || "等待阶段信息";
}
function renderExperimentFilters() {
  const statuses=[...new Set(state.experiments.map(item=>item.status))];
  setFilterOptions("#experimentStatusFilter",statuses,"全部状态",experimentStatusLabel);
}
function filteredExperiments() {
  const status=$("#experimentStatusFilter").value, mode=$("#experimentModeFilter").value;
  return state.experiments.filter(item=>(!status||item.status===status)&&(!mode||item.mode===mode));
}
function renderSuites() {
  const select=$("#runSuite"),previous=select.value;
  select.innerHTML=state.suites.length?state.suites.map(s=>`<option value="${s.id}">${escapeHtml(s.name)} · ${escapeHtml(s.skill_name)}</option>`).join(""):'<option value="">请先创建测试套件</option>';
  if(state.suites.some(s=>s.id===previous))select.value=previous;
}
function experimentLineageMarkup(item) {
  const links=[];
  if(item.retry_of_experiment_id)links.push(`<button class="text-button retry-link" data-detail="${item.retry_of_experiment_id}">重试自 ${escapeHtml(item.retry_of_experiment_id.slice(0,8))}</button>`);
  (item.retry_experiment_ids||[]).forEach((id,index)=>links.push(`<button class="text-button retry-link" data-detail="${id}">后续重试 #${index+1}</button>`));
  return links.length?`<div class="experiment-lineage">${links.join("")}</div>`:"";
}
function renderExperiments() {
  const list=$("#experimentList"),items=filteredExperiments();
  if(!state.experiments.length){list.innerHTML='<div class="table-card empty">尚无实验记录。创建测试套件后，即可从右侧发起首次运行。</div>';return;}
  if(!items.length){list.innerHTML='<div class="table-card empty">当前筛选下尚无实验记录。</div>';return;}
  const stalled=items.filter(item=>item.progress?.stalled).length;document.title=stalled?`(${stalled}) AAW Skill Eval`:"AAW Skill Eval";
  list.innerHTML=items.map(item=>{const progress=item.progress||{},total=progress.total||0,done=progress.completed||0,percent=total?Math.round(done/total*100):0,retrying=state.retryingExperiments.has(item.id);return `<article class="experiment-item ${progress.stalled?"is-stalled":""}">
    <div><h3>${escapeHtml(item.suite_name)}</h3><div class="experiment-meta"><span class="pill ${item.status}">${escapeHtml(experimentStatusLabel(item.status))}</span><span>${providerName(item.profile.runner.provider)} → ${providerName(item.profile.judge.provider)}</span><span>${item.mode==="formal"?"正式":"快速"} · ${item.trials} trial</span><span>${fmtTime(item.created_at)}</span><span>${escapeHtml(item.project_commit.slice(0,8))}</span></div>${experimentLineageMarkup(item)}${total?`<div class="progress-row"><div class="progress-track"><i style="width:${percent}%"></i></div><span>${done}/${total} 完成${progress.running?` · ${progress.running} 运行中`:""}${progress.queued?` · ${progress.queued} 等待`:""}${progress.failed?` · ${progress.failed} 异常`:""}</span>${progress.active_stage?`<strong>${escapeHtml(stageLabel(progress.active_stage))}</strong>`:""}${progress.stalled?`<b class="stall-warning">${progress.active_heartbeat_age_seconds!=null&&progress.active_heartbeat_age_seconds<45?"静默等待":"心跳中断"} · ${fmtDuration(progress.active_activity_age_seconds)} 无新活动</b>`:""}</div>`:""}</div>
    <div class="experiment-result"><strong class="score">${fmtScore(item.scores.current)}</strong><button class="button button-ghost button-small" data-detail="${item.id}">详情</button><button class="button button-ghost button-small" data-retry-experiment="${item.id}" ${retrying?"disabled":""}>${retrying?"正在加入…":"重试"}</button></div>
  </article>`}).join("");
  $$('[data-detail]').forEach(button=>button.addEventListener("click",()=>navigateToExperiment(button.dataset.detail)));
  $$('[data-retry-experiment]').forEach(button=>button.addEventListener("click",()=>retryExperiment(button.dataset.retryExperiment)));
}
function updatePolling(){const active=state.experiments.some(x=>["queued","preparing","running"].includes(x.status));if(active&&!state.poller)state.poller=setInterval(()=>refreshExperiments().catch(()=>{}),2000);if(!active&&state.poller){clearInterval(state.poller);state.poller=null;}}

async function loadExpectedMarkdown(event){
  const input=event.currentTarget,file=input.files?.[0],status=$("#expectedFileStatus");
  status.classList.remove("loaded","error");
  if(!file){status.textContent="文件仅在浏览器本地读取，内容会填入上方文本框。";return;}
  if(!/\.(md|markdown)$/i.test(file.name)){input.value="";status.textContent="请选择 .md 或 .markdown 文件。";status.classList.add("error");toast("预期效果只支持 Markdown 文件");return;}
  if(file.size>2*1024*1024){input.value="";status.textContent="文件超过 2 MB，请精简后重试。";status.classList.add("error");toast("Markdown 文件不能超过 2 MB");return;}
  try{const content=await file.text();if(!content.trim())throw new Error("Markdown 文件内容为空");$("#expected").value=content;invalidateDraft();status.textContent=`已导入 ${file.name} · ${(file.size/1024).toFixed(1)} KB`;status.classList.add("loaded");}
  catch(error){input.value="";status.textContent=error.message||"无法读取 Markdown 文件。";status.classList.add("error");toast(status.textContent);}
}

async function generateDraft(){
  const required=[$("#projectPath"),$("#skillPath"),$("#skillInput"),$("#expected")],missing=required.find(field=>!field.value.trim());
  if(missing){showMessage("请先填写项目地址、Skill、输入和预期效果。",true);missing.focus();return;}
  const button=$("#draftButton");button.disabled=true;button.textContent="正在验证项目与 Skill…";
  try{const payload={project_path:$("#projectPath").value.trim(),skill_path:$("#skillPath").value.trim(),input:$("#skillInput").value.trim(),expected:$("#expected").value.trim()};state.draft=await api("/api/v1/rubric-drafts",{method:"POST",body:JSON.stringify(payload)});$("#verifiedContext").innerHTML=`<div><small>项目基线</small><strong>${escapeHtml(state.draft.project.name)} · ${state.draft.project.commit.slice(0,10)}</strong></div><div><small>Skill 修订</small><strong>${escapeHtml(state.draft.skill.name)} · ${state.draft.skill.content_hash.slice(0,10)}</strong></div>`;$("#suiteName").value=`${state.draft.skill.name} / ${state.draft.project.name}`;$("#caseJson").value=JSON.stringify(state.draft.case,null,2);$("#draftPanel").classList.remove("hidden");showMessage("评分草案已生成。请确认 Rubric、权重和验证命令。",false);}catch(error){showMessage(error.message,true);}finally{button.disabled=false;button.textContent="生成评分草案";}
}
function showMessage(message,error){const node=$("#suiteMessage");node.textContent=message;node.classList.remove("hidden","error");if(error)node.classList.add("error");}
async function saveSuite(){let saved;try{if(!state.draft)throw new Error("请先生成评分草案");const name=$("#suiteName").value.trim();if(!name){$("#suiteName").focus();throw new Error("请填写套件名称");}let caseData;try{caseData=JSON.parse($("#caseJson").value);}catch{throw new Error("评分用例 JSON 格式不正确");}const payload={name,project_path:$("#projectPath").value.trim(),skill_path:$("#skillPath").value.trim(),setup:{commands:lines($("#setupCommands").value),preflight:lines($("#preflightCommands").value),network:false,timeout_seconds:900},cases:[caseData]};saved=await api("/api/v1/suites",{method:"POST",body:JSON.stringify(payload)});}catch(error){showMessage(error.message,true);return;}$("#newSuite").close();resetSuiteForm();toast(`测试套件已保存：${saved.name}`);try{await loadAll();}catch{toast("套件已保存，但列表刷新失败，请手动刷新");}}
function invalidateDraft(){if(!state.draft)return;state.draft=null;$("#draftPanel").classList.add("hidden");showMessage("输入已变更，请重新生成评分草案。",false);}
function resetSuiteForm(){$("#suiteForm").reset();state.draft=null;$("#draftPanel").classList.add("hidden");$("#verifiedContext").innerHTML="";$("#suiteMessage").textContent="";$("#suiteMessage").classList.add("hidden");const status=$("#expectedFileStatus");status.textContent="文件仅在浏览器本地读取，内容会填入上方文本框。";status.classList.remove("loaded","error");}

function selectedModel(provider,role){return provider==="chrys"?$(`#${role}ChrysModel`).value:$(`#${role}CodexModel`).value.trim();}
function selectedTimeoutSeconds(){
  const raw=parseInt($("#timeoutSeconds")?.value,10);
  const value=Number.isFinite(raw)?raw:1800;
  return Math.min(14400,Math.max(30,value));
}
async function launchExperiment(){
  const suiteId=$("#runSuite").value;if(!suiteId)return toast("请先创建测试套件");
  const runnerProvider=$("#runnerProvider").value;if(!runnerProvider)return toast("没有可用的 Runner");
  const runnerModel=selectedModel(runnerProvider,"runner");if(!runnerModel)return toast("请选择或填写 Runner 模型");
  const same=$("#judgeSame").checked,judgeProvider=same?runnerProvider:$("#judgeProvider").value,judgeModel=same?runnerModel:selectedModel(judgeProvider,"judge");
  if(!judgeProvider||!judgeModel)return toast("请选择或填写 Judge 模型");
  const runnerEffort=$("#runnerEffort").value,judgeEffort=same?runnerEffort:$("#judgeEffort").value;
  const timeoutSeconds=selectedTimeoutSeconds();
  const profileName=`${runnerProvider}-${runnerModel}__${judgeProvider}-${judgeModel}`;
  const button=$("#runButton"),label=button.textContent;button.disabled=true;button.textContent="正在加入队列…";
  try{const body={suite_id:suiteId,mode:$("#runMode").value,profile:{schema_version:2,name:profileName,runner_provider:runnerProvider,runner_model:runnerModel,runner_reasoning_effort:runnerEffort,judge_provider:judgeProvider,judge_model:judgeModel,judge_reasoning_effort:judgeEffort,timeout_seconds:timeoutSeconds,network:false,allowed_mcp_servers:[]}};const result=await api("/api/v1/experiments",{method:"POST",body:JSON.stringify(body)});upsertExperiment(result.experiment);toast(`实验 ${result.id.slice(0,8)} 已加入队列（单轮无活动超时 ${timeoutSeconds}s）`);refreshExperiments().catch(()=>toast("实验已入队，后续状态刷新失败"));}catch(error){toast(error.message);}finally{button.disabled=false;button.textContent=label;}
}
function runActions(item,run){const actions=[];if(["queued","running"].includes(run.status))actions.push(`<button class="text-button danger" data-cancel-run="${run.id}">取消 run</button>`);if(["infra_error","timeout"].includes(run.error_kind)&&run.current_attempt<2)actions.push(`<button class="text-button" data-retry-run="${run.id}">正式重试</button>`);if(run.artifact_available)actions.push(`<button class="text-button" data-conversation="${run.id}">${isViewerRun(run.id)?"收起对话":"查看对话"}</button>`);if(run.artifact_available)actions.push(`<button class="text-button" data-log="${run.id}">日志</button>`);if(!["queued","running"].includes(run.status)&&run.artifact_available)actions.push(`<button class="text-button" data-evidence="${run.id}">证据</button>`);if(run.workspace_retained&&!["queued","running"].includes(run.status))actions.push(`<button class="text-button danger" data-clean-workspace="${run.id}">清理现场</button>`);if(!["queued","running"].includes(run.status))actions.push(`<button class="text-button" data-review="${run.id}">复核${run.reviews.length?` (${run.reviews.length})`:""}</button>`);return actions.join("");}
function renderTimeline(run){const events=state.runEvents[run.id]||[];if(!run.tracking_available&&!events.length)return '<p class="legacy-note">此 run 创建于阶段追踪功能之前，没有可用的阶段时间线。</p>';const lastHeartbeat=events.findLastIndex(event=>event.kind==="heartbeat");const visible=events.filter((event,index)=>event.kind!=="heartbeat"||index===lastHeartbeat);return `<ol class="timeline">${visible.map(event=>`<li class="${event.kind}"><time>${fmtTime(event.created_at)}</time><div><strong>${escapeHtml(stageLabel(event.stage))}</strong><span>${escapeHtml(event.message)}</span>${event.attempt>1?`<small>重试 #${event.attempt}</small>`:""}</div></li>`).join("")||'<li><div><span>正在等待首个阶段事件…</span></div></li>'}</ol>`;}
function stallDiagnosis(item,run){
  if(!run.stalled)return "";
  const provider=run.current_stage==="judge"?item.profile.judge.provider:item.profile.runner.provider;
  const alive=run.heartbeat_age_seconds!=null&&run.heartbeat_age_seconds<45;
  const output=run.output_bytes||{},stdout=output.stdout||0,stderr=output.stderr||0;
  const outputNote=stdout+stderr===0?"stdout/stderr 均为 0 字节":`stdout ${stdout} 字节 · stderr ${stderr} 字节`;
  const timeout=item.profile_config?.timeout_seconds;
  const limit=timeout&&["runner","judge"].includes(run.current_stage)?`当前阶段 ${fmtDuration(elapsedSince(run.stage_started_at))} · 单轮无活动超时上限 ${fmtDuration(timeout)}（持续有活动不会被中断）`:"";
  return `<div class="stall-diagnostic"><strong>${providerName(provider)} ${alive?"静默等待":"心跳已中断"}</strong><span>最近 ${fmtDuration(run.activity_age_seconds)} 没有新的输出或阶段进展；${outputNote}。</span>${limit?`<span>${limit}</span>`:""}<span>无法判断 CLI 内部阶段；可查看调用记录和原始流，必要时复制诊断或取消后重试。</span></div>`;
}
function activeRunStripCard(run) {
  // 方案一.7 / 方案五：并行执行时同时展示两个活动 Run 的
  // 当前阶段、已运行时间、最后有效活动、stalled、取消/对话/日志入口。
  const elapsed = run.started_at ? elapsedSince(run.started_at) : null;
  return `<div class="active-run${run.stalled ? " is-stalled" : ""}" data-active-run="${run.id}">
    <div class="active-run-head">
      <span class="pill ${run.status}">${escapeHtml(experimentStatusLabel(run.status))}</span>
      <strong>${escapeHtml(GROUP_LABELS[run.group] || run.group)} · Trial ${run.trial}</strong>
      <span class="active-run-case" title="${escapeHtml(run.case_id)}">${escapeHtml(run.case_id)}</span>
      ${run.stalled ? '<span class="stall-warning">活动停滞</span>' : ""}
    </div>
    <div class="active-run-stats">
      <span>阶段 <strong>${escapeHtml(stageLabel(run.current_stage))}</strong></span>
      <span>已运行 ${fmtDuration(elapsed)}</span>
      <span class="${run.stalled ? "warn" : ""}">最后有效活动 ${fmtDuration(run.activity_age_seconds)} 前</span>
      <span>心跳 ${fmtDuration(run.heartbeat_age_seconds)} 前</span>
    </div>
    <div class="active-run-actions">
      <button class="text-button danger" data-cancel-run="${run.id}">取消</button>
      ${run.artifact_available ? `<button class="text-button" data-conversation="${run.id}">ACP 对话</button>` : '<span class="cell-empty">对话将在运行开始后可用</span>'}
      <button class="text-button" data-log="${run.id}">日志</button>
    </div>
  </div>`;
}

function activeRunsStripMarkup(item) {
  const active = item.runs.filter(run => run.status === "running");
  if (!active.length) return "";
  return `<div class="active-runs" id="activeRunsStrip" aria-label="活动 Run 状态（并行执行时同时展示两组）">${active.map(activeRunStripCard).join("")}</div>`;
}

function renderRun(item,run){const wsSize=state.workspaceUsage&&state.workspaceUsage.for===item.id?state.workspaceUsage.runs[run.id]:null;
  run={...run,error_message:errorText(run.error_message)};
  const defaultOpen=run.status==="running"||run.stalled||!["queued","completed","cancelled"].includes(run.status),open=state.expandedRuns[run.id]??defaultOpen;
  const totalSeconds=run.completed_at&&run.started_at?(new Date(run.completed_at)-new Date(run.started_at))/1000:elapsedSince(run.started_at);
  const stageSeconds=run.status==="running"?elapsedSince(run.stage_started_at):null;
  const scoringSkipped=!["queued","running","completed"].includes(run.status)&&run.quality_score==null;
  const logs=state.runLogs[run.id];
  return `<article class="run-card ${run.stalled?"is-stalled":""}" data-run-card="${run.id}"><div class="run-summary"><div><span class="run-order">${escapeHtml(run.group)} · Trial ${run.trial}${run.current_attempt>1?` · 重试 #${run.current_attempt}`:""}</span><h3>${escapeHtml(run.case_id)}</h3></div><div class="run-stage"><span class="pill ${run.status}">${escapeHtml(experimentStatusLabel(run.status))}</span><strong>${escapeHtml(stageLabel(run.current_stage))}</strong>${scoringSkipped?'<span class="skip-badge" title="Runner 未完成，验证器与 Judge 未执行">评分已跳过</span>':""}</div><div class="run-clocks"><span>总耗时 ${fmtDuration(totalSeconds)}</span>${stageSeconds!=null?`<span>当前阶段 ${fmtDuration(stageSeconds)}</span>`:""}<span>心跳 ${fmtDuration(run.heartbeat_age_seconds)} 前</span><span class="${run.stalled?"warn":""}">有效活动 ${fmtDuration(run.activity_age_seconds)} 前</span>${wsSize!=null?`<span>现场 ${fmtBytes(wsSize)}</span>`:""}</div><div class="run-actions">${runActions(item,run)}<button class="text-button" data-toggle-run="${run.id}">${open?"收起":"时间线"}</button></div></div>${state.evidenceOpen[run.id]&&run.artifact_available?`<div class="evidence-strip"><span class="evidence-label">证据</span><button class="text-button" data-artifact-run="${run.id}" data-artifact="scores.json">scores.json</button><button class="text-button" data-artifact-run="${run.id}" data-artifact="changes.patch">改动 patch</button><button class="text-button" data-artifact-run="${run.id}" data-artifact="final-response.md">最终回复</button></div>`:""}<div class="run-detail ${open?"":"hidden"}" id="run-detail-${run.id}">${run.error_message?`<div class="message error"><strong>${escapeHtml(stageLabel(run.current_stage))}</strong> · ${escapeHtml(run.error_kind||"error")} · ${escapeHtml(run.error_message)}</div>`:""}${scoringSkipped?`<div class="skip-note">评分已跳过：Runner 未完成（${escapeHtml(experimentStatusLabel(run.status))}），确定性验证器、自动分与 Judge 盲评均未执行，因此分数显示为 “—”。如需评分请重试该 run。</div>`:""}${stallDiagnosis(item,run)}${run.attempts.length?`<p class="attempt-history">历史尝试：${run.attempts.map(attempt=>`#${attempt.attempt} ${escapeHtml(experimentStatusLabel(attempt.status))}`).join(" · ")}</p>`:""}${run.reviews.length?`<div class="run-reviews"><strong>人工复核（${run.reviews.length} · 与自动分并列保存）</strong>${run.reviews.map(review=>`<div class="run-review"><strong>${fmtScore(review.score)}</strong><span>${escapeHtml(review.reviewer)} · ${fmtTime(review.created_at)}${review.note?` · “${escapeHtml(review.note)}”`:""}</span></div>`).join("")}</div>`:""}${renderTimeline(run)}${logs?`<div class="log-panel">${logs.items.map(log=>`<h4>${escapeHtml(log.name)}</h4><pre>${escapeHtml(log.content)}</pre>`).join("")||'<p>暂无日志输出。</p>'}</div>`:""}</div></article>`;
}
async function cancelRun(runId){if(!window.confirm("取消当前 run，并继续执行其余 run？"))return;try{await api(`/api/v1/runs/${runId}/cancel`,{method:"POST"});toast("已请求取消 run");await refreshDetail();}catch(error){toast(error.message);}}
async function cancelExperiment(id){if(!window.confirm("取消整个实验及所有未运行的 run？"))return;try{await api(`/api/v1/experiments/${id}/cancel`,{method:"POST"});toast("已请求取消实验");await refreshDetail();}catch(error){toast(error.message);}}
async function retryRun(runId){if(!window.confirm("对这个基础设施失败执行一次正式重试？原失败记录会保留。"))return;try{await api(`/api/v1/runs/${runId}/retry`,{method:"POST"});toast("正式重试已加入队列");await refreshDetail();}catch(error){toast(error.message);}}
async function retryExperiment(experimentId) {
  if (state.retryingExperiments.has(experimentId)) return;
  if (!window.confirm("将使用这条实验记录的固定版本和配置创建一次完整重跑；如果原实验仍在运行，会先请求取消。继续？")) return;
  state.retryingExperiments.add(experimentId);
  renderExperiments();
  if (state.detail?.id === experimentId) renderDetail(state.detail);
  try {
    const result = await api(`/api/v1/experiments/${experimentId}/retry`, {method:"POST"});
    upsertExperiment(result.experiment);
    toast(`重试实验 ${result.id.slice(0,8)} 已加入队列`);
    refreshExperiments().catch(() => toast("实验已入队，列表刷新失败"));
    if (state.detail?.id === experimentId) await refreshDetail();
  } catch (error) {
    toast(error.message);
  } finally {
    state.retryingExperiments.delete(experimentId);
    renderExperiments();
    if (state.detail?.id === experimentId) renderDetail(state.detail);
  }
}
async function cleanRunWorkspace(runId){
  if(!window.confirm("删除该 run 的工作区现场？评分、证据包与实验记录保留。"))return;
  try{const result=await api(`/api/v1/runs/${runId}/workspace-cleanup`,{method:"POST"});
    toast(result.failed&&result.failed.length?`现场清理未完成：${result.failed.length} 个路径被占用，可稍后重试`:"现场已清理");}
  catch(error){toast(error.message);}
  invalidateWorkspaceUsage();
  if(state.detail)renderDetail(state.detail);
}
async function cleanExperimentWorkspaces(experimentId){
  const total=usageTotal(experimentId);
  const sizeText=total>0?`（共 ${fmtBytes(total)}）`:"";
  if(!window.confirm(`删除该实验的全部工作区现场${sizeText}？评分、证据包与实验记录保留。`))return;
  try{const result=await api(`/api/v1/experiments/${experimentId}/workspace-cleanup`,{method:"POST"});
    const failed=result.failed&&result.failed.length?`，${result.failed.length} 个路径被占用可稍后重试`:"";
    const skipped=result.skipped&&result.skipped.length?`，跳过运行中的 ${result.skipped.length} 个`:"";
    toast(`现场已清理${failed}${skipped}`);}
  catch(error){toast(error.message);}
  invalidateWorkspaceUsage();
  if(state.detail)renderDetail(state.detail);
}
function invalidateWorkspaceUsage(){state.workspaceUsage=null;}
function loadWorkspaceUsage(item){
  if(state.workspaceUsage&&state.workspaceUsage.for===item.id)return;
  api(`/api/v1/experiments/${item.id}/workspace-usage`).then(usage=>{state.workspaceUsage={for:item.id,...usage};if(state.detail&&state.detail.id===item.id)renderDetail(state.detail);}).catch(()=>{});
}
async function setBaseline(item){try{await api(`/api/v1/skills/${item.skill_id}/baseline`,{method:"POST",body:JSON.stringify({revision_id:item.current_revision_id})});toast("已设为基准版本");try{await loadAll();}catch{toast("基准已保存，但页面刷新失败");}}catch(error){toast(error.message);}}
function toggleEvidenceStrip(runId){state.evidenceOpen[runId]=!state.evidenceOpen[runId];if(state.detail)renderDetail(state.detail);}
async function openArtifact(runId,name){try{const result=await api(`/api/v1/runs/${runId}/artifacts`);const item=result.items.find(entry=>entry.name===name);if(!item)return toast(`该 run 没有 ${name}（可能未产生该证据文件）`);window.open(item.url,"_blank","noopener");}catch(error){toast(error.message);}}

const LOG_CURSOR_CACHE_KEY = "aaw-skill-eval.log-cursors.v1";
const MAX_BROWSER_LOG_RECORDS = 5000;

function activeRun(item) {
  const activeId = item.progress?.active_run_id;
  return item.runs.find(run => run.id === activeId)
    || item.runs.find(run => run.status === "running")
    || null;
}

function readLogCursors() {
  try { return JSON.parse(sessionStorage.getItem(LOG_CURSOR_CACHE_KEY) || "{}"); } catch { return {}; }
}

function persistLogCursors() {
  if (!state.logConsole) return;
  const cursors = readLogCursors();
  Object.entries(state.logConsole.streams).forEach(([key, stream]) => {
    if (stream.cursor) cursors[key] = stream.cursor;
  });
  try { sessionStorage.setItem(LOG_CURSOR_CACHE_KEY, JSON.stringify(cursors)); } catch {}
}

function logStreamKey(consoleState = state.logConsole) {
  if (!consoleState) return "";
  return consoleState.scope === "experiment"
    ? `experiment:${consoleState.experimentId}`
    : `run:${consoleState.runId}:attempt:${consoleState.attempt}`;
}

function currentLogStream() {
  const consoleState = state.logConsole;
  if (!consoleState) return null;
  const key = logStreamKey(consoleState);
  if (!consoleState.streams[key]) {
    consoleState.streams[key] = {
      cursor: null,
      records: [],
      invocationRecords: [],
      files: [],
      selectedFile: "",
      preview: null,
      previewLoading: false,
      previewError: "",
      lastPreviewAt: 0,
      lastFilesCheck: 0,
      historical: false,
      pending: false,
      resetNotice: "",
      promptPreview: null,
      promptPreviewId: null,
    };
  }
  return consoleState.streams[key];
}

function ensureLogConsole(item, {fresh = false} = {}) {
  if (fresh || !state.logConsole || state.logConsole.experimentId !== item.id) {
    state.logConsole = {
      experimentId: item.id,
      scope: "experiment",
      runId: null,
      attempt: null,
      pinned: false,
      mode: "raw",
      unmasked: false,
      channel: "",
      keyword: "",
      paused: false,
      atBottom: true,
      scrollTop: 0,
      newLines: 0,
      loading: false,
      streams: {},
    };
  }
  syncLogSelection(item);
}

function syncLogSelection(item) {
  const consoleState = state.logConsole;
  if (!consoleState || consoleState.pinned) return;
  const run = activeRun(item);
  if (run) {
    consoleState.scope = "run";
    consoleState.runId = run.id;
    consoleState.attempt = run.current_attempt;
  } else {
    consoleState.scope = "experiment";
    consoleState.runId = null;
    consoleState.attempt = null;
  }
}

function selectedRun(item = state.detail) {
  if (!item || state.logConsole?.scope !== "run") return null;
  return item.runs.find(run => run.id === state.logConsole.runId) || null;
}

function selectedAttempts(run) {
  if (!run) return [];
  return [...new Set([...(run.attempts || []).map(item => item.attempt), run.current_attempt])].sort((a, b) => a - b);
}

function selectExperimentLog({pin = true} = {}) {
  const consoleState = state.logConsole;
  if (!consoleState) return;
  consoleState.scope = "experiment";
  consoleState.runId = null;
  consoleState.attempt = null;
  consoleState.pinned = pin;
  consoleState.newLines = 0;
  renderLogConsoleOnly();
  loadSelectedLogFiles();
  fetchSelectedLog();
}

function selectRunLog(runId, {attempt = null, pin = true} = {}) {
  const item = state.detail;
  const run = item?.runs.find(candidate => candidate.id === runId);
  if (!run || !state.logConsole) return;
  state.logConsole.scope = "run";
  state.logConsole.runId = runId;
  state.logConsole.attempt = attempt || run.current_attempt;
  state.logConsole.pinned = pin;
  state.logConsole.newLines = 0;
  renderLogConsoleOnly();
  loadSelectedLogFiles();
  fetchSelectedLog();
}

function followCurrentLog() {
  if (!state.detail || !state.logConsole) return;
  state.logConsole.pinned = false;
  syncLogSelection(state.detail);
  state.logConsole.newLines = 0;
  renderLogConsoleOnly();
  loadSelectedLogFiles();
  fetchSelectedLog();
}

function resetSelectedLog() {
  const stream = currentLogStream();
  if (!stream) return;
  stream.cursor = null;
  stream.records = [];
  stream.invocationRecords = [];
  stream.historical = false;
  stream.pending = false;
  stream.resetNotice = "";
}

function selectedLogUrl() {
  const consoleState = state.logConsole;
  if (consoleState.scope === "experiment") return `/api/v1/experiments/${consoleState.experimentId}/logs`;
  return `/api/v1/runs/${consoleState.runId}/logs?attempt=${consoleState.attempt}`;
}

function selectedLogFilesUrl() {
  const consoleState = state.logConsole;
  if (consoleState.scope === "experiment") return `/api/v1/experiments/${consoleState.experimentId}/log-files`;
  return `/api/v1/runs/${consoleState.runId}/log-files?attempt=${consoleState.attempt}`;
}

function appendLogRecords(stream, records) {
  const known = new Set(stream.records.map(record => `${record.sequence}:${record.timestamp}`));
  const additions = records.filter(record => {
    const key = `${record.sequence}:${record.timestamp}`;
    if (known.has(key)) return false;
    known.add(key);
    return true;
  });
  stream.records.push(...additions);
  stream.invocationRecords.push(...additions.filter(record => record.channel === "invocation"));
  if (stream.records.length > MAX_BROWSER_LOG_RECORDS) {
    stream.records.splice(0, stream.records.length - MAX_BROWSER_LOG_RECORDS);
  }
  return additions.length;
}

async function fetchSelectedLog({reset = false} = {}) {
  const consoleState = state.logConsole;
  if (!consoleState || consoleState.paused || consoleState.loading) return;
  const stream = currentLogStream();
  if (!stream) return;
  if (reset) resetSelectedLog();
  consoleState.loading = true;
  try {
    const separator = selectedLogUrl().includes("?") ? "&" : "?";
    const parameters = new URLSearchParams({mode: consoleState.mode, limit_bytes: "262144"});
    if (stream.cursor) parameters.set("cursor", stream.cursor);
    if (consoleState.mode === "raw" && consoleState.unmasked) parameters.set("unmasked", "true");
    const result = await api(`${selectedLogUrl()}${separator}${parameters.toString()}`);
    const wasAtBottom = consoleState.atBottom;
    if (result.reset_required) {
      stream.records = [];
      stream.invocationRecords = [];
      stream.resetNotice = "日志源已重新打开，已从安全位置继续读取。";
    }
    const added = appendLogRecords(stream, result.records || []);
    stream.cursor = result.next_cursor || stream.cursor;
    stream.historical = Boolean(result.historical);
    stream.pending = Boolean(result.pending);
    persistLogCursors();
    if (!wasAtBottom && added) consoleState.newLines += added;
    if (state.logConsole === consoleState && currentLogStream() === stream) {
      updateLogOutput();
      if (Date.now() - stream.lastFilesCheck > 5000) loadSelectedLogFiles();
      if (stream.selectedFile && Date.now() - stream.lastPreviewAt > 3000) fetchFilePreview();
    }
  } catch (error) {
    toast(`日志读取失败：${error.message}`);
  } finally {
    if (state.logConsole) state.logConsole.loading = false;
  }
}

async function loadSelectedLogFiles() {
  const consoleState = state.logConsole;
  if (!consoleState) return;
  const stream = currentLogStream();
  if (!stream) return;
  try {
    const result = await api(selectedLogFilesUrl());
    const files = result.items || [];
    const changed = files.map(file => file.url).join("\n") !== stream.files.map(file => file.url).join("\n");
    stream.files = files;
    stream.lastFilesCheck = Date.now();
    if (stream.selectedFile && !files.some(file => file.url === stream.selectedFile)) {
      stream.selectedFile = "";
      stream.preview = null;
    }
    if (changed && state.logConsole === consoleState && currentLogStream() === stream) renderLogConsoleOnly();
  } catch (error) {
    toast(`日志文件读取失败：${error.message}`);
  }
}

async function fetchFilePreview() {
  const consoleState = state.logConsole, stream = currentLogStream();
  if (!consoleState || !stream?.selectedFile || stream.previewLoading) return;
  const fileUrl = stream.selectedFile;
  stream.previewLoading = true;
  stream.previewError = "";
  stream.lastPreviewAt = Date.now();
  updateLogOutput();
  try {
    const url = new URL(fileUrl, window.location.origin);
    url.searchParams.set("preview", "true");
    if (consoleState.unmasked) url.searchParams.set("unmasked", "true");
    const preview = await api(`${url.pathname}${url.search}`);
    if (state.logConsole === consoleState && currentLogStream() === stream && stream.selectedFile === fileUrl) {
      stream.preview = preview;
      updateLogOutput();
    }
  } catch (error) {
    stream.previewError = error.message;
    updateLogOutput();
    toast(`文件预览失败：${error.message}`);
  } finally {
    stream.previewLoading = false;
  }
}

function visibleLogRecords() {
  const consoleState = state.logConsole;
  const stream = currentLogStream();
  if (!consoleState || !stream) return [];
  const keyword = consoleState.keyword.trim().toLocaleLowerCase();
  return stream.records.filter(record => {
    if (consoleState.channel && record.channel !== consoleState.channel) return false;
    return !keyword || `${record.source} ${record.channel} ${record.text}`.toLocaleLowerCase().includes(keyword);
  });
}

function logLine(record) {
  const tag = `${record.source || "system"}/${record.channel || "event"}`;
  const partial = record.partial ? " · partial" : "";
  return `[${fmtTime(record.timestamp)}] [${tag}${partial}] ${record.text}`;
}

function responseText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(responseText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  if (value.type === "agent_message" || value.role === "assistant") return responseText(value.content || value.text);
  for (const key of ["item", "delta", "final_response", "response", "output", "result", "message", "content", "text"]) {
    const found = responseText(value[key]);
    if (found) return found;
  }
  return "";
}

function readableLogText(records) {
  const lines = [], pending = {};
  const add = (record, value) => {
    if (!value.trim()) return;
    let readable = value;
    try {
      const parsed = JSON.parse(value);
      readable = responseText(parsed) || [parsed.type, parsed.item?.type].filter(Boolean).join(" · ") || value;
    } catch {
      if (/^\s*[\[{]/.test(value)) return;
    }
    lines.push(`[${fmtTime(record.timestamp)}] [${record.source || "system"}] ${readable}`);
  };
  records.forEach(record => {
    if (record.channel === "invocation") {
      const event = record.details;
      if (event) lines.push(`[${fmtTime(record.timestamp)}] [${event.source}] ${event.phase === "start" ? `启动 PID ${event.pid}` : event.phase === "end" ? `退出码 ${event.exit_code} · ${fmtDuration(event.duration_ms / 1000)}` : `启动失败：${event.error}`}`);
      if (event?.phase === "end") {
        Object.entries(pending).forEach(([key, value]) => {
          add({source: key, timestamp: record.timestamp}, value);
          delete pending[key];
        });
      }
    } else if (record.channel === "stdout") {
      const key = record.source || "agent";
      pending[key] = (pending[key] || "") + record.text;
      const parts = pending[key].split("\n");
      pending[key] = parts.pop();
      parts.forEach(part => add(record, part));
    } else if (record.channel === "stderr" || record.channel === "event" || record.channel === "acp") {
      add(record, record.text);
    }
  });
  Object.entries(pending).forEach(([source, value]) => {
    if (!value.trim()) return;
    add({source, timestamp: new Date().toISOString()}, value);
  });
  return lines.join("\n") || "尚无 Agent 响应。";
}

function logInvocations() {
  const events = currentLogStream()?.invocationRecords.filter(record => record.details) || [];
  const byId = new Map();
  events.forEach(record => {
    const value = record.details;
    byId.set(value.id, {...(byId.get(value.id) || {}), ...value});
  });
  return [...byId.values()];
}

function invocationStatus() {
  const run = selectedRun();
  const invocations = logInvocations();
  const last = invocations.at(-1);
  if (!run || !last) return "尚无 Agent 调用记录。";
  if (last.phase === "spawn_error") return `启动失败 · ${last.error || "未知错误"}`;
  if (last.phase !== "start") return `${last.source} 已退出 · PID ${last.pid || "—"} · 退出码 ${last.exit_code ?? "—"} · 用时 ${fmtDuration((last.duration_ms || 0) / 1000)}`;
  if (run.status !== "running") return `调用记录未收到结束事件 · run 状态 ${experimentStatusLabel(run.status)} · 进程状态未知`;
  const age = Math.max(0, Math.floor((Date.now() - new Date(last.started_at).getTime()) / 1000));
  const recentOutput = currentLogStream().records.filter(record => ["stdout", "stderr", "acp"].includes(record.channel)).at(-1);
  const silent = Math.max(0, Math.floor((Date.now() - new Date(recentOutput?.timestamp || last.started_at).getTime()) / 1000));
  const heartbeat = run.heartbeat_age_seconds;
  const stateLabel = heartbeat == null ? "心跳未知" : heartbeat >= 45 ? "心跳中断" : silent >= 120 ? "静默等待" : "运行中";
  return `${stateLabel} · PID ${last.pid} · 已运行 ${fmtDuration(age)} · ${fmtDuration(silent)} 无输出 · 心跳 ${heartbeat == null ? "未知" : `${fmtDuration(heartbeat)} 前`} · 无活动超时 ${fmtDuration(last.timeout_seconds)}${stateLabel === "静默等待" ? " · 无法判断 CLI 内部阶段" : ""}`;
}

function invocationMarkup() {
  const stream = currentLogStream();
  const invocations = logInvocations();
  return invocations.map((entry, index) => `<div class="log-invocation">
    <div class="log-invocation-head"><strong>${escapeHtml(entry.source)} · 调用 ${index + 1} · ${entry.phase === "start" ? "运行中" : entry.phase === "end" ? `退出码 ${entry.exit_code ?? "—"}` : "启动失败"}</strong><span>PID ${escapeHtml(entry.pid ?? "—")} · ${escapeHtml(entry.started_at || "")} ${entry.ended_at ? `→ ${escapeHtml(entry.ended_at)}` : ""}</span></div>
    <div class="log-invocation-path">目录：${escapeHtml(entry.cwd || "")}</div>
    <pre class="log-command">${escapeHtml(entry.command || "")}</pre>
    <div class="log-invocation-actions"><button class="text-button" data-copy-command="${escapeHtml(entry.id)}">复制命令</button>${entry.prompt_file ? `<button class="text-button" data-preview-prompt="${escapeHtml(entry.id)}">${stream.promptPreviewId === entry.id ? "收起提示词" : "预览提示词"}</button>` : ""}</div>
    ${stream.promptPreviewId === entry.id ? `<pre class="log-prompt-preview">${escapeHtml(stream.promptPreview?.content || "正在读取提示词…")}</pre>` : ""}
  </div>`).join("") || '<p class="log-note">新测评启动后，这里会显示每次 Agent 调用。</p>';
}

function logPresentation() {
  const stream = currentLogStream(), consoleState = state.logConsole;
  if (!stream || !consoleState) return {content: "", count: "", note: ""};
  if (stream.selectedFile) {
    const preview = stream.preview;
    return {
      content: preview ? (preview.content || "文件为空。") : stream.previewError || "正在读取文件…",
      count: preview ? `${(preview.size / 1024).toFixed(1)} KiB` : "文件",
      note: preview?.truncated ? "文件较大，当前显示末尾 256 KiB。" : "",
    };
  }
  const visible = visibleLogRecords();
  return {
    content: visible.length ? visible.map(logLine).join("\n") : "暂无可显示的日志。",
    count: `${visible.length}/${stream.records.length} 条`,
    note: stream.pending
      ? "该 run 尚未开始，日志会在启动后自动出现。"
      : stream.historical
        ? "历史实验没有统一实时日志索引；可查看仍可用的原始输出文件。"
        : stream.resetNotice,
  };
}

function updateLogOutput() {
  const output = $("#liveLogOutput"), readable = $("#readableLogOutput"), count = $("#logCount"), note = $("#logNote");
  if (!output || !count || !note) return;
  const presentation = logPresentation();
  const visible = visibleLogRecords();
  const newLines = $("#logNewLines");
  count.textContent = presentation.count;
  note.textContent = presentation.note;
  note.classList.toggle("hidden", !presentation.note);
  if (newLines) {
    newLines.textContent = `有 ${state.logConsole.newLines} 条新日志，回到底部`;
    newLines.classList.toggle("hidden", !state.logConsole.newLines);
  }
  if (output.textContent !== presentation.content) {
    output.textContent = presentation.content;
    restoreLogScroll();
  }
  if (readable) {
    const content = currentLogStream()?.selectedFile ? presentation.content : readableLogText(visible);
    if (readable.textContent !== content) readable.textContent = content;
  }
  const status = $("#logProcessStatus");
  if (status) status.textContent = invocationStatus();
  const calls = $("#logInvocations");
  if (calls) {
    const markup = invocationMarkup();
    if (calls.innerHTML !== markup) {
      calls.innerHTML = markup;
      bindInvocationActions();
    }
  }
}

function renderLogConsole(item) {
  const consoleState = state.logConsole;
  const stream = currentLogStream();
  if (!consoleState || !stream) return "";
  const run = selectedRun(item);
  const attempts = selectedAttempts(run);
  const files = stream.files || [];
  const presentation = logPresentation();
  const runTabs = item.runs.map(candidate => {
    const selected = consoleState.scope === "run" && candidate.id === consoleState.runId;
    return `<button class="log-tab ${selected ? "active" : ""}" data-log-run="${candidate.id}">${escapeHtml(candidate.group)} · T${candidate.trial}${candidate.current_attempt > 1 ? ` · #${candidate.current_attempt}` : ""}</button>`;
  }).join("");
  return `<section class="live-log-console" id="liveLogConsole">
    <div class="live-log-head"><div><p class="eyebrow">LIVE LOGS</p><h3>实时日志控制台</h3></div><span class="log-count" id="logCount">${escapeHtml(presentation.count)}</span></div>
    <div class="log-tabs"><button class="log-tab ${consoleState.scope === "experiment" ? "active" : ""}" data-log-scope="experiment">实验日志</button>${runTabs}</div>
    <div class="log-controls">
      ${run ? `<label>尝试<select id="logAttempt">${attempts.map(value => `<option value="${value}"${value === consoleState.attempt ? " selected" : ""}>尝试 #${value}</option>`).join("")}</select></label>` : ""}
      <label>通道<select id="logChannel"${stream.selectedFile ? " disabled" : ""}><option value="">全部通道</option><option value="event"${consoleState.channel === "event" ? " selected" : ""}>系统事件</option><option value="invocation"${consoleState.channel === "invocation" ? " selected" : ""}>调用</option><option value="acp"${consoleState.channel === "acp" ? " selected" : ""}>Agent 流（ACP）</option><option value="stdout"${consoleState.channel === "stdout" ? " selected" : ""}>stdout</option><option value="stderr"${consoleState.channel === "stderr" ? " selected" : ""}>stderr</option></select></label>
      <label class="log-search">搜索<input id="logSearch" value="${escapeHtml(consoleState.keyword)}" placeholder="关键词"${stream.selectedFile ? " disabled" : ""}></label>
      <button class="text-button" id="logPause">${consoleState.paused ? "继续" : "暂停"}</button>
      <button class="text-button" id="logFollow">跟随当前 run</button>
      <button class="text-button" id="logCopy">复制可见内容</button>
      ${run ? '<button class="text-button" id="logCopyDiagnostics">复制诊断</button>' : ""}
      ${run?.status === "running" ? '<button class="text-button danger" id="logCancelRun">取消当前 run</button>' : ""}
      ${run && item.status !== "running" ? `<button class="text-button" data-retry-experiment="${item.id}">重试实验</button>` : ""}
      ${stream.selectedFile ? "" : '<button class="text-button" id="logClear">清空显示</button>'}
      ${files.length ? `<label class="log-file-select">查看文件<select id="logFile"><option value="">实时日志</option>${files.map(file => `<option value="${escapeHtml(file.url)}"${file.url === stream.selectedFile ? " selected" : ""}>${escapeHtml(file.name)}</option>`).join("")}</select></label>${stream.selectedFile ? '<button class="text-button" id="logDownloadButton">下载</button>' : ""}` : ""}
    </div>
    <label class="log-sensitive"><input type="checkbox" id="logUnmasked"${consoleState.unmasked ? " checked" : ""}> 显示未遮盖内容（可能包含敏感信息）</label>
    ${run ? `<p class="log-process-status" id="logProcessStatus">${escapeHtml(invocationStatus())}</p>` : ""}
    ${run ? `<details class="log-invocations"${run.status === "running" ? " open" : ""}><summary>Agent 调用记录 · ${logInvocations().length}</summary><div id="logInvocations">${invocationMarkup()}</div></details>` : ""}
    <p class="legacy-note log-note ${presentation.note ? "" : "hidden"}" id="logNote">${escapeHtml(presentation.note)}</p>
    ${stream.selectedFile ? "" : `<button class="log-new-lines ${consoleState.newLines ? "" : "hidden"}" id="logNewLines">有 ${consoleState.newLines} 条新日志，回到底部</button>`}
    <div class="log-output-grid"><div><h4>可读响应</h4><pre class="live-log-output" id="readableLogOutput" tabindex="0">${escapeHtml(stream.selectedFile ? presentation.content : readableLogText(visibleLogRecords()))}</pre></div><div><h4>原始流</h4><pre class="live-log-output" id="liveLogOutput" tabindex="0">${escapeHtml(presentation.content)}</pre></div></div>
  </section>`;
}

function restoreLogScroll() {
  const output = $("#liveLogOutput");
  const readable = $("#readableLogOutput");
  const consoleState = state.logConsole;
  if (!output || !consoleState) return;
  requestAnimationFrame(() => {
    output.scrollTop = consoleState.atBottom ? output.scrollHeight : consoleState.scrollTop;
    if (readable && consoleState.atBottom) readable.scrollTop = readable.scrollHeight;
  });
}

function renderLogConsoleOnly() {
  const node = $("#liveLogConsole");
  if (!node || !state.detail) return;
  node.outerHTML = renderLogConsole(state.detail);
  bindLogConsole();
  restoreLogScroll();
}

async function copyVisibleLogs() {
  const text = currentLogStream()?.selectedFile
    ? currentLogStream().preview?.content || ""
    : visibleLogRecords().map(logLine).join("\n");
  if (!text) return toast("没有可复制的日志");
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制可见日志");
  } catch {
    toast("浏览器未允许复制，请手动选择日志内容");
  }
}

async function copyDiagnostics() {
  const consoleState = state.logConsole;
  if (!consoleState?.runId) return;
  try {
    const result = await api(`/api/v1/runs/${consoleState.runId}/diagnostics?attempt=${consoleState.attempt}`);
    await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
    toast("已复制遮盖敏感值的诊断信息");
  } catch (error) { toast(`复制诊断失败：${error.message}`); }
}

async function previewInvocationPrompt(id) {
  const stream = currentLogStream();
  const entry = logInvocations().find(item => item.id === id);
  if (!stream || !entry?.prompt_file) return;
  if (stream.promptPreviewId === id) {
    stream.promptPreviewId = null;
    stream.promptPreview = null;
    updateLogOutput();
    return;
  }
  stream.promptPreviewId = id;
  stream.promptPreview = null;
  updateLogOutput();
  try {
    const base = selectedLogFilesUrl().split("?")[0];
    const path = entry.prompt_file.split("/").map(encodeURIComponent).join("/");
    const url = new URL(`${base}/${path}`, window.location.origin);
    url.searchParams.set("preview", "true");
    if (state.logConsole.attempt != null) url.searchParams.set("attempt", state.logConsole.attempt);
    if (state.logConsole.unmasked) url.searchParams.set("unmasked", "true");
    const result = await api(`${url.pathname}${url.search}`);
    if (stream.promptPreviewId === id) {
      stream.promptPreview = result;
      updateLogOutput();
    }
  } catch (error) {
    stream.promptPreview = {content: `提示词读取失败：${error.message}`};
    updateLogOutput();
  }
}

function bindInvocationActions() {
  $$('[data-copy-command]').forEach(button => button.addEventListener("click", async () => {
    const entry = logInvocations().find(item => item.id === button.dataset.copyCommand);
    if (!entry) return;
    try { await navigator.clipboard.writeText(entry.command); toast("已复制命令"); }
    catch { toast("浏览器未允许复制"); }
  }));
  $$('[data-preview-prompt]').forEach(button => button.addEventListener("click", () => previewInvocationPrompt(button.dataset.previewPrompt)));
}

function bindLogConsole() {
  const consoleState = state.logConsole;
  if (!consoleState) return;
  $$('[data-log-scope="experiment"]').forEach(button => button.addEventListener("click", () => selectExperimentLog()));
  $$('[data-log-run]').forEach(button => button.addEventListener("click", () => selectRunLog(button.dataset.logRun)));
  $("#logAttempt")?.addEventListener("change", event => selectRunLog(consoleState.runId, {attempt: Number(event.target.value)}));
  $("#logChannel")?.addEventListener("change", event => {
    consoleState.channel = event.target.value;
    updateLogOutput();
  });
  $("#logSearch")?.addEventListener("input", event => {
    consoleState.keyword = event.target.value;
    updateLogOutput();
  });
  $("#logPause")?.addEventListener("click", () => {
    consoleState.paused = !consoleState.paused;
    renderLogConsoleOnly();
    if (!consoleState.paused) fetchSelectedLog();
  });
  $("#logFollow")?.addEventListener("click", followCurrentLog);
  $("#logCopy")?.addEventListener("click", copyVisibleLogs);
  $("#logCopyDiagnostics")?.addEventListener("click", copyDiagnostics);
  $("#logCancelRun")?.addEventListener("click", () => cancelRun(consoleState.runId));
  $("#liveLogConsole [data-retry-experiment]")?.addEventListener("click", () => retryExperiment(state.detail.id));
  bindInvocationActions();
  $("#logClear")?.addEventListener("click", () => {
    const stream = currentLogStream();
    if (stream) stream.records = [];
    consoleState.newLines = 0;
    renderLogConsoleOnly();
  });
  $("#logFile")?.addEventListener("change", event => {
    const stream = currentLogStream();
    stream.selectedFile = event.target.value;
    stream.preview = null;
    stream.previewError = "";
    stream.lastPreviewAt = 0;
    renderLogConsoleOnly();
    if (stream.selectedFile) fetchFilePreview();
  });
  $("#logDownloadButton")?.addEventListener("click", async () => {
    const url = currentLogStream()?.selectedFile;
    if (!url) return;
    if (state.logConsole?.unmasked) {
      window.open(url, "_blank", "noopener");
      return;
    }
    // masked by default: download the masked preview instead of the raw file
    try {
      const separator = url.includes("?") ? "&" : "?";
      const result = await api(`${url}${separator}preview=true`);
      const name = decodeURIComponent(url.split("/").pop().split("?")[0]).replace(/[?#].*$/, "");
      downloadText(`masked-${name}`, result.content);
      toast("已下载遮盖敏感值后的文件；如需原文请勾选“显示未遮盖内容”后再下载");
    } catch (error) {
      toast(`下载失败：${error.message}`);
    }
  });
  $("#logUnmasked")?.addEventListener("change", event => {
    consoleState.unmasked = event.target.checked;
    resetSelectedLog();
    const stream = currentLogStream();
    if (stream) { stream.preview = null; stream.promptPreview = null; stream.promptPreviewId = null; }
    updateLogOutput();
    fetchSelectedLog();
    if (stream?.selectedFile) fetchFilePreview();
  });
  $("#logNewLines")?.addEventListener("click", () => {
    consoleState.atBottom = true;
    consoleState.newLines = 0;
    renderLogConsoleOnly();
  });
  const output = $("#liveLogOutput");
  output?.addEventListener("scroll", () => {
    consoleState.scrollTop = output.scrollTop;
    consoleState.atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 12;
    if (consoleState.atBottom && consoleState.newLines) {
      consoleState.newLines = 0;
      renderLogConsoleOnly();
    }
  });
}

function startLogPolling() {
  if (state.logPoller) clearInterval(state.logPoller);
  state.logPoller = setInterval(() => fetchSelectedLog(), 1000);
}

function stopLogPolling() {
  if (state.logPoller) clearInterval(state.logPoller);
  state.logPoller = null;
}

const fmean = values => values.reduce((sum, value) => sum + value, 0) / values.length;

// ---------------- conversation replay (read-only, live-updating) ----------------

function conversationState(runId) {
  return state.conversations[runId] ||= {
    source: "runner", data: null, signature: null, loading: false,
    open: false, poller: null, expanded: new Set(), unmasked: false, promptCache: {}
  };
}

function viewerGroupState(group) {
  return state.convViewer.groups[group] ||= {runId: null, source: "runner", sources: {}};
}

function viewerSourceState(group, source) {
  const g = viewerGroupState(group);
  return g.sources[source] ||= {
    openTurn: null, expanded: new Set(), scrollTop: 0,
    lastSeenCount: 0, totalItems: 0, newCount: 0, loaded: false
  };
}

// 当前查看器正在展示的 (组, 来源) 状态；runId 不匹配时返回 null。
function activeViewerSourceState() {
  const v = state.convViewer;
  if (!v.open || !v.activeGroup) return null;
  const g = v.groups[v.activeGroup];
  if (!g?.runId) return null;
  return g.sources[g.source] || null;
}

function isViewerRun(runId) {
  const v = state.convViewer;
  return Boolean(v.open && v.activeGroup && v.groups[v.activeGroup]?.runId === runId);
}

function stopConversationPolling(runId) {
  const conv = state.conversations[runId];
  if (conv?.poller) { clearInterval(conv.poller); conv.poller = null; }
}

function stopAllConversationPolling() {
  Object.values(state.conversations).forEach(conv => {
    if (conv.poller) { clearInterval(conv.poller); conv.poller = null; }
  });
}

function resetConversations() {
  stopAllConversationPolling();
  state.conversations = {};
}

function fmtSize(bytes) {
  if (bytes == null) return "—";
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

const TOOL_STATUS_LABELS = {completed: "完成", failed: "失败", in_progress: "进行中", pending: "等待"};

const RUNNER_STAGES = ["creating_workspace", "installing_skill", "runner", "collecting_changes", "validators", "scoring", "persisting"];

function sourceStageInfo(run, source) {
  if (!run || !["queued", "running"].includes(run.status)) return null;
  const stage = run.current_stage;
  const runnerActive = RUNNER_STAGES.includes(stage);
  const judgeActive = stage === "judge";
  return {
    stage,
    thisActive: source === "runner" ? runnerActive : judgeActive,
    otherActive: source === "runner" ? judgeActive : runnerActive,
  };
}

// 共享对话查看器 markup：组别标签 → run 选择 chips → Runner/Judge 页签 →
// Attempt → Turn。同一时间只展示一个对话（方案对齐结论 1/4/5）。
function conversationViewerMarkup(runId, conv) {
  const run = state.detail?.runs.find(candidate => candidate.id === runId);
  const live = run && ["queued", "running"].includes(run.status);
  const stageInfo = sourceStageInfo(run, conv.source);
  const otherLabel = conv.source === "runner" ? "Judge 评分" : "Runner 执行";
  const tabDot = active => active ? ' <i class="conv-tab-dot" title="该侧正在产生新事件"></i>' : "";
  const tabs = ["runner", "judge"].map(source => {
    const info = sourceStageInfo(run, source);
    return `<button class="conv-tab${conv.source === source ? " active" : ""}" data-conv-source="${source}">${source === "runner" ? "Runner 对话" : "Judge 对话"}${live && info?.thisActive ? tabDot(true) : ""}</button>`;
  }).join("");
  const maskLabel = conv.unmasked ? "已显示未遮盖原文" : "敏感值已遮盖";
  const stageNote = live
    ? (stageInfo?.thisActive
        ? `阶段：${stageLabel(stageInfo.stage)}`
        : stageInfo?.otherActive
          ? `本侧暂无新事件 · ${otherLabel}进行中，可切换页签查看`
          : `阶段：${stageLabel(run.current_stage)}`)
    : "只读回放";
  const groupTabs = GROUP_ORDER
    .filter(group => state.detail?.runs.some(candidate => candidate.group === group && candidate.artifact_available))
    .map(group => `<button class="conv-group-tab${group === state.convViewer.activeGroup ? " active" : ""}" data-viewer-group="${group}">${escapeHtml(GROUP_LABELS[group] || group)}</button>`)
    .join("");
  const runChips = state.detail.runs
    .filter(candidate => candidate.group === state.convViewer.activeGroup && candidate.artifact_available)
    .map(candidate => `<button class="conv-run-chip${candidate.id === runId ? " active" : ""}" data-viewer-run="${candidate.id}" title="${escapeHtml(candidate.case_id)} · Trial ${candidate.trial}">${escapeHtml(candidate.case_id)} · T${candidate.trial}</button>`)
    .join("");
  const src = activeViewerSourceState();
  const badge = src && src.newCount > 0 ? `<button class="conv-new-badge" data-conv-new title="点击跳到底部">有 ${src.newCount} 条新消息 ↓</button>` : "";
  const metaParts = [live ? '<span class="conv-live">● 运行中实时更新</span>' : "", stageNote, maskLabel].filter(Boolean);
  return `<div class="conversation-head">
      <div class="conv-viewer-row conv-group-row">${groupTabs}</div>
      <div class="conv-viewer-row conv-viewer-toolbar">
        <div class="conv-run-chips">${runChips}</div>
        <div class="conversation-controls">
          <label class="conv-mask${conv.unmasked ? " is-unmasked" : ""}"><input type="checkbox" data-conv-unmasked${conv.unmasked ? " checked" : ""}> 显示未遮盖内容（可能包含敏感信息）</label>
          <button class="text-button" data-conv-copy>复制对话</button>
          <button class="text-button" data-conv-export>导出对话</button>
          <button class="text-button" data-viewer-close>关闭</button>
        </div>
      </div>
      <div class="conv-viewer-row conv-viewer-meta-row">
        <div class="conversation-tabs">${tabs}</div>
        <span class="conversation-meta">${badge}${metaParts.join(" · ")}</span>
      </div>
    </div>
    <div class="conversation-body" id="convViewerBody">${conv.data ? attemptsMarkup(runId, conv) : '<p class="conv-loading">正在读取对话记录…</p>'}</div>`;
}

function attemptsMarkup(runId, conv) {
  const pending = Boolean(conv.data?.pending);
  return conv.data.attempts.map(attempt => {
    if (!attempt.available) {
      return `<div class="conv-attempt"><h4>尝试 #${attempt.attempt}</h4><p class="conv-missing">${escapeHtml(attempt.reason || "没有对话记录")}</p></div>`;
    }
    const session = attempt.session || {};
    const toolCallCount = (attempt.turns || []).reduce((n, t) => n + (t.items || []).filter(i => i.type === "tool_call").length, 0);
    const meta = [
      session.model && `模型 ${escapeHtml(session.model)}`,
      session.agent && `agent ${escapeHtml(session.agent)}`,
      toolCallCount ? `工具调用 ${toolCallCount} 次` : "",
      session.skills?.length ? `技能 ${session.skills.length} 个` : "",
    ].filter(Boolean).join(" · ");
    return `<div class="conv-attempt">
      <h4>尝试 #${attempt.attempt}${meta ? ` <small>${meta}</small>` : ""}</h4>
      ${attempt.turns.map(turn => turnMarkup(runId, conv, attempt, turn, pending)).join("")
        || '<p class="conv-missing">会话已建立但没有任何轮次记录（可能被立即取消）。</p>'}
      ${attempt.unparsed_lines ? `<p class="conv-missing">另有 ${attempt.unparsed_lines} 行无法解析的 wire 记录，可在诊断区查看原始日志。</p>` : ""}
    </div>`;
  }).join("");
}

function turnMarkup(runId, conv, attempt, turn, pending = false) {
  const expandedSet = activeViewerSourceState()?.expanded || conv.expanded;
  const prompt = turn.prompt;
  const promptKey = `prompt:${attempt.attempt}:${turn.turn}`;
  const usage = turn.usage?.input_tokens != null
    ? ` · tokens ${turn.usage.input_tokens} 入 / ${turn.usage.output_tokens ?? "—"} 出` : "";
  const context = turn.context?.size ? ` · 上下文 ${turn.context.used ?? "—"}/${turn.context.size}` : "";
  const stateLabel = turn.stop_reason
    ? `stop ${turn.stop_reason}`
    : pending ? '<span class="conv-live">● 本轮进行中</span>' : "未收到结束信号";
  const promptBlock = !prompt
    ? '<p class="conv-missing">该轮没有 invocation 记录，提示词缺失。</p>'
    : `<details class="conv-prompt" data-conv-prompt="${runId}|${attempt.attempt}|${prompt.file}" data-conv-key="${promptKey}"${expandedSet.has(promptKey) ? " open" : ""}>
        <summary>提示词 · ${escapeHtml(prompt.file.split("/").pop())} · ${fmtSize(prompt.bytes)}${prompt.available ? "" : "（文件缺失）"}</summary>
        <pre>展开时加载…</pre>
      </details>`;
  // Turn 手风琴：完成态默认全部收起、一次只展开一个（src.openTurn 单值）；
  // 运行中由 updateViewerProgress 跟随最新轮次。
  const turnKey = `a${attempt.attempt}t${turn.turn}`;
  const openTurn = activeViewerSourceState()?.openTurn;
  return `<details class="conv-turn" data-conv-turn="${turnKey}"${openTurn === turnKey ? " open" : ""}>
    <summary><span class="conv-turn-title">第 ${turn.turn} 轮</span><span class="conv-turn-meta">${stateLabel}${usage}${context}</span></summary>
    <div class="conv-turn-body">
      ${promptBlock}
      ${turn.items.map((item, index) => conversationItemMarkup(runId, conv, attempt, turn, item, index)).join("")}
      ${turn.error ? `<div class="conv-error">轮次错误 · ${escapeHtml(JSON.stringify(turn.error).slice(0, 300))}</div>` : ""}
    </div>
  </details>`;
}

function conversationItemMarkup(runId, conv, attempt, turn, item, index) {
  const expandedSet = activeViewerSourceState()?.expanded || conv.expanded;
  const key = `item:${attempt.attempt}:${turn.turn}:${index}`;
  if (item.type === "message") {
    return `<div class="conv-message"><span class="conv-role">Agent 回复</span><pre>${escapeHtml(item.text)}</pre></div>`;
  }
  if (item.type === "thought") {
    return `<details class="conv-thought" data-conv-key="${key}"${expandedSet.has(key) ? " open" : ""}>
      <summary>Agent 思考 · ${item.text.length} 字</summary><pre>${escapeHtml(item.text)}</pre></details>`;
  }
  if (item.type === "tool_call") {
    const statusLabel = TOOL_STATUS_LABELS[item.status] || item.status || "未知";
    const statusClass = item.status === "failed" ? "bad" : item.status === "completed" ? "ok" : "";
    const resultPreview = item.result
      ? (String(item.result).split("\n").map(l => l.trim()).find(l => l) || "").slice(0, 70)
      : "";
    return `<details class="conv-tool" data-conv-key="${key}"${expandedSet.has(key) ? " open" : ""}>
      <summary><span class="conv-tool-name">${escapeHtml(item.name || item.tool_call_id || "工具调用")}</span>${item.input ? `<span class="conv-tool-input">${escapeHtml(item.input)}</span>` : ""}<span class="conv-tool-preview">${escapeHtml(resultPreview)}</span><span class="conv-tool-status ${statusClass}">${statusLabel}</span></summary>
      <div class="conv-tool-body">
        ${item.kind ? `<p><strong>类型：</strong>${escapeHtml(item.kind)}</p>` : ""}
        ${item.input ? `<p><strong>入参：</strong>${escapeHtml(item.input)}</p>` : ""}
        ${item.result ? `<pre>${escapeHtml(item.result)}</pre>` : '<p class="conv-missing">该工具调用没有结果记录（可能被取消或记录中断）。</p>'}
      </div>
    </details>`;
  }
  if (item.type === "plan") return `<div class="conv-plan">${item.entries ? `计划更新 · ${item.completed}/${item.entries} 项完成` : "Agent 更新了执行计划"}</div>`;
  if (item.type === "system_error") return `<div class="conv-error">Chrys 错误 · ${escapeHtml(item.text)}</div>`;
  if (item.type === "system_warning") return `<div class="conv-warning">Chrys 警告 · ${escapeHtml(item.text)}</div>`;
  return "";
}

function renderConversationInto(runId) {
  if (isViewerRun(runId)) renderConversationViewer();
}

function countConversationItems(result) {
  return (result?.attempts || []).reduce((sum, attempt) =>
    sum + (attempt.turns || []).reduce((n, turn) => n + (turn.items || []).length, 0), 0);
}

// 实时更新计数：跟随底部时视为已读；用户在阅读历史时累计 newCount，
// 由查看器头部的“有 N 条新消息”徽标呈现（方案对齐结论 6）。
function updateViewerProgress(runId, result, unchanged) {
  const src = activeViewerSourceState();
  if (!src || !isViewerRun(runId)) return;
  const total = countConversationItems(result);
  src.totalItems = total;
  // 运行中的任务默认展开最新 Turn：数据变化时把唯一展开的轮次跟随到最新
  const run = state.detail?.runs.find(candidate => candidate.id === runId);
  if (run?.status === "running" && !unchanged) {
    for (const attempt of [...(result.attempts || [])].reverse()) {
      const turns = attempt.turns || [];
      if (turns.length) { src.openTurn = `a${attempt.attempt}t${turns[turns.length - 1].turn}`; break; }
    }
  }
  if (!src.loaded) { src.loaded = true; src.lastSeenCount = total; src.newCount = 0; return; }
  if (unchanged || total <= src.lastSeenCount) return;
  const body = $("#convViewerBody");
  const following = body ? body.scrollHeight - body.scrollTop - body.clientHeight < 48 : true;
  if (following) { src.lastSeenCount = total; src.newCount = 0; }
  else { src.newCount += total - src.lastSeenCount; src.lastSeenCount = total; }
}

async function fetchConversation(runId) {
  const conv = conversationState(runId);
  if (conv.loading) return;
  conv.loading = true;
  try {
    const result = await api(`/api/v1/runs/${runId}/conversation?source=${conv.source}${conv.unmasked ? "&unmasked=true" : ""}`);
    if (state.conversations[runId] !== conv) return;
    const signature = result.attempts.map(attempt => attempt.signature || "none").join("|");
    const unchanged = conv.signature === signature && conv.data;
    conv.data = result;
    conv.signature = signature;
    updateViewerProgress(runId, result, unchanged);
    if (!unchanged) renderConversationInto(runId);
    if (!result.pending) stopConversationPolling(runId);
  } catch (error) {
    toast(`对话读取失败：${error.message}`);
  } finally {
    conv.loading = false;
  }
}

function toggleConversationMask(runId) {
  const conv = conversationState(runId);
  conv.unmasked = !conv.unmasked;
  conv.data = null;
  conv.signature = null;
  conv.promptCache = {};
  const src = activeViewerSourceState();
  if (src) src.loaded = false;
  renderConversationInto(runId);
  fetchConversation(runId);
  toast(conv.unmasked ? "已切换为显示未遮盖原文（可能包含敏感信息）" : "已恢复默认遮盖敏感值");
}

function startConversationPolling(runId) {
  stopConversationPolling(runId);
  const run = state.detail?.runs.find(candidate => candidate.id === runId);
  if (!run || run.status !== "running") return;
  conversationState(runId).poller = setInterval(() => fetchConversation(runId), 2000);
}

// 共享查看器渲染：签名未变时不动 DOM（滚动/展开天然保持）；视图（组/run/来源/
// 遮盖）或数据变化时仅重建查看器自身，并按“是否在跟随底部”决定滚动位置。
function renderConversationViewer() {
  const host = $("#conversationViewer");
  if (!host) return;
  const v = state.convViewer;
  if (!v.open || !state.detail || !v.activeGroup) {
    if (host.innerHTML) { host.innerHTML = ""; host.dataset.key = ""; host.dataset.viewKey = ""; }
    return;
  }
  const group = v.activeGroup;
  const g = v.groups[group];
  const run = g?.runId ? state.detail.runs.find(candidate => candidate.id === g.runId) : null;
  if (!run || !run.artifact_available) { host.innerHTML = ""; host.dataset.key = ""; host.dataset.viewKey = ""; return; }
  const conv = conversationState(run.id);
  const viewKey = `${group}|${run.id}|${g.source}|${conv.unmasked ? "raw" : "masked"}`;
  const key = `${viewKey}|${conv.signature || "loading"}`;
  if (host.dataset.key === key) return;
  const prevBody = host.querySelector(".conversation-body");
  const sameView = host.dataset.viewKey === viewKey;
  const wasFollowing = prevBody ? prevBody.scrollHeight - prevBody.scrollTop - prevBody.clientHeight < 48 : false;
  const restoreScroll = sameView ? (prevBody?.scrollTop ?? 0) : (viewerSourceState(group, g.source).scrollTop || 0);
  host.innerHTML = `<section class="conversation-viewer">${conversationViewerMarkup(run.id, conv)}</section>`;
  host.dataset.key = key;
  host.dataset.viewKey = viewKey;
  const body = host.querySelector(".conversation-body");
  if (body) body.scrollTop = wasFollowing ? body.scrollHeight : restoreScroll;
  bindViewerActions(run.id);
}

// 从 run 卡打开：指向该 run 的组，可选指定来源；scrollToViewer=false 用于
// 组间/run 间切换（此时按各来源保存的滚动位置恢复，不抢滚动）。
function openSharedViewer(runId, source, {scrollToViewer = true} = {}) {
  const run = state.detail?.runs.find(candidate => candidate.id === runId);
  if (!run || !run.artifact_available) return;
  const v = state.convViewer;
  v.open = true;
  v.activeGroup = run.group;
  const g = viewerGroupState(run.group);
  if (g.runId !== runId) {
    Object.values(g.sources).forEach(s => { s.loaded = false; s.newCount = 0; });
    g.runId = runId;
  }
  if (source) g.source = source;
  stopAllConversationPolling();
  Object.values(state.conversations).forEach(conv => { conv.open = false; });
  const conv = conversationState(runId);
  conv.open = true;
  if (conv.source !== g.source) { conv.source = g.source; conv.data = null; conv.signature = null; }
  renderDetail(state.detail);
  fetchConversation(runId);
  startConversationPolling(runId);
  if (scrollToViewer) {
    requestAnimationFrame(() => $("#conversationViewer")?.scrollIntoView({behavior: "smooth", block: "start"}));
  }
}

// 组间切换：默认选与当前 run 同 case、同 trial 的配对 run（pair_parallel 的
// 对齐关系），缺配对时退回同 case，再退回该组第一个可查看 run。
function switchViewerGroup(group) {
  const v = state.convViewer;
  if (!v.open || v.activeGroup === group) return;
  const currentRunId = v.groups[v.activeGroup]?.runId;
  const g = viewerGroupState(group);
  const candidates = state.detail.runs.filter(candidate => candidate.group === group && candidate.artifact_available);
  if (!candidates.length) { toast(`${GROUP_LABELS[group] || group}没有可查看的对话`); return; }
  if (!g.runId || !candidates.some(candidate => candidate.id === g.runId)) {
    const cur = state.detail.runs.find(candidate => candidate.id === currentRunId);
    g.runId = (candidates.find(candidate => candidate.case_id === cur?.case_id && candidate.trial === cur?.trial)
      || candidates.find(candidate => candidate.case_id === cur?.case_id)
      || candidates[0]).id;
  }
  openSharedViewer(g.runId, null, {scrollToViewer: false});
}

function closeViewer() {
  state.convViewer.open = false;
  stopAllConversationPolling();
  Object.values(state.conversations).forEach(conv => { conv.open = false; });
  if (state.detail) renderDetail(state.detail);
}

function toggleConversation(runId) {
  if (state.convViewer.open && isViewerRun(runId)) closeViewer();
  else openSharedViewer(runId);
}

function openConversationAt(runId, source) {
  openSharedViewer(runId, source);
}

function switchConversationSource(runId, source) {
  const conv = conversationState(runId);
  if (isViewerRun(runId)) viewerGroupState(state.convViewer.activeGroup).source = source;
  if (conv.source === source) return;
  conv.source = source;
  conv.data = null;
  conv.signature = null;
  const src = activeViewerSourceState();
  if (src) src.loaded = false;
  renderConversationInto(runId);
  fetchConversation(runId);
}

async function loadPromptInto(details, runId) {
  const pre = details.querySelector("pre");
  if (!pre || pre.dataset.loaded) return;
  const conv = conversationState(runId);
  const [, attempt, file] = details.dataset.convPrompt.split("|");
  const cacheKey = `${conv.unmasked ? "raw" : "masked"}|${file}`;
  if (conv.promptCache?.[cacheKey]) {
    pre.textContent = conv.promptCache[cacheKey];
    pre.dataset.loaded = "1";
    return;
  }
  pre.textContent = "正在读取提示词…";
  try {
    const path = file.split("/").map(encodeURIComponent).join("/");
    const result = await api(`/api/v1/runs/${runId}/log-files/${path}?preview=true&attempt=${attempt}${conv.unmasked ? "&unmasked=true" : ""}`);
    conv.promptCache ||= {};
    conv.promptCache[cacheKey] = result.content || "（提示词为空）";
    pre.textContent = conv.promptCache[cacheKey];
    pre.dataset.loaded = "1";
  } catch (error) {
    pre.textContent = `提示词读取失败：${error.message}`;
  }
}

function bindViewerActions(runId) {
  const host = $("#conversationViewer");
  if (!host) return;
  host.querySelectorAll("[data-viewer-group]").forEach(button =>
    button.addEventListener("click", () => switchViewerGroup(button.dataset.viewerGroup)));
  host.querySelectorAll("[data-viewer-run]").forEach(button =>
    button.addEventListener("click", () => {
      if (button.dataset.viewerRun !== runId) openSharedViewer(button.dataset.viewerRun, null, {scrollToViewer: false});
    }));
  host.querySelectorAll("[data-conv-source]").forEach(button =>
    button.addEventListener("click", () => switchConversationSource(runId, button.dataset.convSource)));
  host.querySelectorAll("[data-conv-unmasked]").forEach(toggle =>
    toggle.addEventListener("change", () => toggleConversationMask(runId)));
  host.querySelectorAll("[data-conv-copy]").forEach(button =>
    button.addEventListener("click", () => copyConversation(runId)));
  host.querySelectorAll("[data-conv-export]").forEach(button =>
    button.addEventListener("click", () => exportConversation(runId)));
  host.querySelectorAll("[data-viewer-close]").forEach(button =>
    button.addEventListener("click", () => closeViewer()));
  host.querySelector("[data-conv-new]")?.addEventListener("click", () => {
    const body = $("#convViewerBody");
    if (body) body.scrollTop = body.scrollHeight;
  });
  // Turn 手风琴：打开一个就收起其他；再次点击收起当前（openTurn 置空）
  host.querySelectorAll(".conv-turn").forEach(details => {
    details.addEventListener("toggle", () => {
      const src = activeViewerSourceState();
      if (!src) return;
      const turnKey = details.dataset.convTurn;
      if (details.open) {
        src.openTurn = turnKey;
        host.querySelectorAll(".conv-turn[open]").forEach(other => { if (other !== details) other.open = false; });
      } else if (src.openTurn === turnKey) src.openTurn = null;
    });
  });
  // 提示词/思考/工具调用的展开状态保存在当前 (组, 来源) 上
  host.querySelectorAll("details[data-conv-key]").forEach(details =>
    details.addEventListener("toggle", () => {
      const src = activeViewerSourceState();
      if (!src) return;
      if (details.open) src.expanded.add(details.dataset.convKey);
      else src.expanded.delete(details.dataset.convKey);
    }));
  host.querySelectorAll("details[data-conv-prompt]").forEach(details =>
    details.addEventListener("toggle", () => { if (details.open) loadPromptInto(details, runId); }));
  host.querySelectorAll("details[data-conv-prompt][open]").forEach(details =>
    loadPromptInto(details, runId));
  // 滚动位置随当前来源保存；回到底部即清空“新消息”徽标
  const body = $("#convViewerBody");
  body?.addEventListener("scroll", () => {
    const src = activeViewerSourceState();
    if (!src) return;
    src.scrollTop = body.scrollTop;
    if (src.newCount && body.scrollHeight - body.scrollTop - body.clientHeight < 48) {
      src.newCount = 0;
      src.lastSeenCount = src.totalItems;
      host.querySelector(".conv-new-badge")?.remove();
    }
  });
}

function downloadText(filename, text) {
  const blob = new Blob([text], {type: "text/plain;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function fetchConversationPrompt(runId, attempt, file) {
  const conv = conversationState(runId);
  const cacheKey = `${conv.unmasked ? "raw" : "masked"}|${file}`;
  conv.promptCache ||= {};
  if (conv.promptCache[cacheKey] !== undefined) return conv.promptCache[cacheKey];
  const path = file.split("/").map(encodeURIComponent).join("/");
  const result = await api(`/api/v1/runs/${runId}/log-files/${path}?preview=true&attempt=${attempt}${conv.unmasked ? "&unmasked=true" : ""}`);
  conv.promptCache[cacheKey] = result.content || "（提示词为空）";
  return conv.promptCache[cacheKey];
}

async function buildConversationText(runId, {withPrompts = false} = {}) {
  const conv = conversationState(runId);
  const itemLine = item => {
    if (item.type === "message") return `Agent 回复：\n${item.text}`;
    if (item.type === "thought") return `Agent 思考：\n${item.text}`;
    if (item.type === "tool_call") {
      const status = TOOL_STATUS_LABELS[item.status] || item.status || "未知";
      return [`工具调用：${item.name || item.tool_call_id}（${status}）`,
        item.input ? `  入参：${item.input}` : null,
        item.result ? `  结果：${item.result}` : "  结果：（无记录）"].filter(Boolean).join("\n");
    }
    if (item.type === "plan") return `计划更新 · ${item.completed}/${item.entries} 项完成`;
    if (item.type === "system_error") return `Chrys 错误 · ${item.text}`;
    if (item.type === "system_warning") return `Chrys 警告 · ${item.text}`;
    return null;
  };
  const lines = [];
  const experiment = state.detail;
  lines.push(`# ${experiment ? experiment.suite_name : "实验"} · ${conv.source === "runner" ? "Runner" : "Judge"} 对话回放`);
  lines.push(`run: ${runId}`);
  lines.push(`导出时间：${new Date().toISOString()}`);
  lines.push(`敏感值：${conv.unmasked ? "未遮盖（原文）" : "已按默认规则遮盖"}`);
  for (const attempt of conv.data?.attempts || []) {
    lines.push(`\n===== 尝试 #${attempt.attempt} =====`);
    if (!attempt.available) {
      lines.push(attempt.reason || "没有对话记录");
      continue;
    }
    const session = attempt.session || {};
    const meta = [
      session.model && `模型 ${session.model}`,
      session.agent && `agent ${session.agent}`,
      session.tools != null ? `工具 ${session.tools} 个` : "",
    ].filter(Boolean).join(" · ");
    if (meta) lines.push(`会话：${meta}`);
    for (const turn of attempt.turns) {
      const usage = turn.usage?.input_tokens != null
        ? ` · tokens ${turn.usage.input_tokens}/${turn.usage.output_tokens ?? "—"}` : "";
      lines.push(`\n-- 第 ${turn.turn} 轮 · ${turn.stop_reason ? `stop ${turn.stop_reason}` : "未收到结束信号"}${usage} --`);
      if (turn.prompt?.file) {
        if (withPrompts) {
          const promptText = await fetchConversationPrompt(runId, attempt.attempt, turn.prompt.file);
          lines.push(`[提示词 ${turn.prompt.file}]\n${promptText}`);
        } else {
          lines.push(`[提示词 ${turn.prompt.file}（${fmtSize(turn.prompt.bytes)}，导出文件内含全文）]`);
        }
      } else {
        lines.push("[提示词记录缺失]");
      }
      turn.items.forEach(item => {
        const line = itemLine(item);
        if (line) lines.push(line);
      });
      if (turn.error) lines.push(`轮次错误：${JSON.stringify(turn.error)}`);
    }
  }
  return lines.join("\n");
}

async function copyConversation(runId) {
  const conv = conversationState(runId);
  if (!conv.data) return toast("对话尚未加载");
  try {
    const text = await buildConversationText(runId);
    await navigator.clipboard.writeText(text);
    toast(conv.unmasked ? "已复制对话（未遮盖原文）" : "已复制对话（敏感值已遮盖）");
  } catch {
    toast("浏览器未允许复制，请手动选择内容");
  }
}

async function exportConversation(runId) {
  const conv = conversationState(runId);
  if (!conv.data) return toast("对话尚未加载");
  toast("正在生成导出文件（含提示词全文）…");
  try {
    const text = await buildConversationText(runId, {withPrompts: true});
    const name = `conversation-${runId.slice(0, 8)}-${conv.source}${conv.unmasked ? "-raw" : "-masked"}.txt`;
    downloadText(name, text);
    toast(conv.unmasked ? `已导出 ${name}（未遮盖原文）` : `已导出 ${name}（敏感值已遮盖）`);
  } catch (error) {
    toast(`导出失败：${error.message}`);
  }
}

function verdictMarkup(item) {
  const conclusion = item.conclusion;
  if (!conclusion) return "";
  if (["queued", "preparing", "running"].includes(item.status)) {
    return `<span class="verdict-badge is-running">实验进行中</span><span class="verdict-note">结论将在所有 run 完成后给出</span>`;
  }
  const map = {
    gates_failed: ["is-gates-failed", "未达标", "硬门禁未通过 · 硬门禁优先于质量分，分数保留供分析"],
    provisional: ["is-provisional", "暂定结论", "候选组尚缺 trial · 差值不参与正式比较"],
    no_score: ["is-no-score", "无有效评分", "候选组没有完成的 run，无法给出结论"],
    solid: ["is-solid", "结论有效", "硬门禁通过 · trial 齐全 · 差值为正式比较"],
  };
  const [cls, label, note] = map[conclusion.verdict] || ["is-unknown", conclusion.verdict, ""];
  return `<span class="verdict-badge ${cls}">${escapeHtml(label)}</span><span class="verdict-note">${escapeHtml(note)}</span>`;
}

function groupScoreChip(item, group) {
  const info = item.conclusion?.groups?.[group];
  if (!info) return "";
  if (info.missing) {
    return `<span class="group-chip is-missing"><small>${GROUP_LABELS[group]}</small><strong>—</strong><span class="chip-note">未参与（无基准修订）</span></span>`;
  }
  const notes = [];
  notes.push(info.provisional
    ? `<span class="chip-note provisional">暂定 ${info.completed_trials}/${info.expected_trials} trial</span>`
    : `<span class="chip-note">${info.completed_trials}/${info.expected_trials} trial</span>`);
  if (info.gates_total) notes.push(`<span class="chip-note${info.gates_failed ? " gates-failed" : ""}">门禁 ${info.gates_passed}/${info.gates_total}</span>`);
  return `<span class="group-chip${info.gates_failed ? " is-gates-failed" : ""}${info.provisional ? " is-provisional" : ""}"><small>${GROUP_LABELS[group]}</small><strong>${info.score == null ? "—" : fmtScore(info.score)}</strong>${notes.join("")}</span>`;
}

function conclusionMarkup(item) {
  const conclusion = item.conclusion;
  if (!conclusion) return "";
  const deltaCell = (value, formal, label) => {
    if (value == null) return `<span class="delta-item">${label}<span class="delta">—</span></span>`;
    const tag = formal ? '<small class="delta-formal">正式比较</small>' : '<small class="delta-provisional">暂定 · 不参与正式比较</small>';
    return `<span class="delta-item">${label}${fmtDelta(value)}${tag}</span>`;
  };
  // 紧凑结果带（方案二）：结论、三组总分、硬门禁、差值各出现一次，
  // 不再使用三张大分数卡，也不再与对照表头重复。
  return `<div class="conclusion-band">
    <div class="conclusion-verdict">${verdictMarkup(item)}</div>
    <div class="conclusion-groups">${GROUP_ORDER.map(group => groupScoreChip(item, group)).join("")}</div>
    <div class="conclusion-deltas">${deltaCell(item.delta_no_skill, conclusion.formal_deltas?.no_skill, "当前 vs 无 Skill")}${deltaCell(item.delta_baseline, conclusion.formal_deltas?.baseline, "当前 vs 基准")}</div>
  </div>`;
}

function caseRunStats(byGroup) {
  const mean = runs => {
    const scored = runs.filter(run => run.status === "completed" && run.quality_score != null);
    return scored.length ? fmean(scored.map(run => run.quality_score)) : null;
  };
  const current = byGroup.current || [];
  const completed = current.filter(run => run.status === "completed");
  const gateFailed = completed.some(run => (run.hard_gates?.total || 0) > 0 && run.hard_gates.passed < run.hard_gates.total);
  const currentMean = mean(current);
  const noSkillMean = mean(byGroup.no_skill || []);
  return {
    gateFailed,
    delta: currentMean != null && noSkillMean != null ? currentMean - noSkillMean : null,
  };
}

function defaultCaseId(item, byGroup) {
  const cases = item.suite_snapshot?.cases || [];
  if (!cases.length) return null;
  if (cases.length === 1) return cases[0].id;
  // 方案一.3 默认选择顺序：硬门禁失败 > current 相对 no_skill 差值最差 > 套件中的第一个 case
  const ranked = cases.map((spec, index) => {
    const stats = caseRunStats(byGroup.get(spec.id) || {});
    return {id: spec.id, index, gateFailed: stats.gateFailed, delta: stats.delta};
  }).sort((a, b) =>
    Number(b.gateFailed) - Number(a.gateFailed)
    || (a.delta ?? Infinity) - (b.delta ?? Infinity)
    || a.index - b.index);
  return ranked[0].id;
}

function selectedCase(item, byGroup) {
  const cases = item.suite_snapshot?.cases || [];
  if (!cases.length) return null;
  if (!state.detailCaseId || !cases.some(spec => spec.id === state.detailCaseId)) {
    state.detailCaseId = defaultCaseId(item, byGroup);
  }
  return cases.find(spec => spec.id === state.detailCaseId) || cases[0];
}

function caseSelectorMarkup(item, byGroup) {
  const cases = item.suite_snapshot?.cases || [];
  if (cases.length < 2) return "";
  return `<div class="case-selector" role="tablist" aria-label="选择测评用例（一次只展示一个）">${cases.map(spec => {
    const stats = caseRunStats(byGroup.get(spec.id) || {});
    const flag = stats.gateFailed
      ? '<span class="case-flag is-gate" title="该用例 current 组硬门禁未通过">门禁未过</span>'
      : stats.delta != null && stats.delta < 0
        ? `<span class="case-flag is-drop" title="current 相对 no_skill 差值 ${stats.delta.toFixed(1)}">${fmtDelta(stats.delta)}</span>`
        : "";
    const active = spec.id === state.detailCaseId;
    return `<button type="button" class="case-chip${active ? " active" : ""}" role="tab" aria-selected="${active}" data-case-select="${escapeHtml(spec.id)}"><span class="case-chip-name">${escapeHtml(spec.name || spec.id)}</span>${flag}</button>`;
  }).join("")}</div>`;
}

const GRADER_TYPE_LABELS = {command: "命令验证器", file_exists: "文件存在检查", forbidden_changes: "禁改检查", llm_rubric: "LLM 评分"};

function snapshotPre(text) {
  // 长文本使用内部滚动（CSS max-height + overflow），不无限拉长页面（方案一.4）
  return `<pre class="snapshot-text">${escapeHtml(text || "")}</pre>`;
}

function graderSnapshotRow(grader) {
  const typeLabel = `${GRADER_TYPE_LABELS[grader.type] || grader.type} · 权重 ${grader.weight ?? "—"}${grader.hard_gate ? " · 硬门禁（必须通过）" : ""}`;
  const config = [
    grader.command ? `<span class="snap-kv"><small>command</small><code>${escapeHtml(grader.command)}</code></span>` : "",
    grader.path ? `<span class="snap-kv"><small>path</small><code>${escapeHtml(grader.path)}</code></span>` : "",
    Array.isArray(grader.patterns) && grader.patterns.length ? `<span class="snap-kv"><small>patterns</small><code>${escapeHtml(grader.patterns.join(" · "))}</code></span>` : "",
    grader.rubric ? `<details class="snap-rubric"><summary>rubric（点击展开）</summary>${snapshotPre(grader.rubric)}</details>` : "",
    `<span class="snap-kv"><small>timeout</small><code>${grader.timeout_seconds ?? "—"}s</code></span>`,
  ].filter(Boolean).join("");
  return `<div class="grader-snapshot${grader.hard_gate ? " is-gate" : ""}">
    <div class="grader-snapshot-head"><strong>${escapeHtml(grader.name || grader.id)}</strong><code>${escapeHtml(grader.id)}</code><span class="dim-type${grader.hard_gate ? " gate" : ""}">${escapeHtml(typeLabel)}</span></div>
    <div class="grader-snapshot-config">${config}</div>
  </div>`;
}

function caseSnapshotMarkup(item, caseSpec) {
  const graders = caseSpec.graders || [];
  const followups = Array.isArray(caseSpec.followups) ? caseSpec.followups : [];
  const collapsedMeta = `<span class="snap-field"><small>用例 ID</small><code>${escapeHtml(caseSpec.id)}</code></span>
    <span class="snap-field"><small>权重</small><code>${caseSpec.weight ?? 1}</code></span>
    <span class="snap-field"><small>评分维度</small><code>${graders.length} 项</code></span>
    <span class="snap-field"><small>最大对话轮数</small><code>${caseSpec.max_turns ?? "—"}</code></span>`;
  const body = `<div class="snapshot-grid">
        <div class="snapshot-block"><h4>Agent 输入</h4>${snapshotPre(caseSpec.input)}</div>
        <div class="snapshot-block"><h4>预期效果（仅评测器可见）</h4>${snapshotPre(caseSpec.expected)}</div>
        ${caseSpec.agent_context ? `<div class="snapshot-block"><h4>Agent context</h4>${snapshotPre(caseSpec.agent_context)}</div>` : ""}
        <div class="snapshot-block"><h4>对话设置</h4><div class="snap-kv-row"><span class="snap-kv"><small>最大轮数</small><code>${caseSpec.max_turns ?? "—"}</code></span><span class="snap-kv"><small>Follow-up</small><code>${followups.length} 条</code></span></div>${followups.length ? `<ul class="snap-followups">${followups.map(followup => `<li><small>触发条件（输出包含）</small><code>${escapeHtml(followup.when_output_contains)}</code><small>回复</small>${snapshotPre(followup.reply)}</li>`).join("")}</ul>` : ""}</div>
      </div>
      <div class="snapshot-block"><h4>评分维度（${graders.length} 项）</h4>${graders.map(graderSnapshotRow).join("")}</div>`;
  return `<details class="case-snapshot" id="caseSnapshot"${state.caseSnapshotOpen ? " open" : ""}>
    <summary>
      <span class="case-snapshot-title"><strong>${escapeHtml(caseSpec.name || caseSpec.id)}</strong><span class="snapshot-badge" title="以下定义为实验创建时固化的套件快照，可能与当前套件定义不同">本次实验快照</span></span>
      <span class="case-snapshot-meta">${collapsedMeta}</span>
      <span class="case-snapshot-toggle">${state.caseSnapshotOpen ? "收起" : "查看用例定义"}</span>
    </summary>
    <div class="case-snapshot-body">${body}</div>
  </details>`;
}

function caseSectionMarkup(item) {
  const cases = item.suite_snapshot?.cases || [];
  if (!cases.length) {
    // 旧版实验缺少固化的套件快照：明确标注缺失，不补造
    return `<div class="case-snapshot case-snapshot-empty"><p class="snap-missing">本实验缺少固化的套件快照（旧版实验记录），无法展示用例定义；结果对照与运行明细仍基于已有 run 数据。</p></div>`;
  }
  const grouped = runsByCaseAndGroup(item);
  const selected = selectedCase(item, grouped);
  if (!selected) return "";
  return `${caseSelectorMarkup(item, grouped)}${caseSnapshotMarkup(item, selected)}`;
}

function runsByCaseAndGroup(item) {
  const grouped = new Map();
  item.runs.forEach(run => {
    let byGroup = grouped.get(run.case_id);
    if (!byGroup) { byGroup = {}; grouped.set(run.case_id, byGroup); }
    (byGroup[run.group] ||= []).push(run);
  });
  return grouped;
}

function graderScoreStats(grader, runs) {
  // 方案四：非完成 Run 不参与均分——均值只统计已完成 Run 的数值分数，
  // 与雷达图 graderMeanScore 同一数据源同一算法。
  const comps = runs
    .filter(run => run.status === "completed")
    .map(run => (run.scores?.components || []).find(entry => entry.grader_id === grader.id))
    .filter(comp => comp && comp.score != null);
  return {
    mean: comps.length ? fmean(comps.map(comp => Number(comp.score))) : null,
    count: comps.length,
    gatePassed: comps.filter(comp => comp.passed).length,
    gateTotal: comps.length,
  };
}

function comparisonListTypeLabel(grader) {
  // 明细列表行内直接携带类型与权重——总分是加权均值，权重必须可见（可对账）。
  return grader.hard_gate
    ? "硬门禁（必须通过）"
    : grader.type === "duration"
      ? `执行效率（按总耗时折算） · 权重 ${grader.weight ?? "—"}`
      : grader.type === "llm_rubric"
        ? `LLM 评分 · 权重 ${grader.weight ?? "—"}`
        : `命令验证器 · 权重 ${grader.weight ?? "—"}`;
}

function comparisonListValue(grader, runs) {
  // 与 graderScoreStats 同一数据源同一算法：已完成 Run 的数值分数均值；
  // 硬门禁行显示通过状态而非分数。未完成 run 给出占位说明。
  const stats = graderScoreStats(grader, runs);
  if (!stats.count) {
    const unfinished = runs.filter(run => run.status !== "completed").length;
    return unfinished
      ? {text: "未评分", cls: "", note: `${unfinished} 个 run 未完成`}
      : {text: "—", cls: "", note: ""};
  }
  if (grader.hard_gate) {
    const passed = stats.gatePassed === stats.gateTotal;
    return {text: passed ? "通过" : "未通过", cls: passed ? "ok" : "bad", note: ""};
  }
  return {text: fmtScore(stats.mean), cls: "", note: stats.count > 1 ? `均值 ${stats.count} trial` : ""};
}

function comparisonQualityValue(runs) {
  const completed = runs.filter(run => run.status === "completed" && run.quality_score != null);
  if (!completed.length) return {text: "—", cls: "", note: "", gatesFail: false};
  const gatesFail = completed.some(run => (run.hard_gates?.total || 0) > 0 && run.hard_gates.passed < run.hard_gates.total);
  return {
    text: fmtScore(fmean(completed.map(run => run.quality_score))),
    cls: gatesFail ? "bad" : "",
    note: `${completed.length}/${runs.length} trial`,
    gatesFail,
  };
}

function trialGroupCell(grader, run) {
  // 方案四：按 trial_index 对齐后，某一组这一侧的 Trial 单元格。
  // 失败/缺失/排队中/运行中的一侧保留占位；非完成 Run 可查看状态和错误。
  if (!run) {
    return `<div class="trial-cell is-missing"><span class="cell-empty">缺失（该组没有此 Trial 的 run 记录）</span></div>`;
  }
  const comp = (run.scores?.components || []).find(entry => entry.grader_id === grader.id);
  const isGate = !!grader.hard_gate || (comp ? !!comp.hard_gate : false);
  let scoreHtml;
  if (comp && comp.score != null) {
    const value = isGate ? (comp.passed ? "通过" : "未通过") : fmtScore(comp.score);
    const cls = comp.passed === false ? "bad" : comp.passed === true ? "ok" : "";
    scoreHtml = `<span class="trial-score ${cls}">${escapeHtml(value)}</span>`;
  } else if (run.status === "running") {
    scoreHtml = '<span class="cell-empty">运行中 · 暂无评分</span>';
  } else if (run.status === "queued") {
    scoreHtml = '<span class="cell-empty">排队中 · 尚未开始</span>';
  } else {
    scoreHtml = '<span class="cell-empty">未评分（Runner 未完成，不参与均分）</span>';
  }
  const judgeLog = run.artifact_available
    ? `<button class="text-button" data-judge-log="${run.id}">Judge 对话</button>`
    : "";
  const error = run.status !== "completed" && run.error_message
    ? `<p class="trial-error"><strong>${escapeHtml(run.error_kind || "error")}</strong> · ${escapeHtml(errorText(run.error_message))}</p>`
    : "";
  return `<div class="trial-cell${run.status !== "completed" ? " is-unfinished" : ""}">
    <div class="trial-cell-head"><span class="pill ${run.status}">${escapeHtml(experimentStatusLabel(run.status))}</span>${scoreHtml}${run.current_attempt > 1 ? `<span class="trial-invalid">重试 #${run.current_attempt}</span>` : ""}${comp?.invalid ? '<span class="trial-invalid">无效</span>' : ""}${judgeLog}</div>
    ${error}
    ${comp?.reasoning ? `<p class="trial-reasoning"><strong>评分理由：</strong>${escapeHtml(comp.reasoning)}</p>` : ""}
    ${comp?.evidence ? `<details class="trial-evidence"><summary>证据</summary><pre>${escapeHtml(comp.evidence)}</pre></details>` : ""}
  </div>`;
}

function trialComparisonBlock(grader, byGroup, availableGroups) {
  // 按 Trial 分行，no_skill 与 current（及 baseline 第三列）并排对齐；
  // 一次展开即同时展示所有参与组。供明细列表的展开面板复用。
  const trialIndexes = [...new Set(
    availableGroups.flatMap(group => (byGroup[group] || []).map(run => run.trial))
  )].sort((a, b) => a - b);
  const head = `<div class="trial-comparison-grid trial-comparison-head"><span class="trial-index-label">Trial</span>${availableGroups.map(group => `<span class="trial-group-label">${GROUP_LABELS[group]}</span>`).join("")}</div>`;
  const rows = trialIndexes.map(trial => {
    const cells = availableGroups
      .map(group => (byGroup[group] || []).find(run => run.trial === trial))
      .map(run => trialGroupCell(grader, run));
    return `<div class="trial-comparison-grid"><span class="trial-index-label">Trial ${trial}</span>${cells.join("")}</div>`;
  }).join("");
  return `<div class="trial-comparison" data-trial-comparison="${escapeHtml(grader.id)}" style="--trial-groups:${availableGroups.length}">${head}${rows || '<p class="cell-empty">该维度还没有任何 run 记录。</p>'}</div>`;
}

function caseReviewsMarkup(byGroup, availableGroups) {
  const entries = [];
  availableGroups.forEach(group => (byGroup[group] || []).forEach(run => (run.reviews || []).forEach(review => entries.push({group, run, review}))));
  // 方案二：无人工复核时不显示空白模块
  if (!entries.length) return "";
  const means = availableGroups
    .map(group => {
      const scores = [];
      (byGroup[group] || []).forEach(run => (run.reviews || []).forEach(review => scores.push(review.score)));
      return scores.length ? `${GROUP_LABELS[group]} ${fmtScore(fmean(scores))}` : "";
    })
    .filter(Boolean)
    .join(" · ");
  return `<div class="case-reviews"><strong>人工复核（与自动分并列保存 · ${entries.length} 条）</strong><ul>${entries.map(({group, run, review}) => `<li><span class="review-group">${GROUP_LABELS[group]} · Trial ${run.trial}</span><strong>${fmtScore(review.score)}</strong><span class="review-meta">${escapeHtml(review.reviewer)} · ${fmtTime(review.created_at)}${review.note ? ` · “${escapeHtml(review.note)}”` : ""}</span></li>`).join("")}</ul>${means ? `<p class="review-means">人工均分：${means}</p>` : ""}</div>`;
}

function comparisonListMarkup(caseSpec, byGroup, data) {
  // 明细列表（合并原明细表）：质量分 + 全部评分维度（含硬门禁）+ 执行效率
  //（服务端合成分量，仅已配置 time_scoring 的实验出现）按组分列对齐，
  // 每行携带类型与权重，点击展开该维度的 Trial 对照；人工复核挂在列表尾部。
  const availableGroups = GROUP_ORDER.filter(group => (byGroup[group] || []).length);
  const graderRows = [...(caseSpec.graders || [])];
  const timeAxis = data?.axes.find(axis => axis.id === EXECUTION_TIME_GRADER_ID);
  if (timeAxis) graderRows.push(timeAxis);
  const columns = `12px minmax(0,1fr) repeat(${availableGroups.length}, minmax(78px, max-content))`;
  const head = `<li class="dimension-head" style="grid-template-columns:${columns}" aria-hidden="true"><span></span><span class="dimension-name">评分维度</span>${availableGroups.map(group => `<span class="dimension-value">${GROUP_LABELS[group]}</span>`).join("")}</li>`;
  const quality = `<li class="dimension-item quality-item"><div class="dimension-row" style="grid-template-columns:${columns}">
      <span></span>
      <span class="dimension-main"><span class="dimension-name">质量分</span><span class="dimension-meta">加权均值 · 硬门禁不计入</span></span>
      ${availableGroups.map(group => {
        const runs = byGroup[group] || [];
        const value = comparisonQualityValue(runs);
        return `<span class="dimension-value ${value.cls}"><strong>${escapeHtml(value.text)}</strong>${value.note ? `<small>${escapeHtml(value.note)}</small>` : ""}${value.gatesFail ? '<small class="gates-note">门禁未过 · 未达标</small>' : ""}</span>`;
      }).join("")}
    </div></li>`;
  const items = graderRows.map(grader => {
    const expanded = state.expandedDimensions.has(grader.id);
    return `<li class="dimension-item${grader.hard_gate ? " is-gate" : ""}${expanded ? " is-expanded" : ""}">
      <button type="button" class="dimension-row" style="grid-template-columns:${columns}" data-dimension-open="${escapeHtml(grader.id)}" aria-expanded="${expanded}" title="${expanded ? "收起" : "展开"}该维度的 Trial 对照">
        <span class="dimension-chevron" aria-hidden="true">›</span>
        <span class="dimension-main"><span class="dimension-name">${escapeHtml(grader.name || grader.id)}</span><span class="dimension-meta">${escapeHtml(comparisonListTypeLabel(grader))}</span></span>
        ${availableGroups.map(group => {
          const value = comparisonListValue(grader, byGroup[group] || []);
          return `<span class="dimension-value ${value.cls}"><strong>${escapeHtml(value.text)}</strong>${value.note ? `<small>${escapeHtml(value.note)}</small>` : ""}</span>`;
        }).join("")}
      </button>
      ${expanded ? `<div class="dimension-trial-panel">${trialComparisonBlock(grader, byGroup, availableGroups)}</div>` : ""}
    </li>`;
  }).join("");
  return `<ul class="radar-dimensions">${head}${quality}${items}</ul>${caseReviewsMarkup(byGroup, availableGroups)}`;
}

function caseRunsOfGroup(byGroup, group) {
  return byGroup[group] || [];
}

function graderMeanScore(grader, runs) {
  // 与明细列表 comparisonListValue/comparisonQualityValue 同一数据源与同一算法（graderScoreStats）：
  // 已完成 Run 中该 grader 的数值分数均值（雷达与明细表一致性的基础）
  return graderScoreStats(grader, runs).mean;
}

function caseComparisonData(item, caseSpec, byGroup) {
  // 方案三数据规则：坐标轴只含 hard_gate=false 且产生数值分数的 grader
  //（command/llm_rubric 等非门禁 grader 均产出 0-100 数值分）。
  const axes = (caseSpec.graders || []).filter(grader => !grader.hard_gate);
  // 「执行效率」是服务端按 time_scoring 折算总耗时的合成分量：任一 run 带有该
  // 分量时作为追加轴参与雷达与明细列表（旧实验无此分量，不受影响）。
  const timeComponent = GROUP_ORDER
    .flatMap(group => caseRunsOfGroup(byGroup, group))
    .flatMap(run => run.scores?.components || [])
    .find(component => component.grader_id === EXECUTION_TIME_GRADER_ID);
  if (timeComponent) {
    axes.push({
      id: EXECUTION_TIME_GRADER_ID,
      name: "执行效率",
      type: "duration",
      hard_gate: false,
      weight: timeComponent.weight,
    });
  }
  const hasGateGraders = (caseSpec.graders || []).some(grader => grader.hard_gate);
  const expectedTrials = item.trials || 1;
  const series = GROUP_ORDER
    .filter(group => caseRunsOfGroup(byGroup, group).length > 0)
    .map(group => {
      const runs = caseRunsOfGroup(byGroup, group);
      const completed = runs.filter(run => run.status === "completed" && run.quality_score != null);
      const values = axes.map(axis => graderMeanScore(axis, runs));
      const gatesPassed = completed.reduce((sum, run) => sum + (run.hard_gates?.passed || 0), 0);
      const gatesTotal = completed.reduce((sum, run) => sum + (run.hard_gates?.total || 0), 0);
      return {
        group,
        runs,
        completedTrials: completed.length,
        totalTrials: runs.length,
        quality: completed.length ? fmean(completed.map(run => run.quality_score)) : null,
        values,
        hasAnyValue: values.some(value => value != null),
        provisional: completed.length > 0 && completed.length < expectedTrials,
        gatesPassed,
        gatesTotal,
        gatesFailed: gatesTotal > 0 && gatesPassed < gatesTotal,
      };
    });
  return {axes, series, hasGateGraders};
}

function radarLabelLines(name) {
  // 均衡折行：超过 11 字断成两行，优先语义分隔符（顿号/间隔号），
  // 且保证第二行不长于第一行，避免"首行短、次行长"的失衡观感。
  if (name.length <= 11) return [name];
  const semantic = [...name.matchAll(/[、·]/g)]
    .map(match => match.index + 1)
    .find(cut => cut > 2 && cut < name.length - 2 && name.length - cut <= cut);
  const cut = semantic ?? Math.ceil(name.length / 2);
  return [name.slice(0, cut), name.slice(cut)];
}

function radarPointMarkup(group, axisIndex, value, axis, entry) {
  const style = RADAR_GROUP_STYLES[group] || RADAR_GROUP_STYLES.current;
  const size = 300, cx = size / 2, cy = size / 2, radius = 96;
  const angle = (Math.PI * 2 * axisIndex) / (axis.total) - Math.PI / 2;
  const r = radius * Math.max(0, Math.min(100, value)) / 100;
  const x = cx + r * Math.cos(angle), y = cy + r * Math.sin(angle);
  const shape = style.point === "square"
    ? `<rect x="${(x - 3.5).toFixed(1)}" y="${(y - 3.5).toFixed(1)}" width="7" height="7" fill="${style.color}" stroke="white" stroke-width="1.2"/>`
    : style.point === "triangle"
      ? `<path d="M ${x.toFixed(1)} ${(y - 4.5).toFixed(1)} L ${(x + 4.2).toFixed(1)} ${(y + 3.4).toFixed(1)} L ${(x - 4.2).toFixed(1)} ${(y + 3.4).toFixed(1)} Z" fill="${style.color}" stroke="white" stroke-width="1.2"/>`
      : `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${style.color}" stroke="white" stroke-width="1.2"/>`;
  const label = `${axis.name || axis.id} · ${GROUP_LABELS[group]}：${value.toFixed(1)}（${entry.completedTrials} 个已完成 Trial 均值）`;
  return `<g class="radar-point" tabindex="0" role="img" aria-label="${escapeHtml(label)}" data-radar-point data-tooltip="${escapeHtml(label)}" data-group="${escapeHtml(group)}" data-axis="${escapeHtml(axis.id)}" data-value="${value.toFixed(4)}">${shape}</g>`;
}

function radarSvgMarkup(data) {
  const size = 300, cx = size / 2, cy = size / 2, radius = 96;
  const total = data.axes.length;
  const angle = i => (Math.PI * 2 * i) / total - Math.PI / 2;
  const xy = (i, value) => {
    const r = radius * Math.max(0, Math.min(100, value)) / 100;
    return [cx + r * Math.cos(angle(i)), cy + r * Math.sin(angle(i))];
  };
  // 动态画布（不硬编码余量）：按每个轴标签的估算像素宽、锚点方向与行数，
  // 计算标签实际占用的四向边界，生成恰好包住"圆 + 全部标签"的 viewBox。
  // 标签因此永远落在 SVG 自身边界内，不可能溢出画布撞进相邻栏目。
  const fontSize = 10.5, lineHeight = 12, labelGap = 10, pad = 4;
  const charWidth = fontSize;  // 中文字符宽 ≈ 字号
  let minX = 0, minY = 0, maxX = size, maxY = size;
  const labelLayout = data.axes.map((axis, i) => {
    const a = angle(i);
    const lx = cx + (radius + labelGap) * Math.cos(a);
    const ly = cy + (radius + labelGap) * Math.sin(a);
    const lines = radarLabelLines(String(axis.name || axis.id));
    const anchor = Math.abs(Math.cos(a)) < 0.3 ? "middle" : Math.cos(a) > 0 ? "start" : "end";
    const width = Math.max(...lines.map(line => line.length)) * charWidth;
    const left = anchor === "end" ? lx - width : anchor === "middle" ? lx - width / 2 : lx;
    minX = Math.min(minX, left - pad);
    maxX = Math.max(maxX, left + width + pad);
    minY = Math.min(minY, ly - fontSize - pad);
    maxY = Math.max(maxY, ly + (lines.length - 1) * lineHeight + pad);
    return {lx, ly, anchor, lines};
  });
  const rings = [20, 40, 60, 80, 100].map(level => {
    const points = data.axes.map((_, i) => xy(i, level).map(v => v.toFixed(1)).join(",")).join(" ");
    // 刻度文字贴在竖轴左侧、圆环内侧，远离顶轴外置标签，不再叠字
    return `<polygon class="radar-ring${level === 100 ? " outer" : ""}" points="${points}"/>`
      + (level === 50 || level === 100 ? `<text class="radar-tick" x="${cx - 5}" y="${(cy - radius * level / 100 + 10).toFixed(1)}" text-anchor="end">${level}</text>` : "");
  }).join("")
    + `<text class="radar-tick" x="${cx - 5}" y="${cy + 3}" text-anchor="end">0</text>`;
  const spokes = data.axes.map((_, i) => {
    const [x, y] = xy(i, 100);
    return `<line class="radar-axis-line" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
  }).join("");
  const labels = labelLayout.map(({lx, ly, anchor, lines}) => {
    const labelSpans = lines.map((line, li) => `<tspan x="${lx.toFixed(1)}" dy="${li ? lineHeight : 3}">${escapeHtml(line)}</tspan>`).join("");
    return `<text class="radar-label" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}"><title>${escapeHtml(lines.join(""))}</title>${labelSpans}</text>`;
  }).join("");
  const series = data.series.filter(entry => entry.hasAnyValue);
  // 先绘制所有曲线，再统一绘制最上层的点位标记：否则后画组的半透明
  // 多边形会盖住先画组的点，悬停/键盘聚焦都命不中（z 序修复）。
  const shapes = series.map(entry => {
    const style = RADAR_GROUP_STYLES[entry.group] || RADAR_GROUP_STYLES.current;
    const points = entry.values
      .map((value, i) => value == null ? null : {i, value})
      .filter(Boolean);
    if (points.length < 2) return "";
    const closed = points.length === total && points.length >= 3;
    return `<${closed ? "polygon" : "polyline"} class="radar-series" points="${points.map(p => xy(p.i, p.value).map(v => v.toFixed(1)).join(",")).join(" ")}" fill="${closed ? style.color + "1f" : "none"}" stroke="${style.color}" stroke-width="2"${style.dash ? ` stroke-dasharray="${style.dash}"` : ""}/>`;
  }).join("");
  const markers = series.flatMap(entry => {
    return entry.values
      .map((value, i) => value == null ? null : radarPointMarkup(entry.group, i, value, {...data.axes[i], total}, entry))
      .filter(Boolean);
  }).join("");
  return `<svg class="radar-svg" viewBox="${minX.toFixed(1)} ${minY.toFixed(1)} ${(maxX - minX).toFixed(1)} ${(maxY - minY).toFixed(1)}" role="img" aria-label="评分维度雷达图（0-100 刻度，${total} 个数值维度）">${rings}${spokes}${shapes}${markers}${labels}</svg>`;
}

function radarGatesMarkup(data) {
  // 方案三：硬门禁显示在图表上方状态条（不是坐标轴）
  if (!data.hasGateGraders) return "";
  const chips = data.series.map(entry => `<span class="radar-gate${entry.gatesFailed ? " failed" : entry.gatesTotal ? " passed" : ""}"><b>${GROUP_LABELS[entry.group]}</b>${entry.completedTrials === 0 ? " 暂无完成 Run" : ` 门禁 ${entry.gatesPassed}/${entry.gatesTotal}${entry.gatesFailed ? " · 未通过" : " · 通过"}`}</span>`).join("");
  return `<div class="radar-gates" role="status" aria-label="硬门禁状态">${chips}</div>`;
}

function radarLegendMarkup(data) {
  // 方案三交互规则：图例显示组名、总质量分、完成 Trial 数；
  // 无有效结果的组不绘制曲线，也不进入图例。
  const drawn = data.series.filter(entry => entry.hasAnyValue);
  const empty = data.series.filter(entry => !entry.hasAnyValue);
  const legend = drawn.map(entry => {
    const style = RADAR_GROUP_STYLES[entry.group] || RADAR_GROUP_STYLES.current;
    const marker = style.point === "square"
      ? `<rect x="9" y="2" width="8" height="8" fill="${style.color}"/>`
      : style.point === "triangle"
        ? `<path d="M 13 1 L 18 10 L 8 10 Z" fill="${style.color}"/>`
        : `<circle cx="13" cy="6" r="4.5" fill="${style.color}"/>`;
    return `<li class="legend-${entry.group}"><svg width="26" height="12" aria-hidden="true"><line x1="0" y1="6" x2="26" y2="6" stroke="${style.color}" stroke-width="2"${style.dash ? ` stroke-dasharray="${style.dash}"` : ""}/>${marker}</svg><span class="legend-group">${GROUP_LABELS[entry.group]}</span><strong>${entry.quality == null ? "—" : fmtScore(entry.quality)}</strong><small>${entry.completedTrials}/${entry.totalTrials} trial${entry.provisional ? ' · <em class="provisional">临时结果</em>' : ""}</small></li>`;
  }).join("");
  const emptyNote = empty.length
    ? `<p class="radar-empty-note">${empty.map(entry => GROUP_LABELS[entry.group]).join("、")}暂无有效结果，未绘制曲线。</p>`
    : "";
  const legendNote = drawn.length
    ? '<p class="radar-legend-note">总分为按维度权重加权的均值，权重见右侧明细。</p>'
    : "";
  return `<ul class="radar-legend">${legend}</ul>${legendNote}${emptyNote}`;
}

function radarSectionMarkup(item, caseSpec, byGroup, data) {
  // 合并视图：雷达图（有边界，标签封在 SVG 内）与结果明细列表之间以竖直
  // 分隔线划界；原明细表的内容（质量分/硬门禁/权重/Trial 对照/人工复核）
  // 全部并入右侧列表，不再有第二视图。
  const radarUsable = data.axes.length >= 3 && data.series.some(entry => entry.hasAnyValue);
  const reason = data.axes.length < 3 ? "数值维度少于 3 个" : "暂无有效评分结果";
  const availableGroups = GROUP_ORDER.filter(group => (byGroup[group] || []).length);
  const chartCol = radarUsable
    ? `<div class="radar-chart-col">
        ${radarGatesMarkup(data)}
        <div class="radar-chart-wrap">${radarSvgMarkup(data)}<div class="radar-tooltip" id="radarTooltip" role="status"></div></div>
        ${radarLegendMarkup(data)}
      </div>`
    : "";
  return `<div class="radar-layout${radarUsable ? "" : " is-list-only"}" id="comparisonRadar">
    ${chartCol}
    <div class="radar-dimension-col">
      <h4 class="radar-dimension-title">结果明细<span class="radar-dimension-hint">（点击维度展开 Trial 对照）</span></h4>
      ${radarUsable ? "" : `<p class="radar-empty-note">${reason}，未绘制雷达图。</p>`}
      ${comparisonListMarkup(caseSpec, byGroup, data)}
    </div>
  </div>`;
}

// 原评分构成中的基线污染警告迁移到结果对照顶部（评分只在这一处展示）。
function skillsLoadedWarning(item) {
  const polluted = (item.runs || []).filter(run =>
    run.group === "no_skill" && Array.isArray(run.scores?.skills_loaded) && run.scores.skills_loaded.filter(Boolean).length);
  if (!polluted.length) return "";
  const names = [...new Set(polluted.flatMap(run => run.scores.skills_loaded.filter(Boolean)))];
  return `<p class="skills-loaded warn comparison-warning">⚠ 对照组 Agent 加载了技能：${escapeHtml(names.join("、"))}——基线可能被全局技能污染，解读对比结论时请知悉。</p>`;
}

function comparisonViewParts(item) {
  // 合并视图：只有一种结果对照呈现（雷达 + 明细列表），无第二视图可切换。
  const cases = item.suite_snapshot?.cases || [];
  if (!cases.length) return {body: ""};
  const grouped = runsByCaseAndGroup(item);
  const selected = selectedCase(item, grouped);
  if (!selected) return {body: ""};
  const byGroup = grouped.get(selected.id) || {};
  const data = caseComparisonData(item, selected, byGroup);
  return {body: skillsLoadedWarning(item) + radarSectionMarkup(item, selected, byGroup, data)};
}

function comparisonMarkup(item) {
  return comparisonViewParts(item).body;
}

function renderDetail(item, {fresh = false} = {}) {
  state.detail = item;
  const previousLogKey = logStreamKey();
  ensureLogConsole(item);
  $("#detailTitle").textContent = item.suite_name;
  const p = item.profile, active = ["queued", "preparing", "running"].includes(item.status);
  const retrying = state.retryingExperiments.has(item.id);
  const body = $("#detailBody");
  const rebuild = fresh || body.dataset.experimentId !== item.id || !$("#detailSummary");
  // 方案一.1 紧凑实验标题栏：名称（页面 h1）+ 状态/模式/Runner·Judge·模型一行，
  // commit/Profile/隔离等次要信息收进一行，保留重试/取消操作。
  const summary = `<div class="detail-titlebar">
    <div class="titlebar-main">
      <span class="pill ${item.status}">${escapeHtml(experimentStatusLabel(item.status))}</span>
      <span class="titlebar-mode">${item.mode === "formal" ? "正式" : "快速"} · ${item.trials} trial</span>
      <span class="titlebar-models">${providerName(p.runner.provider)} ${escapeHtml(modelName(p.runner))} → ${providerName(p.judge.provider)} ${escapeHtml(modelName(p.judge))}</span>
      ${p.self_judge ? '<span class="self-judge">Self-judge</span>' : ""}
      <div class="detail-actions"><button class="button button-ghost button-small" data-retry-experiment="${item.id}" ${retrying ? "disabled" : ""}>${retrying ? "正在加入…" : "重试实验"}</button>${active ? '<button class="button button-ghost button-small danger" id="cancelExperimentButton">取消整个实验</button>' : ""}${usageTotal(item)>0?`<button class="button button-ghost button-small" id="cleanWorkspacesButton">清理现场 (${fmtBytes(usageTotal(item))})</button>`:""}</div>
    </div>
    <div class="titlebar-meta">
      <span>commit ${escapeHtml(item.project_commit.slice(0, 10))}</span>
      <span>Profile ${escapeHtml(p.hash.slice(0, 10))}</span>
      <span>Runner 隔离 ${escapeHtml(p.runner.isolation)} · 网络 ${escapeHtml(p.runner.network_policy)}</span>
      ${item.execution_mode === "pair_parallel_v1" ? `<span>配对并行（单实验并发上限 ${item.concurrency_limit ?? 2}）</span>` : ""}
    </div>
  </div>${experimentLineageMarkup(item)}${conclusionMarkup(item)}${item.error_message ? `<div class="message error">${escapeHtml(item.error_message)}</div>` : ""}`;
  const caseSection = caseSectionMarkup(item);
  const comparisonParts = comparisonViewParts(item);
  const runs = activeRunsStripMarkup(item) + item.runs.map(run => renderRun(item, run)).join("") || '<div class="empty">正在准备运行列表…</div>';
  const completedRuns = (item.runs || []).filter(r => r.status === "completed");
  const gateInfos = completedRuns.map(r => r.hard_gates).filter(Boolean);
  const gatesAllFailed = gateInfos.length > 0 && gateInfos.every(g => (g.passed ?? 0) === 0);
  const baselineGate = gatesAllFailed ? " disabled title=\"当前实验未达标（硬门禁未通过），设为基准可能误导后续对比\"" : "";
  const baselineNote = gatesAllFailed ? '<p class="baseline-disabled-note">当前实验未达标（硬门禁未通过），已停用设为基准，避免误导后续对比。</p>' : "";
  const footer = item.status === "completed" ? `<button class="button button-ghost" id="setBaselineButton"${baselineGate}>将当前修订设为基准版本</button>${baselineNote}` : "";
  if (rebuild) {
    state.lastComparison = comparisonParts.body;
    state.lastCaseSection = caseSection;
    // 方案一.8：诊断日志默认收起，继续作为排障区域（运行中也不再默认展开）
    body.innerHTML = `<div id="detailSummary">${summary}</div><section class="detail-section" id="detailCaseSection"><div class="section-heading"><div><p class="eyebrow">CASE &amp; SNAPSHOT</p><h2>测评用例</h2></div></div><div id="detailCaseBody">${caseSection}</div></section><section class="detail-section" id="detailComparison"><div class="section-heading"><div><p class="eyebrow">CASE COMPARISON</p><h2>结果对照</h2></div></div><div id="detailComparisonBody">${comparisonParts.body}</div></section><section class="detail-section" id="detailRunsSection"><div class="section-heading"><div><p class="eyebrow">RUNS</p><h2>运行明细</h2></div></div><div class="run-grid" id="detailRunGrid">${runs}</div><div id="conversationViewer"></div></section><details class="detail-section diagnostic-section" id="diagnosticSection"><summary><div><p class="eyebrow">DIAGNOSTICS</p><h2>诊断 · 原始日志与调用记录</h2></div><span class="diagnostic-hint">实时日志、Agent 调用、原始输出文件</span></summary>${renderLogConsole(item)}</details><div id="detailFooter">${footer}</div>`;
    body.dataset.experimentId = item.id;
    bindLogConsole();
    restoreLogScroll();
  } else {
    $("#detailSummary").innerHTML = summary;
    const caseBody = $("#detailCaseBody");
    if (caseBody && state.lastCaseSection !== caseSection) {
      state.lastCaseSection = caseSection;
      caseBody.innerHTML = caseSection;
    }
    const comparisonBody = $("#detailComparisonBody");
    if (comparisonBody && state.lastComparison !== comparisonParts.body) {
      state.lastComparison = comparisonParts.body;
      comparisonBody.innerHTML = comparisonParts.body;
    }
    $("#detailRunGrid").innerHTML = runs;
    $("#detailFooter").innerHTML = footer;
  }
  bindDetailActions(item);
  renderConversationViewer();
  loadWorkspaceUsage(item);
  if (!rebuild && previousLogKey !== logStreamKey()) {
    renderLogConsoleOnly();
    loadSelectedLogFiles();
    fetchSelectedLog();
  }
}

function showRadarTooltip(target) {
  const tooltip = $("#radarTooltip");
  const wrap = target.closest(".radar-chart-wrap");
  if (!tooltip || !wrap) return;
  tooltip.textContent = target.dataset.tooltip || "";
  tooltip.classList.add("show");
  const pointRect = target.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  const left = Math.max(0, Math.min(wrapRect.width - 10, pointRect.left - wrapRect.left + pointRect.width / 2));
  const top = Math.max(0, pointRect.top - wrapRect.top - 8);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
  tooltip.style.transform = "translate(-50%, -100%)";
}

function hideRadarTooltip() {
  $("#radarTooltip")?.classList.remove("show");
}

function bindRadarInteractions() {
  // 方案三交互规则：悬停或键盘聚焦显示精确分数
  const container = $("#comparisonRadar");
  if (!container) return;
  container.addEventListener("mouseover", event => {
    const target = event.target.closest("[data-radar-point]");
    if (target) showRadarTooltip(target);
  });
  container.addEventListener("mouseout", event => {
    if (event.target.closest("[data-radar-point]")) hideRadarTooltip();
  });
  // R1P1：Chromium 对 SVG 元素的程序化/键盘 focus 不派发冒泡的 focusin，
  // 事件委托收不到——focus/blur 不冒泡但可在捕获阶段于祖先监听，
  // 因此用捕获态 focus/blur 替代 focusin/focusout，键盘聚焦同样生效。
  container.addEventListener("focus", event => {
    const target = event.target.closest?.("[data-radar-point]");
    if (target) showRadarTooltip(target);
  }, true);
  container.addEventListener("blur", event => {
    if (event.target.closest?.("[data-radar-point]")) hideRadarTooltip();
  }, true);
}

function bindDetailActions(item) {
  const id = item.id;
  $$('[data-toggle-run]').forEach(button => button.addEventListener("click", () => {
    const runId = button.dataset.toggleRun;
    state.expandedRuns[runId] = !(state.expandedRuns[runId] ?? false);
    renderDetail(state.detail);
    // a freshly expanded run has no events loaded yet; re-render once they arrive
    if (state.expandedRuns[runId] && !state.eventCursors[runId]) {
      loadRunEvents(runId).then(() => { if (state.detail) renderDetail(state.detail); });
    }
  }));
  $$('[data-evidence]').forEach(button => button.addEventListener("click", () => toggleEvidenceStrip(button.dataset.evidence)));
  $$('[data-artifact]').forEach(button => button.addEventListener("click", () => openArtifact(button.dataset.artifactRun, button.dataset.artifact)));
  $$('[data-review]').forEach(button => button.addEventListener("click", () => addReview(id, button.dataset.review)));
  $$('[data-cancel-run]').forEach(button => button.addEventListener("click", () => cancelRun(button.dataset.cancelRun)));
  $$('[data-retry-run]').forEach(button => button.addEventListener("click", () => retryRun(button.dataset.retryRun)));
  $("#detailSummary")?.querySelectorAll("[data-retry-experiment]").forEach(button => button.addEventListener("click", () => retryExperiment(button.dataset.retryExperiment)));
  $$('[data-conversation]').forEach(button => button.addEventListener("click", () => toggleConversation(button.dataset.conversation)));
  $$('[data-log]').forEach(button => button.addEventListener("click", () => {
    selectRunLog(button.dataset.log);
    const diagnostics = $("#diagnosticSection");
    if (diagnostics) {
      diagnostics.open = true;
      diagnostics.scrollIntoView({behavior: "smooth", block: "start"});
    }
  }));
  $$('[data-judge-log]').forEach(button => button.addEventListener("click", () => openConversationAt(button.dataset.judgeLog, "judge")));
  // 方案一.3：Case 选择器——一次只展示一个 case；选择在轮询刷新间保留
  $$('[data-case-select]').forEach(button => button.addEventListener("click", () => {
    if (state.detailCaseId === button.dataset.caseSelect) return;
    state.detailCaseId = button.dataset.caseSelect;
    state.expandedDimensions.clear();  // 维度的 Trial 对照展开状态随 case 重置
    if (state.detail) renderDetail(state.detail);
  }));
  // 工作区现场手动清理（只删 workspaces/ 目录，评分与证据包保留）
  $("#cleanWorkspacesButton")?.addEventListener("click", () => cleanExperimentWorkspaces(state.detail.id));
  $$('[data-clean-workspace]').forEach(button => button.addEventListener("click", () => cleanRunWorkspace(button.dataset.cleanWorkspace)));
  bindRadarInteractions();
  // 明细列表行：点击展开/收起该维度的 Trial 对照（展开状态轮询间保留）
  $$('[data-dimension-open]').forEach(button => button.addEventListener("click", () => {
    const graderId = button.dataset.dimensionOpen;
    if (state.expandedDimensions.has(graderId)) state.expandedDimensions.delete(graderId);
    else state.expandedDimensions.add(graderId);
    if (state.detail) renderDetail(state.detail);
  }));
  // 方案一.4：快照展开状态同步进状态模型，轮询重渲染不丢失
  const snapshot = $("#caseSnapshot");
  snapshot?.addEventListener("toggle", () => { state.caseSnapshotOpen = snapshot.open; });
  $("#detailSummary")?.querySelectorAll("[data-detail]").forEach(button => button.addEventListener("click", () => navigateToExperiment(button.dataset.detail)));
  const cancel = $("#cancelExperimentButton");
  if (cancel) cancel.addEventListener("click", () => cancelExperiment(id));
  const baseline = $("#setBaselineButton");
  if (baseline) baseline.addEventListener("click", () => setBaseline(item));
}

async function loadRunEvents(runId) {
  try {
    const after = state.eventCursors[runId] || 0;
    const result = await api(`/api/v1/runs/${runId}/events?after=${after}`);
    state.runEvents[runId] = [...(state.runEvents[runId] || []), ...result.items];
    if (result.items.length) state.eventCursors[runId] = result.items.at(-1).id;
  } catch (error) { toast(error.message); }
}

async function refreshDetail() {
  if (!state.detail) return;
  try {
    const item = await api(`/api/v1/experiments/${state.detail.id}`);
    state.detail = item;
    await Promise.all(item.runs.filter(run => run.status === "running" || run.stalled || !["queued", "completed", "cancelled"].includes(run.status)).map(run => loadRunEvents(run.id)));
    renderDetail(item);
    fetchSelectedLog();
    if (!["queued", "preparing", "running"].includes(item.status)) {
      clearInterval(state.detailPoller);
      state.detailPoller = null;
      stopLogPolling();
    }
  } catch (error) { toast(error.message); }
}

function routeExperimentId() {
  const match = location.hash.match(ROUTE_EXPERIMENT);
  return match ? match[1] : null;
}

function leaveDetail() {
  stopLogPolling();
  resetConversations();
  if (state.detailPoller) { clearInterval(state.detailPoller); state.detailPoller = null; }
  state.detail = null;
  state.routeId = null;
}

function applyRoute() {
  const id = routeExperimentId();
  const homeView = $("#homeView"), experimentView = $("#experimentView");
  if (!homeView || !experimentView) return;
  if (id) {
    homeView.classList.add("hidden");
    experimentView.classList.remove("hidden");
    if (state.routeId !== id) showDetail(id);
    return;
  }
  experimentView.classList.add("hidden");
  homeView.classList.remove("hidden");
  if (state.routeId) leaveDetail();
}

function navigateToExperiment(id) { location.hash = `#/experiments/${id}`; }
function backToList() { location.hash = "#/"; }

async function showDetail(id) {
  state.routeId = id;
  try {
    const item = await api(`/api/v1/experiments/${id}`);
    if (state.routeId !== id) return;
    state.runEvents = {};
    state.eventCursors = {};
    state.runLogs = {};
    state.expandedRuns = {};
    resetConversations();
    // 视图状态（选中 case、快照展开）只在切换到另一个实验时重置；
    // 同一实验内的重载（如提交人工复核后的 showDetail）保留用户选择
    if (state.detailCaseFor !== id) {
      state.detailCaseFor = id;
      state.detailCaseId = null;
      state.caseSnapshotOpen = false;
      state.lastCaseSection = "";
      state.expandedDimensions.clear();
    }
    item.runs.forEach(run => { if (run.status === "running" || run.stalled || !["queued","completed","cancelled"].includes(run.status)) state.expandedRuns[run.id] = true; });
    ensureLogConsole(item, {fresh: true});
    renderDetail(item, {fresh: true});
    window.scrollTo({top: 0});
    await Promise.all(item.runs.filter(run => state.expandedRuns[run.id]).map(run => loadRunEvents(run.id)));
    renderDetail(item);
    await loadSelectedLogFiles();
    await fetchSelectedLog();
    // 1s log polling only makes sense while the experiment can still produce
    // logs; terminal experiments keep a single fetch (R1P2)
    const stillActive = ["queued", "preparing", "running"].includes(item.status);
    if (stillActive) startLogPolling();
    if (state.detailPoller) clearInterval(state.detailPoller);
    if (stillActive) state.detailPoller = setInterval(refreshDetail, 2000);
  } catch (error) { toast(error.message); }
}


document.addEventListener("DOMContentLoaded", () => {
  window.addEventListener("hashchange", applyRoute);
  $("#backToList")?.addEventListener("click", backToList);
  applyRoute();
});
async function addReview(experimentId,runId){const scoreText=window.prompt("人工复核分（0–100）");if(scoreText===null)return;const score=Number(scoreText);if(!Number.isFinite(score)||score<0||score>100)return toast("请输入 0–100 的分数");const note=window.prompt("复核说明（可留空）")??"";try{await api(`/api/v1/runs/${runId}/reviews`,{method:"POST",body:JSON.stringify({score,note,reviewer:"local-user"})});toast("人工复核已保存");await showDetail(experimentId);}catch(error){toast(error.message);}}

document.addEventListener("DOMContentLoaded",()=>{
  restoreRuntimeCache();
  $$('[data-open]').forEach(button=>button.addEventListener("click",()=>$("#"+button.dataset.open).showModal()));$$('[data-close]').forEach(button=>button.addEventListener("click",()=>$("#"+button.dataset.close).close()));
  $("#draftButton").addEventListener("click",generateDraft);$("#saveSuiteButton").addEventListener("click",saveSuite);$("#runButton").addEventListener("click",launchExperiment);$("#refreshButton").addEventListener("click",()=>loadAll({refreshRuntime:true}).then(()=>toast("已刷新")));
  $("#expectedFile").addEventListener("change",loadExpectedMarkdown);
  $("#suiteForm").addEventListener("submit",event=>event.preventDefault());["#projectPath","#skillPath","#skillInput","#expected"].forEach(selector=>$(selector).addEventListener("input",invalidateDraft));
  ["#runnerProvider","#judgeProvider","#judgeSame"].forEach(selector=>$(selector).addEventListener("change",syncProviderControls));
  ["#experimentStatusFilter","#experimentModeFilter"].forEach(selector=>$(selector).addEventListener("change",renderExperiments));
  loadAll().catch(error=>toast(error.message));
});
