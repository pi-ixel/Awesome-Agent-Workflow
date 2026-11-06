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
