import { expect, it, vi } from "vitest";
import { startDiagnosticsCollector } from "../../../src/plugins/diagnostics/capture/collector.ts";
import { LogSink } from "../../../src/plugins/diagnostics/capture/logSink.ts";
import type { DiagnosticsHost } from "../../../src/plugins/host/types.ts";
import type { HostService } from "../../../src/plugins/host/service.ts";
import { DesktopAcpConnection } from "../../../src/plugins/acpConnection/lifecycle/connectionService.ts";
import { createAcpSession } from "../../../src/plugins/acpRuntime/sessions/channelSession.ts";
import { diagnosticProbeFor } from "../../../src/plugins/acpRuntime/protocol/diagnosticProbe.ts";
import { standardAcpPeer } from "../../helpers/standardAcpPeer.ts";

it("dispatches queued probes in the main collector without blocking snapshots", async () => {
  const request = vi.fn(async (command: string) => {
    if (command === "diagnostics_status") return { observing: true };
    if (command === "diagnostics_probe_take") return ["connection-id"];
    return undefined;
  });
  const host = { isNative: () => true, request, flush: () => Promise.resolve() } as unknown as DiagnosticsHost;
  const probe = vi.fn(() => new Promise(() => {}));
  const snapshot = vi.fn(() => ({ runtime: [] }));
  const collector = startDiagnosticsCollector(host, new LogSink(), {
    cursor: { sequence: 0 }, snapshot, probeConnection: probe,
  });
  try {
    await vi.waitFor(() => expect(probe).toHaveBeenCalledWith("connection-id"));
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("diagnostics_snapshot", { snapshot: { runtime: [] } }));
  } finally {
    await collector.stop();
  }
});

it("publishes the result of a queued probe from the connection owner into the snapshot", async () => {
  const service = new DesktopAcpConnection({} as HostService, {});
  const peer = standardAcpPeer();
  peer.handlers.set("initialize", () => ({ protocolVersion: 1, agentInfo: { name: "fixture" }, agentCapabilities: { sessionCapabilities: { list: {} } } }));
  const connection = service.createConnection(peer.client, 1);
  const handshake = createAcpSession(connection);
  const negotiated = await handshake.initialize();
  await handshake.closeSession();
  connection.configureDiagnosticProbe(diagnosticProbeFor(negotiated));
  const channel = connection.openChannel({ project: { id: "p", path: "C:/project" } });
  await channel.port.request("session/load", { sessionId: "s", cwd: "C:/project" });
  const id = service.diagnostics()[0]!.id;
  let queued = [id];
  let published: ReturnType<typeof service.diagnostics> = [];
  const request = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "diagnostics_status") return { observing: true };
    if (command === "diagnostics_probe_take") { const ids = queued; queued = []; return ids; }
    if (command === "diagnostics_snapshot") published = (args?.snapshot as { connections: typeof published }).connections;
    return undefined;
  });
  const host = { isNative: () => true, request, flush: () => Promise.resolve() } as unknown as DiagnosticsHost;
  const collector = startDiagnosticsCollector(host, new LogSink(), {
    cursor: { sequence: 0 }, snapshot: () => ({ connections: service.diagnostics() }),
    probeConnection: (connectionId) => service.probe(connectionId),
  });
  try {
    await vi.waitFor(() => expect(published[0]?.probe?.status).toBe("success"), { timeout: 5000, interval: 50 });
    expect(peer.received.filter((entry) => entry.method === "session/list")).toHaveLength(1);
  } finally {
    await collector.stop();
    channel.close();
    await service.shutdown();
  }
});
