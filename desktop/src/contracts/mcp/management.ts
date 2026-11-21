export interface McpProfile {
  readonly id: string | null;
  readonly name: string;
}

export interface NativeMcpEntry {
  readonly name: string;
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
  readonly transport: "http";
  readonly url: string;
  readonly headers: readonly McpCredentialReference[];
}

export interface ManagedMcpEntry extends ManagedMcpDefinition {
  readonly enabled: boolean;
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
      readonly previousName: string;
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
  read(profile: McpProfile): Promise<NativeMcpSnapshot | null>;
  readLocal(selector: string): Promise<LocalMcpProfile | null>;
  change(
    profile: McpProfile,
    revision: string,
    change: McpChange<NativeMcpDraft>,
  ): Promise<void>;
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
  ): Promise<void>;
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
  ): Promise<{
    readonly revision: string;
    readonly servers: readonly McpHttpConfig[];
    readonly skipped: readonly {
      readonly name: string;
      readonly reason: string;
    }[];
  }>;
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
    }): Promise<readonly string[]>;
  };
  readonly testHttp?: (
    client: AgentExtensionClient,
    server: McpHttpConfig,
  ) => Promise<{ readonly ok: boolean; readonly message: string }>;
}
