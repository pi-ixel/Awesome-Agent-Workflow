import type * as ProjectOperationsModule from "../../src/plugins/project/sessions/operations.ts";
import { startDesktopRuntime } from "../../src/bootstrap/mainRuntime.ts";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { standardAcpPeer } from "../helpers/standardAcpPeer.ts";
import { createTestDesktopRuntime as createDesktopRuntime } from "../helpers/desktopRuntime.ts";
import {
  bindRuntimeServices,
  openRealWorkspace,
  closeRealRuntime,
  closeSessionRuntime,
  projectFactory,
  attachSessionPreloading,
  switchRuntimeAgent,
  preloadSessionList,
} from "../helpers/projectCoordinatorFixture.ts";
import { SessionFactory } from "../../src/plugins/project/conversation/SessionFactory.ts";
import type { AgentsService } from "../../src/plugins/agents/service.ts";
import { mutableWorkspace } from "../helpers/workspace.ts";
let useWorkspaceStore: ReturnType<typeof mutableWorkspace>;
import { createAgentTransport } from "../../src/plugins/agents/launch/agentTransport.ts";

vi.mock("../../src/plugins/agents/launch/agentTransport.ts", () => ({
  createAgentTransport: vi.fn(),
}));
vi.mock("../../src/plugins/agents/enhancements/icode/chrysArchive.ts", () => ({
  readChrysArchive: vi.fn(() => Promise.resolve([])),
}));

const peers: ReturnType<typeof standardAcpPeer>[] = [];
const desktop = createDesktopRuntime({
  attachPreloading: () => () => {},
  close: (options) => closeRealRuntime(options),
});
let sequence = 0;
let detach: (() => void) | undefined;
let agentService: AgentsService;
beforeAll(async () => {
  const { acpRuntime, agents } = await desktop.ready;
  agentService = agents;
  bindRuntimeServices(acpRuntime.protocol, agents);
  useWorkspaceStore = mutableWorkspace((await startDesktopRuntime().ready).project);
});
beforeEach(() => {
  peers.length = 0;
  sequence = 0;
  agentService.select("chrys");
  useWorkspaceStore.setState({
    selectedPath: null,
    activePath: null,
    pinnedPaths: [],
    recentWorkspaces: [],
  });
  vi.mocked(createAgentTransport).mockImplementation(() => {
    const peer = standardAcpPeer();
    peer.handlers.set("session/new", () => ({
      sessionId: `new-${++sequence}`,
    }));
    peers.push(peer);
    return Promise.resolve(peer.client);
  });
});
afterEach(async () => {
  detach?.();
  detach = undefined;
  await closeRealRuntime();
});
afterAll(async () => desktop.shutdown());

