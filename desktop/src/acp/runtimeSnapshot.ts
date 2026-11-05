/** MCP 服务器条目（名字 + 工具数）。 */
export interface McpServerEntry {
  readonly name: string;
  readonly toolCount: number;
}

/** runtime 合并快照：输入区状态行与悬停明细的数据源。 */
export interface RuntimeSnapshot {
  readonly agentProfile: string | null;
  readonly displayName: string | null;
  readonly modelProfileId: string | null;
  /** runtimeDetails.model.name（比 profile id 友好；缺失回落 profile id）。 */
  readonly modelName: string | null;
  readonly modelProvider: string | null;
  readonly maxContextTokens: number | null;
  readonly skillInvocations?: Readonly<Record<string, string>>;
  readonly skillNames: readonly string[];
  readonly toolNames: readonly string[];
  readonly skillSources: readonly { source: string; count: number }[];
  readonly mcpServers: readonly McpServerEntry[];
  readonly mcpFailures: readonly {
    readonly name: string;
    readonly error: string;
  }[];
}
