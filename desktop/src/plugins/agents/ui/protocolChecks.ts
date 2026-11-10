/**
 * 协议自检的检查表推导（纯函数，无 React / store 依赖）。
 *
 * 组织原则：**按能力组织，与具体 agent 底座无关**。每行 = 一个用户可感知
 * 的能力（对话回复、思考流、用量条、模型切换……），行内回答「这能力有
 * 没有、靠哪种形式满足、缺失时影响什么」。wire 上的消息名
 * （agent_message_chunk、usage_update、_chrys/usage_update …）只是
 * 能力的「提供形式」，出现在括号注脚里，绝不充当行主语——同一个能力
 * 可以有多种形式（如用量条：标准 usage_update 或 iCode 扩展），任一
 * 形式满足即支持。
 *
 * 文案原则：表里只出现我们依赖的能力；每行自答「需要我做什么吗」——
 * 只有 warn/danger 行需要用户关注（影响写在行内），其余明示「无需处理」。
 *
 * 状态语义：
 * - ok      能力已满足（注明形式）——无需处理；
 * - warn    agent 已提供某形式但客户端尚未接入（适配点），或能力缺失
 *   但有降级（影响见行内）——换 agent 前值得看一眼；
 * - danger  失败且影响核心链路（握手失败、list 报错）——按行内原因排查；
 * - unobserved 安全探查不触发对话类能力（≠不支持）——无需处理，
 *   想坐实就跑一次深度探查；
 * - info    有兜底、无需处理的行（如未声明的会话关闭）。深度探查
 *   = 两轮真实对话（轮 1 轻量回复、轮 2 多步任务：列目录 + 跑命令），
 *   会触发思考/工具/计划/审批——两轮后仍未出现即为可信的缺失结论。
 */
import type { AgentProbeResult } from "../probe/types.ts";

export type CheckStatus = "ok" | "warn" | "danger" | "unobserved" | "info";

export interface CheckRow {
  readonly key: string;
  readonly label: string;
  readonly status: CheckStatus;
  /** 徽标短文案（支持 / 缺失 / 已提供未接入 / …）。 */
  readonly badge: string;
  /** 依据与数据（满足形式、计数、原因）。 */
  readonly detail: string;
  /** 缺失/降级时的功能影响；满足时为空。 */
  readonly impact: string;
}

export interface CheckGroup {
  readonly key: string;
  readonly title: string;
  readonly rows: readonly CheckRow[];
}

// ------------------------------------------------------------- 能力读取守卫

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function capGroup(
  capabilities: Readonly<Record<string, unknown>> | null,
  key: string,
): Readonly<Record<string, unknown>> | null {
  if (capabilities === null) return null;
  return asRecord(capabilities[key]);
}

function capBool(
  group: Readonly<Record<string, unknown>> | null,
  key: string,
): boolean | null {
  if (group === null) return null;
  const value = group[key];
  return typeof value === "boolean" ? value : null;
}

// ------------------------------------------------------------- 行构造助手

const OK_BADGE = "支持";
const MISSING_BADGE = "缺失";
const PROVIDED_UNWIRED_BADGE = "已提供未接入";
const UNOBSERVED_BADGE = "待验证";

function ok(key: string, label: string, detail: string): CheckRow {
  return { key, label, status: "ok", badge: OK_BADGE, detail, impact: "" };
}
function warnMissing(
  key: string,
  label: string,
  detail: string,
  impact: string,
): CheckRow {
  return { key, label, status: "warn", badge: MISSING_BADGE, detail, impact };
}
function danger(
  key: string,
  label: string,
  detail: string,
  impact: string,
): CheckRow {
  return { key, label, status: "danger", badge: "失败", detail, impact };
}

/**
 * 一种能力的「提供形式」：wire 计数 + 是否已被客户端消费。
 * consumed=false 表示 agent 发了、客户端还没接（适配点，不算满足）。
 */
interface CapabilityForm {
  readonly form: string;
  readonly count: number;
  readonly consumed: boolean;
}

/** 深度探查的对话轮全部失败（模型超时/无凭证）——事件观测不可下结论。 */
function deepTurnsAllFailed(result: AgentProbeResult): boolean {
  return (
    result.depth === "deep" &&
    result.prompts.length > 0 &&
    result.prompts.every((turn) => turn.status === "failed")
  );
}

/**
 * 能力行（事件类）：有已消费形式在收 → 支持（注明形式）；有形式在收但
 * 全未消费 → 已提供未接入；全没收到 → 待验证（安全探查，或深度探查但
 * 对话轮全败——模型没应答，观测无从谈起）/ 缺失（深度探查两轮真实对话
 * 仍未出现，证据写进 detail）。
 */
