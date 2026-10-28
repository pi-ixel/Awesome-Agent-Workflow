/**
 * 设置 store（src/stores）：iCode（原 chrys）路径、审批默认模式、界面语言、
 * skills 安装源目录、界面主题（暗夜/暖白），以及「测试连接」状态。
 *
 * 持久化：每项设置变更即写入 localStorage（Tauri WebView 的本地存储，
 * 随应用数据目录落盘），启动时读回并经类型守卫校验——损坏/越界的旧值
 * 一律回落默认，绝不带病进入状态。
 */
import { create } from "zustand";
import {
  hostRuntime,
  joinPath,
  type CommandResult,
  type HostRuntime,
} from "../core/host";
import { createLogger } from "../core/logger";
import type { Language } from "../core/i18n";

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
 * 审批默认模式：chrys 发起 `session/request_permission` 反向请求时，
 * 客户端的默认应答策略（协议形状见 src/acp/types.ts 的
 * RequestPermissionRequestParams；选项 kind 见 chrys server.py
 * _request_permission，当前只提供 allow_once / reject_once）。
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

/**
 * iCode（原 chrys）可执行路径默认值：留空（不硬编码开发者本机路径）。启动时若
 * 为空会异步探测（PATH 查找与常见安装位置，见 probeChrysPath）；探测不到
 * 保持为空，设置页提示手动指定。已有用户持久化值不受影响。
 */
export const defaultChrysPath = "";

/**
 * 探测的命令名与顺序：iCode 0.30 起只安装 `icode` 命令，旧版装的是
 * `chrys`——先找新名，找不到再回落旧名，两种安装都能命中。
 */
const PROBE_PROGRAM_NAMES: readonly string[] = ["icode", "chrys"];

/** 探测不到 PATH 时依次尝试的常见安装位置（存在即采纳；新名在前）。 */
const CHRYS_FALLBACK_CANDIDATES: readonly string[] = [
  "C:/Program Files/Chrys/icode.exe",
  "C:/Program Files (x86)/Chrys/icode.exe",
  "D:/Program Files/Chrys/icode.exe",
  "C:/Program Files/Chrys/chrys.exe",
  "C:/Program Files (x86)/Chrys/chrys.exe",
  "D:/Program Files/Chrys/chrys.exe",
];

/** 安装源由用户选择，不假定开发者机器上的仓库位置。 */
export const defaultSkillsSourceDir = "";

const defaultLanguage: Language = "zh-CN";
const defaultApprovalMode: ApprovalMode = "ask";
const defaultTheme: ThemePreference = "dark";
/** 问答自动应答默认关闭：自动选择有误操作风险，开启是显式决定。 */
const defaultAutoAnswerQuestions = false;
const defaultChatWidth: ChatWidth = "standard";

/** 需要持久化的设置子集（连接测试状态属于运行时，不落盘）。 */
interface PersistedSettings {
  readonly chrysPath: string;
  readonly approvalMode: ApprovalMode;
  readonly language: Language;
  readonly skillsSourceDir: string;
  readonly theme: ThemePreference;
  /** 结构化提问挂起 60s 无交互自动提交首个选项（M5，默认关）。 */
  readonly autoAnswerQuestions: boolean;
  /** 会话内容宽度档（消息流 / 输入卡 / 停靠坞共用）。 */
  readonly chatWidth: ChatWidth;
}

