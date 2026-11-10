import type { Context, Plugin } from "cordis";
import { expect, it, vi } from "vitest";
import { desktopSettingsKey } from "../../src/plugins/configuration/config.ts";
import { installDesktopWorkbench } from "../../src/bootstrap/installDesktopWorkbench.ts";
import * as agentsPlugin from "../../src/plugins/agents/index.ts";
import type { AgentProbeSnapshot } from "../../src/plugins/agents/types.ts";
import { createDemoHost } from "../../src/plugins/host/adapters/host.ts";
import type { CommandResult } from "../../src/plugins/host/types.ts";
import * as projectPlugin from "../../src/plugins/project/index.ts";
import { SESSION_AUTO_ARCHIVE_SCAN_INTERVAL_MS } from "../../src/plugins/project/sessions/sessionArchive.ts";
import { createTestDesktopRuntime } from "../helpers/desktopRuntime.ts";
import { standardAcpPeer } from "../helpers/standardAcpPeer.ts";

const definitions = Object.values(
  import.meta.glob<Plugin.Object<unknown> & { name: string }>(
    "../../src/plugins/*/index.ts",
    { eager: true },
  ),
);

it.each(definitions)(
  "unloads and reinstalls the production $name fiber",
  async (definition) => {
    let root: Context | undefined;
    const runtime = createTestDesktopRuntime(
      {
        attachPreloading: () => () => {},
        close: () => Promise.resolve(),
      },
      undefined,
      (context) => {
        root = context;
      },
    );
    try {
      await runtime.ready;
      if (!root) throw new Error("Desktop root was not installed");
      const [fiber] = root.registry.get(definition)?.fibers ?? [];
      if (!fiber)
        throw new Error(`Missing production fiber for ${definition.name}`);
      const service: unknown = root.get(definition.name);
      expect(service).toBeDefined();
      expect(service).not.toHaveProperty("dispose");
      expect(fiber.parent).toBe(root);
      expect(fiber).not.toBe(root.fiber);
      expect(fiber.getEffects().map(({ label }) => label)).toContain(
        `${definition.name}:resources`,
      );

      const config: unknown = fiber.config;
      await fiber.dispose();
      expect(root.get(definition.name)).toBeUndefined();

      const replacement = await root.plugin(definition, config);
      expect(replacement).not.toBe(fiber);
      const replacementService: unknown = root.get(definition.name);
      expect(replacementService).toBeDefined();
      expect(replacementService).not.toHaveProperty("dispose");
      expect(replacementService).not.toBe(service);
    } finally {
      await runtime.shutdown();
    }
  },
);