function capabilityRow(
  key: string,
  label: string,
  forms: readonly CapabilityForm[],
  result: AgentProbeResult,
  impactIfMissing: string,
): CheckRow {
  const received = forms.filter((item) => item.count > 0);
  const satisfied = received.find((item) => item.consumed);
  if (satisfied !== undefined) {
    return ok(key, label, `经${satisfied.form} ×${String(satisfied.count)}`);
  }
  if (received.length > 0) {
    return {
      key,
      label,
      status: "warn",
      badge: PROVIDED_UNWIRED_BADGE,
      detail: `agent 已提供（${received.map((item) => item.form).join("、")}）；客户端接入后即可用`,
      impact: `接入前的表现：${impactIfMissing}`,
    };
  }
  if (result.depth === "deep" && !deepTurnsAllFailed(result)) {
    return {
      key,
      label,
      status: "warn",
      badge: MISSING_BADGE,
      detail: `两轮真实对话（含多步任务）仍未出现${forms.length === 1 ? `（客户端目前仅经${forms[0]!.form}获得此能力）` : ""}`,
      impact: impactIfMissing,
    };
  }
  return {
    key,
    label,
    status: "unobserved",
    badge: UNOBSERVED_BADGE,
    detail:
      result.depth === "deep"
        ? "深度对话轮未成功（原因见「深度对话」行），本次无法观测——无需处理，稍后重试"
        : "安全探查不触发对话，看不到属正常——无需处理",
    impact: "",
  };
}

/** 工具 kind 分布 → "read×3 · edit×1" 短文案。 */
function toolKindSummary(result: AgentProbeResult): string {
  const entries = Object.entries(result.events.toolKindCounts);
  if (entries.length === 0) return "已收到";
  return entries.map(([kind, n]) => `${kind}×${String(n)}`).join(" · ");
}

// ------------------------------------------------------------- 分组推导

function handshakeGroup(result: AgentProbeResult): CheckGroup {
  const rows: CheckRow[] = [];
  if (!result.ok) {
    rows.push(
      danger(
        "link",
        "连接链路",
        `${result.failedStep ?? "?"}：${result.failureReason ?? "未知原因"}`,
        "agent 未走通基础 ACP 链路，无法建立会话",
      ),
    );
  } else {
    rows.push(
      ok(
        "link",
        "连接链路",
        "initialize 与 session/new 已完成；列表和关闭结果见下方",
      ),
    );
  }
  rows.push(
    result.protocolVersion !== null
      ? ok(
          "protocol-version",
          "协议版本协商",
          `protocolVersion v${String(result.protocolVersion)}（客户端请求 v1）`,
        )
      : danger(
          "protocol-version",
          "协议版本协商",
          "握手未完成，无版本数据",
          "见上方失败原因",
        ),
  );
  rows.push(
    result.agentName !== null
      ? ok(
          "agent-identity",
          "agent 身份",
          `${result.agentName}${result.agentVersion === null ? "" : ` ${result.agentVersion}`}`,
        )
      : warnMissing(
          "agent-identity",
          "agent 身份",
          "initialize 未返回 agentInfo",
          "诊断与日志里指代该 agent 时缺名称",
        ),
  );
  return { key: "handshake", title: "握手与身份", rows };
}

