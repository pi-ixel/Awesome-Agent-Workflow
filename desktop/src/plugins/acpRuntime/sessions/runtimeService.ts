import type { AcpRuntimeService } from "../service.ts";
import type { AcpConnectionService } from "../../acpConnection/service.ts";
import type { AgentsService } from "../../agents/service.ts";
import type { AgentProbeSessionFactory } from "../../agents/types.ts";
import { RuntimeConnections } from "./connections.ts";
import { createAcpSession } from "./channelSession.ts";
import type { Logger } from "../../../shared/logging/logger.ts";

export class DesktopAcpRuntime {
  private stopping?: Promise<void>;
  private readonly connections: RuntimeConnections;
  readonly service: AcpRuntimeService;

  constructor(
    private readonly base: AcpConnectionService,
    agents: AgentsService,
    private readonly logger: Logger,
  ) {
    this.connections = new RuntimeConnections(base, agents, logger, (agentId) =>
      agents.configuration.getState().agents.some(
        (agent) => agent.id === agentId && agent.supportsCustomAnswers === true,
      ),
    );
    const connections = this.connections;
    this.service = {
      protocol: {
        get selection() { return connections.selection; },
        prepare: connections.prepare.bind(connections),
        prepareSwitch: connections.prepareSwitch.bind(connections),
        commitSwitch: connections.commitSwitch.bind(connections),
        abortSwitch: connections.abortSwitch.bind(connections),
        setSelection: connections.setSelection.bind(connections),
        open: connections.open.bind(connections),
        openIndependent: connections.openIndependent.bind(connections),
        readProjectHistory: connections.readProjectHistory.bind(connections),
        has: connections.has.bind(connections),
        promote: connections.promote.bind(connections),
        release: connections.release.bind(connections),
        recover: connections.recover.bind(connections),
        restore: connections.restore.bind(connections),
        close: connections.close.bind(connections),
      },
      shutdown: this.shutdown.bind(this),
    };
  }

  createProbeLease: AgentProbeSessionFactory = (transport, capacity, options) => {
    if (this.stopping) throw new Error("ACP runtime is stopping");
    const connection = this.base.createConnection(transport, capacity);
    return {
      openSession: () => createAcpSession(connection, options, this.logger),
      release: (force) => this.base.releaseConnection(connection, force),
    };
  };

  shutdown(options?: { force?: boolean }): Promise<void> {
    return (this.stopping ??= this.connections.dispose(options));
  }
}