it("stops Agent checks and rebinds Agent configuration and UI on the same root", async () => {
  const previous = localStorage.getItem(desktopSettingsKey);
  localStorage.setItem(
    desktopSettingsKey,
    JSON.stringify({
      activeAgentId: "codeagent",
      chrysPath: "D:/legacy/icode.exe",
      theme: "warm",
    }),
  );
  const demoHost = createDemoHost();
  const runCommand = demoHost.runCommand.bind(demoHost);
  let finishLookup!: (value: CommandResult) => void;
  const pendingLookup = new Promise<CommandResult>((resolve) => {
    finishLookup = resolve;
  });
  const lookup = vi
    .spyOn(demoHost, "runCommand")
    .mockImplementation((program, args) => {
      if (args[0] === "codeagent") return pendingLookup;
      return runCommand(program, args);
    });
  let finishHandshake!: () => void;
  const handshake = new Promise<void>((resolve) => {
    finishHandshake = resolve;
  });
  const peer = standardAcpPeer();
  peer.handlers.set("initialize", () => handshake);
  let root: Context | undefined;
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    async (context) => {
      root = context;
      await installDesktopWorkbench(context);
    },
    demoHost,
  );
  try {
    const { agents, workbench } = await runtime.ready;
    const [fiber] = root?.registry.get(agentsPlugin)?.fibers ?? [];
    if (!root || !fiber) throw new Error("Agents fiber is missing");
    const view = () => workbench.getSnapshot();
    const about = view().about[0];
    expect(about?.id).toBe("active-agent");
    expect(view().settings.some(({ id }) => id === "agents")).toBe(true);
    expect(lookup).toHaveBeenCalledWith("where", ["codeagent"]);
    expect(agents).not.toHaveProperty("initialize");
    expect(agents).not.toHaveProperty("preferences");
    expect(agents.selectedId).toBe("codeagent");
    const oldExecutable = agents.executableConfiguration("chrys")!;
    expect(oldExecutable.value).toBe("D:/legacy/icode.exe");
    expect(agents.configuration).not.toHaveProperty("setState");
    expect(agents.configuration.getState()).not.toHaveProperty("setAgentSettings");
    expect(agents.probeState).not.toHaveProperty("setState");
    expect(agents.probeState.getState()).not.toHaveProperty("reset");
    const configurationListener = vi.fn();
    const probeListener = vi.fn<(state: AgentProbeSnapshot) => void>();
    const launchListener = vi.fn();
    agents.configuration.subscribe(configurationListener);
    agents.probeState.subscribe(probeListener);
    agents.subscribeLaunchConfiguration(launchListener);
    agents.select("native-opencode");
    expect(agents.selectedId).toBe("native-opencode");
    oldExecutable.setValue("D:/current/icode.exe");
    expect(configurationListener).toHaveBeenCalled();
    expect(launchListener).toHaveBeenCalled();
    const probe = vi
      .spyOn(root.acpConnection, "createTransport")
      .mockResolvedValueOnce(peer.client);
    const check = agents.runProtocolCheck("native-opencode", {
      cwd: "D:/project",
      depth: "safe",
      toolPaths: {},
    });
    await vi.waitFor(() => expect(peer.received[0]?.method).toBe("initialize"));
    expect(probeListener).toHaveBeenCalled();
    configurationListener.mockClear();
    probeListener.mockClear();
    launchListener.mockClear();

    await fiber.dispose();
    expect(view().about).toEqual([]);
    expect(view().settings.some(({ id }) => id === "agents")).toBe(false);
    expect(peer.client.isClosed).toBe(true);
    expect(probeListener.mock.calls.map(([state]) => state.phase)).toEqual(["idle"]);
    probeListener.mockClear();
    oldExecutable.setValue("D:/stale/icode.exe");
    await root.plugin(agentsPlugin);
    const replacement = root.agents;
    expect(replacement).not.toBe(agents);
    expect(view().about[0]?.id).toBe("active-agent");
    expect(view().about[0]).not.toBe(about);
    await vi.waitFor(() => {
      expect(root?.project).toBeDefined();
      expect(view().settings.some(({ id }) => id === "agents")).toBe(true);
    });

    finishLookup({ code: 1, stdout: "", stderr: "" });
    finishHandshake();
    await check;
    await Promise.resolve();
    expect(probe).toHaveBeenCalledOnce();
    expect(configurationListener).not.toHaveBeenCalled();
    expect(probeListener).not.toHaveBeenCalled();
    expect(launchListener).not.toHaveBeenCalled();
    expect(
      lookup.mock.calls.filter(([, args]) => args[0] === "codeagent"),
    ).toHaveLength(1);
    expect(agents.probeState.getState()).toMatchObject({
      phase: "idle",
      resultsByAgent: {},
    });
    expect(replacement.probeState.getState()).toMatchObject({
      phase: "idle",
      resultsByAgent: {},
    });
    expect(replacement.configuration.getState()).toMatchObject({
      activeAgentId: "native-opencode",
      discoveredAgents: [],
    });
    expect(root.configuration.read(desktopSettingsKey)).toMatchObject({
      activeAgentId: "native-opencode",
      agentSettings: { chrys: { executablePath: "D:/current/icode.exe" } },
      chrysPath: "D:/legacy/icode.exe",
      theme: "warm",
    });
  } finally {
    finishLookup({ code: 1, stdout: "", stderr: "" });
    finishHandshake();
    await runtime.shutdown();
    lookup.mockRestore();
    if (previous === null) localStorage.removeItem(desktopSettingsKey);
    else localStorage.setItem(desktopSettingsKey, previous);
  }
});

