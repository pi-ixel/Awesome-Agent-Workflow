/**
 * 报错改成人话（ADR 035）：错误码的说明集中在这里。
 * 常见错误单独说明；其余按类别给出说明与处理建议；认不出的错误码不作为正文显示，
 * 原始信息只放在「技术详情」里。已经是中文说明的消息原样显示。
 */

export interface ErrorText {
  /** 首行：发生了什么。 */
  readonly title: string;
  /** 可以怎么处理。 */
  readonly hint?: string;
  /** 认出的错误码，放在技术详情里。 */
  readonly code?: string;
  /** 原始信息，放在技术详情里；与 title 相同时省略。 */
  readonly detail?: string;
}

type Entry = { readonly title: string | ((arg: string) => string); readonly hint?: string };

const RETRY = "可以点「刷新」后重试；仍有问题请把技术详情发给维护者。";
const CHECK_AGENT = "请在设置里检查 Agent 配置和登录状态，然后继续运行或处置节点。";
const DISPOSE = "可以在节点上点「处置…」，重跑这一步或回退。";

/** 单独说明的错误码。值里的函数接收错误码后面的补充信息（如缺的字段名）。 */
const CODES: Readonly<Record<string, Entry>> = {
  // 启动
  WORKFLOW_INPUT_REQUIRED: { title: (arg) => arg ? `还需要填写「${arg}」。` : "还有必填项没有填写。" },
  WORKFLOW_INVALID: { title: (arg) => arg ? `工作流源码有错误，暂时不能运行：${arg}` : "工作流源码有错误，暂时不能运行。", hint: "请在工作流详情里查看诊断，修改源码后再运行。" },
  WORKFLOW_NOT_FOUND: { title: "找不到这个工作流，可能已被删除。" },
  WORKFLOW_ENTRY_UNKNOWN: { title: "工作流里没有这个起点，可能是源码改过了。", hint: "请重新打开启动表单选择起点。" },
  WORKFLOW_PRESET_READ_ONLY: { title: "预置工作流不能修改。", hint: "可以先复制一份再改。" },
  WORKFLOW_COPY_FAILED: { title: "复制工作流失败。", hint: RETRY },
  WORKFLOW_SCRIPTS_UNTRUSTED: { title: (arg) => arg ? `还没有确认信任这些脚本：${arg}` : "工作流里有还没确认信任的脚本。", hint: "请在工作流详情里查看脚本内容，确认信任后再运行。" },
  WORKFLOW_PACKAGE_INVALID: { title: "这不是有效的工作流文件。", hint: "请选择从 AAW 导出的工作流文件（.json）。" },
  WORKFLOW_PACKAGE_TOO_LARGE: { title: "工作流文件太大，无法导入。" },
  WORKFLOW_PATH_INVALID: { title: (arg) => arg ? `工作流文件里有不安全的路径：${arg}` : "工作流文件里有不安全的路径。", hint: "为了安全没有导入。" },
  WORKFLOW_IMPORT_FAILED: { title: "导入工作流失败。", hint: RETRY },
  DRAFT_NOT_FOUND: { title: "找不到这份草稿，可能已经保存或放弃了。" },
  DRAFT_UNCHANGED: { title: "草稿还没有改动，没有可保存的内容。", hint: "在编辑会话里告诉 AI 要怎么改。" },
  DRAFT_CREATE_FAILED: { title: "无法创建草稿。", hint: RETRY },
  DRAFT_SAVE_FAILED: { title: "保存工作流失败，原来的工作流没有改动。", hint: RETRY },
  WORKFLOW_DELETE_FAILED: { title: "删除工作流失败。", hint: RETRY },
  WORKSPACE_NOT_BOUND: { title: "请先打开一个项目，工作流会在该项目目录里运行。" },
  NODE_KNOWLEDGE_UNAVAILABLE: { title: (arg) => arg ? `知识文件不可读取：${arg}` : "工作流引用的知识文件缺失。", hint: "请检查工作流目录。" },
  ACP_COMMAND_REQUIRED: { title: "没有可用的 Agent 启动命令。", hint: "请先在设置里配置 Agent。" },
  PYTHON_SCRIPT_UNAVAILABLE: { title: (arg) => arg ? `Python 脚本不可读取：${arg}` : "工作流包内的 Python 脚本缺失或不可读取。" },
  INVALID_ARGUMENT: { title: "项目目录或启动参数无效。" },
  PREFLIGHT_WORKFLOW_CHANGED: { title: "检查之后工作流又改过了。", hint: "请重新检查后再启动。" },
  PREFLIGHT_CONFIGURATION_CHANGED: { title: "检查之后 Agent 配置变了。", hint: "请重新检查后再启动。" },
  PREFLIGHT_WARNING_CONFIRMATION_REQUIRED: { title: "有新的环境提醒需要你确认。", hint: "请重新检查并确认提醒后再启动。" },
  PREFLIGHT_FAILED: { title: "运行环境检查没有通过。", hint: "请按检查结果里的建议处理后再启动。" },
  // 运行占用与状态
  RUN_NOT_FOUND: { title: "找不到这次运行，可能属于其他项目或已被清理。" },
  RUN_ALREADY_ACTIVE: { title: "这次运行已经在跑了。" },
  RUN_ALREADY_CLAIMED: { title: "这次运行正被另一个窗口或进程占用。", hint: "等它停下后再操作；确认那个进程已经退出时，可以点「检查并解除占用」。" },
  RUN_NOT_FOUND_OR_CLAIMED: { title: "这次运行不存在，或正被另一个进程占用。" },
  RUN_LEASE_MISMATCH: { title: "这次运行已被另一个进程接管，当前操作没有生效。", hint: "请刷新后查看最新状态。" },
  RUN_LEASE_OR_REVISION_CHANGED: { title: "运行状态刚刚变了，当前操作没有生效。", hint: "请刷新后再试。" },
  RUN_REVISION_CHANGED: { title: "运行状态刚刚变了，当前操作没有生效。", hint: "请刷新后再试。" },
  RUN_NOT_ACTIVE: { title: "这次运行没有在跑。" },
  RUN_NOT_RESUMABLE: { title: "这次运行已经结束，不能继续。", hint: "可以用同一个工作流再发起一次运行。" },
  RUN_CANCELLED: { title: "运行已停止。" },
  OWNER_PROCESS_EXITED: { title: "上次负责这次运行的应用进程已经退出，运行停了下来。", hint: "检查节点状态后可以继续运行。" },
  OWNER_PROCESS_STILL_ALIVE: { title: "负责这次运行的进程还在，暂时不能解除占用。" },
  SERVICE_RESTART_OWNER_EXITED: { title: "工作流服务重启时，负责这次运行的进程已经退出，运行停了下来。", hint: "检查节点状态后可以继续运行。" },
  RUNTIME_CONFIGURATION_CHANGED: { title: "Agent 启动配置和这次运行开始时不一致。", hint: "请恢复原来的配置后继续，或重新发起运行。" },
  RUNTIME_REQUIRES_FRESH_RUN: { title: "这次运行无法在当前版本里继续，需要重新发起。" },
  DATABASE_VERSION_UNSUPPORTED: { title: "运行记录来自更新版本的应用，当前版本无法读取。", hint: "请升级应用。" },
  // 节点执行
  ACTION_OUTCOME_REQUIRES_RECONCILIATION: { title: "动作执行异常，请核验后处理", hint: DISPOSE },
  UNKNOWN_ACTION_REQUIRES_RECONCILIATION: { title: "不确定这个动作有没有执行完，需要你核验。", hint: DISPOSE },
  PYTHON_OUTCOME_UNKNOWN: { title: "脚本执行中断，不确定有没有执行完。", hint: DISPOSE },
  PYTHON_PROCESS_FAILED_OR_INVALID_OUTPUT: { title: "脚本执行失败，或输出的格式不对。", hint: "可以在节点详情里看脚本输出。" },
  PYTHON_SPAWN_FAILED: { title: "无法启动 Python。", hint: "请确认已安装 Python 并能在命令行里运行。" },
  PYTHON_SCRIPT_CHANGED: { title: "运行开始后脚本被改过，为了安全没有继续执行。", hint: "请恢复脚本，或重新发起运行。" },
  CONDITION_NOT_BOOLEAN: { title: "连线条件未返回布尔值", hint: "请检查工作流源码里这条连线的条件。" },
  NO_MATCHING_ROUTE: { title: "没有满足条件的后续连线", hint: "节点的结果不符合任何一条连线的条件；可以处置节点，或修改工作流。" },
  SUBFLOW_INPUT_MUST_BE_OBJECT: { title: "子流程输入格式不正确", hint: "请检查工作流源码里调用子流程的输入。" },
  NODE_RESULT_INVALID: { title: "节点提交的结果不符合工作流要求的格式。", hint: "可以在会话里让 Agent 按要求重新提交。" },
  NODE_RESULT_MUST_BE_OBJECT: { title: "节点提交的结果不符合工作流要求的格式。", hint: "可以在会话里让 Agent 按要求重新提交。" },
  EVENT_DELIVERY_FAILED: { title: "运行事件未能送达，请刷新后检查状态" },
  EVIDENCE_REQUIRED: { title: "请写明你核验的依据。" },
  WORKFLOW_EVIDENCE_REQUIRED: { title: "请写明你核验的依据。" },
  RETRY_NOT_AUTHORIZED: { title: "这一步需要你确认后才能重试。", hint: DISPOSE },
  // 人工干预与确认（ADR 031）
  ANOTHER_INSTANCE_BLOCKED: { title: "同一层还有别的并行实例卡着，现在不能回退这一个。", hint: "请先处理那个实例。" },
  STEP_NOT_AVAILABLE: { title: "这一步已经不在运行路径上，不能回到这里。" },
  STEP_NOT_IN_CURRENT_FLOW: { title: "只能改道到同一个流程里的步骤。" },
  STEP_NO_LONGER_CURRENT: { title: "运行已经离开这一步，改道没有生效。", hint: "请刷新后重新选择。" },
  CHECKPOINT_SUPERSEDED: { title: "这个回退点已经因为之前的回退作废了。", hint: "请选择更新的回退点。" },
  CHECKPOINT_NOT_FOUND: { title: "找不到这个回退点。", hint: "请刷新后重新选择。" },
  NO_PENDING_CONFIRMATION: { title: "这里已经不需要确认了。", hint: "请刷新后查看最新状态。" },
  INTERVENTION_NOTE_TOO_LONG: { title: "返工意见太长了，请精简后再提交。" },
  INTERVENTION_TARGET_NOT_FOUND: { title: "要处置的节点已经不在了。", hint: "请刷新后重新选择。" },
  // Desktop 侧的节点会话
  WORKFLOW_SESSION_OWNER_MISSING: { title: "找不到原会话所属的 Agent，无法安全恢复；请核验节点后处理" },
  WORKFLOW_AGENT_UNAVAILABLE: { title: "原会话使用的 Agent 不可用，请检查 Agent 配置后处理节点" },
  WORKFLOW_AGENT_CONFIGURATION_CHANGED: { title: "原会话使用的 Agent 配置已更改，请恢复原配置后处理节点" },
  WORKFLOW_AGENT_RESUME_UNSUPPORTED: { title: "原 Agent 未声明支持恢复会话，请核验节点后选择处置方式" },
  WORKFLOW_SESSION_OWNER_CONFLICT: { title: "会话标识与另一个 Agent 的会话冲突，请核验节点后处理" },
  ACP_SESSION_ADOPTION_REJECTED: { title: "会话暂时无法接入，请稍后检查节点状态" },
  WORKFLOW_SESSION_NOT_ACCEPTING_INPUT: { title: "这个节点会话现在不接收回复。" },
  WORKFLOW_STORAGE_FULL: { title: "本机存储空间满了，记不下节点会话属于哪个 Agent，运行只好停下。", hint: "多半是旧版本留下的会话消息快照占满了空间；腾出空间后，在节点上点「处置…」重跑这一步。" },
  WORKFLOW_MODEL_UNAVAILABLE: { title: (arg) => `这个角色指定的模型「${arg}」在 Agent 里没有。`, hint: "请在工作流详情的「执行者」里换一个模型或留空，然后继续运行。" },
  WORKFLOW_MODEL_UNSUPPORTED: { title: (arg) => `Agent 不支持切换模型，无法使用「${arg}」。`, hint: "请在工作流详情的「执行者」里把模型留空，或换一个支持选模型的 Agent。" },
  // 问题池
  QUESTION_POOL_TOOL_ERROR: { title: "问题池操作失败，请检查问题池服务" },
  QUESTION_POOL_EXECUTABLE_UNAVAILABLE: { title: "问题池程序不可用，请检查应用安装" },
};

