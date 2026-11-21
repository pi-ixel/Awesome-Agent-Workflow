import type { ComponentType } from "react";
import type {
  ManagedMcpDefinition,
  McpImportPlan,
  McpInstallResult,
} from "../../contracts/mcp/management.ts";
import type {} from "cordis";

declare module "cordis" {
  interface Context {
    mcp: McpService;
  }
}

export interface McpService {
  readonly View: ComponentType;
  previewInstall(
    agentId: string,
    definitions: readonly ManagedMcpDefinition[],
  ): Promise<McpImportPlan>;
  commitInstall(plan: McpImportPlan): Promise<McpInstallResult>;
}
