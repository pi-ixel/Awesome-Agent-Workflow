import type {
  AgentSettingsAccess,
  AgentSettingsData,
  AgentSettingsMap,
} from "../core/agentConfiguration.ts";
/**
 * 设置 store（src/stores）：Agent 配置与管理（当前选择 +
 * 自定义条目 + 本机扫描）、审批默认模式、界面语言、skills 安装源目录、
 * 界面主题（暗夜/暖白）与按 Agent 隔离的扩展设置。
 *
 * 持久化：每项设置变更即写入 localStorage（Tauri WebView 的本地存储，
 * 随应用数据目录落盘），启动时读回并经类型守卫校验——损坏/越界的旧值
 * 一律回落默认，绝不带病进入状态。
 */
import { create } from "zustand";
import { hostRuntime, joinPath, type HostRuntime } from "../core/host";
import { createLogger } from "../core/logger";
import type { Language } from "../core/i18n";
import { applyUiFontSizePx, normalizeUiFontSizePx } from "../core/uiFontSize";
import {
  DEFAULT_AGENT_ID,
  agentAdapters,
  findAgentAdapter,
  customAgentIdOf,
  nativeAcpCandidates,
  parseCommandArgv,
  type CustomAgentEntry,
} from "../agents/registry.ts";

/**
 * 界面主题：暗夜（默认，深色）或暖白（米白浅色）。
 * 取值经根元素 `theme-warm` 类驱动 src/index.css 的语义 token 切换。
 */
export type ThemePreference = "dark" | "warm";

/** 主题选单（顺序即展示顺序）。 */
export const themeOptions: readonly {
  readonly value: ThemePreference;
  readonly label: string;
}[] = [
  { value: "dark", label: "暗夜" },
  { value: "warm", label: "暖白" },
];

/**
 * 会话内容宽度（消息流 / 输入卡 / 停靠坞共用，保持对齐）：
 * standard 保证正文可读行宽（默认）；wide 给表格 / diff 等宽内容更多
 * 空间；full 铺满（等宽内容最优，正文行宽换可读性）。
 */
export type ChatWidth = "standard" | "wide" | "full";

export const chatWidthOptions: readonly {
  readonly value: ChatWidth;
  readonly label: string;
}[] = [
  { value: "standard", label: "标准" },
  { value: "wide", label: "宽" },
  { value: "full", label: "全宽" },
];

/** 宽度档 → 内容列 max-w class（三处消费点共用，保证对齐）。 */
export function chatWidthClassOf(width: ChatWidth): string {
  if (width === "wide") {
    return "max-w-6xl";
  }
  if (width === "full") {
    return "max-w-none";
  }
  return "max-w-4xl";
}

const logger = createLogger("settings");

/**
 * 审批默认模式：Agent 发起 `session/request_permission` 时的客户端应答策略。
 * 按请求实际提供的标准 option kind 选择，不假定某种 Agent 的固定选项。
 */
export type ApprovalMode = "ask" | "auto-allow";

/** 审批模式选单（顺序即展示顺序）。 */
export const approvalModeOptions: readonly {
  readonly value: ApprovalMode;
  readonly label: string;
}[] = [
  { value: "ask", label: "每次询问（弹出审批对话框）" },
  { value: "auto-allow", label: "自动放行（默认允许工具调用）" },
];

/** 安装源由用户选择，不假定开发者机器上的仓库位置。 */
export const defaultSkillsSourceDir = "";

const defaultLanguage: Language = "zh-CN";
const defaultApprovalMode: ApprovalMode = "ask";
const defaultTheme: ThemePreference = "dark";
/** 问答自动应答默认关闭：自动选择有误操作风险，开启是显式决定。 */
const defaultAutoAnswerQuestions = false;
const defaultChatWidth: ChatWidth = "standard";
/** 界面字号基准默认 14px（复刻 ZCode;可调范围见 core/uiFontSize）。 */
const defaultUiFontSize = 14;

