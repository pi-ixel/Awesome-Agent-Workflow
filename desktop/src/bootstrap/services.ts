import type { AcpConnectionService } from "../contracts/acpConnection.ts";
import type { AcpRuntimeService } from "../contracts/acpRuntime.ts";
import type { ProjectService } from "../contracts/project.ts";
import type { HostService } from "../contracts/host.ts";
import type { ConfigurationService } from "../contracts/configuration.ts";
import type { DiagnosticsService } from "../contracts/diagnostics.ts";
import type { AgentsService } from "../contracts/agents.ts";
import type { WorkbenchService } from "../contracts/workbench.ts";
import type { DocumentsService } from "../contracts/documents.ts";
import type { GitService } from "../contracts/git.ts";
import type { TerminalService } from "../contracts/terminal.ts";
import type { WorkflowService } from "../contracts/workflow.ts";
import type { SkillsService } from "../contracts/skills.ts";
import type { AccountService } from "../contracts/account.ts";
import type { UpdatesService } from "../contracts/updates.ts";

declare module "cordis" {
  interface Context {
    host: HostService;
    configuration: ConfigurationService;
    diagnostics: DiagnosticsService;
    agents: AgentsService;
    acpConnection: AcpConnectionService;
    acpRuntime: AcpRuntimeService;
    project: ProjectService;
    workbench: WorkbenchService;
    documents: DocumentsService;
    git: GitService;
    terminal: TerminalService;
    workflow: WorkflowService;
    skills: SkillsService;
    account: AccountService;
    updates: UpdatesService;
  }
}
export {};
