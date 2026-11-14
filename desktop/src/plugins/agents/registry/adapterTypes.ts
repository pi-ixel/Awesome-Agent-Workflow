import type { AcpDialect, AgentDialectHooks } from "../../acpRuntime/types.ts";
import type { AcpSessionEvent } from "../../acpRuntime/events.ts";
import type { AgentSettingsData } from "../configuration/types.ts";
import type { AgentExecutableConfiguration } from "../configuration/types.ts";
import type { SkillInstallation } from "../../skills/types.ts";
import type { HostAgentCommands, HostCommands } from "../../host/types.ts";
import type { HostArchiveFiles } from "../../host/types.ts";
import type { LoggerFactory } from "../../../shared/logging/logger.ts";

/** 一次 agent 启动的完整描述（transport 工厂的入参形状）。 */
export interface AgentLaunch {
  /** 完整 argv，如 ["C:/path/icode.exe", "acp"]。 */
  readonly command: readonly string[];
  /** 工作目录；null 表示继承宿主。 */
  readonly cwd: string | null;
  /** 追加的环境变量（与宿主环境合并）。 */
  readonly extraEnv: Readonly<Record<string, string>>;
}

/** buildLaunch 的入参。 */
export interface AgentLaunchContext {
  /** 会话工作区目录（通过 session/new 的 cwd 参数传入）。 */
  readonly workspacePath: string | null;
  /** agent 可执行文件路径；缺省回退 PATH 查找（command 名语义）。 */
  readonly executablePath?: string;
}

export interface AgentConfigurationContext {
  readonly commands: HostAgentCommands;
  readonly signal: AbortSignal;
  readonly createLogger?: LoggerFactory;
}

export interface AgentAdapter {
  /** Canonical identity for reporting only; never changes ACP model IDs. */
  readonly usageModelId?: (model: string) => string;
  /** Whether prompt-result totals define the displayed context usage. */
  readonly promptUsageBasis?: "prompt-total";
  /** Record prompt totals while retaining the independently reported context. */
  readonly turnUsageBasis?: "prompt-total";
  /** Optional storage prefix for reported session counters. */
  readonly sessionUsageCachePrefix?: string;
  /** Scope of the counters returned in a prompt response. */
  readonly promptUsage?: {
    readonly accounting: "turn" | "turn-delta";
  };
  /** Shared per-connection budget for list/new/load/prompt; not a session limit. */
  readonly maxConcurrentRequests?: number;
  /** Optional force-stop grace after a user cancellation. Omitted means no timer. */
  readonly cancellationGraceMs?: number;
  readonly settingsDefaults?: AgentSettingsData;
  readonly migrateSettings?: (
    stored: AgentSettingsData | undefined,
    legacy: Readonly<Record<string, unknown>>,
  ) => AgentSettingsData;
  /** Optional initialization of this Agent's executable configuration. */
  readonly initializeConfiguration?: (
    settings: object,
    context: AgentConfigurationContext,
  ) => Promise<void>;
  readonly executableConfiguration?: (
    settings: object,
    context: AgentConfigurationContext,
  ) => AgentExecutableConfiguration;
  readonly configuredExecutable?: (
    settings: object,
    toolPaths: object,
  ) => string | undefined;
  readonly skillInstallation?: SkillInstallation;
  /** 稳定标识（日志与设置引用）。 */
  readonly id: string;
  /** 展示名（界面与日志）。 */
  readonly displayName: string;
  /** 产出启动描述。 */
  buildLaunch(context: AgentLaunchContext): AgentLaunch;
  /** 可选的异步启动校验/归一化，不改写用户配置或连接身份。 */
  readonly prepareLaunch?: (
    launch: AgentLaunch,
    commands: HostCommands,
    signal?: AbortSignal,
  ) => Promise<AgentLaunch>;
  /** initialize 握手的客户端标识（AcpSession clientInfo）。 */
  readonly clientInfo: { readonly name: string; readonly version?: string };
  /**
   * 创建方言挂接（私有通知翻译 + 私有反向请求处理，注入 AcpSession）。
   * 纯标准 ACP agent 可省略——协议层对未知消息已有兜底透传。
   */
  readonly createDialect?: (hooks: AgentDialectHooks) => AcpDialect;
  /** 可选的 agent 专属压缩历史读取器。 */
  readonly readArchive?: (
    host: HostArchiveFiles,
    sessionId: string,
    cwd: string,
  ) => Promise<AcpSessionEvent[]>;
  /** 方言注记（扩展通知 / 反向请求名等，供诊断与人读）。 */
  readonly normalizePermission?: (
    toolCall: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>>;
  readonly notes: readonly string[];
}
