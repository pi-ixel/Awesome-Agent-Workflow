import type { Context } from "cordis";
import { describe, expect, it, vi } from "vitest";
import { installDesktopWorkbench } from "../../src/bootstrap/installDesktopWorkbench.ts";
import * as projectPlugin from "../../src/plugins/project/plugin.ts";
import { createTestDesktopRuntime as createDesktopRuntime } from "../helpers/desktopRuntime.ts";
import { createTransportPair } from "../../src/plugins/acpConnection/protocol/transport/inMemoryTransport.ts";
import type {
  AcpProcessEvent,
  AcpProcessHost,
} from "../../src/contracts/host.ts";
import * as elicitation from "../../src/plugins/project/interactions/elicitationStore.ts";

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
    );
    const { acpConnection } = await runtime.ready;
    const transport = await acpConnection.createNativeTransport({
      command: ["agent", "acp"],
      cwd: "/project",
    });
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
  it("registers stable services and shares preload subscription across consumers", async () => {
    const detach = vi.fn();
    const attachPreloading = vi.fn(() => detach);
    const close = vi.fn(() => Promise.resolve());
    const runtime = createDesktopRuntime({ attachPreloading, close });
    const services = await runtime.ready;
    expect(await runtime.ready).toBe(services);
    const first = services.project.attachPreloading();
    const second = services.project.attachPreloading();
    expect(attachPreloading).toHaveBeenCalledTimes(1);
    first();
    first();
    expect(detach).not.toHaveBeenCalled();
    second();
    expect(detach).toHaveBeenCalledTimes(1);
    await runtime.shutdown();
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => services.project.attachPreloading()).toThrow("stopping");
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
  const runtime = createDesktopRuntime({
    attachPreloading: () => () => {},
    close: () => Promise.resolve(),
    registerProject,
    preloadSessionList,
    renameSession,
    beginDraft,
    focusSession,
  });
  const { project, acpRuntime } = await runtime.ready;
  expect(acpRuntime).not.toHaveProperty("renameSession");
  expect(acpRuntime).not.toHaveProperty("attachPreloading");
  for (const command of [
    "send",
    "enqueue",
    "decidePermission",
    "submitAnswers",
    "answerForm",
  ]) {
    expect(acpRuntime).not.toHaveProperty(command);
    expect(project).toHaveProperty(command);
  }
  project.registerProject("/project");
  await project.preloadSessionList("/project", true);
  project.renameSession("owner", "same", "title");
  expect(project.beginDraft("/project")).toBe(draft);
  expect(project.focusSession("/project", "same", "owner")).toBe(true);
  expect(preloadSessionList).toHaveBeenCalledWith("/project", true);
  expect(registerProject).toHaveBeenCalledWith("/project");
  expect(renameSession).toHaveBeenCalledWith("owner", "same", "title");
  expect(focusSession).toHaveBeenCalledWith("/project", "same", "owner");
  await runtime.shutdown();
  expect(() => project.beginDraft("/project")).toThrow("stopping");
  expect(() => project.focusSession("/project", "same", "owner")).toThrow(
    "stopping",
  );
  expect(() => project.renameSession("owner", "same", "late")).toThrow(
    "stopping",
  );
  expect(() => project.preloadSessionList("/project")).toThrow("stopping");
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
  expect(project.forms).toBe(forms.store);
  const form = {
    message: "Confirm",
    sessionId: "same-session",
    requestedSchema: { properties: {} },
    requestId: "same-request",
  };
  const pending = () => project.forms.getState().pending;
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
  const firstId = pending().find((item) => item.owner === firstOwner)!.id;
  const secondId = pending().find((item) => item.owner === secondOwner)!.id;
  project.answerForm(firstId, "decline");
  await expect(first).resolves.toEqual({ action: "decline" });
  expect(pending().map((item) => item.id)).toContain(secondId);
  project.answerForm(secondId, "cancel");
  await expect(second).resolves.toEqual({ action: "cancel" });
  await runtime.shutdown();
  expect(() => project.answerForm(secondId, "cancel")).toThrow("stopping");
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
  const [item] = project.forms.getState().pending;
  expect(item).toBeDefined();
  project.forms.getState().select(item!.id);
  expect(workbench.getSnapshot().project[0]?.service).toBe(project);

  await fiber.dispose();
  await expect(pending).resolves.toEqual({ action: "cancel" });
  expect(removeListener).toHaveBeenCalledOnce();
  expect(workbench.getSnapshot().project).toEqual([]);
  item!.context?.activate();
  expect(activate).not.toHaveBeenCalled();
  project.forms.getState().select(item!.id);
  expect(project.forms.getState()).toMatchObject({
    pending: [],
    activeId: null,
    activeOwner: null,
  });
  await expect(forms.offer({}, "Late", form, signal)).resolves.toEqual({
    action: "cancel",
  });

  await root.plugin(projectPlugin, config);
  expect(workbench.getSnapshot().project[0]?.service).toBe(root.project);
  expect(root.project.forms).not.toBe(project.forms);
  expect(root.project.forms.getState()).toMatchObject({
    pending: [],
    activeId: null,
    activeOwner: null,
  });
});
