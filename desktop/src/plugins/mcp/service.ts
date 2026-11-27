import type { ComponentType } from "react";
import type {
  ManagedMcpDefinition,
  McpInspection,
  McpImportPlan,
  McpInstallResult,
  McpTool,
} from "../../contracts/mcp/management.ts";
import type { ReadonlySnapshot } from "../../shared/state/readonlySnapshot.ts";
import type {} from "cordis";

declare module "cordis" {
  interface Context {
    mcp: McpService;
  }
}

export interface McpService {
  readonly View: ComponentType;
  readonly builtins: ReadonlySnapshot<readonly BuiltinMcp[]>;
  /** 登记页面描述，返回随所属插件释放的注销函数。 */
  registerBuiltin(entry: BuiltinMcp): () => void;
  previewInstall(
    agentId: string,
    definitions: readonly ManagedMcpDefinition[],
  ): Promise<McpImportPlan>;
  commitInstall(plan: McpImportPlan): Promise<McpInstallResult>;
}

export interface BuiltinMcp {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly scope: string;
  /** 默认用 id 匹配运行时服务名。动态名称由所属插件识别。 */
  readonly matchesServer?: (name: string) => boolean;
  readonly enabled?: {
    read(): Promise<boolean>;
    watch(listener: (enabled: boolean) => void): Promise<() => void>;
    set(enabled: boolean): Promise<boolean>;
  };
  readonly tools?: {
    read(): Promise<BuiltinMcpTools>;
    probe(): Promise<McpInspection>;
    setEnabled(
      names: readonly string[],
      enabled: boolean,
    ): Promise<readonly string[]>;
  };
  readonly registration?: (sessionId: string) => Promise<{
    readonly name: string;
    readonly connected: boolean;
  } | null>;
}

export interface BuiltinMcpTools {
  readonly tools: readonly McpTool[];
  readonly disabledTools: readonly string[];
}
