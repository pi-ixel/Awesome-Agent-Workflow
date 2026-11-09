import {
  createOwnedSession,
  sessionConnection,
} from "../helpers/ownedSession.ts";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";

// Only the composition list is replaced. All protocol/store/UI code remains real.
vi.mock("../../src/plugins/agents/builtins.ts", () => ({
  builtinAgentAdapters: [],
}));
beforeAll(() => {
  const poison = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) poison(path);
      else if (/\.tsx?$/.test(path))
        vi.doMock(path.replaceAll("\\", "/"), () => {
          throw new Error(`Forbidden enhancement load: ${path}`);
        });
    }
  };
  poison(resolve("src/plugins/agents/enhancements/icode"));
  poison(resolve("src/plugins/agents/enhancements/codeagent"));
});

async function ready(agentKey = "standard-a") {
  const { standardAcpPeer } = await import("../helpers/standardAcpPeer.ts");
  const { createSessionStore, attachSession } =
    await import("../../src/plugins/project/conversation/sessionStore.ts");
  const fixture = standardAcpPeer();
  const session = createOwnedSession(fixture.client);
  await session.initialize({ timeoutMs: 500 });
  await session.newSession("D:/local-fixture", { timeoutMs: 500 });
  const store = createSessionStore(agentKey);
  const detach = attachSession(session, store);
  return { ...fixture, session, store, detach };
}

it("loads actual registry/settings/workspace/runtime and standard wire → store → tool UI with ICode forbidden", async () => {
  const registry = await import("../../src/plugins/agents/registry.ts");
  await import("../../src/plugins/project/workspaceStore.ts");
  await import("../../src/plugins/project/sessionCoordinator.ts");
  expect(registry.agentAdapters).toEqual([]);
  const adapter = registry.resolveAgentAdapter("custom-local", [
    { id: "custom-local", name: "Local", command: ["local", "acp"] },
  ])?.adapter;
  expect(adapter).toBeDefined();
  expect(adapter?.createDialect).toBeUndefined();
  const { createTestDesktopRuntime } =
    await import("../helpers/desktopRuntime.ts");
  const desktop = createTestDesktopRuntime({
    attachPreloading: () => () => {},
    close: () => Promise.resolve(),
  });
  try {
    const { agents } = await desktop.ready;
    agents.configuration.getState().addCustomAgent("Local", "local acp");
    agents.select("custom-local");
    expect(agents.listBuiltins()).toEqual([]);
    const selected = agents.resolve();
    expect(selected?.id).toBe("custom-local");
    expect(selected?.createDialect).toBeUndefined();
    expect(
      agents.buildLaunch(selected!, {}, "D:/local-fixture").command,
    ).toEqual(["local", "acp"]);
  } finally {
    await desktop.shutdown();
  }
  const f = await ready();
  try {
    f.handlers.set("session/prompt", () => {
      f.update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello from wire" },
      });
      f.update({
        sessionUpdate: "tool_call",
        toolCallId: "edit",
        title: "Standard edit",
        kind: "edit",
        status: "completed",
        content: [
          {
            type: "diff",
            path: "sample.txt",
            oldText: "before",
            newText: "after",
          },
        ],
      });
      return { stopReason: "end_turn" };
    });
    expect(
      f.store
        .getState()
        .sendPrompt("inspect", [
          { type: "image", data: "AA==", mimeType: "image/png" },
        ]),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(f.store.getState().lastStopReason).toBe("end_turn"),
    );
    const prompt = f.received.find((wire) => wire.method === "session/prompt");
    expect(prompt?.params?.prompt).toEqual([
      { type: "text", text: "inspect" },
      { type: "image", data: "AA==", mimeType: "image/png" },
    ]);
    expect(f.store.getState().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "assistant", text: "hello from wire" }),
      ]),
    );
    const tool = f.store.getState().items.find((item) => item.kind === "tool");
    expect(tool?.kind).toBe("tool");
    const { ToolContent } =
      await import("../../src/plugins/project/conversation/ui/ToolContent.tsx");
    render(
      <ToolContent content={tool?.kind === "tool" ? tool.content : null} />,
    );
    expect(screen.getByText("sample.txt")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("after")).toBeInTheDocument();
  } finally {
    f.detach();
    await sessionConnection(f.session).close();
  }
});

