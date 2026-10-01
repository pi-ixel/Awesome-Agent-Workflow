const state = {
  suites: [], experiments: [], draft: null, poller: null,
  runtime: null, controlsInitialized: false, detail: null, detailPoller: null, routeId: null, lastComparison: "",
  experimentsRequestSeq: 0,
  runEvents: {}, eventCursors: {}, runLogs: {}, expandedRuns: {}, retryingExperiments: new Set(),
  logConsole: null, logPoller: null, conversations: {},
  // detail view state (方案二)：选中 case、快照展开、视图模式在轮询刷新时保留，
  // 仅在切换到另一个实验时重置（detailCaseFor 记录状态所属实验）。
  // detailViewMode 是用户偏好（localStorage 持久化），不随实验切换重置。
  detailCaseFor: null, detailCaseId: null, caseSnapshotOpen: false, lastCaseSection: "",
  detailViewMode: null, lastComparisonToggle: "",
  // 方案四：已展开 Trial 对照的评分维度（grader id 集合）——轮询重渲染不关闭，
  // 切换实验或切换 case 时清空。
  expandedDimensions: new Set()
};
const RUNTIME_CACHE_KEY = "aaw-skill-eval.runtime.v1";
const COMPARISON_VIEW_KEY = "aaw-skill-eval.comparison-view.v1";
const ROUTE_EXPERIMENT = /^#\/experiments\/([0-9a-f-]{36})$/i;
const GROUP_ORDER = ["no_skill", "baseline", "current"];
const GROUP_LABELS = {no_skill: "无 Skill", baseline: "上一基准", current: "当前候选"};
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
function runActions(item,run){const actions=[];if(["queued","running"].includes(run.status))actions.push(`<button class="text-button danger" data-cancel-run="${run.id}">取消 run</button>`);if(["infra_error","timeout"].includes(run.error_kind)&&run.current_attempt<2)actions.push(`<button class="text-button" data-retry-run="${run.id}">正式重试</button>`);if(run.artifact_available)actions.push(`<button class="text-button" data-conversation="${run.id}">对话</button>`);if(run.artifact_available)actions.push(`<button class="text-button" data-log="${run.id}">日志</button>`);if(!["queued","running"].includes(run.status)&&run.artifact_available)actions.push(`<button class="text-button" data-evidence="${run.id}">证据</button>`);if(!["queued","running"].includes(run.status))actions.push(`<button class="text-button" data-review="${run.id}">复核${run.reviews.length?` (${run.reviews.length})`:""}</button>`);return actions.join("");}
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
function renderScoreBreakdown(run){
  const components=run.scores?.components;
  if(!Array.isArray(components)||!components.length)return "";
  const rows=components.map(comp=>{
    const isRubric=comp.grader_type==="llm_rubric";
    const isGate=!!comp.hard_gate;
    const tag=isRubric?`LLM 评分 · 权重 ${comp.weight??"—"}`:isGate?"硬门禁（必须通过）":`命令验证器 · 权重 ${comp.weight??"—"}`;
    const value=isRubric?fmtScore(comp.score):(comp.passed?"通过":"未通过");
    const cls=comp.passed===false?"bad":comp.passed===true?"ok":"";
    return `<details class="score-component"><summary><span class="comp-name">${escapeHtml(comp.name||comp.grader_id)}</span><span class="comp-tag">${escapeHtml(tag)}</span><span class="comp-value ${cls}">${escapeHtml(String(value))}</span></summary><div class="comp-body">${comp.reasoning?`<p><strong>评分理由：</strong>${escapeHtml(comp.reasoning)}</p>`:""}${comp.evidence?`<pre>${escapeHtml(comp.evidence)}</pre>`:""}</div></details>`;
  }).join("");
  const gates=run.hard_gates||{};
  const loaded=Array.isArray(run.scores?.skills_loaded)?run.scores.skills_loaded.filter(Boolean):[];
  const isNoSkill=run.group==="no_skill";
  const loadedNote=loaded.length
    ?`<span class="skills-loaded ${isNoSkill?"warn":""}">${isNoSkill?"⚠ 对照组 Agent 加载了技能":"Agent 加载的技能"}：${escapeHtml(loaded.join("、"))}${isNoSkill?"——基线可能被全局技能污染，解读对比结论时请知悉":""}</span>`
    :"";
  return `<div class="score-breakdown"><div class="score-breakdown-head"><strong>评分构成（${components.length} 项）</strong><span class="comp-total">总分 ${fmtScore(run.quality_score)} · 硬门禁 ${gates.passed??0}/${gates.total??0}</span>${loadedNote}<span class="evidence-links"><button class="text-button" data-artifact-run="${run.id}" data-artifact="scores.json">scores.json</button><button class="text-button" data-artifact-run="${run.id}" data-artifact="changes.patch">改动 patch</button><button class="text-button" data-artifact-run="${run.id}" data-artifact="final-response.md">最终回复</button></span></div>${rows}</div>`;
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

function renderRun(item,run){
  run={...run,error_message:errorText(run.error_message)};
  const defaultOpen=run.status==="running"||run.stalled||!["queued","completed","cancelled"].includes(run.status),open=state.expandedRuns[run.id]??defaultOpen;
  const totalSeconds=run.completed_at&&run.started_at?(new Date(run.completed_at)-new Date(run.started_at))/1000:elapsedSince(run.started_at);
  const stageSeconds=run.status==="running"?elapsedSince(run.stage_started_at):null;
  const scoringSkipped=!["queued","running","completed"].includes(run.status)&&run.quality_score==null;
  const logs=state.runLogs[run.id];
  return `<article class="run-card ${run.stalled?"is-stalled":""}" data-run-card="${run.id}"><div class="run-summary"><div><span class="run-order">${escapeHtml(run.group)} · Trial ${run.trial}${run.current_attempt>1?` · 重试 #${run.current_attempt}`:""}</span><h3>${escapeHtml(run.case_id)}</h3></div><div class="run-stage"><span class="pill ${run.status}">${escapeHtml(experimentStatusLabel(run.status))}</span><strong>${escapeHtml(stageLabel(run.current_stage))}</strong>${scoringSkipped?'<span class="skip-badge" title="Runner 未完成，验证器与 Judge 未执行">评分已跳过</span>':""}</div><div class="run-clocks"><span>总耗时 ${fmtDuration(totalSeconds)}</span>${stageSeconds!=null?`<span>当前阶段 ${fmtDuration(stageSeconds)}</span>`:""}<span>心跳 ${fmtDuration(run.heartbeat_age_seconds)} 前</span><span class="${run.stalled?"warn":""}">有效活动 ${fmtDuration(run.activity_age_seconds)} 前</span></div><div class="run-actions">${runActions(item,run)}<button class="text-button" data-toggle-run="${run.id}">${open?"收起":"时间线"}</button></div></div><div class="run-detail ${open?"":"hidden"}" id="run-detail-${run.id}">${run.error_message?`<div class="message error"><strong>${escapeHtml(stageLabel(run.current_stage))}</strong> · ${escapeHtml(run.error_kind||"error")} · ${escapeHtml(run.error_message)}</div>`:""}${scoringSkipped?`<div class="skip-note">评分已跳过：Runner 未完成（${escapeHtml(experimentStatusLabel(run.status))}），确定性验证器、自动分与 Judge 盲评均未执行，因此分数显示为 “—”。如需评分请重试该 run。</div>`:""}${renderScoreBreakdown(run)}<div class="conversation-slot" id="conversation-slot-${run.id}"></div>${stallDiagnosis(item,run)}${run.attempts.length?`<p class="attempt-history">历史尝试：${run.attempts.map(attempt=>`#${attempt.attempt} ${escapeHtml(experimentStatusLabel(attempt.status))}`).join(" · ")}</p>`:""}${run.reviews.length?`<div class="run-reviews"><strong>人工复核（${run.reviews.length} · 与自动分并列保存）</strong>${run.reviews.map(review=>`<div class="run-review"><strong>${fmtScore(review.score)}</strong><span>${escapeHtml(review.reviewer)} · ${fmtTime(review.created_at)}${review.note?` · “${escapeHtml(review.note)}”`:""}</span></div>`).join("")}</div>`:""}${renderTimeline(run)}${logs?`<div class="log-panel">${logs.items.map(log=>`<h4>${escapeHtml(log.name)}</h4><pre>${escapeHtml(log.content)}</pre>`).join("")||'<p>暂无日志输出。</p>'}</div>`:""}</div></article>`;
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
async function setBaseline(item){try{await api(`/api/v1/skills/${item.skill_id}/baseline`,{method:"POST",body:JSON.stringify({revision_id:item.current_revision_id})});toast("已设为基准版本");try{await loadAll();}catch{toast("基准已保存，但页面刷新失败");}}catch(error){toast(error.message);}}
async function showEvidence(runId){try{const result=await api(`/api/v1/runs/${runId}/artifacts`);if(!result.items.length)return toast("这个 run 暂无证据文件");const preferred=result.items.find(item=>item.name==="scores.json")||result.items[0];window.open(preferred.url,"_blank","noopener");}catch(error){toast(error.message);}}
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

function stopConversationPolling(runId) {
  const conv = state.conversations[runId];
  if (conv?.poller) { clearInterval(conv.poller); conv.poller = null; }
}

function resetConversations() {
  Object.keys(state.conversations).forEach(stopConversationPolling);
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

function conversationPanelMarkup(runId, conv) {
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
  return {
    signature: `${conv.source}#${conv.unmasked ? "raw" : "masked"}#${conv.signature || "loading"}`,
    html: `<section class="conversation-panel" data-conversation-panel="${runId}">
      <div class="conversation-head">
        <div class="conversation-tabs">${tabs}</div>
        <div class="conversation-controls">
          <label class="conv-mask${conv.unmasked ? " is-unmasked" : ""}"><input type="checkbox" data-conv-unmasked${conv.unmasked ? " checked" : ""}> 显示未遮盖内容（可能包含敏感信息）</label>
          <button class="text-button" data-conv-copy>复制对话</button>
          <button class="text-button" data-conv-export>导出对话</button>
        </div>
        <span class="conversation-meta">${live ? '<span class="conv-live">● 运行中实时更新</span>' : ""} · ${stageNote} · ${maskLabel}</span>
      </div>
      <div class="conversation-body">${conv.data ? attemptsMarkup(runId, conv) : '<p class="conv-loading">正在读取对话记录…</p>'}</div>
    </section>`
  };
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
    : `<details class="conv-prompt" data-conv-prompt="${runId}|${attempt.attempt}|${prompt.file}" data-conv-key="${promptKey}"${conv.expanded.has(promptKey) ? " open" : ""}>
        <summary>提示词 · ${escapeHtml(prompt.file.split("/").pop())} · ${fmtSize(prompt.bytes)}${prompt.available ? "" : "（文件缺失）"}</summary>
        <pre>展开时加载…</pre>
      </details>`;
  return `<details class="conv-turn" open>
    <summary><span class="conv-turn-title">第 ${turn.turn} 轮</span><span class="conv-turn-meta">${stateLabel}${usage}${context}</span></summary>
    <div class="conv-turn-body">
      ${promptBlock}
      ${turn.items.map((item, index) => conversationItemMarkup(runId, conv, attempt, turn, item, index)).join("")}
      ${turn.error ? `<div class="conv-error">轮次错误 · ${escapeHtml(JSON.stringify(turn.error).slice(0, 300))}</div>` : ""}
    </div>
  </details>`;
}

function conversationItemMarkup(runId, conv, attempt, turn, item, index) {
  const key = `item:${attempt.attempt}:${turn.turn}:${index}`;
  if (item.type === "message") {
    return `<div class="conv-message"><span class="conv-role">Agent 回复</span><pre>${escapeHtml(item.text)}</pre></div>`;
  }
  if (item.type === "thought") {
    return `<details class="conv-thought" data-conv-key="${key}"${conv.expanded.has(key) ? " open" : ""}>
      <summary>Agent 思考 · ${item.text.length} 字</summary><pre>${escapeHtml(item.text)}</pre></details>`;
  }
  if (item.type === "tool_call") {
    const statusLabel = TOOL_STATUS_LABELS[item.status] || item.status || "未知";
    const statusClass = item.status === "failed" ? "bad" : item.status === "completed" ? "ok" : "";
    const resultPreview = item.result
      ? (String(item.result).split("\n").map(l => l.trim()).find(l => l) || "").slice(0, 70)
      : "";
    return `<details class="conv-tool" data-conv-key="${key}"${conv.expanded.has(key) ? " open" : ""}>
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
  const slot = document.getElementById(`conversation-slot-${runId}`);
  const conv = state.conversations[runId];
  if (!slot || !conv || !conv.open) return;
  const {signature, html} = conversationPanelMarkup(runId, conv);
  if (slot.dataset.signature === signature) return;
  slot.dataset.signature = signature;
  slot.innerHTML = html;
  bindConversationActions(runId);
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

function expandRunForConversation(runId) {
  // The conversation slot lives inside the run-detail container, which stays
  // collapsed (.hidden) for completed runs unless expanded. Opening a
  // conversation must expand the run card too, otherwise the panel renders
  // into a hidden container and nothing is visible (R1P1).
  const needsExpand = !state.expandedRuns[runId];
  if (needsExpand) state.expandedRuns[runId] = true;
  if (!state.detail) return;
  renderDetail(state.detail);
  // the timeline of a freshly expanded run has no events loaded yet
  if (needsExpand && !state.eventCursors[runId]) {
    loadRunEvents(runId).then(() => { if (state.detail) renderDetail(state.detail); });
  }
}

function toggleConversation(runId) {
  const conv = conversationState(runId);
  conv.open = !conv.open;
  if (conv.open) {
    expandRunForConversation(runId);
    fetchConversation(runId);
    startConversationPolling(runId);
    document.getElementById(`conversation-slot-${runId}`)?.scrollIntoView({behavior: "smooth", block: "nearest"});
  } else {
    stopConversationPolling(runId);
    renderDetail(state.detail);
  }
}

function openConversationAt(runId, source) {
  const conv = conversationState(runId);
  const hadData = conv.open && conv.source === source && conv.data;
  conv.open = true;
  if (conv.source !== source) { conv.source = source; conv.data = null; conv.signature = null; }
  if (!state.expandedRuns[runId] || !hadData) expandRunForConversation(runId);
  if (!hadData) {
    fetchConversation(runId);
    startConversationPolling(runId);
  }
  document.getElementById(`conversation-slot-${runId}`)?.scrollIntoView({behavior: "smooth", block: "nearest"});
}

function switchConversationSource(runId, source) {
  const conv = conversationState(runId);
  if (conv.source === source) return;
  conv.source = source;
  conv.data = null;
  conv.signature = null;
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

function bindConversationActions(runId) {
  const panel = document.querySelector(`[data-conversation-panel="${runId}"]`);
  const conv = state.conversations[runId];
  if (!panel || !conv) return;
  panel.querySelectorAll("[data-conv-source]").forEach(button =>
    button.addEventListener("click", () => switchConversationSource(runId, button.dataset.convSource)));
  panel.querySelectorAll("[data-conv-unmasked]").forEach(toggle =>
    toggle.addEventListener("change", () => toggleConversationMask(runId)));
  panel.querySelectorAll("[data-conv-copy]").forEach(button =>
    button.addEventListener("click", () => copyConversation(runId)));
  panel.querySelectorAll("[data-conv-export]").forEach(button =>
    button.addEventListener("click", () => exportConversation(runId)));
  panel.querySelectorAll("details[data-conv-key]").forEach(details =>
    details.addEventListener("toggle", () => {
      if (details.open) conv.expanded.add(details.dataset.convKey);
      else conv.expanded.delete(details.dataset.convKey);
    }));
  panel.querySelectorAll("details[data-conv-prompt]").forEach(details =>
    details.addEventListener("toggle", () => { if (details.open) loadPromptInto(details, runId); }));
  panel.querySelectorAll("details[data-conv-prompt][open]").forEach(details =>
    loadPromptInto(details, runId));
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

function groupHeaderCell(byGroup, group) {
  // 方案二：表头只保留组名——总分/trial 数/门禁已在结论带与质量分行出现，
  // 不再在顶部与对照表头之间重复。
  const runs = byGroup[group] || [];
  if (!runs.length) return `<th class="is-missing"><span>${GROUP_LABELS[group]}</span><small>未参与</small></th>`;
  return `<th><span>${GROUP_LABELS[group]}</span></th>`;
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

function graderValueCell(grader, runs) {
  // 方案四：删除每个分组单元格的独立 details——单元格只保留汇总值，
  // Trial 对照统一由维度行的“展开 Trial 对照”入口提供。
  const stats = graderScoreStats(grader, runs);
  const isGate = !!grader.hard_gate;
  if (!stats.count) {
    const unfinished = runs.filter(run => run.status !== "completed").length;
    return `<td><span class="cell-empty">${unfinished ? `未评分（${unfinished} 个 run 未完成）` : "—"}</span></td>`;
  }
  let value, cls = "";
  if (isGate) {
    value = `${stats.gatePassed}/${stats.gateTotal} 通过`;
    cls = stats.gatePassed === stats.gateTotal ? "ok" : "bad";
  } else if (stats.count === 1) {
    value = fmtScore(stats.mean);
  } else {
    value = `${fmtScore(stats.mean)}（均值 ${stats.count} trial）`;
  }
  return `<td class="${cls}"><span class="cell-value">${escapeHtml(value)}</span></td>`;
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

function trialComparisonRow(grader, byGroup, availableGroups) {
  // 方案四：展开后按 Trial 分行，no_skill 与 current（及 baseline 第三列）
  // 并排对齐；一次展开即同时展示所有参与组。
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
  return `<tr class="trial-comparison-row"><td colspan="${availableGroups.length + 1}">
    <div class="trial-comparison" data-trial-comparison="${escapeHtml(grader.id)}" style="--trial-groups:${availableGroups.length}">${head}${rows || '<p class="cell-empty">该维度还没有任何 run 记录。</p>'}</div>
  </td></tr>`;
}

function qualityCell(runs) {
  const completed = runs.filter(run => run.status === "completed" && run.quality_score != null);
  if (!completed.length) return `<td class="quality-cell">—</td>`;
  const gatesFail = completed.some(run => (run.hard_gates?.total || 0) > 0 && run.hard_gates.passed < run.hard_gates.total);
  return `<td class="quality-cell${gatesFail ? " is-gates-failed" : ""}"><strong>${fmtScore(fmean(completed.map(run => run.quality_score)))}</strong><small> ${completed.length}/${runs.length} trial</small>${gatesFail ? '<small class="gates-failed-note">门禁未过 · 未达标</small>' : ""}</td>`;
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

function caseCard(caseSpec, byGroup, expectedTrials) {
  const graders = caseSpec.graders || [];
  const availableGroups = GROUP_ORDER.filter(group => (byGroup[group] || []).length);
  if (!availableGroups.length) {
    return `<article class="case-card"><p class="case-empty">该用例尚未产生 run。</p></article>`;
  }
  const header = `<thead><tr><th class="dim-col">评分维度</th>${availableGroups.map(group => groupHeaderCell(byGroup, group)).join("")}</tr></thead>`;
  const rows = graders.map(grader => {
    const typeLabel = grader.hard_gate ? "硬门禁（必须通过）" : grader.type === "llm_rubric" ? `LLM 评分 · 权重 ${grader.weight ?? "—"}` : `命令验证器 · 权重 ${grader.weight ?? "—"}`;
    // 方案四：每个评分维度只提供一个“展开 Trial 对照”入口（与类型同行，保持表格紧凑）；
    // 展开状态存于 state.expandedDimensions，轮询重渲染不关闭。
    const expanded = state.expandedDimensions.has(grader.id);
    return `<tr data-grader-row="${escapeHtml(grader.id)}" class="dim-row${expanded ? " is-expanded" : ""}"><th class="dim-col"><span class="dim-name">${escapeHtml(grader.name || grader.id)}</span><span class="dim-meta"><span class="dim-type${grader.hard_gate ? " gate" : ""}">${escapeHtml(typeLabel)}</span><button type="button" class="text-button dimension-trials-toggle" data-dimension-trials="${escapeHtml(grader.id)}" aria-expanded="${expanded}">${expanded ? "收起 Trial 对照" : "展开 Trial 对照"}</button></span></th>${availableGroups.map(group => graderValueCell(grader, byGroup[group])).join("")}</tr>${expanded ? trialComparisonRow(grader, byGroup, availableGroups) : ""}`;
  }).join("");
  const qualityRow = `<tr class="quality-row"><th class="dim-col"><span class="dim-name">质量分</span><span class="dim-type">加权均值 · 硬门禁不计入</span></th>${availableGroups.map(group => qualityCell(byGroup[group])).join("")}</tr>`;
  // 用例名称/ID/权重已由 Case 选择器与测评用例查看区呈现，这里不再重复（方案二）
  return `<article class="case-card">
    <div class="table-card comparison-wrap"><table class="comparison-table">${header}<tbody>${rows}${qualityRow}</tbody></table></div>
    ${caseReviewsMarkup(byGroup, availableGroups)}
  </article>`;
}

function caseRunsOfGroup(byGroup, group) {
  return byGroup[group] || [];
}

function graderMeanScore(grader, runs) {
  // 与明细表 graderValueCell/qualityCell 同一数据源与同一算法（graderScoreStats）：
  // 已完成 Run 中该 grader 的数值分数均值（雷达与明细表一致性的基础）
  return graderScoreStats(grader, runs).mean;
}

function caseComparisonData(item, caseSpec, byGroup) {
  // 方案三数据规则：坐标轴只含 hard_gate=false 且产生数值分数的 grader
  //（command/llm_rubric 等非门禁 grader 均产出 0-100 数值分）。
  const axes = (caseSpec.graders || []).filter(grader => !grader.hard_gate);
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

function comparisonViewMode() {
  if (state.detailViewMode !== "radar" && state.detailViewMode !== "table") {
    // 方案一.5：首次进入默认雷达图，之后记住用户选择（localStorage）
    let stored = null;
    try { stored = localStorage.getItem(COMPARISON_VIEW_KEY); } catch {}
    state.detailViewMode = stored === "table" ? "table" : "radar";
  }
  return state.detailViewMode;
}

function setComparisonViewMode(mode) {
  state.detailViewMode = mode;
  try { localStorage.setItem(COMPARISON_VIEW_KEY, mode); } catch {}
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
  const rings = [20, 40, 60, 80, 100].map(level => {
    const points = data.axes.map((_, i) => xy(i, level).map(v => v.toFixed(1)).join(",")).join(" ");
    return `<polygon class="radar-ring${level === 100 ? " outer" : ""}" points="${points}"/>`
      + (level === 50 || level === 100 ? `<text class="radar-tick" x="${(cx + 3).toFixed(1)}" y="${(cy - radius * level / 100 - 3).toFixed(1)}">${level}</text>` : "");
  }).join("")
    + `<text class="radar-tick" x="${(cx + 3).toFixed(1)}" y="${(cy - 3).toFixed(1)}">0</text>`;
  const spokes = data.axes.map((_, i) => {
    const [x, y] = xy(i, 100);
    return `<line class="radar-axis-line" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
  }).join("");
  const labels = data.axes.map((axis, i) => {
    const lx = cx + (radius + 14) * Math.cos(angle(i));
    const ly = cy + (radius + 14) * Math.sin(angle(i));
    const anchor = Math.abs(Math.cos(angle(i))) < 0.3 ? "middle" : Math.cos(angle(i)) > 0 ? "start" : "end";
    const name = String(axis.name || axis.id);
    // 长标签两行折行（在顿号/间隔符处优先断行），避免省略号截断
    let labelLines;
    if (name.length > 11) {
      const sep = name.search(/[、·]|生命周期/);
      const cut = sep > 2 && sep < name.length - 2 ? sep + 1 : Math.ceil(name.length / 2);
      labelLines = [name.slice(0, cut), name.slice(cut)];
    } else {
      labelLines = [name];
    }
    const labelSpans = labelLines.map((line, li) => `<tspan x="${lx.toFixed(1)}" dy="${li ? 11 : 3}">${escapeHtml(line)}</tspan>`).join("");
    return `<text class="radar-label" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}"><title>${escapeHtml(name)}</title>${labelSpans}</text>`;
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
  return `<svg class="radar-svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="评分维度雷达图（0-100 刻度，${total} 个数值维度）">${rings}${spokes}${shapes}${markers}${labels}</svg>`;
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
  return `<ul class="radar-legend">${legend}</ul>${emptyNote}`;
}

function radarDimensionListMarkup(data) {
  // 方案三交互规则：雷达图旁显示紧凑维度列表，点击维度打开对应 Trial 对照
  //（与 Trial 联动领域对接：入口为 data-dimension-open，当前先切到明细表并定位到该维度行）
  return `<ul class="radar-dimensions">${data.axes.map((axis, i) => {
    const values = data.series
      .map(entry => `${GROUP_LABELS[entry.group]} ${entry.values[i] == null ? "—" : entry.values[i].toFixed(1)}`)
      .join(" · ");
    return `<li><button type="button" class="radar-dimension" data-dimension-open="${escapeHtml(axis.id)}" title="打开该维度的 Trial 对照"><span class="radar-dimension-chevron">›</span><span class="radar-dimension-name">${escapeHtml(axis.name || axis.id)}</span><span class="radar-dimension-values">${escapeHtml(values)}</span></button></li>`;
  }).join("")}</ul>`;
}

function radarSectionMarkup(item, caseSpec, byGroup, data) {
  return `<div class="radar-layout" id="comparisonRadar">
    <div class="radar-chart-col">
      ${radarGatesMarkup(data)}
      <div class="radar-chart-wrap">${radarSvgMarkup(data)}<div class="radar-tooltip" id="radarTooltip" role="status"></div></div>
      ${radarLegendMarkup(data)}
    </div>
    <div class="radar-dimension-col">
      <h4 class="radar-dimension-title">数值维度（点击打开 Trial 对照）</h4>
      ${radarDimensionListMarkup(data)}
    </div>
  </div>`;
}

function comparisonViewParts(item) {
  const cases = item.suite_snapshot?.cases || [];
  if (!cases.length) return {toggle: "", body: ""};
  const grouped = runsByCaseAndGroup(item);
  const selected = selectedCase(item, grouped);
  if (!selected) return {toggle: "", body: ""};
  const byGroup = grouped.get(selected.id) || {};
  const expected = item.conclusion?.expected_trials_per_group || item.trials || 1;
  const data = caseComparisonData(item, selected, byGroup);
  // 方案三：少于三个数值维度自动切换明细表；R1P2 扩展——所有参与组都
  // 没有有效评分（如全部 run 超时/失败）时雷达只是一张空网格，同样自动
  // 切明细表（表内的“未评分”占位与 Trial 对照更能说明情况）。
  const tooFewAxes = data.axes.length < 3;
  const noValidScores = !data.series.some(entry => entry.hasAnyValue);
  const radarUsable = !tooFewAxes && !noValidScores;
  const reason = tooFewAxes ? "数值维度少于 3 个" : "暂无有效评分结果";
  const mode = radarUsable && comparisonViewMode() === "radar" ? "radar" : "table";
  const toggle = `<div class="view-toggle" role="tablist" aria-label="结果对照视图"><button type="button" class="view-toggle-button${mode === "radar" ? " active" : ""}" data-view-mode="radar" role="tab" aria-selected="${mode === "radar"}"${radarUsable ? "" : ` disabled title="${reason}，无法绘制雷达图"`}>雷达图</button><button type="button" class="view-toggle-button${mode === "table" ? " active" : ""}" data-view-mode="table" role="tab" aria-selected="${mode === "table"}">明细表</button></div>${radarUsable ? "" : `<span class="view-notice">${reason}，已自动显示明细表。</span>`}`;
  const body = mode === "radar"
    ? radarSectionMarkup(item, selected, byGroup, data)
    : caseCard(selected, byGroup, expected);
  return {toggle, body};
}

function comparisonMarkup(item) {
  const parts = comparisonViewParts(item);
  return `${parts.toggle}${parts.body}`;
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
      <div class="detail-actions"><button class="button button-ghost button-small" data-retry-experiment="${item.id}" ${retrying ? "disabled" : ""}>${retrying ? "正在加入…" : "重试实验"}</button>${active ? '<button class="button button-ghost button-small danger" id="cancelExperimentButton">取消整个实验</button>' : ""}</div>
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
    state.lastComparisonToggle = comparisonParts.toggle;
    state.lastCaseSection = caseSection;
    // 方案一.8：诊断日志默认收起，继续作为排障区域（运行中也不再默认展开）
    body.innerHTML = `<div id="detailSummary">${summary}</div><section class="detail-section" id="detailCaseSection"><div class="section-heading"><div><p class="eyebrow">CASE &amp; SNAPSHOT</p><h2>测评用例</h2></div></div><div id="detailCaseBody">${caseSection}</div></section><section class="detail-section" id="detailComparison"><div class="section-heading"><div><p class="eyebrow">CASE COMPARISON</p><h2>结果对照</h2></div><div class="comparison-heading-actions" id="comparisonViewSlot">${comparisonParts.toggle}</div></div><div id="detailComparisonBody">${comparisonParts.body}</div></section><section class="detail-section" id="detailRunsSection"><div class="section-heading"><div><p class="eyebrow">RUNS</p><h2>运行明细</h2></div></div><div class="run-grid" id="detailRunGrid">${runs}</div></section><details class="detail-section diagnostic-section" id="diagnosticSection"><summary><div><p class="eyebrow">DIAGNOSTICS</p><h2>诊断 · 原始日志与调用记录</h2></div><span class="diagnostic-hint">实时日志、Agent 调用、原始输出文件</span></summary>${renderLogConsole(item)}</details><div id="detailFooter">${footer}</div>`;
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
    const toggleSlot = $("#comparisonViewSlot");
    if (toggleSlot && state.lastComparisonToggle !== comparisonParts.toggle) {
      state.lastComparisonToggle = comparisonParts.toggle;
      toggleSlot.innerHTML = comparisonParts.toggle;
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
  Object.entries(state.conversations).forEach(([runId, conv]) => {
    if (conv.open) renderConversationInto(runId);
  });
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
  $$('[data-evidence]').forEach(button => button.addEventListener("click", () => showEvidence(button.dataset.evidence)));
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
  // 方案一.5：雷达图/明细表视图切换——记住选择（localStorage），轮询间保留
  $$('[data-view-mode]').forEach(button => button.addEventListener("click", () => {
    if (button.disabled) return;
    if (comparisonViewMode() === button.dataset.viewMode) return;
    setComparisonViewMode(button.dataset.viewMode);
    if (state.detail) renderDetail(state.detail);
  }));
  bindRadarInteractions();
  // 方案四：每个评分维度唯一的“展开 Trial 对照”入口——一次展开/收起所有参与组
  $$('[data-dimension-trials]').forEach(button => button.addEventListener("click", () => {
    const graderId = button.dataset.dimensionTrials;
    if (state.expandedDimensions.has(graderId)) state.expandedDimensions.delete(graderId);
    else state.expandedDimensions.add(graderId);
    if (state.detail) renderDetail(state.detail);
  }));
  // 方案三：点击雷达旁紧凑维度列表中的维度，打开对应维度的 Trial 对照
  //（切到明细表、展开该维度并滚动定位）。
  $$('[data-dimension-open]').forEach(button => button.addEventListener("click", () => {
    const graderId = button.dataset.dimensionOpen;
    setComparisonViewMode("table");
    state.expandedDimensions.add(graderId);
    if (state.detail) renderDetail(state.detail);
    requestAnimationFrame(() => {
      const row = document.querySelector(`tr[data-grader-row="${CSS.escape(graderId)}"]`);
      if (!row) return;
      row.scrollIntoView({behavior: "smooth", block: "center"});
      row.classList.add("flash-target");
      setTimeout(() => row.classList.remove("flash-target"), 2200);
    });
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