/** 自动归档天数阈值归一：非法/越界回落默认 30，下限 1（ZCode 同规则）。 */
function normalizeArchiveDays(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 30;
  }
  return Math.min(365, Math.max(1, Math.floor(value)));
}

/** 需要持久化的设置子集（连接测试状态属于运行时，不落盘）。 */
interface PersistedSettings {
  readonly agentSettings: AgentSettingsMap;
  readonly approvalMode: ApprovalMode;
  readonly language: Language;
  readonly skillsSourceDir: string;
  readonly theme: ThemePreference;
  /** 结构化提问挂起 60s 无交互自动提交首个选项（M5，默认关）。 */
  readonly autoAnswerQuestions: boolean;
  /** 会话内容宽度档（消息流 / 输入卡 / 停靠坞共用）。 */
  readonly chatWidth: ChatWidth;
  /** 界面字号基准 px（12–20,text-* 刻度随它 calc 派生）。 */
  readonly uiFontSize: number;
  readonly messageStreamShowTodos: boolean;
  /** 会话自动归档（默认关——静默归起历史会话必须由用户显式开启）。 */
  readonly sessionAutoArchiveEnabled: boolean;
  /** 自动归档的闲置天数阈值：updatedAt 早于 now−N 天的会话进归档（最小 1）。 */
  readonly sessionAutoArchiveOlderThanDays: number;
  /** 自定义 agent 条目（本机发现项不落盘，每次扫描现算）。 */
  readonly agents: readonly CustomAgentEntry[];
  /** 新会话使用的 agent（内置 / native-* / custom-*）。 */
  readonly activeAgentId: string;
}

function defaultAgentSettings(): AgentSettingsMap {
  return Object.fromEntries(
    agentAdapters.flatMap((adapter) =>
      adapter.settingsDefaults
        ? [[adapter.id, { ...adapter.settingsDefaults }]]
        : [],
    ),
  );
}
function loadAgentSettings(
  record: Readonly<Record<string, unknown>>,
): AgentSettingsMap {
  const stored = record.agentSettings;
  const result: Record<string, AgentSettingsData> = {};
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const [id, value] of Object.entries(stored)) {
      if (value && typeof value === "object" && !Array.isArray(value))
        Object.defineProperty(result, id, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }
  }
  for (const adapter of agentAdapters) {
    if (adapter.migrateSettings)
      result[adapter.id] = adapter.migrateSettings(result[adapter.id], record);
    else if (adapter.settingsDefaults)
      result[adapter.id] = {
        ...adapter.settingsDefaults,
        ...result[adapter.id],
      };
  }
  return result;
}

const defaultSettings: PersistedSettings = {
  agentSettings: defaultAgentSettings(),
  approvalMode: defaultApprovalMode,
  language: defaultLanguage,
  skillsSourceDir: defaultSkillsSourceDir,
  theme: defaultTheme,
  autoAnswerQuestions: defaultAutoAnswerQuestions,
  chatWidth: defaultChatWidth,
  uiFontSize: defaultUiFontSize,
  messageStreamShowTodos: false,
  sessionAutoArchiveEnabled: false,
  sessionAutoArchiveOlderThanDays: 30,
  agents: [],
  activeAgentId: DEFAULT_AGENT_ID,
};

const storageKey = "aaw-desktop.settings.v1";

function isApprovalMode(value: unknown): value is ApprovalMode {
  // 旧值 "auto-reject"（自动拒绝，已下线的危险选项）一律按未设置回落 ask
  return value === "ask" || value === "auto-allow";
}

function isLanguage(value: unknown): value is Language {
  return value === "zh-CN" || value === "en-US";
}

function isTheme(value: unknown): value is ThemePreference {
  return value === "dark" || value === "warm";
}

function isChatWidth(value: unknown): value is ChatWidth {
  return value === "standard" || value === "wide" || value === "full";
}

