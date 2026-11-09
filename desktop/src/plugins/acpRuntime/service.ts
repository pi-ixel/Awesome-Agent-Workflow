import type { AcpRuntimeService } from "../../contracts/acpRuntime.ts";
import type { AcpConnectionService } from "../../contracts/acpConnection.ts";
import type { AgentsService } from "../../contracts/agents.ts";
import type { AgentProbeSessionFactory } from "../../contracts/agentProbe.ts";
import { RuntimeConnections } from "./connections.ts";
import { createAcpSession } from "./channelSession.ts";

export class DesktopAcpRuntime implements AcpRuntimeService {
  private stopping?: Promise<void>;
  readonly protocol: RuntimeConnections;

  constructor(private readonly base: AcpConnectionService, agents: AgentsService) {
    this.protocol = new RuntimeConnections(base, agents);
  }

  createProbeLease: AgentProbeSessionFactory = (transport, capacity, options) => {
    if (this.stopping) throw new Error("ACP runtime is stopping");
    const connection = this.base.createConnection(transport, capacity);
    return {
      openSession: () => createAcpSession(connection, options),
      release: (force) => this.base.releaseConnection(connection, force),
    };
  };

  shutdown(options?: { force?: boolean }): Promise<void> {
    return (this.stopping ??= this.protocol.dispose(options));
  }
}
