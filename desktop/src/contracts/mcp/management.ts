export interface McpProfile {
  readonly id: string | null;
  readonly name: string;
}

export interface NativeMcpEntry {
  readonly name: string;
  readonly id?: string;
  readonly source?: string;
  readonly readOnly?: boolean;
  readonly effective?: boolean;
  readonly description?: string;
  readonly connectionRevision?: string;
  readonly redactedConfig?: Readonly<Record<string, unknown>>;
  readonly transport: string;
  readonly enabled: boolean;
  readonly url: string | null;
  readonly command: string | null;
  readonly cwd: string | null;
  readonly argsCount: number;
  readonly secretKeys: readonly string[];
}

export interface NativeMcpSnapshot {
  readonly revision: string;
  readonly warnings?: readonly string[];
  readonly entries: readonly NativeMcpEntry[];
}

export interface LocalMcpProfile {
  readonly profile: McpProfile;
  readonly snapshot: NativeMcpSnapshot;
}

export interface NativeMcpDraft {
  readonly name: string;
  readonly transport: "stdio" | "http";
  readonly url?: string;
  readonly command?: string;
  readonly cwd?: string;
  readonly args?: readonly string[];
  readonly secretChanges: Readonly<Record<string, string | null>>;
}

export type McpChange<T> =
  | {
      readonly kind: "save";
      readonly previousName: string | null;
      readonly draft: T;
    }
  | {
      readonly kind: "toggle";
      readonly name: string;
      readonly enabled: boolean;
    }
  | { readonly kind: "remove"; readonly name: string };

export interface McpCredentialReference {
  readonly name: string;
  readonly source: "environment" | "system";
  readonly reference: string;
  readonly prefix: string;
}

/** 可供市场、导入及同步使用的配置描述。凭据字段只允许引用。 */
export interface ManagedMcpDefinition {
  readonly name: string;
  readonly description?: string;
  readonly transport: "http";
  readonly url: string;
  readonly headers: readonly McpCredentialReference[];
}

export interface ManagedMcpEntry extends ManagedMcpDefinition {
  readonly enabled: boolean;
  readonly connectionRevision?: string;
  readonly disabledTools?: readonly string[];
}

export interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly readOnly?: boolean;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
}

export interface McpInspection {
  readonly ok: boolean;
  readonly message: string;
  readonly checkedAt: number;
  readonly durationMs: number;
  readonly tools?: readonly McpTool[];
}

export interface ManagedMcpSnapshot {
  readonly revision: string;
  readonly entries: readonly ManagedMcpEntry[];
}

export interface McpHttpConfig {
  readonly name: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly options?: Readonly<Record<string, unknown>>;
}

export type McpTestTarget =
  | {
      readonly source: "native";
      readonly profile: McpProfile;
      readonly previousName: string | null;
      readonly entryId?: string;
      readonly entryRevision?: string;
      readonly workspace?: string;
      readonly revision: string;
      readonly draft: NativeMcpDraft;
    }
  | {
      readonly source: "managed";
      readonly draft: ManagedMcpDefinition;
    };

/** 导入、同步及安装预览以配置版本为基准，提交时仍走同一保存操作。 */
export interface McpImportPlan {
  readonly agentId: string;
  readonly revision: string;
  readonly definitions: readonly ManagedMcpDefinition[];
  readonly accepted: readonly string[];
  readonly skipped: McpInstallResult["skipped"];
}

export interface McpInstallResult {
  readonly applied: readonly string[];
  readonly skipped: readonly {
    readonly name: string;
    readonly reason: string;
  }[];
}

export interface NativeMcpHost {
  read(
    profile: McpProfile,
    workspace?: string,
  ): Promise<NativeMcpSnapshot | null>;
  readLocal(
    selector: string,
    workspace?: string,
  ): Promise<LocalMcpProfile | null>;
  change(
    profile: McpProfile,
    revision: string,
    change: McpChange<NativeMcpDraft>,
  ): Promise<string>;
  inspect?(
    target: Extract<McpTestTarget, { source: "native" }>,
    program: string,
  ): Promise<McpInspection>;
  sessionProfile(sessionId: string): Promise<string | null>;
  testConfig(
    target: Extract<McpTestTarget, { source: "native" }>,
  ): Promise<McpHttpConfig>;
}

export interface McpManagementHost {
  native(provider: string): NativeMcpHost;
  managedRead(agentId: string): Promise<ManagedMcpSnapshot>;
  managedChange(
    agentId: string,
    revision: string,
    change: McpChange<ManagedMcpDefinition>,
  ): Promise<string>;
  previewInstall(
    agentId: string,
    definitions: readonly ManagedMcpDefinition[],
    excluded: readonly string[],
  ): Promise<McpImportPlan>;
  commitInstall(
    plan: McpImportPlan,
    excluded: readonly string[],
  ): Promise<McpInstallResult>;
  managedResolve(
    agentId: string,
    excluded: readonly string[],
    generation: string,
  ): Promise<{
    readonly revision: string;
    readonly servers: readonly McpHttpConfig[];
    readonly skipped: readonly {
      readonly name: string;
      readonly reason: string;
    }[];
  }>;
  retireManaged?(generation: string): Promise<void>;
  inspection?: {
    read(
      keys: readonly string[],
    ): Promise<Readonly<Record<string, McpInspection>>>;
    save(key: string, result: McpInspection): Promise<void>;
    probe(draft: ManagedMcpDefinition): Promise<McpInspection>;
    browserTools(): Promise<{
      tools: readonly McpTool[];
      disabledTools: readonly string[];
    }>;
    probeBrowser(): Promise<McpInspection>;
    setBrowserTools(
      tools: readonly string[],
      enabled: boolean,
    ): Promise<readonly string[]>;
    setManagedTools(
      agentId: string,
      name: string,
      revision: string,
      tools: readonly string[],
      enabled: boolean,
    ): Promise<string>;
  };
  testConfig(
    target: Extract<McpTestTarget, { source: "managed" }>,
  ): Promise<McpHttpConfig>;
}

export interface AgentExtensionClient {
  readonly capabilities: Readonly<Record<string, unknown>>;
  request(
    method: string,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}

export interface NativeMcpManagement {
  readonly defaultProfile: string;
  readonly scoped?: boolean;
  readonly hostInspection?: boolean;
  readonly processConfig?: {
    readonly revision: () => number;
    readonly changed: () => void;
  };
  readonly editableTransports: readonly NativeMcpDraft["transport"][];
  nativeHost(host: McpManagementHost): NativeMcpHost;
}

export interface AgentMcpManagement {
  readonly native?: NativeMcpManagement;
  readonly injection?: {
    supportsHttp(capabilities: Readonly<Record<string, unknown>>): boolean;
    nativeNames?(context: {
      readonly host: McpManagementHost;
      readonly client: AgentExtensionClient | undefined;
      readonly sessionId: string | null;
      readonly workspacePath: string;
    }): Promise<readonly string[]>;
  };
  readonly testHttp?: (
    client: AgentExtensionClient,
    server: McpHttpConfig,
  ) => Promise<{ readonly ok: boolean; readonly message: string }>;
}