/** 按前缀归类的说明：先匹配到的生效。 */
const FAMILIES: readonly { readonly prefix: string; readonly entry: Entry }[] = [
  { prefix: "ACP_", entry: { title: "和 Agent 的连接出了问题。", hint: CHECK_AGENT } },
  { prefix: "WORKFLOW_AGENT_", entry: { title: "节点使用的 Agent 不可用。", hint: CHECK_AGENT } },
  { prefix: "HOST_", entry: { title: "工作流服务和应用之间的连接中断了。", hint: RETRY } },
  { prefix: "QUESTION_POOL_", entry: { title: "问题池出了问题。", hint: "请检查应用安装；问题池恢复后可以继续运行或处置节点。" } },
  { prefix: "QUESTION_TRACKER_", entry: { title: "问题池没有启动。", hint: "请检查应用安装后继续运行。" } },
  { prefix: "PYTHON_", entry: { title: "脚本节点执行出了问题。", hint: "请确认 Python 可用、脚本没有被改动；可以在节点上处置。" } },
  { prefix: "RESULT_", entry: { title: "节点结果的提交通道出了问题。", hint: DISPOSE } },
  { prefix: "ARTIFACT", entry: { title: "读取节点产出的文件失败。", hint: "请确认文件还在、没有超出大小限制。" } },
  { prefix: "PROCESS_", entry: { title: "无法确认节点进程的状态。", hint: DISPOSE } },
  { prefix: "INTERVENTION_", entry: { title: "处置请求不完整。", hint: "请重新选择处置方式。" } },
  { prefix: "CHECKPOINT_", entry: { title: "回退点不可用。", hint: "请刷新后重新选择。" } },
  { prefix: "STEP_", entry: { title: "这一步现在不能操作。", hint: "请刷新后重新选择。" } },
  { prefix: "RUN_", entry: { title: "这次运行的状态不允许当前操作。", hint: "请刷新后查看最新状态。" } },
  { prefix: "PREFLIGHT_", entry: { title: "启动前检查没有通过。", hint: "请重新检查后再启动。" } },
  { prefix: "INVALID_", entry: { title: "工作流定义或运行数据有错误。", hint: "请检查工作流源码；仍有问题请把技术详情发给维护者。" } },
  { prefix: "MISSING_", entry: { title: "工作流定义缺少必要的内容。", hint: "请检查工作流源码。" } },
  { prefix: "UNKNOWN_", entry: { title: "工作流定义引用了不存在的内容。", hint: "请检查工作流源码。" } },
  { prefix: "SUBFLOW_", entry: { title: "子流程的输入或输出不对。", hint: "请检查工作流源码。" } },
  { prefix: "WORKFLOW_", entry: { title: "工作流操作失败。", hint: RETRY } },
];