it("stops project scans, releases preferences, and restores them on the same root", async () => {
  vi.useFakeTimers();
  const previous = window.localStorage.getItem(desktopSettingsKey);
  window.localStorage.setItem(
    desktopSettingsKey,
    JSON.stringify({
      approvalMode: "auto-reject",
      chatWidth: "wide",
      theme: "warm",
    }),
  );
  const busySessionIds = vi.fn(() => new Set<string>());
  let completeClose!: () => void;
  const closeGate = new Promise<void>((resolve) => {
    completeClose = resolve;
  });
  const close = vi.fn(() => closeGate);
  let root: Context | undefined;
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, busySessionIds, close },
    undefined,
    async (context) => {
      root = context;
      await installDesktopWorkbench(context);
    },
  );
  try {
    const { acpRuntime, project, workbench } = await runtime.ready;
    const [fiber] = root?.registry.get(projectPlugin)?.fibers ?? [];
    if (!root || !fiber) throw new Error("Project fiber is missing");
    const config = fiber.config as Parameters<typeof projectPlugin.apply>[1];
    const sidebar = workbench.getSnapshot().sidebar[0];
    expect(sidebar?.id).toBe("project-tree");
    const { preferences } = project;
    expect(preferences.getState()).toMatchObject({
      approvalMode: "ask",
      chatWidth: "wide",
    });
    preferences.setSessionAutoArchive(true, 14);
    expect(busySessionIds).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(SESSION_AUTO_ARCHIVE_SCAN_INTERVAL_MS);
    expect(busySessionIds).toHaveBeenCalledTimes(2);

    const done = vi.fn();
    const unloading = fiber.dispose().then(done);
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledOnce();
    expect(done).not.toHaveBeenCalled();
    completeClose();
    await unloading;
    expect(runtime.project).toBeUndefined();
    expect(workbench.getSnapshot().sidebar).toEqual([]);
    preferences.setSessionAutoArchive(true, 42);
    expect(preferences.getState().sessionAutoArchiveEnabled).toBe(false);
    vi.advanceTimersByTime(SESSION_AUTO_ARCHIVE_SCAN_INTERVAL_MS);
    expect(busySessionIds).toHaveBeenCalledTimes(2);
    expect(root.acpRuntime).toBe(acpRuntime);
    await root.plugin(projectPlugin, config);
    expect(workbench.getSnapshot().sidebar[0]?.id).toBe("project-tree");
    expect(workbench.getSnapshot().sidebar[0]).not.toBe(sidebar);
    expect(root.project.preferences).not.toBe(preferences);
    expect(root.project.preferences.getState()).toMatchObject({
      sessionAutoArchiveEnabled: true,
      sessionAutoArchiveOlderThanDays: 14,
      chatWidth: "wide",
    });
    expect(root.configuration.read(desktopSettingsKey)?.theme).toBe("warm");
    expect(busySessionIds).toHaveBeenCalledTimes(3);
  } finally {
    completeClose();
    await runtime.shutdown();
    if (previous === null) window.localStorage.removeItem(desktopSettingsKey);
    else window.localStorage.setItem(desktopSettingsKey, previous);
    vi.useRealTimers();
  }
});

it("starts preloading without mounting a view and detaches it on each Project unload", async () => {
  const detach = vi.fn();
  const attachPreloading = vi.fn(() => detach);
  let root: Context | undefined;
  const runtime = createTestDesktopRuntime(
    { attachPreloading, close: () => Promise.resolve() },
    undefined,
    (context) => {
      root = context;
    },
  );
  try {
    await runtime.ready;
    const [fiber] = root?.registry.get(projectPlugin)?.fibers ?? [];
    if (!root || !fiber) throw new Error("Project fiber is missing");
    const config = fiber.config as Parameters<typeof projectPlugin.apply>[1];
    await fiber.dispose();
    expect(attachPreloading).not.toHaveBeenCalled();

    const first = await root.plugin(projectPlugin, {
      ...config,
      startBackground: true,
    });
    expect(attachPreloading).toHaveBeenCalledOnce();
    expect(first.getEffects().map(({ label }) => label)).toContain(
      "project:preloading",
    );
    await first.dispose();
    expect(detach).toHaveBeenCalledOnce();

    await root.plugin(projectPlugin, { ...config, startBackground: true });
    expect(attachPreloading).toHaveBeenCalledTimes(2);
  } finally {
    await runtime.shutdown();
  }
  expect(detach).toHaveBeenCalledTimes(2);
});