describe("main runtime with the ACP pool", () => {
  it("queries project history without constructing a SessionRuntime", async () => {
    const create = vi.spyOn(SessionFactory.prototype, "create");
    try {
      await preloadSessionList("/catalog-only");
      expect(create).not.toHaveBeenCalled();
      expect([...projectFactory.sessions()]).toHaveLength(0);
      expect(projectFactory.open("/catalog-only").history("chrys")).toEqual([]);
      expect(peers).toHaveLength(4);
      expect(peers.every((peer) => !peer.client.isClosed)).toBe(true);
    } finally {
      create.mockRestore();
    }
  });
  it("still releases other sessions and all connections after one cleanup fails", async () => {
    await openRealWorkspace("/a", { forceNew: true });
    await openRealWorkspace("/b", { forceNew: true });
    const [first, second] = [...projectFactory.sessions()];
    const secondDetach = vi.spyOn(second!, "detachViews");
    const disposeActivity = first!.disposeActivity;
    first!.disposeActivity = () => {
      disposeActivity();
      throw new Error("activity cleanup failed");
    };
    await expect(closeRealRuntime()).rejects.toThrow("Runtime cleanup failed");
    expect(secondDetach).toHaveBeenCalledTimes(1);
    expect(peers.every((peer) => peer.client.isClosed)).toBe(true);
    expect([...projectFactory.sessions()]).toHaveLength(0);
  });
  it("recovers all sessions on a failed connection without replaying prompts", async () => {
    for (let index = 0; index < 5; index++)
      await openRealWorkspace(`/project-${index}`, { forceNew: true });
    const affectedIds = peers[0]!.received.filter(
      (wire) => wire.method === "session/new",
    ).length;
    expect(affectedIds).toBe(2);
    const runtimes = [...projectFactory.sessions()];
    const originals = runtimes.map((runtime) => runtime.session);
    peers[0]!.peer.exit(1);
    await vi.waitFor(
      () => {
        expect(
          runtimes.filter(
            (runtime, index) => runtime.session !== originals[index],
          ),
        ).toHaveLength(2);
        expect(runtimes.every((runtime) => !runtime.recovering)).toBe(true);
      },
      { timeout: 4000 },
    );
    expect(peers).toHaveLength(5);
    expect(
      peers
        .flatMap((peer) => peer.received)
        .filter((wire) => wire.method === "session/prompt"),
    ).toHaveLength(0);
    expect(
      runtimes
        .filter((runtime, index) => runtime.session !== originals[index])
        .every((runtime) => runtime.store.getState().queuePaused),
    ).toBe(true);
  });
  it("reuses a historical load when foreground opening overtakes preloading", async () => {
    const create = vi.mocked(createAgentTransport).getMockImplementation()!;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.mocked(createAgentTransport).mockImplementation(async (...args) => {
      const transport = await create(...args);
      const peer = peers.find((item) => item.client === transport)!;
      peer.handlers.set("session/list", () => ({
        sessions: [{ sessionId: "history", cwd: "/project" }],
      }));
      peer.handlers.set("session/load", async () => {
        await gate;
        return {};
      });
      return transport;
    });
    useWorkspaceStore.setState({
      recentWorkspaces: [
        { path: "/project", lastOpenedAt: "2026-11-09T00:00:00Z" },
      ],
    });
    detach = attachSessionPreloading();
    await vi.waitFor(() =>
      expect(
        peers
          .flatMap((peer) => peer.received)
          .filter((wire) => wire.method === "session/load"),
      ).toHaveLength(1),
    );
    const opened = openRealWorkspace("/project", { sessionId: "history" });
    finish();
    expect(await opened).toMatchObject({ sessionId: "history" });
    expect(
      peers
        .flatMap((peer) => peer.received)
        .filter((wire) => wire.method === "session/load"),
    ).toHaveLength(1);
    expect([...projectFactory.sessions()]).toHaveLength(1);
  });

  it("limits background project discovery to ten projects and lists every page", async () => {
    const create = vi.mocked(createAgentTransport).getMockImplementation()!;
    vi.mocked(createAgentTransport).mockImplementation(async (...args) => {
      const transport = await create(...args);
      peers
        .find((peer) => peer.client === transport)!
        .handlers.set("session/list", (wire) => ({
          sessions: [],
          ...(wire.params?.cursor ? {} : { nextCursor: "page-2" }),
        }));
      return transport;
    });
    useWorkspaceStore.setState({
      recentWorkspaces: Array.from({ length: 12 }, (_, index) => ({
        path: `/project-${index}`,
        lastOpenedAt: "2026-11-09T00:00:00Z",
      })),
    });
    detach = attachSessionPreloading();
    await vi.waitFor(() =>
      expect(
        peers
          .flatMap((peer) => peer.received)
          .filter((wire) => wire.method === "session/list"),
      ).toHaveLength(20),
    );
    expect(
      new Set(
        peers
          .flatMap((peer) => peer.received)
          .filter((wire) => wire.method === "session/list")
          .map((wire) => wire.params?.cwd),
      ).size,
    ).toBe(10);
    expect([...projectFactory.sessions()]).toHaveLength(0);
  });

  it("preserves the active Agent and session when target preparation fails", async () => {
    await openRealWorkspace("/project", { forceNew: true });
    const current = [...projectFactory.sessions()][0]!;
    vi.mocked(createAgentTransport).mockRejectedValueOnce(
      new Error("target launch failed"),
    );
    await expect(switchRuntimeAgent("codeagent")).rejects.toThrow(
      "warmup failed",
    );
    expect(agentService.selectedId).toBe("chrys");
    expect(current.disposed).toBe(false);
    expect(current.store.getState().isConnecting).toBe(false);
    expect(current.store.getState().queuePaused).toBe(true);
    expect(peers.filter((peer) => !peer.client.isClosed)).toHaveLength(4);
  });
  it("opens five sessions over four neutral connections with balanced allocation", async () => {
    const opened = [];
    for (let i = 0; i < 5; i++)
      opened.push(await openRealWorkspace(`/project-${i}`, { forceNew: true }));
    expect(opened.every(Boolean)).toBe(true);
    expect(peers).toHaveLength(4);
    expect(
      peers
        .map(
          (peer) =>
            peer.received.filter((wire) => wire.method === "session/new")
              .length,
        )
        .sort(),
    ).toEqual([1, 1, 1, 2]);
    for (const [launch] of vi.mocked(createAgentTransport).mock.calls)
      expect(launch.cwd).toBeNull();
    const first = [...projectFactory.sessions()][0]!;
    await closeSessionRuntime(
      first.workspacePath,
      first.agentKey,
      first.session.sessionId,
    );
    expect(peers.every((peer) => !peer.client.isClosed)).toBe(true);
    expect([...projectFactory.sessions()]).toHaveLength(4);
  });

  it("warms four connections even without any projects", async () => {
    detach = attachSessionPreloading();
    await vi.waitFor(() => expect(peers).toHaveLength(4));
    expect(
      peers
        .flatMap((peer) => peer.received)
        .some((wire) => wire.method === "session/new"),
    ).toBe(false);
  });

  it("replaces unused startup connections after executable discovery changes the launch path", async () => {
    const executable = agentService.executableConfiguration("chrys")!;
    const original = executable.value;
    detach = attachSessionPreloading();
    await vi.waitFor(() => expect(peers).toHaveLength(4));
    const initial = [...peers];
    try {
      executable.setValue("D:/discovered/icode.exe");
      await vi.waitFor(() =>
        expect(initial.every((peer) => peer.client.isClosed)).toBe(true),
      );
      expect(peers).toHaveLength(8);
      await vi.waitFor(async () => {
        expect(
          await openRealWorkspace("/after-discovery", { forceNew: true }),
        ).not.toBeNull();
      });
      expect(peers.filter((peer) => !peer.client.isClosed)).toHaveLength(4);
    } finally {
      detach?.();
      detach = undefined;
      executable.setValue(original);
    }
  });

  it("loads at most two historical sessions per project without creating empty sessions", async () => {
    const create = vi.mocked(createAgentTransport).getMockImplementation()!;
    vi.mocked(createAgentTransport).mockImplementation(async (...args) => {
      const transport = await create(...args);
      peers
        .find((peer) => peer.client === transport)!
        .handlers.set("session/list", (wire) => ({
          sessions: [1, 2, 3].map((id) => ({
            sessionId: `${String(wire.params?.cwd)}-${id}`,
            cwd: wire.params?.cwd,
            updatedAt: `2026-11-0${id}T00:00:00Z`,
          })),
        }));
      return transport;
    });
    useWorkspaceStore.setState({
      recentWorkspaces: [
        { path: "/history", lastOpenedAt: "2026-11-09T00:00:00Z" },
      ],
    });
    detach = attachSessionPreloading();
    await vi.waitFor(() =>
      expect(
        [...projectFactory.sessions()].filter(
          (runtime) => runtime.session.sessionId,
        ),
      ).toHaveLength(2),
    );
    expect(
      peers
        .flatMap((peer) => peer.received)
        .filter((wire) => wire.method === "session/load")
        .map((wire) => wire.params?.sessionId)
        .sort(),
    ).toEqual(["/history-2", "/history-3"]);
    expect(
      peers
        .flatMap((peer) => peer.received)
        .some((wire) => wire.method === "session/new"),
    ).toBe(false);
  });

  it("switches Agent only after target preparation, closes old sessions and retains four connections", async () => {
    await openRealWorkspace("/project", { forceNew: true });
    const old = [...peers];
    await switchRuntimeAgent("codeagent");
    expect(agentService.selectedId).toBe("codeagent");
    expect(old.every((peer) => peer.client.isClosed)).toBe(true);
    expect(peers.filter((peer) => !peer.client.isClosed)).toHaveLength(4);
    expect([...projectFactory.sessions()]).toHaveLength(0);
    expect(
      await openRealWorkspace("/project", { forceNew: true }),
    ).not.toBeNull();
    expect(peers).toHaveLength(8);
  });
});

