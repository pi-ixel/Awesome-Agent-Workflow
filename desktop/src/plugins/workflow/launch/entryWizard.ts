/**
 * 入口启动向导的领域逻辑：三入口元数据、变量校验与首条中文 prompt 生成。
 *
 * 权威对照：
 * - 入口定义与变量：`skills/aaw-workflow/scripts/cli/definitions/flow.yaml`
 *   （entrypoints: sr=[SR]、ar=[SR,AR,描述]、dev=[SR]）；
 * - 启动约束与场景说明：`skills/aaw-workflow/SKILL.md` 的「入口意图判定」
 *   与「启动流程」两节。
 *
 * 生成的 prompt 是发给 chrys 会话的自然语言指令（不是直接执行 CLI）：
 * 会话侧由 aaw-workflow skill 识别「进入工作流 + 指定入口」的意图并收集
 * 变量执行 `start`。因此 prompt 必须同时携带：明确的启动意图、入口名、
 * 全部入口变量，并声明「不要继续已有 SR」（SKILL.md 的意图判定规则）。
 */

/** aaw CLI 的三个启动入口（flow.yaml entrypoints 键）。 */
export type AawEntryId = "sr" | "ar" | "dev";

/** 一个入口的静态描述（向导第一步的卡片数据）。 */
export interface AawEntryDefinition {
  readonly id: AawEntryId;
  readonly title: string;
  /** 一句话场景说明。 */
  readonly summary: string;
  /** 链路与产出说明（帮助用户判断入口是否合适）。 */
  readonly detail: string;
  /** 需要收集的变量名列表（与 CLI entrypoints.vars 对应）。 */
  readonly vars: readonly string[];
}

/** 三入口元数据（文案对照 SKILL.md 的入口定位表）。 */
export const AAW_ENTRY_DEFINITIONS: readonly AawEntryDefinition[] = [
  {
    id: "sr",
    title: "SR 严谨流程",
    summary: "企业 / 严谨流程，需求需完整留痕",
    detail: "11 步链路，产出约 11 份文档；需要提供原始需求文件。",
    vars: ["SR", "需求文件"],
  },
  {
    id: "ar",
    title: "AR 从 AR 切入",
    summary: "已有架构基线，从某个 AR 直接切入",
    detail:
      "从 ar-clarify 起步；要求仓库已执行过 repo-init 并存在 .sdd/software_architecture.md。",
    vars: ["SR", "AR", "描述"],
  },
  {
    id: "dev",
    title: "dev 个人轻量",
    summary: "个人开发者 / 轻量迭代，追求快速出代码",
    detail:
      "6 步短链路，设计与开发同一人；只适合一人能独立设计并实现的小需求。",
    vars: ["SR", "一句话需求"],
  },
];

/** SR 入口的需求提供方式：选择已有文件，或直接粘贴原文。 */
export type SrRequirementMode = "file" | "paste";

/** SR 入口输入。 */
export interface SrEntryInput {
  readonly kind: "sr";
  readonly sr: string;
  readonly requirementMode: SrRequirementMode;
  readonly requirementFile: string;
  readonly requirementText: string;
}

/** AR 入口输入。 */
export interface ArEntryInput {
  readonly kind: "ar";
  readonly sr: string;
  readonly ar: string;
  readonly description: string;
}

/** dev 入口输入。 */
export interface DevEntryInput {
  readonly kind: "dev";
  readonly sr: string;
  readonly requirement: string;
}

export type AawEntryInput = SrEntryInput | ArEntryInput | DevEntryInput;

/** 入口标题查找（向导步骤二回显用）。 */
export function entryTitleOf(id: AawEntryId): string {
  const found = AAW_ENTRY_DEFINITIONS.find((entry) => entry.id === id);
  return found === undefined ? id : found.title;
}

function trim(raw: string): string {
  return raw.trim();
}

/**
 * 校验入口输入；合法返回 null，否则返回中文错误文案（向导直接展示）。
 */
export function validateEntryInput(input: AawEntryInput): string | null {
  const sr = trim(input.sr);
  if (sr.length === 0) {
    return "请填写 SR 编号（如 SR-001）";
  }
  switch (input.kind) {
    case "sr":
      if (input.requirementMode === "file") {
        if (trim(input.requirementFile).length === 0) {
          return "请填写原始需求文件路径，或改为粘贴需求原文";
        }
      } else if (trim(input.requirementText).length === 0) {
        return "请粘贴原始需求原文（保持原文，不要总结改写）";
      }
      return null;
    case "ar":
      if (trim(input.ar).length === 0) {
        return "请填写 AR 编号（如 AR-003）";
      }
      if (trim(input.description).length === 0) {
        return "请填写 AR 描述";
      }
      return null;
    case "dev":
      if (trim(input.requirement).length === 0) {
        return "请用一句话描述要做的需求";
      }
      return null;
  }
}

/** 需求原文定界符：避免多行原文与指令正文混淆。 */
const REQUIREMENT_FENCE = "<<<需求原文";

/**
 * 生成首条中文 prompt：含「进入工作流」意图、入口名与全部入口变量，
 * 交给会话发送（由会话侧 aaw-workflow skill 执行 start）。
 */
export function buildEntryPrompt(input: AawEntryInput): string {
  const sr = trim(input.sr);
  const lines: string[] = [
    `进入 AAW 工作流：请从${entryTitleOf(input.kind)}入口新建一条工作流（新建，不要继续已有 SR）。`,
    "",
    "入口变量：",
    `- SR 编号：${sr}`,
  ];
  if (input.kind === "sr") {
    if (input.requirementMode === "file") {
      lines.push(
        `- 原始需求文件：${trim(input.requirementFile)}（请以它作为 requirement-file 启动，保持原文不加工）`,
      );
    } else {
      lines.push(
        "- 原始需求：以下为需求原文（请先原样落盘为临时 Markdown 文件，再作为 requirement-file 启动；不要总结、改写或做设计性加工）：",
        REQUIREMENT_FENCE,
        trim(input.requirementText),
        ">>>",
      );
    }
  } else if (input.kind === "ar") {
    lines.push(
      `- AR 编号：${trim(input.ar)}`,
      `- AR 描述：${trim(input.description)}`,
    );
  } else {
    lines.push(`- 一句话需求：${trim(input.requirement)}`);
  }
  lines.push(
    "",
    "请按 aaw-workflow 的启动流程执行，并在启动后回显关键信息与我核对。",
  );
  return lines.join("\n");
}
