/**
 * `/` 命令面板的纯逻辑（触发检测 + 命令目录 + 过滤 + token 替换），
 * 与渲染解耦便于单测。设计对齐 ZCode 的 slash 面板：
 *
 * - 触发：**行首** `/`（或中文顿号 `、` 的归一——行首误触顿号是 `/` 的
 *   常见输入法场景）后跟连续非空白非斜杠字符；面板随 query 过滤；
 * - 目录四类：内置命令（选中即执行）、AAW 工作流入口（打开 AAW 面板
 *   并把向导定位到对应入口表单）、skills（插入提示文本——chrys 没有
 *   用户侧 `$` 触发语法，agent 读到提示后自行 load_skill）、agent 侧
 *   命令（agent 经 available_commands 推送的清单，插入 `/名 ` 由 agent
 *   自己解析执行——与底座无关，iCode / OpenCode 推了就有）；
 * - 过滤：复用 mention 的归一子串 / 子序列口径（分隔符与大小写不敏感）。
 */
import type { WorkflowEntryCommand } from "../../../../contracts/workbench.ts";
import type { AgentCommandEntry } from "../../../../contracts/acpProtocol.ts";

/** slash 命令条目。 */
export interface SlashItem {
  /** 唯一 id（`clear` / `wizard-sr` / `skill:aaw-workflow` / `agent:review`）。 */
  readonly id: string;
  /** 显示名（不含斜杠，如 `clear`、`sr`、`aaw-workflow`）。 */
  readonly label: string;
  readonly group: "命令" | "工作流入口" | "Skills" | "Agent 命令";
  readonly description: string;
  /** action=选中即执行；insert=往输入框插入 insertText。 */
  readonly kind: "action" | "insert";
  /** action 类的执行标识（ChatInput 侧映射到具体 store 调用）。 */
  readonly actionId?: "clear" | "diagnostics" | "retry";
  readonly run?: () => void;
  /** insert 类的插入文本。 */
  readonly insertText?: string;
}

/** 检测光标前是否处在行首 slash 触发段；返回查询串（可空）或 null。 */
export function detectSlashTrigger(textBeforeCaret: string): string | null {
  const lastLine = textBeforeCaret.slice(
    Math.max(textBeforeCaret.lastIndexOf("\n") + 1, 0),
  );
  const match = /^(?:\/|、)([^\s/]*)$/.exec(lastLine);
  return match === null ? null : (match[1] ?? "");
}

/** skill 项的插入文本：自然语言提示（agent 自行 load_skill）。 */
export function skillInsertText(name: string): string {
  return name;
}

/** 内置命令。工作流入口和 skills 由调用方提供。 */
const STATIC_ITEMS: readonly SlashItem[] = [
  {
    id: "clear",
    label: "clear",
    group: "命令",
    description: "清空当前会话的消息流",
    kind: "action",
    actionId: "clear",
  },
  {
    id: "diagnostics",
    label: "diagnostics",
    group: "命令",
    description: "打开诊断窗口（日志、性能与运行时）",
    kind: "action",
    actionId: "diagnostics",
  },
  {
    id: "retry",
    label: "retry",
    group: "命令",
    description: "重发最后一条用户消息",
    kind: "action",
    actionId: "retry",
  },
];

/**
 * 组装完整目录（skills 来自会话运行时已加载的 skill 清单；agent 命令
 * 来自 agent 推送的 available_commands——推了就进面板，与底座无关）。
 */
export function buildSlashItems(
  skillNames: readonly string[],
  agentCommands: readonly AgentCommandEntry[] = [],
  invocations?: Readonly<Record<string, string>>,
  workflowEntries: readonly WorkflowEntryCommand[] = [],
): readonly SlashItem[] {
  return [
    ...STATIC_ITEMS,
    ...workflowEntries.map((entry): SlashItem => ({
      ...entry,
      group: "工作流入口",
      kind: "action",
    })),
    ...agentCommands.map((command): SlashItem => ({
      id: `agent:${command.name}`,
      label: command.name,
      group: "Agent 命令",
      description:
        command.description === null || command.description.length === 0
          ? command.inputHint === null
            ? "agent 侧命令"
            : `参数：${command.inputHint}`
          : command.inputHint === null
            ? command.description
            : `${command.description}（参数：${command.inputHint}）`,
      kind: "insert",
      // 以 `/名 ` 形式插入，参数由用户补——执行在 agent 侧
      insertText: `/${command.name} `,
    })),
    ...skillNames.map((name): SlashItem => ({
      id: `skill:${name}`,
      label: name,
      group: "Skills",
      description: "插入使用该 skill 的提示",
      kind: "insert",
      insertText: invocations?.[name] ?? skillInsertText(name),
    })),
  ];
}

/** 归一（与 mention.ts 同口径：分隔符与大小写不敏感）。 */
function normalize(value: string): string {
  return value.toLowerCase().replaceAll(/[\\/._-]+/g, "");
}

/** 模糊匹配：归一子串（位置越前越优）→ 归一子序列兜底。 */
function matches(candidate: string, query: string): number | null {
  if (query.length === 0) {
    return 0;
  }
  const nCandidate = normalize(candidate);
  const nQuery = normalize(query);
  if (nQuery.length === 0) {
    return 0;
  }
  const index = nCandidate.indexOf(nQuery);
  if (index !== -1) {
    return index;
  }
  // 子序列兜底：query 各字符按序出现在 candidate 中
  let cursor = 0;
  for (const char of nQuery) {
    const found = nCandidate.indexOf(char, cursor);
    if (found === -1) {
      return null;
    }
    cursor = found + 1;
  }
  return nCandidate.length;
}

/** 过滤目录（静态命令不受 skills 数量影响；Skills 最多展示 6 条）。 */
export function filterSlashItems(
  items: readonly SlashItem[],
  query: string,
): SlashItem[] {
  const scored: { item: SlashItem; score: number; order: number }[] = [];
  items.forEach((item, order) => {
    const score = matches(item.label, query);
    if (score !== null) {
      scored.push({ item, score, order });
    }
  });
  scored.sort((left, right) => {
    if (left.score !== right.score) {
      return left.score - right.score;
    }
    return left.order - right.order;
  });
  // 静态命令全保留；Skills 只留前 6（69 个 skill 全列会把面板撑爆）
  let skillsKept = 0;
  return scored
    .filter(({ item }) => {
      if (item.group !== "Skills") {
        return true;
      }
      skillsKept += 1;
      return skillsKept <= 6;
    })
    .map(({ item }) => item);
}

/** 选中后替换草稿中的 `/token`（含顿号形态）为 replacement。 */
export function replaceSlashToken(
  draft: string,
  caret: number,
  query: string,
  replacement: string,
): { text: string; caret: number } {
  const tokenLength = query.length + 1;
  const start = caret - tokenLength;
  if (start < 0 || !/[/、]/.test(draft[start] ?? "")) {
    // 边缘兜底（IME / 粘贴导致检测失准）：追加在末尾
    return {
      text: `${draft}${draft.length > 0 ? " " : ""}${replacement}`,
      caret: draft.length + replacement.length + 1,
    };
  }
  return {
    text: draft.slice(0, start) + replacement + draft.slice(caret),
    caret: start + replacement.length,
  };
}