it("does not advertise unsupported capabilities, rejects reverse methods, and remains usable", async () => {
  const f = await ready();
  try {
    const caps = f.received.find((wire) => wire.method === "initialize")?.params
      ?.clientCapabilities;
    expect(caps).toEqual({ fs: { readTextFile: false, writeTextFile: false } });
    for (const method of [
      "fs/read_text_file",
      "fs/write_text_file",
      "terminal/create",
      "terminal/output",
      "terminal/release",
      "terminal/wait_for_exit",
      "terminal/kill",
      "unknown/request",
    ]) {
      expect(
        (
          await f.request(method, {
            sessionId: "same-session",
            path: "never-read",
          })
        ).error,
      ).toMatchObject({ code: -32601 });
    }
    await expect(
      f.session.prompt("still usable", { timeoutMs: 500 }),
    ).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(
      f.received.some((wire) =>
        [
          "authenticate",
          "session/fork",
          "session/resume",
          "session/delete",
        ].includes(wire.method ?? ""),
      ),
    ).toBe(false);
  } finally {
    f.detach();
    await sessionConnection(f.session).close();
  }
});

it("keeps same-ID agents isolated through cancellation and connection failure", async () => {
  const a = await ready("agent-a");
  const b = await ready("agent-b");
  try {
    let complete: ((value: unknown) => void) | undefined;
    a.handlers.set(
      "session/prompt",
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    a.handlers.set("session/cancel", () =>
      complete?.({ stopReason: "cancelled" }),
    );
    a.store.getState().sendPrompt("cancel me");
    await vi.waitFor(() => expect(complete).toBeDefined());
    b.store.getState().sendPrompt("finish me");
    await vi.waitFor(() =>
      expect(b.store.getState().lastStopReason).toBe("end_turn"),
    );
    a.store.getState().requestCancel();
    await vi.waitFor(() =>
      expect(a.store.getState().lastStopReason).toBe("cancelled"),
    );
    a.handlers.set("session/prompt", () => new Promise(() => {}));
    a.store.getState().sendPrompt("disconnect me");
    a.peer.exit(1);
    await vi.waitFor(() =>
      expect(a.store.getState().turnState).toBe("unknown"),
    );
    expect(a.store.getState().connectionFailure).toBeTruthy();
    expect(a.store.getState().queuePaused).toBe(true);
    expect(b.store.getState().lastError).toBeNull();
    expect(b.store.getState().items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "cancel me" })]),
    );
  } finally {
    a.detach();
    b.detach();
    await sessionConnection(a.session).close();
    await sessionConnection(b.session).close();
  }
});

it("recovers after invalid responses and timeout, then restores a standard session", async () => {
  const { standardAcpPeer } = await import("../helpers/standardAcpPeer.ts");
  const f = await ready();
  try {
    f.handlers.set("session/prompt", () => ({}));
    await expect(
      f.session.prompt("invalid", { timeoutMs: 500 }),
    ).rejects.toThrow();
    f.handlers.set("session/prompt", () => new Promise(() => {}));
    await expect(
      f.session.prompt("timeout", { timeoutMs: 20 }),
    ).rejects.toThrow();
    await sessionConnection(f.session).close();
    const replacement = standardAcpPeer();
    const restored = createOwnedSession(replacement.client);
    await restored.initialize();
    replacement.handlers.set("session/load", () => ({
      modes: {
        currentModeId: "ask",
        availableModes: [{ id: "ask", name: "Ask" }],
      },
    }));
    await restored.loadSession("restored", "D:/local-fixture", {
      timeoutMs: 500,
    });
    replacement.handlers.set("session/prompt", () => ({
      stopReason: "end_turn",
    }));
    await expect(
      restored.prompt("recovered", { timeoutMs: 500 }),
    ).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(
      replacement.received
        .filter((wire) => wire.method === "session/prompt")
        .at(-1)?.params?.sessionId,
    ).toBe("restored");
  } finally {
    f.detach();
    await sessionConnection(f.session).close();
  }
});

