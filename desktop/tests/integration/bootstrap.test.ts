import { diagnosticsOwner } from "../helpers/diagnosticsOwner.ts";
import type { Context } from "cordis";
import { describe, expect, it, vi } from "vitest";
import { installDesktopWorkbench } from "../../src/bootstrap/installDesktopWorkbench.ts";
import * as projectPlugin from "../../src/plugins/project/index.ts";
import { createTestDesktopRuntime as createDesktopRuntime } from "../helpers/desktopRuntime.ts";
import { createTransportPair } from "../../src/plugins/acpConnection/protocol/transport/inMemoryTransport.ts";
import type { AcpProcessEvent, AcpProcessHost } from "../../src/plugins/host/types.ts";
import * as elicitation from "../../src/plugins/project/interactions/elicitationStore.ts";

it("isolates product logs and diagnostic preferences between actual Desktop roots", async () => {
  const operations = { attachPreloading: () => () => {}, close: () => Promise.resolve() };
  const first = createDesktopRuntime(operations);
  const second = createDesktopRuntime(operations);
  const firstPath = "D:/first-root-logging";
  const secondPath = "D:/second-root-logging";
  try {
    const [a, b] = await Promise.all([first.ready, second.ready]);
    const aCapture = diagnosticsOwner(a.diagnostics);
    const bCapture = diagnosticsOwner(b.diagnostics);
    expect(Object.keys(a.diagnostics).sort()).toEqual([
      "createLogger", "open", "reader", "recordAcpRaw", "startupTheme",
    ]);
    aCapture.clearLogs();
    bCapture.clearLogs();
    a.project.projects.selectWorkspace(firstPath);
    b.project.projects.selectWorkspace(secondPath);
    a.agents.select("missing-agent-first-root");
    b.agents.select("missing-agent-second-root");
    const aLogs = aCapture.logs.getState().entries;
    const bLogs = bCapture.logs.getState().entries;
    expect(aLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: "store", context: { path: firstPath } }),
      expect.objectContaining({ channel: "agents", context: { agentId: "missing-agent-first-root" } }),
    ]));
    expect(bLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: "store", context: { path: secondPath } }),
      expect.objectContaining({ channel: "agents", context: { agentId: "missing-agent-second-root" } }),
    ]));
    expect(JSON.stringify(aLogs)).not.toContain("second-root");
    expect(JSON.stringify(bLogs)).not.toContain("first-root");
    bCapture.setLogLevel("error");
    bCapture.clearLogs();
    expect(aCapture.logs.getState().level).toBe("debug");
    expect(aCapture.logs.getState().entries).toEqual(aLogs);
    expect(bCapture.logs.getState().entries).toEqual([]);
    await first.shutdown();
    b.diagnostics.createLogger("test").error("second root still active");
    expect(aCapture.logs.getState().entries).toEqual([]);
    expect(bCapture.logs.getState().entries.at(-1)?.message).toBe("second root still active");
  } finally {
    await Promise.all([first.shutdown(), second.shutdown()]);
  }
});

