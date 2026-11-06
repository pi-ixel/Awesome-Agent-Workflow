import type { AgentSettingsData } from "../core/agentConfiguration.ts";
import type { AgentExecutableConfiguration } from "../core/agentConfiguration.ts";
import type { SkillInstallation } from "../core/skillInstallation.ts";
import type { AcpDialect, AcpSessionEvent } from "../acp/session.ts";
import type { HostRuntime } from "../core/host.ts";
import type { AgentQuestion, AgentQuestionResult } from "../acp/types.ts";

export type QuestionResponder = (
  sessionId: string,
  requestId: string,
  questions: readonly AgentQuestion[],
  callerName: string | null,
) => Promise<AgentQuestionResult | null>;

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

/** 组装层传给 createDialect 的运行时回调（UI 挂起 → 用户决策 → 回传）。 */
export interface AgentDialectHooks {
  /** 结构化提问回调。 */
  readonly onQuestion?: QuestionResponder;
}

export interface AgentAdapter {
  /** Optional force-stop grace after a user cancellation. Omitted means no timer. */
  readonly cancellationGraceMs?: number;
  readonly settingsDefaults?: AgentSettingsData;
  readonly migrateSettings?: (
    stored: AgentSettingsData | undefined,
    legacy: Readonly<Record<string, unknown>>,
  ) => AgentSettingsData;
  /** Optional initialization of this Agent's executable configuration. */
  readonly initializeConfiguration?: (settings: object) => Promise<void>;
  readonly executableConfiguration?: (
    settings: object,
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
  /** initialize 握手的客户端标识（AcpSession clientInfo）。 */
  readonly clientInfo: { readonly name: string; readonly version?: string };
  /**
   * 创建方言挂接（私有通知翻译 + 私有反向请求处理，注入 AcpSession）。
   * 纯标准 ACP agent 可省略——协议层对未知消息已有兜底透传。
   */
  readonly createDialect?: (hooks: AgentDialectHooks) => AcpDialect;
  /** 可选的 agent 专属压缩历史读取器。 */
  readonly readArchive?: (
    host: HostRuntime,
    sessionId: string,
    cwd: string,
  ) => Promise<AcpSessionEvent[]>;
  /** 方言注记（扩展通知 / 反向请求名等，供诊断与人读）。 */
  readonly normalizePermission?: (
    toolCall: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>>;
  readonly notes: readonly string[];
}
