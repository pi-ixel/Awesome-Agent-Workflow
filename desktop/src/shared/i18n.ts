/**
 * 最小界面多语言设施（src/core）。
 *
 * 当前策略：中文为完整语言（默认），英文为「预留」——仅覆盖设置页高频
 * 词条，缺失词条回落中文，避免出现半成品的全量英文界面。新增文案时先在
 * `zhMessages` 补齐，英文词条随翻译进度逐步补入 `enMessages`。
 */

/** 界面语言。 */
export type Language = "zh-CN" | "en-US";

/**
 * 语言选单（顺序即展示顺序）。
 *
 * 只暴露中文：英文是半成品（仅覆盖设置页高频词条），不作为可选项露出，
 * 避免用户切到残缺界面。`Language` 类型与 en 词条机制保留，供未来翻译
 * 补齐后重新放开。
 */
export const languageOptions: readonly {
  readonly value: Language;
  readonly label: string;
}[] = [{ value: "zh-CN", label: "中文" }];

/** 词条键：先补 zh，再按进度补 en。 */
export type MessageKey =
  | "settings.title"
  | "settings.subtitle"
  | "settings.toolPathsSection"
  | "settings.toolPathsHint"
  | "settings.testConnection"
  | "settings.testing"
  | "settings.approvalSection"
  | "settings.approvalHint"
  | "settings.languageSection"
  | "settings.skillsSourceSection"
  | "settings.skillsSourceHint"
  | "settings.reset"
  | "approval.ask"
  | "approval.autoAllow"
  | "approval.autoReject";

const zhMessages: Readonly<Record<MessageKey, string>> = {
  "settings.title": "设置",
  "settings.subtitle":
    "工具路径、Agent 配置、审批默认模式、界面语言与 AAW skills 安装源",
  "settings.toolPathsSection": "工具路径",
  "settings.toolPathsHint":
    "健康检查与 AAW 状态查询使用这些工作流工具路径；Agent 可执行路径在对应 Agent 设置中配置。",
  "settings.testConnection": "测试连接",
  "settings.testing": "测试中…",
  "settings.approvalSection": "审批默认模式",
  "settings.approvalHint":
    "Agent 请求执行工具时的客户端默认处理方式；与 Agent 自身的会话模式独立。",
  "settings.languageSection": "界面语言",
  "settings.skillsSourceSection": "AAW skills 安装源目录",
  "settings.skillsSourceHint":
    "安装目标和安装方式由所选 Agent 的技能安装能力提供。",
  "settings.reset": "恢复默认设置",
  "approval.ask": "每次询问（弹出审批对话框）",
  "approval.autoAllow": "自动放行（默认允许工具调用）",
  "approval.autoReject": "自动拒绝（默认拒绝工具调用）",
};

/** 英文词条：有意保持 Partial——缺失键回落中文（预留，不算完整翻译）。 */
const enMessages: Partial<Readonly<Record<MessageKey, string>>> = {
  "settings.title": "Settings",
  "settings.testConnection": "Test connection",
  "settings.testing": "Testing…",
  "settings.languageSection": "Interface language",
  "settings.reset": "Reset to defaults",
};

/** 取翻译函数：当前语言词条 → 英文词条 → 中文词条 → 键名本身。 */
export function createTranslator(
  language: Language,
): (key: MessageKey) => string {
  return (key) => {
    if (language === "en-US") {
      return enMessages[key] ?? zhMessages[key] ?? key;
    }
    return zhMessages[key] ?? key;
  };
}