const CODE = /\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)\b/;

/** 从消息里找出错误码，以及紧跟在「CODE:」后面的补充信息。 */
function parse(message: string): { code: string; arg: string } | null {
  const trimmed = message.trim();
  const head = /^([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)(?::\s*([\s\S]*))?$/.exec(trimmed);
  if (head) return { code: head[1]!, arg: head[2]?.trim() ?? "" };
  // 消息里夹着错误码（例如「节点#1#2: PYTHON_OUTCOME_UNKNOWN」）：认得出的才算。
  for (const match of trimmed.matchAll(new RegExp(CODE, "g"))) {
    const code = match[1]!;
    if (CODES[code] || FAMILIES.some((family) => code.startsWith(family.prefix))) return { code, arg: "" };
  }
  return null;
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  if (cause === undefined || cause === null) return "";
  if (typeof cause === "object") {
    try { return JSON.stringify(cause); } catch { return ""; }
  }
  return typeof cause === "number" || typeof cause === "boolean" || typeof cause === "bigint" ? String(cause) : "";
}

export function describeError(cause: unknown): ErrorText {
  const message = messageOf(cause).trim();
  if (message === "") return { title: "操作失败。", hint: RETRY };
  const parsed = parse(message);
  if (!parsed) {
    // 没有错误码：已经是给人看的说明（多为中文），原样显示。
    if (/[一-鿿]/.test(message)) return { title: message };
    return { title: "出现了内部错误。", hint: RETRY, detail: message };
  }
  const entry = CODES[parsed.code] ?? FAMILIES.find((family) => parsed.code.startsWith(family.prefix))?.entry;
  const title = entry === undefined ? "出现了内部错误。" : typeof entry.title === "function" ? entry.title(parsed.arg) : entry.title;
  return {
    title,
    ...(entry?.hint ? { hint: entry.hint } : entry === undefined ? { hint: RETRY } : {}),
    code: parsed.code,
    ...(message !== parsed.code ? { detail: message } : {}),
  };
}

/** 只能放一行字的地方：说明加处理建议。 */
export function errorLine(cause: unknown): string {
  return joinHint(describeError(cause));
}

/** 中文句子直接相接；说明没有句末标点时补一个句号。 */
export function joinHint(text: ErrorText): string {
  if (!text.hint) return text.title;
  return /[。！？.!?]$/.test(text.title) ? `${text.title}${text.hint}` : `${text.title}。${text.hint}`;
}

/** 服务进程退出：直接给出诊断日志的末尾几行，不让用户自己去找文件。 */
export function serviceExitText(code: unknown, stderrTail: unknown, retryLabel: string): ErrorText {
  const lines = Array.isArray(stderrTail) ? stderrTail.filter((line): line is string => typeof line === "string") : [];
  return {
    title: `工作流服务意外退出${typeof code === "number" ? `（退出码 ${code}）` : ""}。`,
    hint: `点「${retryLabel}」重新启动服务。`,
    ...(lines.length > 0 ? { detail: lines.join("\n") } : {}),
  };
}
