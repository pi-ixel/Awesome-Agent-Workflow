import { describe, expect, it, vi } from "vitest";
import { AcpConnection } from "../../src/plugins/acpConnection/channels/AcpConnection.ts";
import { diagnosticProbeFor } from "../../src/plugins/acpRuntime/protocol/diagnosticProbe.ts";
import { createAcpSession } from "../../src/plugins/acpRuntime/sessions/channelSession.ts";
import { standardAcpPeer } from "../helpers/standardAcpPeer.ts";

async function fixture(support = true) {
  const peer = standardAcpPeer();
  peer.handlers.set("initialize", () => ({
    protocolVersion: 1,
    agentInfo: { name: "fixture" },
    agentCapabilities: { sessionCapabilities: support ? { list: {} } : {} },
  }));
  const connection = new AcpConnection(peer.client, 1);
  const handshake = createAcpSession(connection);
  const negotiated = await handshake.initialize();
  await handshake.closeSession();
  connection.configureDiagnosticProbe(diagnosticProbeFor(negotiated));
  const channel = connection.openChannel({
    project: { id: "c:/project", path: "C:/project" },
  });
  return { peer, connection, channel };
}

describe("connection diagnostics probe", () => {
  it("uses one read-only request on the existing idle connection", async () => {
    const { peer, connection, channel } = await fixture();
    try {
      expect((await connection.probe()).status).toBe("no-project");
      await channel.port.request("session/load", {
        sessionId: "one",
        cwd: "C:/project",
      });
      const result = await connection.probe();
      expect(result.status).toBe("success");
      expect(result.durationMs).toBeTypeOf("number");
      expect(
        peer.received.filter((entry) => entry.method === "session/list"),
      ).toMatchObject([{ params: { cwd: "C:/project" } }]);
      expect(
        peer.received.some(
          (entry) =>
            entry.method === "session/prompt" || entry.method === "session/new",
        ),
      ).toBe(false);
    } finally {
      channel.close();
      await connection.close();
    }
  });

  it("skips unsupported and busy connections", async () => {
    const unsupported = await fixture(false);
    expect((await unsupported.connection.probe()).status).toBe("unsupported");
    unsupported.channel.close();
    await unsupported.connection.close();
    const { peer, connection, channel } = await fixture();
    let finish!: (value: object) => void;
    peer.handlers.set(
      "session/prompt",
      () =>
        new Promise<object>((resolve) => {
          finish = resolve;
        }),
    );
    try {
      await channel.port.request("session/load", {
        sessionId: "one",
        cwd: "C:/project",
      });
      const prompt = channel.port.request("session/prompt", {
        sessionId: "one",
        prompt: [],
      });
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      expect((await connection.probe()).status).toBe("busy");
      expect(
        peer.received.filter((entry) => entry.method === "session/list"),
      ).toHaveLength(0);
      finish({ stopReason: "end_turn" });
      await prompt;
    } finally {
      channel.close();
      await connection.close();
    }
  });

  it("does not quarantine a connection when a diagnostic request times out", async () => {
    const { peer, connection, channel } = await fixture();
    let finish!: (value: object) => void;
    peer.handlers.set(
      "session/list",
      () =>
        new Promise<object>((resolve) => {
          finish = resolve;
        }),
    );
    try {
      await channel.port.request("session/load", {
        sessionId: "one",
        cwd: "C:/project",
      });
      const first = connection.probe(20);
      expect(connection.probe(20)).toBe(first);
      const result = await first;
      expect(result.status).toBe("error");
      expect(result.message).toContain("对端可能仍在处理");
      expect(
        peer.received.some((entry) => entry.method === "$/cancel_request"),
      ).toBe(true);
      expect(connection.available).toBe(true);
      finish({ sessions: [] });
      await channel.port.request("session/prompt", {
        sessionId: "one",
        prompt: [],
      });
      expect(connection.available).toBe(true);
    } finally {
      channel.close();
      await connection.close();
    }
  });

  it("does not probe while an unscheduled control request is in flight", async () => {
    const { peer, connection, channel } = await fixture();
    let finish!: (value: object) => void;
    peer.handlers.set(
      "session/set_mode",
      () =>
        new Promise<object>((resolve) => {
          finish = resolve;
        }),
    );
    try {
      await channel.port.request("session/load", {
        sessionId: "one",
        cwd: "C:/project",
      });
      const pending = channel.port.request("session/set_mode", {
        sessionId: "one",
        modeId: "x",
      });
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      expect((await connection.probe()).status).toBe("busy");
      expect(
        peer.received.filter((entry) => entry.method === "session/list"),
      ).toHaveLength(0);
      finish({});
      await pending;
    } finally {
      channel.close();
      await connection.close();
    }
  });

  it("holds the scheduling slot until the probe times out, then allows business", async () => {
    const { peer, connection, channel } = await fixture();
    peer.handlers.set("session/list", () => new Promise(() => {}));
    peer.handlers.set("session/set_mode", () => ({}));
    try {
      await channel.port.request("session/load", {
        sessionId: "one",
        cwd: "C:/project",
      });
      const probe = connection.probe(60);
      await vi.waitFor(() =>
        expect(
          peer.received.some((item) => item.method === "session/list"),
        ).toBe(true),
      );
      const prompt = channel.port.request("session/prompt", {
        sessionId: "one",
        prompt: [],
      });
      const control = channel.port.request("session/set_mode", {
        sessionId: "one",
        modeId: "x",
      });
      expect(connection.diagnosticSessions[0]?.running).toBe(false);
      expect(
        peer.received.some((item) => item.method === "session/prompt"),
      ).toBe(false);
      expect(
        peer.received.some((item) => item.method === "session/set_mode"),
      ).toBe(false);
      expect((await probe).status).toBe("error");
      await prompt;
      await control;
      expect(
        peer.received.some((item) => item.method === "session/prompt"),
      ).toBe(true);
      expect(connection.available).toBe(true);
    } finally {
      channel.close();
      await connection.close();
    }
  });
});