/** 对话与审批：消息流里的核心体验。 */
function conversationGroup(result: AgentProbeResult): CheckGroup {
  const counts = result.events.eventTypeCounts;
  const rows: CheckRow[] = [
    capabilityRow(
      "messages",
      "对话回复",
      [
        {
          form: "标准消息流",
          count: counts["agent_message_chunk"] ?? 0,
          consumed: true,
        },
      ],
      result,
      "对话看不到 agent 回复",
    ),
    capabilityRow(
      "thoughts",
      "思考过程",
      [
        {
          form: "标准思考流",
          count: counts["agent_thought_chunk"] ?? 0,
          consumed: true,
        },
      ],
      result,
      "思考块不显示",
    ),
    capabilityRow(
      "tools",
      "工具执行过程",
      [
        {
          form: "标准工具通知",
          count: (counts["tool_call"] ?? 0) + (counts["tool_call_update"] ?? 0),
          consumed: true,
        },
      ],
      result,
      "工具执行过程不可见",
    ),
    capabilityRow(
      "plan",
      "任务计划卡",
      [
        {
          form: "标准计划通知",
          count: (counts["plan"] ?? 0) + (counts["plan_update"] ?? 0),
          consumed: true,
        },
      ],
      result,
      "任务步骤卡不显示",
    ),
    capabilityRow(
      "approval",
      "权限审批",
      [
        {
          form: "标准权限请求",
          count: result.permissionRequests,
          consumed: true,
        },
      ],
      result,
      "敏感操作改为直接执行或失败（按 agent 默认策略）",
    ),
  ];

  // 工具 kind 是形式注脚：收到工具通知时顺带展示分布
  const withToolKinds = rows.map((row) =>
    row.key === "tools" && row.status === "ok"
      ? { ...row, detail: `${row.detail}（${toolKindSummary(result)}）` }
      : row,
  );

  if (result.depth === "deep") {
    // 两轮对话结论：轮 1 轻量回复、轮 2 多步任务；全部成功才算走通
    const turns = result.prompts;
    const allOk =
      turns.length > 0 && turns.every((turn) => turn.status === "ok");
    const detail =
      turns.length === 0
        ? "未执行"
        : turns
            .map(
              (turn, index) =>
                `轮${String(index + 1)} ${
                  turn.status === "ok"
                    ? (turn.stopReason ?? "?")
                    : (turn.reason ?? "失败")
                }`,
            )
            .join(" · ");
    withToolKinds.push(
      allOk
        ? ok("prompt-turn", "深度对话（两轮：轻量回复 + 多步任务）", detail)
        : danger(
            "prompt-turn",
            "深度对话（两轮：轻量回复 + 多步任务）",
            detail,
            "模型调用失败（常见：未配置凭证 / 模型不可用）——协议链路本身不受影响",
          ),
    );
  }

  return { key: "conversation", title: "对话与审批", rows: withToolKinds };
}

/** 会话管理：恢复、历史、关闭。 */
function sessionManagementGroup(result: AgentProbeResult): CheckGroup {
  const sessionCaps = capGroup(result.capabilities, "sessionCapabilities");
  const closeDeclared = sessionCaps !== null && "close" in sessionCaps;
  const rows: CheckRow[] = [];

  rows.push(
    capBool(result.capabilities, "loadSession") === true
      ? ok(
          "restore",
          "会话恢复",
          "agent 已声明支持（打开项目自动回到上次会话）",
        )
      : warnMissing(
          "restore",
          "会话恢复",
          "agent 未声明",
          "打开项目无法恢复历史会话，只能每次新建",
        ),
  );

  if (result.list?.status === "ok") {
    rows.push(
      ok(
        "history",
        "历史会话列表",
        `实测可用（${String(result.list.count)} 条会话）`,
      ),
    );
  } else if (result.list?.status === "unsupported") {
    rows.push({
      key: "history",
      label: "历史会话列表",
      status: "info",
      badge: "可选能力未提供",
      detail: "Agent 未实现 session/list",
      impact: "使用本地会话索引，对话不受影响",
    });
  } else if (result.list?.status === "failed") {
    rows.push(
      danger(
        "history",
        "历史会话列表",
        result.list.reason ?? "请求失败",
        "左栏项目树拿不到该项目的会话列表（回落：本地会话索引补充）",
      ),
    );
  } else {
    rows.push(
      warnMissing(
        "history",
        "历史会话列表",
        "链路未走到（握手失败）",
        "左栏项目树拿不到该项目的会话列表",
      ),
    );
  }

  rows.push({
    key: "close",
    label: "干净关闭会话",
    status: result.closeAck === true ? "ok" : "info",
    badge: result.closeAck === true ? OK_BADGE : "无需处理",
    detail:
      result.closeAck === true
        ? "agent 确认了 session/close"
        : closeDeclared
          ? "agent 未确认关闭；进程清理有兜底——无需处理"
          : "agent 未声明；关闭请求照发，失败走进程清理兜底——无需处理",
    impact: "",
  });

  return { key: "session-management", title: "会话管理", rows };
}