it("opens a real session when one of the four initial launches fails", async () => {
  vi.mocked(createAgentTransport).mockRejectedValueOnce(
    new Error("one slot unavailable"),
  );
  const opened = await openRealWorkspace("/partial", { forceNew: true });
  expect(opened?.sessionId).toBeTruthy();
  expect(peers).toHaveLength(3);
  expect([...projectFactory.sessions()]).toHaveLength(1);
});

it("supersedes a prepared Agent and keeps the old task frozen until the latest preparation fails", async () => {
  await openRealWorkspace("/project", { forceNew: true });
  const original = [...projectFactory.sessions()][0]!;
  const create = vi.mocked(createAgentTransport).getMockImplementation()!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  expect(agentService.addCustomAgent("Next", "next acp")).toBeNull();
  vi.mocked(createAgentTransport).mockImplementationOnce(async (...args) => {
    await gate;
    return create(...args);
  });
  const first = switchRuntimeAgent("codeagent");
  const firstResult = expect(first).rejects.toThrow("后续确认替代");
  await vi.waitFor(() => expect(peers).toHaveLength(7));
  vi.mocked(createAgentTransport).mockRejectedValue(
    new Error("latest unavailable"),
  );
  const latest = switchRuntimeAgent("custom-next");
  const latestResult = expect(latest).rejects.toThrow("latest unavailable");
  expect(original.store.getState().operationsBlocked).toBe(true);
  release();
  await firstResult;
  await latestResult;
  expect(agentService.selectedId).toBe("chrys");
  expect(original.disposed).toBe(false);
  expect(original.store.getState().operationsBlocked).toBe(false);
  expect(original.store.getState().queuePaused).toBe(true);
  expect(peers.filter((peer) => !peer.client.isClosed)).toHaveLength(4);
});