function isUiFontSize(value: unknown): value is number {
  return typeof value === "number";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 自定义 agent 条目的逐项守卫（坏条目单独丢弃，不整体回落）。 */
function asCustomAgents(raw: unknown): readonly CustomAgentEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomAgentEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Readonly<Record<string, unknown>>;
    const id = record["id"];
    const name = record["name"];
    const command = record["command"];
    if (
      typeof id !== "string" ||
      typeof name !== "string" ||
      !Array.isArray(command) ||
      command.length === 0 ||
      !command.every((part) => typeof part === "string" && part.length > 0)
    ) {
      continue;
    }
    out.push({ id, name, command });
  }
  return out;
}

/** activeAgentId 守卫：必须能被解析（内置 / native 候选 / 仍在的自定义项）。 */
function isValidAgentId(
  value: unknown,
  agents: readonly CustomAgentEntry[],
): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value === DEFAULT_AGENT_ID) return true;
  if (nativeAcpCandidates.some((item) => item.id === value)) return true;
  return agents.some((item) => item.id === value);
}

/** 读取持久化设置：解析失败或字段非法时逐项回落默认。 */
function loadPersistedSettings(): PersistedSettings {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === null) {
      return defaultSettings;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return defaultSettings;
    }
    const record = parsed as Readonly<Record<string, unknown>>;
    let language = isLanguage(record["language"])
      ? record["language"]
      : defaultSettings.language;
    if (language === "en-US") {
      // 英文是已下线的预留选项（i18n 选单不再暴露）：旧持久化值启动即
      // 回落中文并记日志，避免用户停留在半成品英文界面
      logger.warn("持久化语言为已下线的 en-US 预留项，回落 zh-CN");
      language = defaultLanguage;
    }
    return {
      agentSettings: loadAgentSettings(record),
      approvalMode: isApprovalMode(record["approvalMode"])
        ? record["approvalMode"]
        : defaultSettings.approvalMode,
      language,
      skillsSourceDir: isNonEmptyString(record["skillsSourceDir"])
        ? record["skillsSourceDir"]
        : defaultSettings.skillsSourceDir,
      theme: isTheme(record["theme"]) ? record["theme"] : defaultSettings.theme,
      autoAnswerQuestions:
        typeof record["autoAnswerQuestions"] === "boolean"
          ? record["autoAnswerQuestions"]
          : defaultSettings.autoAnswerQuestions,
      chatWidth: isChatWidth(record["chatWidth"])
        ? record["chatWidth"]
        : defaultSettings.chatWidth,
      uiFontSize: isUiFontSize(record["uiFontSize"])
        ? normalizeUiFontSizePx(record["uiFontSize"])
        : defaultSettings.uiFontSize,
      messageStreamShowTodos:
        typeof record["messageStreamShowTodos"] === "boolean"
          ? record["messageStreamShowTodos"]
          : false,
      sessionAutoArchiveEnabled:
        typeof record["sessionAutoArchiveEnabled"] === "boolean"
          ? record["sessionAutoArchiveEnabled"]
          : defaultSettings.sessionAutoArchiveEnabled,
      sessionAutoArchiveOlderThanDays: normalizeArchiveDays(
        record["sessionAutoArchiveOlderThanDays"],
      ),
      agents: asCustomAgents(record["agents"]),
      activeAgentId: isValidAgentId(
        record["activeAgentId"],
        asCustomAgents(record["agents"]),
      )
        ? record["activeAgentId"]
        : defaultSettings.activeAgentId,
    };
  } catch (error) {
    logger.warn("读取持久化设置失败，使用默认值", {
      error: error instanceof Error ? error.message : String(error),
    });
    return defaultSettings;
  }
}