const defaultSettings: PersistedSettings = {
  chrysPath: defaultChrysPath,
  approvalMode: defaultApprovalMode,
  language: defaultLanguage,
  skillsSourceDir: defaultSkillsSourceDir,
  theme: defaultTheme,
  autoAnswerQuestions: defaultAutoAnswerQuestions,
  chatWidth: defaultChatWidth,
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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
      // 裸命令名 "chrys" 是改名前的旧值（iCode 0.30 起命令叫 icode）：清空
      // 以触发启动探测重新找 icode；绝对路径不受影响——老安装的 chrys.exe
      // 仍可用，探测也保留了对旧名的回落
      chrysPath:
        isNonEmptyString(record["chrysPath"]) && record["chrysPath"] !== "chrys"
          ? record["chrysPath"]
          : defaultSettings.chrysPath,
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
    window.localStorage.setItem(storageKey, JSON.stringify(settings));
  } catch (error) {
    // 持久化失败不阻断设置生效，仅记录（如隐私模式下的配额限制）
    logger.warn("写入持久化设置失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ------------------------------------------------------------- 路径自动探测

/** 取命令输出里的首个非空行（PATH 查找结果的第一条路径）。 */
function firstOutputLine(stdout: string): string | null {
  const line = stdout
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? null;
}

/**
 * 异步探测 iCode（原 chrys）可执行路径：先在 PATH 里找（Windows 的 where
 * 与类 Unix 的 which 各试一次，spawn 失败按未命中处理；命令名先 icode 后
 * chrys，覆盖新旧两种安装），再回落常见安装位置与用户级 chrys 目录。
 * 找到返回绝对路径，探测不到返回 null。宿主可注入（测试用内存宿主布置
 * 现场）。
 */
export async function probeChrysPath(
  host: HostRuntime = hostRuntime,
): Promise<string | null> {
  // 用户级新安装位置优先，避免 PATH 仍指向迁移前的旧程序。
  try {
    const home = await host.homeDir?.();
    if (home) {
      for (const name of ["icode.exe", "icode"]) {
        const candidate = joinPath(home, ".local", "bin", name);
        if (await host.pathExists(candidate)) {
          const result = await host.runCommand(candidate, ["--version"]);
          if (result.code === 0) return candidate;
        }
      }
    }
  } catch {
    // 旧宿主或用户级安装不可用，继续 PATH 探测。
  }
  // PATH 查找：where / which 谁可用用谁（失败一律继续，不猜测平台）
  for (const program of PROBE_PROGRAM_NAMES) {
    for (const lookup of ["where", "which"]) {
      try {
        const result = await host.runCommand(lookup, [program]);
        if (result.code === 0) {
          const found = firstOutputLine(result.stdout);
          if (found !== null) {
            return found;
          }
        }
      } catch {
        // 该查找命令不存在 / 宿主不支持：继续下一个探测手段
      }
    }
  }
  // 常见安装位置
  for (const candidate of CHRYS_FALLBACK_CANDIDATES) {
    try {
      if (await host.pathExists(candidate)) {
        return candidate;
      }
    } catch {
      // pathExists 失败按未命中处理
    }
  }
  // 用户级 chrys 目录下的可执行（%APPDATA%/chrys/icode.exe 等；目录名
  // 保持 chrys 是上游约定——包名与配置目录不随品牌改名）
  try {
    const skillsDir = await host.chrysSkillsDir();
    for (const name of PROBE_PROGRAM_NAMES) {
      const candidate = joinPath(skillsDir, "..", `${name}.exe`);
      if (await host.pathExists(candidate)) {
        return candidate;
      }
    }
  } catch {
    // 宿主不支持：忽略
  }
  return null;
}

/** 「测试连接」的运行时状态。 */
export interface ConnectionStatus {
  readonly status: "idle" | "testing" | "ok" | "error";
  readonly message: string;
  /** 最近一次成功/失败检测的 ISO 时间戳；未检测过为 null。 */
  readonly checkedAt: string | null;
}

interface SettingsStoreState {
  readonly chrysPath: string;
  readonly approvalMode: ApprovalMode;
  readonly language: Language;
  readonly skillsSourceDir: string;
  readonly theme: ThemePreference;
  readonly autoAnswerQuestions: boolean;
  readonly chatWidth: ChatWidth;
  readonly connection: ConnectionStatus;
  /** chrys 路径自动探测进行中（启动时路径为空才触发一次）。 */
  readonly isProbingChrysPath: boolean;
  setChrysPath: (path: string) => void;
  setApprovalMode: (mode: ApprovalMode) => void;
  setLanguage: (language: Language) => void;
  setSkillsSourceDir: (dir: string) => void;
  setTheme: (theme: ThemePreference) => void;
  setAutoAnswerQuestions: (enabled: boolean) => void;
  setChatWidth: (width: ChatWidth) => void;
  /** 执行 `<chrysPath> --version` 验证路径可用性。 */
  testConnection: () => Promise<void>;
  /** 路径为空时的启动探测（PATH 与常见安装位置；只探一次）。 */
  probeChrysPathIfNeeded: (force?: boolean) => Promise<void>;
  /** 全部恢复默认值。 */
  resetToDefaults: () => void;
}

export const useSettingsStore = create<SettingsStoreState>()((set, get) => {
  /** 应用一次命令结果：testConnection 的归约器。 */
  function applyConnectionResult(result: CommandResult): void {
    const next: ConnectionStatus =
      result.code === 0
        ? {
            status: "ok",
            message:
              result.stdout.trim().length > 0
                ? `可用（版本 ${result.stdout.trim()}）`
                : "可用（无版本输出）",
            checkedAt: new Date().toISOString(),
          }
        : {
            status: "error",
            message:
              result.stderr.trim().length > 0
                ? result.stderr.trim()
                : `命令以退出码 ${result.code} 结束`,
            checkedAt: new Date().toISOString(),
          };
    logger.info("iCode 连接检测完成", {
      code: result.code,
      ok: next.status === "ok",
    });
    set({ connection: next });
  }

  /** 写入并持久化一批设置（真实 setter 与 reset 共用）。 */
  function applySettings(patch: Partial<PersistedSettings>): void {
    const next = { ...get(), ...patch };
    set(patch);
    persistSettings({
      chrysPath: next.chrysPath,
      approvalMode: next.approvalMode,
      language: next.language,
      skillsSourceDir: next.skillsSourceDir,
      theme: next.theme,
      autoAnswerQuestions: next.autoAnswerQuestions,
      chatWidth: next.chatWidth,
    });
  }

  return {
    ...loadPersistedSettings(),
    connection: {
      status: "idle",
      message: "尚未检测",
      checkedAt: null,
    },
    isProbingChrysPath: false,
    setChrysPath: (path) => {
      applySettings({ chrysPath: path });
      // 路径变更后，旧检测结果不再有效
      set({
        connection: {
          status: "idle",
          message: "路径已变更，请重新检测",
          checkedAt: null,
        },
      });
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
    testConnection: async () => {
      const program = get().chrysPath;
      if (program.trim() === "") {
        // 空路径（未配置且未探测到）：直接失败收口，不执行空命令
        set({
          connection: {
            status: "error",
            message:
              "未配置 iCode 可执行路径，请手动填写或重新打开应用自动探测",
            checkedAt: new Date().toISOString(),
          },
        });
        return;
      }
      set({
        connection: {
          status: "testing",
          message: `正在执行 ${program} --version …`,
          checkedAt: null,
        },
      });
      logger.info("测试 iCode 连接", { program });
      let result: CommandResult;
      try {
        result = await hostRuntime.runCommand(program, ["--version"]);
      } catch (error) {
        result = {
          code: -1,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
      applyConnectionResult(result);
    },
    probeChrysPathIfNeeded: async (force = false) => {
      const previousPath = get().chrysPath;
      if ((!force && previousPath.trim() !== "") || get().isProbingChrysPath) {
        // 已有路径（含用户持久化值）或在探测中：不覆盖
        return;
      }
      set({ isProbingChrysPath: true });
      try {
        const found = await probeChrysPath();
        if (found !== null && get().chrysPath === previousPath) {
          // 探测结果写入并持久化（用户在探测期间手动填写的值不覆盖）
          applySettings({ chrysPath: found });
          logger.info("已自动探测到 iCode 路径", { chrysPath: found });
        } else if (found === null) {
          logger.warn(
            "未在 PATH 与常见位置找到 iCode（icode/chrys），请在设置中手动指定路径",
          );
        }
      } finally {
        set({ isProbingChrysPath: false });
      }
    },
    resetToDefaults: () => {
      applySettings({ ...defaultSettings });
      logger.info("设置已恢复默认值");
    },
  };
});

// 启动即探测：路径为空（默认空值 / 未配置）时异步找一次 chrys（PATH 与
// 常见安装位置），探测到即写入并持久化，探测不到保持为空——设置页会
// 提示手动指定。已有用户持久化值不受影响（probeChrysPathIfNeeded 直通）。
void useSettingsStore.getState().probeChrysPathIfNeeded();