it("queues the latest confirmation behind an atomic commit without leaking connections", async () => {
  await openRealWorkspace("/project", { forceNew: true });
  const transport = peers[0]!.client;
  const originalKill = transport.kill.bind(transport);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const kill = vi.spyOn(transport, "kill").mockImplementation(async () => {
    await gate;
    return originalKill();
  });
  const first = switchRuntimeAgent("codeagent");
  await vi.waitFor(() => expect(kill).toHaveBeenCalledTimes(1));
  const latest = switchRuntimeAgent("chrys");
  expect(await openRealWorkspace("/blocked", { forceNew: true })).toBeNull();
  expect(peers).toHaveLength(8);
  release();
  await Promise.all([first, latest]);
  expect(agentService.selectedId).toBe("chrys");
  expect(peers.filter((peer) => !peer.client.isClosed)).toHaveLength(4);
  expect(peers).toHaveLength(12);
  expect(await openRealWorkspace("/latest", { forceNew: true })).not.toBeNull();
  kill.mockRestore();
});

it.each([false, true])(
  "exit invalidates queued switches and cleans late prepared connections (force=%s)",
  async (force) => {
    await openRealWorkspace("/project", { forceNew: true });
    const create = vi.mocked(createAgentTransport).getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(createAgentTransport).mockImplementationOnce(async (...args) => {
      await gate;
      return create(...args);
    });
    const first = switchRuntimeAgent("codeagent");
    const firstResult = expect(first).rejects.toThrow(
      /退出|superseded|stopping/,
    );
    await vi.waitFor(() => expect(peers).toHaveLength(7));
    const latest = switchRuntimeAgent("chrys");
    const latestResult = expect(latest).rejects.toThrow("退出");
    const closing = closeRealRuntime({ force });
    release();
    await Promise.all([firstResult, latestResult, closing]);
    expect(peers).toHaveLength(8);
    expect(peers.every((peer) => peer.client.isClosed)).toBe(true);
  },
);