/** 输入与会话控制：模型 / 模式 / @提及。 */
function inputControlGroup(result: AgentProbeResult): CheckGroup {
  const promptCaps = capGroup(result.capabilities, "promptCapabilities");
  const rows: CheckRow[] = [];

  rows.push(
    result.models !== null && result.models.availableModels.length > 0
      ? ok(
          "model-switch",
          "模型切换",
          `${String(result.models.availableModels.length)} 个模型 · 当前 ${result.models.currentModelId ?? "?"}`,
        )
      : warnMissing(
          "model-switch",
          "模型切换",
          "该 agent 未下发模型清单",
          "输入行模型切换器隐藏，回落纯标识显示",
        ),
  );

  rows.push(
    result.modes !== null && result.modes.availableModes.length > 0
      ? ok(
          "mode-switch",
          "模式 / 审批档位切换",
          `当前 ${result.modes.currentModeId} · ${String(result.modes.availableModes.length)} 档`,
        )
      : warnMissing(
          "mode-switch",
          "模式 / 审批档位切换",
          "该 agent 未下发模式清单",
          "会话内档位切换不可用",
        ),
  );

  const embedded = capBool(promptCaps, "embeddedContext");
  rows.push(
    embedded === true
      ? ok("mention", "@文件提及", "agent 已声明内嵌上下文")
      : warnMissing(
          "mention",
          "@文件提及",
          embedded === false ? "agent 声明不支持" : "agent 未声明",
          "@提及退化为纯文本提示，agent 未必读取",
        ),
  );

  return {
    key: "input-control",
    title: "输入与会话控制",
    rows: rows.map((row) =>
      ["model-switch", "mode-switch"].includes(row.key) && row.status === "warn"
        ? { ...row, status: "info", badge: "可选能力未提供" }
        : row,
    ),
  };
}

/** 状态与增强：多种提供形式的能力在这里汇合。 */
function statusEnhancementGroup(result: AgentProbeResult): CheckGroup {
  const counts = result.events.eventTypeCounts;
  const rows: CheckRow[] = [];

  // 用量条：两种形式都已消费——谁在收就经谁满足
  rows.push(
    capabilityRow(
      "usage",
      "用量显示（token / 上下文占用）",
      [
        {
          form: "标准 usage_update（上下文占用口径）",
          count: counts["usage_update"] ?? 0,
          consumed: true,
        },
        {
          form: "Agent 适配器用量扩展",
          count: counts["agent_usage"] ?? 0,
          consumed: true,
        },
      ],
      result,
      "用量条不显示",
    ),
  );

  rows.push(
    capabilityRow(
      "runtime-info",
      "运行时状态（模型标识 / 技能名录 / 工具名单）",
      [
        {
          form: "Agent 适配器运行时扩展",
          count: counts["agent_runtime"] ?? 0,
          consumed: true,
        },
      ],
      result,
      "可选 Agent 增强未观测；标准模型配置和会话状态不受影响",
    ),
  );

  rows.push(
    capabilityRow(
      "agent-errors",
      "细粒度错误 / 警告",
      [
        {
          form: "Agent 适配器错误和警告扩展",
          count: (counts["agent_error"] ?? 0) + (counts["agent_warning"] ?? 0),
          consumed: true,
        },
      ],
      result,
      "agent 侧错误只剩轮次级失败提示",
    ),
  );

  rows.push(
    capabilityRow(
      "questions",
      "结构化问答面板",
      [
        {
          form: "Agent 适配器结构化问答扩展",
          count: result.questionRequests,
          consumed: true,
        },
      ],
      result,
      "问答停靠面板不会出现（自由文本提问不受影响）",
    ),
  );

  // 命令清单：翻译层已同时归一裸风格与命名空间风格（session/update:*），
  // 收到即进斜杠面板的「Agent 命令」组
  rows.push(
    capabilityRow(
      "commands",
      "agent 侧斜杠命令清单",
      [
        {
          form: "available_commands 通知（裸 / 命名空间风格均可）",
          count: counts["available_commands"] ?? 0,
          consumed: true,
        },
      ],
      result,
      "斜杠命令菜单只剩本地静态命令",
    ),
  );

  for (const row of rows) {
    if (
      ["runtime-info", "agent-errors", "questions"].includes(row.key) &&
      row.status === "warn"
    ) {
      Object.assign(row, { status: "info", badge: "可选增强未观测" });
    }
  }
  return { key: "status-enhancement", title: "状态与增强", rows };
}

/** 探查结果 → 分组检查表（设置页「Agent」分片报告卡的数据源）。 */
export function deriveProtocolChecks(
  result: AgentProbeResult,
): readonly CheckGroup[] {
  return [
    handshakeGroup(result),
    conversationGroup(result),
    sessionManagementGroup(result),
    inputControlGroup(result),
    statusEnhancementGroup(result),
  ];
}

/** 头部统计：各状态行数（“N 支持 · M 需关注 …”）。 */
export function probeSummary(groups: readonly CheckGroup[]): {
  readonly ok: number;
  readonly warn: number;
  readonly danger: number;
} {
  let okCount = 0;
  let warnCount = 0;
  let dangerCount = 0;
  for (const group of groups) {
    for (const row of group.rows) {
      if (row.status === "ok") okCount += 1;
      else if (row.status === "warn") warnCount += 1;
      else if (row.status === "danger") dangerCount += 1;
    }
  }
  return { ok: okCount, warn: warnCount, danger: dangerCount };
}
