import { expect, it, vi } from "vitest";
import { codeAgentAdapter } from "../../src/agents/codeagent/adapter.ts";
import { probeExecutable } from "../../src/agents/codeagent/settings.ts";
import { createDemoHost } from "../../src/core/host.ts";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import { standardAcpPeer } from "../helpers/standardAcpPeer.ts";
import { AcpSession } from "../../src/acp/session.ts";
import {
  attachSession,
  createSessionStore,
} from "../../src/stores/sessionStore.ts";

it("launches the builtin with acp and keeps executable settings isolated", () => {
  expect(codeAgentAdapter.buildLaunch({ workspacePath: "D:/work" })).toEqual({
    command: ["codeagent", "acp"],
    cwd: "D:/work",
    extraEnv: {},
  });
  expect(
    codeAgentAdapter.buildLaunch({
      workspacePath: null,
      executablePath: " C:/Program Files/CodeAgent/codeagent.cmd ",
    }).command,
  ).toEqual(["C:/Program Files/CodeAgent/codeagent.cmd", "acp"]);
  const settings = useSettingsStore.getState();
  const original = settings.getAgentSettings("chrys");
  codeAgentAdapter.executableConfiguration!(settings).setValue(
    "X:/codeagent.exe",
  );
  expect(
    codeAgentAdapter.configuredExecutable!(useSettingsStore.getState(), {}),
  ).toBe("X:/codeagent.exe");
  expect(useSettingsStore.getState().getAgentSettings("chrys")).toEqual(
    original,
  );
  codeAgentAdapter.executableConfiguration!(settings).setValue("");
});

it("probes existing PATH results without guessing, and supports the alternate lookup", async () => {
  const host = createDemoHost();
  host.addDir("X:/bin");
  await host.writeTextFile("X:/bin/codeagent.cmd", "shim");
  host.scriptCommand("where", ["codeagent"], {
    code: 0,
    stdout: "X:/missing.exe\nX:/bin/codeagent.cmd\n",
    stderr: "",
  });
  expect(await probeExecutable(host)).toBe("X:/bin/codeagent.cmd");
  host.reset();
  expect(await probeExecutable(host)).toBeNull();
  host.addDir("/bin");
  await host.writeTextFile("/bin/codeagent", "executable");
  host.scriptCommand("which", ["codeagent"], {
    code: 0,
    stdout: "/bin/codeagent\n",
    stderr: "",
  });
  expect(await probeExecutable(host)).toBe("/bin/codeagent");
});

async function fixture(grace = 20) {
  const f = standardAcpPeer();
  f.handlers.set("initialize", () => ({
    protocolVersion: 1,
    agentInfo: { name: "codeagentcli", version: "1.2605.00" },
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true },
      sessionCapabilities: { list: {}, close: {} },
    },
  }));
  const session = new AcpSession(f.client, { cancellationGraceMs: grace });
  await session.initialize();
  await session.newSession("D:/work");
  return { ...f, session };
}

it("runs standard text/image chat and loads history using sessionId without a dialect", async () => {
  const f = await fixture();
  const store = createSessionStore("codeagent-test");
  let detach = attachSession(f.session, store);
  try {
    const image = { type: "image", mimeType: "image/png", data: "AA==" };
    expect(store.getState().sendPrompt("inspect", [image])).toBe(true);
    await vi.waitFor(() =>
      expect(store.getState().lastStopReason).toBe("end_turn"),
    );
    expect(
      f.received.find((wire) => wire.method === "session/prompt")?.params
        ?.prompt,
    ).toEqual([{ type: "text", text: "inspect" }, image]);
    f.handlers.set("session/list", () => ({
      sessions: [{ sessionId: "old", cwd: "D:/work", title: "Previous" }],
    }));
    expect((await f.session.listSessions("D:/work")).sessions[0]?.title).toBe(
      "Previous",
    );
    detach();
    store.getState().clear();
    store.getState().openSession("old");
    detach = attachSession(f.session, store);
    f.handlers.set("session/load", () => {
      f.update(
        {
          sessionUpdate: "user_message_chunk",
          messageId: "image-message",
          content: image,
        },
        "old",
      );
      f.update(
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "history" },
        },
        "old",
      );
      return {};
    });
    store.getState().setHistoryReplaySession("old");
    await f.session.loadSession("old", "D:/work");
    store.getState().setHistoryReplaySession(null);
    store.getState().sealStreamingItems();
    expect(
      f.received.find((wire) => wire.method === "session/load")?.params,
    ).toEqual({ sessionId: "old", cwd: "D:/work", mcpServers: [] });
    expect(store.getState().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "user", attachments: [image] }),
        expect.objectContaining({ kind: "assistant", text: "history" }),
      ]),
    );
  } finally {
    detach();
    await f.session.close();
  }
});

it("force-stops only the unresponsive connection after standard cancellation", async () => {
  const a = await fixture(),
    b = await fixture();
  a.handlers.set("session/prompt", () => new Promise(() => {}));
  const store = createSessionStore("codeagent-force");
  const detach = attachSession(a.session, store);
  store.getState().sendPrompt("hang");
  const kill = vi.spyOn(a.client, "kill");
  try {
    store.getState().requestCancel();
    await vi.waitFor(() => expect(kill).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(store.getState().connectionFailure).toBeTruthy(),
    );
    store.getState().suspendForRecovery();
    const detachReplacement = attachSession(b.session, store);
    store.getState().finishRecovery();
    expect(
      b.received.filter((wire) => wire.method === "session/prompt"),
    ).toHaveLength(0);
    detachReplacement();
    expect(
      a.received.find((wire) => wire.method === "session/cancel")?.id,
    ).toBeUndefined();
    await expect(b.session.prompt("other agent")).resolves.toMatchObject({
      stopReason: "end_turn",
    });
  } finally {
    detach();
    await a.session.close();
    await b.session.close();
  }
});

it("does not kill after graceful cancellation and does not replay a user-cancelled prompt", async () => {
  const f = await fixture(80);
  const store = createSessionStore("codeagent-stop");
  const detach = attachSession(f.session, store);
  let finish: ((value: unknown) => void) | undefined;
  f.handlers.set(
    "session/prompt",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.handlers.set("session/cancel", () => finish?.({ stopReason: "cancelled" }));
  const kill = vi.spyOn(f.client, "kill");
  try {
    store.getState().sendPrompt("stop me");
    await vi.waitFor(() => expect(finish).toBeDefined());
    store.getState().requestCancel();
    await vi.waitFor(() =>
      expect(store.getState().lastStopReason).toBe("cancelled"),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(kill).not.toHaveBeenCalled();
    store.getState().suspendForRecovery();
    store.getState().finishRecovery();
    expect(
      f.received.filter((wire) => wire.method === "session/prompt"),
    ).toHaveLength(1);
  } finally {
    detach();
    await f.session.close();
  }
});