function persistSettings(settings: PersistedSettings): void {
  try {
    let previous: Record<string, unknown> = {};
    try {
      const raw: unknown = JSON.parse(
        window.localStorage.getItem(storageKey) ?? "{}",
      );
      if (raw && typeof raw === "object" && !Array.isArray(raw))
        previous = raw as Record<string, unknown>;
    } catch {
      /* A corrupt previous document must not prevent saving valid settings. */
    }
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({ ...previous, ...settings }),
    );
  } catch (error) {
    // 持久化失败不阻断设置生效，仅记录（如隐私模式下的配额限制）
    logger.warn("写入持久化设置失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ------------------------------------------------------------- 路径自动探测

/** 路径的目录部分（兼容 / 与 \）。 */
function dirOf(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * 解析原生 CLI 的「可直接 spawn 的真 exe」：Windows 上 npm 全局安装的
 * PATH 命中是无扩展名 sh shim / .cmd（CreateProcess 与 Node spawn 都拉
 * 不起），真 exe 在 `<where 目录>/node_modules/<pkg>/bin/` 下。优先取
 * where 输出里现成的 .exe 行，其次按 npm 布局探测。解析不到返回空对象
 * （调用方回落命令名，类 Unix 环境本就能直接 spawn）。
 */
async function resolveNativeExe(
  host: HostRuntime,
  candidate: { readonly program: string; readonly npmPackage?: string },
  whereLines: readonly string[],
): Promise<{ readonly exePath?: string }> {
  const exeLine = whereLines.find((line) =>
    line.toLowerCase().endsWith(".exe"),
  );
  if (exeLine !== undefined) return { exePath: exeLine };
  if (candidate.npmPackage === undefined) return {};
  const dirs = new Set(
    whereLines.map((line) => dirOf(line)).filter((dir) => dir.length > 0),
  );
  for (const dir of dirs) {
    const candidatePath = joinPath(
      dir,
      "node_modules",
      candidate.npmPackage,
      "bin",
      `${candidate.program}.exe`,
    );
    try {
      if (await host.pathExists(candidatePath)) {
        return { exePath: candidatePath };
      }
    } catch {
      // pathExists 失败按未命中处理
    }
  }
  return {};
}

/** 本机扫描命中的原生 ACP CLI（不持久化，每次扫描现算）。 */
export interface DiscoveredAgent {
  readonly id: string;
  readonly name: string;
  /** 扫描展示路径（where/which 的首个命中）。 */
  readonly path: string;
  /** 解析出的可直接 spawn 的真 exe（Windows npm shim 之外的）；未解析到省略。 */
  readonly exePath?: string;
}

interface SettingsStoreState extends AgentSettingsAccess {
  readonly agentSettingsState: AgentSettingsMap;
  readonly agentSettings: AgentSettingsMap;
  readonly approvalMode: ApprovalMode;
  readonly language: Language;
  readonly skillsSourceDir: string;
  readonly theme: ThemePreference;
  readonly autoAnswerQuestions: boolean;
  readonly chatWidth: ChatWidth;
  /** 界面字号基准 px（12–20）;变更即下发根元素并持久化。 */
  readonly uiFontSize: number;
  readonly messageStreamShowTodos: boolean;
  /** 会话自动归档（默认关）与闲置天数阈值（1–365）。 */
  readonly sessionAutoArchiveEnabled: boolean;
  readonly sessionAutoArchiveOlderThanDays: number;
  /** 自定义 agent 条目（持久化）。 */
  readonly agents: readonly CustomAgentEntry[];
  /** 新会话使用的 agent id。 */
  readonly activeAgentId: string;
  /** 本机扫描命中的原生 ACP CLI（内存态）。 */
  readonly discoveredAgents: readonly DiscoveredAgent[];
  readonly isScanningAgents: boolean;
  setApprovalMode: (mode: ApprovalMode) => void;
  setLanguage: (language: Language) => void;
  setSkillsSourceDir: (dir: string) => void;
  setTheme: (theme: ThemePreference) => void;
  setAutoAnswerQuestions: (enabled: boolean) => void;
  setChatWidth: (width: ChatWidth) => void;
  setUiFontSize: (px: number) => void;
  setMessageStreamShowTodos: (enabled: boolean) => void;
  /** 归档设置二合一写入（天数缺省时保持现值）。 */
  setSessionAutoArchive: (enabled: boolean, olderThanDays?: number) => void;
  /** 切换新会话使用的 agent；非法 id 忽略并记日志。 */
  setActiveAgentId: (agentId: string) => void;
  /** 添加自定义 agent（名称 + 命令行）；校验失败返回错误文案，成功返回 null。 */
  addCustomAgent: (name: string, commandText: string) => string | null;
  updateCustomAgent: (
    id: string,
    name: string,
    commandText: string,
  ) => string | null;
  removeCustomAgent: (agentId: string) => void;
  /** 扫描本机原生 ACP CLI（where/which；命中的进内存态 discoveredAgents）。 */
  scanNativeAgents: (host?: HostRuntime) => Promise<void>;
  /** 全部恢复默认值。 */
  resetToDefaults: () => void;
}

export const useSettingsStore = create<SettingsStoreState>()((set, get) => {
  /** 写入并持久化一批设置（真实 setter 与 reset 共用）。 */
  function applySettings(patch: Partial<PersistedSettings>): void {
    const next = { ...get(), ...patch };
    set(patch);
    persistSettings({
      agentSettings: next.agentSettings,
      approvalMode: next.approvalMode,
      language: next.language,
      skillsSourceDir: next.skillsSourceDir,
      theme: next.theme,
      autoAnswerQuestions: next.autoAnswerQuestions,
      chatWidth: next.chatWidth,
      uiFontSize: next.uiFontSize,
      messageStreamShowTodos: next.messageStreamShowTodos,
      sessionAutoArchiveEnabled: next.sessionAutoArchiveEnabled,
      sessionAutoArchiveOlderThanDays: next.sessionAutoArchiveOlderThanDays,
      agents: next.agents,
      activeAgentId: next.activeAgentId,
    });
  }

  return {
    ...loadPersistedSettings(),
    discoveredAgents: [],
    isScanningAgents: false,
    agentSettingsState: {},
    getAgentSettings: (id) => get().agentSettings[id] ?? {},
    setAgentSettings: (id, patch) => {
      applySettings({
        agentSettings: {
          ...get().agentSettings,
          [id]: { ...get().agentSettings[id], ...patch },
        },
      });
    },
    getAgentSettingsState: (id) => get().agentSettingsState[id] ?? {},
    setAgentSettingsState: (id, patch) => {
      set((state) => ({
        agentSettingsState: {
          ...state.agentSettingsState,
          [id]: { ...state.agentSettingsState[id], ...patch },
        },
      }));
    },
    setApprovalMode: (mode) => {
      applySettings({ approvalMode: mode });
      logger.info("审批默认模式已更新", { mode });
    },
    setLanguage: (language) => {
      applySettings({ language });
      logger.info("界面语言已更新", { language });
    },
    setSkillsSourceDir: (dir) => {
      applySettings({ skillsSourceDir: dir });
    },
    setTheme: (theme) => {
      applySettings({ theme });
      logger.info("界面主题已更新", { theme });
    },
    setAutoAnswerQuestions: (enabled) => {
      applySettings({ autoAnswerQuestions: enabled });
      logger.info("问答自动应答已更新", { enabled });
    },
    setChatWidth: (width) => {
      applySettings({ chatWidth: width });
      logger.info("会话内容宽度已更新", { width });
    },
    setMessageStreamShowTodos: (enabled) => {
      applySettings({ messageStreamShowTodos: enabled });
    },
    setSessionAutoArchive: (enabled, olderThanDays) => {
      applySettings({
        sessionAutoArchiveEnabled: enabled,
        ...(olderThanDays !== undefined
          ? {
              sessionAutoArchiveOlderThanDays:
                normalizeArchiveDays(olderThanDays),
            }
          : {}),
      });
      logger.info("会话自动归档设置已更新", {
        enabled,
        olderThanDays:
          olderThanDays !== undefined
            ? normalizeArchiveDays(olderThanDays)
            : get().sessionAutoArchiveOlderThanDays,
      });
    },
    setActiveAgentId: (agentId) => {
      if (!isValidAgentId(agentId, get().agents)) {
        logger.warn("忽略非法的 agent 选择", { agentId });
        return;
      }
      if (agentId === get().activeAgentId) return;
      applySettings({ activeAgentId: agentId });
      void findAgentAdapter(agentId)?.initializeConfiguration?.(get());
      logger.info("新会话将使用的 agent 已切换", { agentId });
    },
    addCustomAgent: (name, commandText) => {
      const trimmedName = name.trim();
      if (trimmedName === "") return "名称不能为空";
      const argv = parseCommandArgv(commandText);
      if (argv.length === 0) return "启动命令不能为空";
      const agents = get().agents;
      if (agents.some((item) => item.name === trimmedName)) {
        return "已存在同名 agent";
      }
      // id 唯一化：slug 冲突时追加序号
      const base = customAgentIdOf(trimmedName);
      let id = base;
      for (let i = 2; agents.some((item) => item.id === id); i += 1) {
        id = `${base}-${i}`;
      }
      applySettings({
        agents: [...agents, { id, name: trimmedName, command: argv }],
      });
      logger.info("已添加自定义 agent", { id, command: argv.join(" ") });
      return null;
    },
    updateCustomAgent: (id, name, commandText) => {
      const trimmedName = name.trim();
      if (!trimmedName) return "名称不能为空";
      const command = parseCommandArgv(commandText);
      if (command.length === 0) return "启动命令不能为空";
      const agents = get().agents;
      if (!agents.some((item) => item.id === id)) return "Agent 不存在";
      if (agents.some((item) => item.id !== id && item.name === trimmedName))
        return "已存在同名 agent";
      applySettings({
        agents: agents.map((item) =>
          item.id === id ? { ...item, name: trimmedName, command } : item,
        ),
      });
      return null;
    },
    removeCustomAgent: (agentId) => {
      const agents = get().agents;
      if (!agents.some((item) => item.id === agentId)) return;
      // 被删的是当前选中项：回落默认 agent，不悬空
      const wasActive = get().activeAgentId === agentId;
      applySettings({
        agents: agents.filter((item) => item.id !== agentId),
        ...(wasActive ? { activeAgentId: defaultSettings.activeAgentId } : {}),
      });
      logger.info("已移除自定义 agent", { agentId });
    },
    scanNativeAgents: async (host = hostRuntime) => {
      if (get().isScanningAgents) return;
      set({ isScanningAgents: true });
      try {
        const found: DiscoveredAgent[] = [];
        for (const candidate of nativeAcpCandidates) {
          for (const lookup of ["where", "which"]) {
            try {
              const result = await host.runCommand(lookup, [candidate.program]);
              if (result.code !== 0) continue;
              const lines = result.stdout
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter((line) => line.length > 0);
              const first = lines[0];
              if (first === undefined) continue;
              found.push({
                id: candidate.id,
                name: candidate.name,
                path: first,
                ...(await resolveNativeExe(host, candidate, lines)),
              });
              break;
            } catch {
              // 该查找命令不存在 / 宿主不支持：继续
            }
          }
        }
        set({ discoveredAgents: found });
        logger.info("本机原生 ACP CLI 扫描完成", {
          found: found.map(
            (item) =>
              `${item.id}${item.exePath === undefined ? "" : "（已解析 exe）"}`,
          ),
        });
      } finally {
        set({ isScanningAgents: false });
      }
    },
    setUiFontSize: (px) => {
      const uiFontSize = normalizeUiFontSizePx(px);
      applySettings({ uiFontSize });
      applyUiFontSizePx(uiFontSize);
      logger.info("界面字号已更新", { uiFontSize });
    },
    resetToDefaults: () => {
      applySettings({
        ...defaultSettings,
        agentSettings: defaultAgentSettings(),
      });
      set({ agentSettingsState: {} });
      logger.info("设置已恢复默认值");
    },
  };
});

// Only the selected adapter may initialize its executable configuration.
void findAgentAdapter(
  useSettingsStore.getState().activeAgentId,
)?.initializeConfiguration?.(useSettingsStore.getState());
// 启动即应用持久化的界面字号基准（--ui-font-size）,全站 text-* 刻度联动。
applyUiFontSizePx(useSettingsStore.getState().uiFontSize);
