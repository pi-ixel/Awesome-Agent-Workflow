import type { AgentProbeSessionFactory } from "../../src/plugins/agents/types.ts";
import { AcpConnection } from "../../src/plugins/acpConnection/channels/AcpConnection.ts";
import { createAcpSession } from "../../src/plugins/acpRuntime/sessions/channelSession.ts";

export const createTestProbeLease: AgentProbeSessionFactory = (transport, capacity, options) => {
  const connection = new AcpConnection(transport, capacity);
  return {
    openSession: () => createAcpSession(connection, options),
    async release(force) {
      if (force) await connection.kill();
      else await connection.close().catch(() => connection.kill());
    },
  };
};