describe("Cordis desktop lifecycle", () => {
  it("routes native process I/O through the injected host and awaits release on shutdown", async () => {
    const listeners = new Map<AcpProcessEvent, (payload: unknown) => void>();
    let finishRelease!: () => void;
    const releasing = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    const host = {
      subscribe: vi.fn(
        (event: AcpProcessEvent, receive: (payload: unknown) => void) => {
          listeners.set(event, receive);
          return Promise.resolve(() => {
            listeners.delete(event);
          });
        },
      ),
      spawn: vi.fn(() => {
        expect(listeners.size).toBe(3);
        listeners.get("stdout")?.({ handle: 42, data: "ready" });
        return Promise.resolve(42);
      }),
      writeLine: vi.fn(() => Promise.resolve()),
      closeInput: vi.fn(() => {
        listeners.get("exit")?.({ handle: 42, code: 0 });
        return Promise.resolve();
      }),
      killTree: vi.fn(() => Promise.resolve({ code: 1, signal: null })),
      release: vi.fn(() => releasing),
    } satisfies AcpProcessHost;
    const runtime = createDesktopRuntime(
      { attachPreloading: () => () => {}, close: async () => {} },
      host,
      (context) => {
        vi.spyOn(context.host, "isNative").mockReturnValue(true);
      },
    );
    const { acpConnection } = await runtime.ready;
    const transport = await acpConnection.createTransport({
      command: ["agent", "acp"],
      cwd: "/project",
    });
    if (!transport) throw new Error("Expected a native ACP transport");
    const onLine = vi.fn();
    transport.onLine(onLine);
    expect(onLine).toHaveBeenCalledWith("ready");
    acpConnection.createConnection(transport, 1);
    transport.writeLine("request");
    expect(host.writeLine).toHaveBeenCalledWith(42, "request");
    expect(host.spawn).toHaveBeenCalledWith({
      program: "agent",
      args: ["acp"],
      cwd: "/project",
      extraEnv: null,
      isolated: false,
    });

    const done = vi.fn();
    const shutdown = runtime.shutdown().then(done);
    try {
      await vi.waitFor(() => expect(host.release).toHaveBeenCalledWith(42));
      expect(host.closeInput).toHaveBeenCalledWith(42);
      expect(host.killTree).not.toHaveBeenCalled();
      expect(listeners.size).toBe(0);
      expect(done).not.toHaveBeenCalled();
    } finally {
      finishRelease();
      await shutdown;
    }
    expect(host.release).toHaveBeenCalledTimes(1);
  });

  it("owns pooled connections through shutdown without closing them twice", async () => {
    const runtime = createDesktopRuntime({
      attachPreloading: () => () => {},
      close: async () => {},
    });
    const { acpConnection } = await runtime.ready;
    const closes: ReturnType<typeof vi.spyOn>[] = [];
    const pool = acpConnection.createPool(() => {
      const pair = createTransportPair();
      closes.push(vi.spyOn(pair.client, "close"));
      return Promise.resolve(acpConnection.createConnection(pair.client, 3));
    });
    await pool.warm();
    const targetCloses: ReturnType<typeof vi.spyOn>[] = [];
    const revision = await pool.prepareSwitch(() => {
      const pair = createTransportPair();
      targetCloses.push(vi.spyOn(pair.client, "close"));
      return Promise.resolve(acpConnection.createConnection(pair.client, 3));
    });
    // Aborting also transfers ownership out of the standalone connection set.
    await pool.abortSwitch(revision);
    await runtime.shutdown();
    expect(closes).toHaveLength(4);
    for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
    for (const close of targetCloses) expect(close).toHaveBeenCalledTimes(1);
    expect(() =>
      acpConnection.createPool(() => Promise.reject(new Error())),
    ).toThrow("stopping");
  });
  it("registers stable services and leaves optional Project background work off", async () => {
    const detach = vi.fn();
    const attachPreloading = vi.fn(() => detach);
    const close = vi.fn(() => Promise.resolve());
    const runtime = createDesktopRuntime({ attachPreloading, close });
    const services = await runtime.ready;
    expect(await runtime.ready).toBe(services);
    expect(Object.keys(services.configuration).sort()).toEqual(["read", "register"]);
    expect(Object.keys(services.acpConnection).sort()).toEqual([
      "createConnection", "createPool", "createTransport", "releaseConnection", "shutdown",
    ]);
    expect(Object.keys(services.acpRuntime).sort()).toEqual(["protocol", "shutdown"]);
    const { protocol } = services.acpRuntime;
    expect(Object.keys(protocol).sort()).toEqual([
      "abortSwitch", "close", "commitSwitch", "has", "open", "prepare", "prepareSwitch",
      "promote", "readProjectHistory", "recover", "release", "restore", "selection", "setSelection",
    ]);
    expect(protocol.selection).toBeUndefined();
    protocol.setSelection("agent@test", "agent");
    expect(protocol.selection).toEqual({ agentKey: "agent@test", agentId: "agent" });
    expect(Object.isFrozen(protocol.selection)).toBe(true);
    expect(services.project.sessions).not.toHaveProperty("attachPreloading");
    expect(services.updates).not.toHaveProperty("start");
    expect(services.workflow).not.toHaveProperty("onSessionActivity");
    expect(attachPreloading).not.toHaveBeenCalled();
    await runtime.shutdown();
    expect(protocol.selection).toBeUndefined();
    expect(() => protocol.setSelection("old", "agent")).toThrow("stopping");
    expect(detach).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("awaits business shutdown before closing base connections and is idempotent", async () => {
    const pair = createTransportPair();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const close = vi.fn(() => gate);
    const runtime = createDesktopRuntime({
      attachPreloading: () => () => {},
      close,
    });
    const { acpConnection } = await runtime.ready;
    acpConnection.createConnection(pair.client, 3);
    const shutdown = runtime.shutdown({ force: true });
    expect(runtime.shutdown()).toBe(shutdown);
    await Promise.resolve();
    expect(close).toHaveBeenCalledWith({ force: true });
    expect(pair.client.isClosed).toBe(false);
    finish();
    await shutdown;
    expect(pair.client.isClosed).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => acpConnection.createConnection(pair.client, 3)).toThrow(
      "stopping",
    );
  });

  it("still closes base resources when business cleanup fails", async () => {
    const pair = createTransportPair();
    const runtime = createDesktopRuntime({
      attachPreloading: () => () => {},
      close: () => Promise.reject(new Error("cleanup failed")),
    });
    const { acpConnection } = await runtime.ready;
    acpConnection.createConnection(pair.client, 3);
    await expect(runtime.shutdown()).rejects.toThrow("shutdown failed");
    expect(pair.client.isClosed).toBe(true);
  });

  it("shutdown during installation waits for both services then closes once", async () => {
    const close = vi.fn(() => Promise.resolve());
    const runtime = createDesktopRuntime({
      attachPreloading: () => () => {},
      close,
    });
    await runtime.shutdown();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

it("routes project discovery, draft and focus operations through the Service and closes admission on shutdown", async () => {
  const draft = { isCurrent: () => true, fail: vi.fn() };
  const registerProject = vi.fn();
  const preloadSessionList = vi.fn(() => Promise.resolve());
  const renameSession = vi.fn();
  const beginDraft = vi.fn(() => draft);
  const focusSession = vi.fn(() => true);
  const openSession: NonNullable<Parameters<typeof createDesktopRuntime>[0]>["openSession"] =
    (_path, options) => Promise.resolve(
      options?.shouldFocus?.() ? { sessionId: null, draft: true } : null,
    );
  const runtime = createDesktopRuntime({
    attachPreloading: () => () => {},
    close: () => Promise.resolve(),
    registerProject,
    preloadSessionList,
    renameSession,
    beginDraft,
    focusSession,
    openSession,
  });
  const { project, acpRuntime } = await runtime.ready;
  expect(acpRuntime).not.toHaveProperty("renameSession");
  expect(acpRuntime).not.toHaveProperty("attachPreloading");
  for (const [group, command] of [
    ["conversation", "send"],
    ["conversation", "enqueue"],
    ["interactions", "decidePermission"],
    ["interactions", "submitAnswers"],
    ["interactions", "answerForm"],
  ] as const) {
    expect(acpRuntime).not.toHaveProperty(command);
    expect(project[group]).toHaveProperty(command);
  }
  project.projects.registerProject("/project");
  await project.sessions.preloadSessionList("/project", true);
  project.sessions.renameSession("owner", "same", "title");
  expect(project.drafts).not.toHaveProperty("beginDraft");
  expect(project.sessions).not.toHaveProperty("focusSession");
  await expect(project.sessions.startNewSession("/project")).resolves.toEqual({ ok: true });
  await project.sessions.openSessionFromEntry("/project", "same", "owner");
  expect(preloadSessionList).toHaveBeenCalledWith("/project", true);
  expect(registerProject).toHaveBeenCalledWith("/project");
  expect(renameSession).toHaveBeenCalledWith("owner", "same", "title");
  expect(beginDraft).toHaveBeenCalledWith("/project");
  expect(focusSession).toHaveBeenCalledWith("/project", "same", "owner");
  await runtime.shutdown();
  await expect(project.sessions.startNewSession("/project")).resolves.toMatchObject({ ok: false });
  await project.sessions.openSessionFromEntry("/project", "same", "owner");
  expect(beginDraft).toHaveBeenCalledOnce();
  expect(focusSession).toHaveBeenCalledOnce();
  expect(() => project.sessions.renameSession("owner", "same", "late")).toThrow(
    "stopping",
  );
  expect(() => project.sessions.preloadSessionList("/project")).toThrow("stopping");
});

it("answers only the addressed project form even when two Agents share a protocol request ID", async ({
  onTestFinished,
}) => {
  const factory = vi.spyOn(elicitation, "createElicitationQueue");
  onTestFinished(() => {
    factory.mockRestore();
  });
  const runtime = createDesktopRuntime({
    attachPreloading: () => () => {},
    close: () => Promise.resolve(),
  });
  onTestFinished(() => runtime.shutdown());
  const { project } = await runtime.ready;
  const forms = factory.mock.results[0]?.value as ReturnType<
    typeof elicitation.createElicitationQueue
  >;
  expect(project.interactions.forms).toBe(forms.view);
  expect(project.interactions.forms).not.toHaveProperty("setState");
  const form = {
    message: "Confirm",
    sessionId: "same-session",
    requestedSchema: { properties: {} },
    requestId: "same-request",
  };
  const pending = () => project.interactions.forms.getState().pending;
  const firstOwner = {};
  const secondOwner = {};
  const first = forms.offer(
    firstOwner,
    "First",
    form,
    new AbortController().signal,
  );
  const second = forms.offer(
    secondOwner,
    "Second",
    form,
    new AbortController().signal,
  );
  const firstId = pending().find((item) => item.label === "First")!.id;
  const secondId = pending().find((item) => item.label === "Second")!.id;
  expect(pending()[0]).not.toHaveProperty("owner");
  project.interactions.answerForm(firstId, "decline");
  await expect(first).resolves.toEqual({ action: "decline" });
  expect(pending().map((item) => item.id)).toContain(secondId);
  project.interactions.answerForm(secondId, "cancel");
  await expect(second).resolves.toEqual({ action: "cancel" });
  await runtime.shutdown();
  expect(() => project.interactions.answerForm(secondId, "cancel")).toThrow("stopping");
});

it("cancels Project forms and releases their listeners on the same-root Fiber reload", async ({
  onTestFinished,
}) => {
  const factory = vi.spyOn(elicitation, "createElicitationQueue");
  onTestFinished(() => {
    factory.mockRestore();
  });
  let root: Context | undefined;
  const runtime = createDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    async (context) => {
      root = context;
      await installDesktopWorkbench(context);
    },
  );
  onTestFinished(() => runtime.shutdown());
  const { project, workbench } = await runtime.ready;
  const [fiber] = root?.registry.get(projectPlugin)?.fibers ?? [];
  if (!fiber || !root) throw new Error("Project fiber is missing");
  const config = fiber.config as Parameters<typeof projectPlugin.apply>[1];
  const forms = factory.mock.results[0]?.value as ReturnType<
    typeof elicitation.createElicitationQueue
  >;
  const { signal } = new AbortController();
  const removeListener = vi.spyOn(signal, "removeEventListener");
  const form = { message: "Pending", requestedSchema: { properties: {} } };
  const activate = vi.fn();
  const pending = forms.offer({}, "Agent", form, signal, undefined, {
    workspacePath: "/project",
    sessionId: "session",
    activate,
  });
  const [item] = project.interactions.forms.getState().pending;
  expect(item).toBeDefined();
  project.interactions.selectForm(item!.id);
  expect(project.interactions.forms.getState().activeId).toBe(item!.id);
  const onChange = vi.fn();
  const unsubscribe = project.interactions.forms.subscribe(onChange);
  const header = workbench.getSnapshot().headers.find(({ id }) => id === "session");
  expect(header?.View).toBeDefined();
  expect(workbench.getSnapshot().exitDetails.map(({ id }) => id)).toEqual(["project-approvals"]);

  await fiber.dispose();
  await expect(pending).resolves.toEqual({ action: "cancel" });
  expect(removeListener).toHaveBeenCalledOnce();
  expect(workbench.getSnapshot().headers).toEqual([]);
  expect(workbench.getSnapshot().collapsedHeaderActions).toEqual([]);
  expect(workbench.getSnapshot().exitDetails).toEqual([]);
  project.interactions.activateForm(item!.id);
  expect(activate).not.toHaveBeenCalled();
  project.interactions.selectForm(item!.id);
  expect(project.interactions.forms.getState()).toMatchObject({
    pending: [],
    activeId: null,
  });
  expect(onChange).toHaveBeenCalledOnce();
  forms.store.setState({ activeId: "discarded" });
  expect(onChange).toHaveBeenCalledOnce();
  unsubscribe();
  await expect(forms.offer({}, "Late", form, signal)).resolves.toEqual({
    action: "cancel",
  });

  await root.plugin(projectPlugin, config);
  expect(root.project).not.toBe(project);
  const reloaded = workbench.getSnapshot().headers.find(({ id }) => id === "session");
  expect(reloaded?.View).toBeDefined();
  expect(reloaded?.View).not.toBe(header?.View);
  expect(workbench.getSnapshot().exitDetails.map(({ id }) => id)).toEqual(["project-approvals"]);
  expect(root.project.interactions.forms).not.toBe(project.interactions.forms);
  expect(root.project.interactions.forms.getState()).toMatchObject({
    pending: [],
    activeId: null,
  });
});
