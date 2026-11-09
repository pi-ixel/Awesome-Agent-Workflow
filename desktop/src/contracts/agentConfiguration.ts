/** Optional executable editor supplied by an adapter. */
export interface AgentExecutableConfiguration {
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
  readonly probing: boolean;
  readonly detectedPath?: string;
  readonly error?: string;
  readonly setValue: (value: string) => void;
  readonly probe: () => Promise<void>;
}

/** Opaque per-Agent configuration; only its adapter interprets the values. */
export type AgentSettingsData = Readonly<Record<string, unknown>>;
export type AgentSettingsMap = Readonly<Record<string, AgentSettingsData>>;
export interface AgentSettingsAccess {
  getAgentSettings(id: string): AgentSettingsData;
  setAgentSettings(id: string, patch: AgentSettingsData): void;
  getAgentSettingsState(id: string): AgentSettingsData;
  setAgentSettingsState(id: string, patch: AgentSettingsData): void;
}

export interface CustomAgentEntry {
  readonly id: string;
  readonly name: string;
  /** 完整 argv（含程序与子命令，如 ["opencode", "acp"]）。 */
  readonly command: readonly string[];
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

export interface AgentPreferences {
  readonly agentSettings: AgentSettingsMap;
  readonly agents: readonly CustomAgentEntry[];
  readonly activeAgentId: string;
}

export interface AgentConfigurationState
  extends AgentPreferences, AgentSettingsAccess {
  readonly agentSettingsState: AgentSettingsMap;
  readonly discoveredAgents: readonly DiscoveredAgent[];
  readonly isScanningAgents: boolean;
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
  resetToDefaults: () => void;
}