it("Service commands address the background owner and never act on the foreground session", async () => {
  const { project } = await startDesktopRuntime().ready;
  await openRealWorkspace("/background", { forceNew: true });
  const background = [...projectFactory.sessions()][0]!;
  await openRealWorkspace("/foreground", { forceNew: true });
  const foreground = [...projectFactory.sessions()].find(
    (item) => item !== background,
  )!;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  for (const peer of peers)
    peer.handlers.set("session/prompt", async () => {
      await gate;
      return { stopReason: "end_turn" };
    });
  const owner = {
    workspacePath: background.workspacePath,
    agentKey: background.agentKey,
    sessionId: background.session.sessionId,
  };
  expect(project.conversation.send(owner, "background work")).toBe(true);
  expect(project.conversation.enqueue(owner, "later")).toBe(true);
  expect(background.store.getState().isAgentRunning).toBe(true);
  expect(foreground.store.getState().isAgentRunning).toBe(false);
  project.conversation.cancel(owner);
  await vi.waitFor(() =>
    expect(
      peers
        .flatMap((peer) => peer.received)
        .filter((wire) => wire.method === "session/cancel")
        .some((wire) => wire.params?.sessionId === owner.sessionId),
    ).toBe(true),
  );
  project.conversation.clearQueue(owner);
  finish();
  await vi.waitFor(() =>
    expect(background.store.getState().isAgentRunning).toBe(false),
  );
  expect(
    peers
      .flatMap((peer) => peer.received)
      .filter((wire) => wire.method === "session/prompt"),
  ).toHaveLength(1);
  expect(() =>
    project.conversation.send({ ...owner, agentKey: "wrong-agent" }, "wrong"),
  ).toThrow("not open");
});

it("Service sends the first draft message once and rejects its stale null-session identity afterward", async () => {
  const { project } = await startDesktopRuntime().ready;
  await openRealWorkspace("/draft", { forceNew: true, draft: true });
  const runtime = [...projectFactory.sessions()][0]!;
  const owner = {
    workspacePath: "/draft",
    agentKey: runtime.agentKey,
    sessionId: null,
  };
  expect(project.conversation.send(owner, "first draft message")).toBe(true);
  await vi.waitFor(() => expect(runtime.session.sessionId).not.toBeNull());
  await vi.waitFor(() =>
    expect(runtime.store.getState().isAgentRunning).toBe(false),
  );
  expect(() => project.conversation.send(owner, "stale draft")).toThrow("not open");
  const wire = peers.flatMap((peer) => peer.received);
  expect(wire.filter((item) => item.method === "session/new")).toHaveLength(1);
  expect(wire.filter((item) => item.method === "session/prompt")).toHaveLength(
    1,
  );
});

it("Service approval decisions isolate identical request IDs across sessions", async () => {
  const { project } = await startDesktopRuntime().ready;
  await openRealWorkspace("/one", { forceNew: true });
  await openRealWorkspace("/two", { forceNew: true });
  const [one, two] = [...projectFactory.sessions()];
  const request = (runtime: NonNullable<typeof one>) =>
    runtime.approval.getState().offerPermission({
      sessionId: runtime.session.sessionId!,
      toolCall: { toolCallId: "same", title: "action" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    });
  const first = request(one!),
    second = request(two!);
  const owner = {
    workspacePath: one!.workspacePath,
    agentKey: one!.agentKey,
    sessionId: one!.session.sessionId,
  };
  project.interactions.decidePermission(owner, "permission:same", "allow");
  await expect(first).resolves.toEqual({
    outcome: "selected",
    optionId: "allow",
  });
  expect(two!.approval.getState().pending).toHaveLength(1);
  project.interactions.cancelPermission(
    {
      workspacePath: two!.workspacePath,
      agentKey: two!.agentKey,
      sessionId: two!.session.sessionId,
    },
    "permission:same",
  );
  await expect(second).resolves.toEqual({ outcome: "cancelled" });
});

vi.mock("../../src/plugins/project/sessions/operations.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof ProjectOperationsModule>();
  const fixture = await import("../helpers/projectCoordinatorFixture.ts");
  return {
    ...actual,
    createProjectOperations: (dependencies: Parameters<typeof actual.createProjectOperations>[0]) => {
      fixture.bindProjectDependencies(dependencies);
      return {
      ...actual.projectOperationsFrom(fixture, dependencies.workspace),
      dispose: undefined,
      };
    },
  };
});
