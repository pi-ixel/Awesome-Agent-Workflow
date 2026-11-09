import type { Context, Plugin } from "cordis";
import { expect, it, vi } from "vitest";
import { desktopSettingsKey } from "../../src/contracts/configuration.ts";
import { installDesktopWorkbench } from "../../src/bootstrap/installDesktopWorkbench.ts";
import * as agentsPlugin from "../../src/plugins/agents/plugin.ts";
import { createDemoHost } from "../../src/plugins/host/host.ts";
import type { CommandResult } from "../../src/contracts/host.ts";
import * as projectPlugin from "../../src/plugins/project/plugin.ts";
import { SESSION_AUTO_ARCHIVE_SCAN_INTERVAL_MS } from "../../src/plugins/project/sessionArchive.ts";
import { createTestDesktopRuntime } from "../helpers/desktopRuntime.ts";

const definitions = Object.values(
  import.meta.glob<Plugin.Object<unknown> & { name: string }>(
    "../../src/plugins/*/plugin.ts",
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
      expect(root.get(definition.name)).toBeDefined();
      expect(root.get(definition.name)).not.toBe(service);
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
  let failProbe!: (reason: Error) => void;
  const pendingProbe = new Promise<never>((_, reject) => {
    failProbe = reject;
  });
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
    expect(view().agents[0]?.service).toBe(agents);
    expect(view().settings.some(({ id }) => id === "agents")).toBe(true);
    expect(lookup).toHaveBeenCalledWith("where", ["codeagent"]);
    const oldSettings = agents.configuration.getState();
    expect(oldSettings.getAgentSettings("chrys")).toMatchObject({
      executablePath: "D:/legacy/icode.exe",
    });
    agents.select("native-opencode");
    oldSettings.setAgentSettings("chrys", {
      executablePath: "D:/current/icode.exe",
    });
    const probe = vi
      .spyOn(agents, "probe")
      .mockImplementation((_id, { onStep }) => {
        onStep?.("等待 initialize");
        return pendingProbe;
      });
    const check = agents.runProtocolCheck("native-opencode", {
      cwd: "D:/project",
      depth: "safe",
      toolPaths: {},
    });
    expect(agents.probeState.getState()).toMatchObject({
      phase: "probing",
      step: "等待 initialize",
    });

    await fiber.dispose();
    expect(view().agents).toEqual([]);
    expect(view().settings.some(({ id }) => id === "agents")).toBe(false);
    expect(agents.configuration.getState().agentSettingsState).toEqual({});
    oldSettings.setActiveAgentId("codeagent");
    oldSettings.setAgentSettings("chrys", {
      executablePath: "D:/stale/icode.exe",
    });
    await root.plugin(agentsPlugin);
    const replacement = root.agents;
    expect(replacement).not.toBe(agents);
    expect(view().agents[0]?.service).toBe(replacement);
    await vi.waitFor(() => {
      expect(root?.project).toBeDefined();
      expect(view().settings.some(({ id }) => id === "agents")).toBe(true);
    });

    finishLookup({ code: 1, stdout: "", stderr: "" });
    failProbe(new Error("late ACP failure"));
    await check;
    await Promise.resolve();
    expect(probe).toHaveBeenCalledOnce();
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
      agentSettingsState: {},
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
    failProbe(new Error("cleanup"));
    await pendingProbe.catch(() => {});
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