it("the forbidden-module sentinel really fails if an enhancement is loaded", async () => {
  // This intentional negative fixture validates the dynamic-import guard itself.
  await expect(
    import("../../src/plugins/agents/enhancements/icode/adapter.ts"),
  ).rejects.toThrow();
});

it("supports form replies, declines URL mode, and cancels forms for another session", async () => {
  const { standardAcpPeer } = await import("../helpers/standardAcpPeer.ts");
  const f = standardAcpPeer();
  const responder = vi.fn(() =>
    Promise.resolve({ action: "accept" as const, content: { name: "local" } }),
  );
  const session = createOwnedSession(f.client, { onElicitation: responder });
  try {
    await session.initialize();
    await session.newSession("D:/fixture");
    expect(f.received[0]?.params?.clientCapabilities).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      elicitation: { form: {} },
    });
    const form = {
      mode: "form",
      message: "Name",
      sessionId: "same-session",
      requestedSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    };
    expect((await f.request("elicitation/create", form)).result).toEqual({
      action: "accept",
      content: { name: "local" },
    });
    expect(
      (
        await f.request("elicitation/create", {
          mode: "url",
          message: "Visit",
          url: "https://example.invalid",
          elicitationId: "url",
        })
      ).result,
    ).toEqual({ action: "decline" });
    expect(
      (
        await f.request("elicitation/create", {
          ...form,
          sessionId: "another-agent",
        })
      ).result,
    ).toEqual({ action: "cancel" });
    expect(responder).toHaveBeenCalledTimes(1);
    await expect(session.prompt("continue")).resolves.toMatchObject({
      stopReason: "end_turn",
    });
  } finally {
    await sessionConnection(session).close();
  }
});

it("reloads on a replacement standard connection and waits for explicit retry", async () => {
  const first = await ready("recovery-agent");
  const { standardAcpPeer } = await import("../helpers/standardAcpPeer.ts");
  const { attachSession } = await import("../../src/plugins/project/conversation/sessionStore.ts");
  first.handlers.set("session/prompt", () => new Promise(() => {}));
  first.store.getState().sendPrompt("unfinished");
  await vi.waitFor(() =>
    expect(
      first.received.some((wire) => wire.method === "session/prompt"),
    ).toBe(true),
  );
  first.peer.exit(1);
  await vi.waitFor(() =>
    expect(first.store.getState().connectionFailure).toBeTruthy(),
  );
  first.detach();
  first.store.getState().suspendForRecovery();
  const next = standardAcpPeer();
  const session = createOwnedSession(next.client);
  let detach = () => {};
  try {
    await session.initialize();
    await session.loadSession("same-session", "D:/local-fixture");
    next.handlers.set("session/prompt", () => new Promise(() => {}));
    detach = attachSession(session, first.store);
    first.store.getState().finishRecovery();
    expect(
      next.received.filter((wire) => wire.method === "session/prompt"),
    ).toHaveLength(0);
    expect(first.store.getState().queuePaused).toBe(true);
    expect(first.store.getState().turnState).toBe("unknown");
    first.store.getState().retryLastPrompt();
    await vi.waitFor(() =>
      expect(
        next.received.filter((wire) => wire.method === "session/prompt"),
      ).toHaveLength(1),
    );
    expect(
      next.received.find((wire) => wire.method === "session/prompt")?.params
        ?.prompt,
    ).toEqual([{ type: "text", text: "unfinished" }]);
    next.peer.exit(1);
    await vi.waitFor(() =>
      expect(first.store.getState().connectionFailure).toBeTruthy(),
    );
    first.store.getState().suspendForRecovery();
    first.store.getState().finishRecovery();
    expect(first.store.getState().turnState).toBe("unknown");
    expect(first.store.getState().queuePaused).toBe(true);
    expect(
      next.received.filter((wire) => wire.method === "session/prompt"),
    ).toHaveLength(1);
  } finally {
    detach();
    await sessionConnection(first.session).close();
    await sessionConnection(session).close();
  }
});
