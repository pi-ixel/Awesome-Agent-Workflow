import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";

// Only the composition list is replaced. All protocol/store/UI code remains real.
vi.mock("../../src/agents/builtins.ts", () => ({ builtinAgentAdapters: [] }));
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
  poison(resolve("src/agents/icode"));
  poison(resolve("src/agents/codeagent"));
});

async function ready(agentKey = "standard-a") {
  const { standardAcpPeer } = await import("../helpers/standardAcpPeer.ts");
  const { AcpSession } = await import("../../src/acp/session.ts");
  const { createSessionStore, attachSession } =
    await import("../../src/stores/sessionStore.ts");
  const fixture = standardAcpPeer();
  const session = new AcpSession(fixture.client);
  await session.initialize({ timeoutMs: 500 });
  await session.newSession("D:/local-fixture", { timeoutMs: 500 });
  const store = createSessionStore(agentKey);
  const detach = attachSession(session, store);
  return { ...fixture, session, store, detach };
}

it("loads actual registry/settings/workspace/runtime and standard wire → store → tool UI with ICode forbidden", async () => {
  const registry = await import("../../src/agents/registry.ts");
  await import("../../src/stores/settingsStore.ts");
  await import("../../src/stores/workspaceStore.ts");
  await import("../../src/ui/realRuntime.ts");
  expect(registry.agentAdapters).toEqual([]);
  const adapter = registry.resolveAgentAdapter("custom-local", [
    { id: "custom-local", name: "Local", command: ["local", "acp"] },
  ])?.adapter;
  expect(adapter).toBeDefined();
  expect(adapter?.createDialect).toBeUndefined();
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
      await import("../../src/ui/session/ToolContent.tsx");
    render(
      <ToolContent content={tool?.kind === "tool" ? tool.content : null} />,
    );
    expect(screen.getByText("sample.txt")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("after")).toBeInTheDocument();
  } finally {
    f.detach();
    await f.session.close();
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
    await f.session.close();
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
    await a.session.close();
    await b.session.close();
  }
});

it("recovers after invalid responses and timeout, then restores a standard session", async () => {
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
    f.handlers.set("session/load", () => ({
      modes: {
        currentModeId: "ask",
        availableModes: [{ id: "ask", name: "Ask" }],
      },
    }));
    await f.session.loadSession("restored", "D:/local-fixture", {
      timeoutMs: 500,
    });
    f.handlers.set("session/prompt", () => ({ stopReason: "end_turn" }));
    await expect(
      f.session.prompt("recovered", { timeoutMs: 500 }),
    ).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(
      f.received.filter((wire) => wire.method === "session/prompt").at(-1)
        ?.params?.sessionId,
    ).toBe("restored");
  } finally {
    f.detach();
    await f.session.close();
  }
});

it("the forbidden-module sentinel really fails if an enhancement is loaded", async () => {
  // This intentional negative fixture validates the dynamic-import guard itself.
  await expect(import("../../src/agents/icode/adapter.ts")).rejects.toThrow();
});

it("supports form replies, declines URL mode, and cancels forms for another session", async () => {
  const { standardAcpPeer } = await import("../helpers/standardAcpPeer.ts");
  const { AcpSession } = await import("../../src/acp/session.ts");
  const f = standardAcpPeer();
  const responder = vi.fn(() =>
    Promise.resolve({ action: "accept" as const, content: { name: "local" } }),
  );
  const session = new AcpSession(f.client, { onElicitation: responder });
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
    await session.close();
  }
});

it("reloads on a replacement standard connection and replays an interrupted prompt only once", async () => {
  const first = await ready("recovery-agent");
  const { standardAcpPeer } = await import("../helpers/standardAcpPeer.ts");
  const { AcpSession } = await import("../../src/acp/session.ts");
  const { attachSession } = await import("../../src/stores/sessionStore.ts");
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
  const session = new AcpSession(next.client);
  let detach = () => {};
  try {
    await session.initialize();
    await session.loadSession("same-session", "D:/local-fixture");
    next.handlers.set("session/prompt", () => new Promise(() => {}));
    detach = attachSession(session, first.store);
    first.store.getState().finishRecovery();
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
    await first.session.close();
    await session.close();
  }
});
