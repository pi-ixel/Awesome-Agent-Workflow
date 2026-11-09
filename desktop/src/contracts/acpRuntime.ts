import type { AcpSessionPort, AcpSessionEvent, ChannelSessionOptions } from "./acpSession.ts";
import type { AgentAdapter, AgentDialectHooks } from "./agentAdapter.ts";
import type { SessionConfigOption } from "./sessionConfiguration.ts";
import type { SessionInfo } from "./acpProtocol.ts";

export interface AcpProtocolRestoreOptions {
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly modelId: string | null;
  readonly modeId?: string;
  readonly configuration: readonly SessionConfigOption[];
  readonly isCurrent: () => boolean;
  readonly onReplay: (event: AcpSessionEvent) => void;
}

export interface AcpProtocolSessionOptions
  extends
    Omit<
      ChannelSessionOptions,
      "clientInfo" | "cancellationGraceMs" | "dialect"
    >,
    AgentDialectHooks {}

/** ACP 会话与连接资源。项目层通过此端口协调 Agent 切换及会话投影。 */
export interface AcpProtocolResources {
  readonly selection:
    { readonly agentKey: string; readonly agentId: string } | undefined;
  prepare(
    adapter: AgentAdapter,
    agentKey: string,
    toolPaths: object,
  ): Promise<void>;
  prepareSwitch(adapter: AgentAdapter, toolPaths: object): Promise<number>;
  commitSwitch(revision: number): Promise<void>;
  abortSwitch(revision: number): Promise<void>;
  setSelection(agentKey: string, agentId: string): void;
  open(agentKey: string, options?: AcpProtocolSessionOptions): AcpSessionPort;
  readProjectHistory(
    session: AcpSessionPort,
    workspacePath: string,
    isCurrent: () => boolean,
  ): Promise<readonly SessionInfo[] | null>;
  has(session: AcpSessionPort): boolean;
  promote(session: AcpSessionPort): void;
  release(session: AcpSessionPort): Promise<void>;
  recover(session: AcpSessionPort): Promise<void>;
  restore(
    session: AcpSessionPort,
    options: AcpProtocolRestoreOptions,
  ): Promise<void>;
  close(options?: { force?: boolean }): Promise<void>;
}

export interface AcpRuntimeService {
  readonly protocol: AcpProtocolResources;
  shutdown(options?: { force?: boolean }): Promise<void>;
}
