import { expect, it, vi } from "vitest";
import type { Context } from "cordis";
import { desktopSettingsKey } from "../../src/plugins/configuration/config.ts";
import type { SkillInstallation } from "../../src/plugins/skills/types.ts";
import { createDemoHost } from "../../src/plugins/host/adapters/host.ts";
import { installDesktopWorkbench } from "../../src/bootstrap/installDesktopWorkbench.ts";
import { createTestDesktopRuntime } from "../helpers/desktopRuntime.ts";
import { createTestSkills } from "../helpers/skills.tsx";
import * as skillsPlugin from "../../src/plugins/skills/index.ts";

it("restores the source and rebinds optional contributions after unloading Skills", async () => {
  const previous = localStorage.getItem(desktopSettingsKey);
  localStorage.setItem(
    desktopSettingsKey,
    JSON.stringify({ skillsSourceDir: "D:/legacy", theme: "warm" }),
  );
  let root: Context | undefined;
  const runtime = createTestDesktopRuntime(
    {
      attachPreloading: () => () => {},
      close: () => Promise.resolve(),
    },
    undefined,
    async (context) => {
      root = context;
      await installDesktopWorkbench(context);
    },
  );
  try {
    const { skills, agents, workbench } = await runtime.ready;
    const [fiber] = root?.registry.get(skillsPlugin)?.fibers ?? [];
    if (!root || !fiber) throw new Error("Skills fiber is missing");
    expect(root.skillsUi.Installer).toBeTypeOf("function");
    expect(workbench.getSnapshot().settingsReset.map(({ id }) => id)).toContain("skills");
    expect(skills.getInstaller()).toEqual({ description: agents.resolve()?.skillInstallation?.description });
    expect(skills.state).not.toHaveProperty("setState");
    expect(skills.state.getState()).not.toHaveProperty("install");
    expect(skills.source).not.toHaveProperty("set");
    expect(
      skills.candidates(["declared", "unknown"], { declared: "run this" }),
    ).toEqual(["declared"]);
    expect(skills.candidates(["undeclared"])).toEqual([]);
    expect(skills.source.getSnapshot()).toBe("D:/legacy");
    const sourceView = root.skillsUi.Source;
    expect(sourceView).toBeDefined();
    const sessionPage = workbench.getSnapshot().pages.find(({ id }) => id === "session");
    skills.setSourceDirectory("D:/persisted");
    const oldSource = vi.fn();
    const oldInstaller = vi.fn();
    skills.source.subscribe(oldSource);
    skills.subscribeInstaller(oldInstaller);
    await fiber.dispose();
    expect(skills.source.getSnapshot()).toBe("");
    skills.setSourceDirectory("D:/stale");
    expect(root.get("skillsUi")).toBeUndefined();
    expect(workbench.getSnapshot().settingsReset.map(({ id }) => id)).not.toContain("skills");
    expect(root.configuration.read(desktopSettingsKey)).toMatchObject({
      skillsSourceDir: "D:/persisted",
      theme: "warm",
    });
    await root.plugin(skillsPlugin);
    expect(root.skills).not.toBe(skills);
    expect(root.skillsUi.Source).not.toBe(sourceView);
    expect(workbench.getSnapshot().pages.find(({ id }) => id === "session")).toBe(sessionPage);
    expect(root.skills.source.getSnapshot()).toBe("D:/persisted");
    agents.select("native-opencode");
    expect(root.skills.getInstaller()).toBeUndefined();
    expect(oldSource).not.toHaveBeenCalled();
    expect(oldInstaller).not.toHaveBeenCalled();
  } finally {
    await runtime.shutdown();
    if (previous === null) localStorage.removeItem(desktopSettingsKey);
    else localStorage.setItem(desktopSettingsKey, previous);
  }
});

it("invalidates an in-flight scan on source changes and cancels the pending scan on unload", async () => {
  vi.useFakeTimers();
  let finish!: (
    entries: readonly { name: string; isInstalled: boolean }[],
  ) => void;
  const old = new Promise<readonly { name: string; isInstalled: boolean }[]>(
    (resolve) => {
      finish = resolve;
    },
  );
  const scan = vi
    .fn<SkillInstallation["scan"]>()
    .mockReturnValueOnce(old)
    .mockResolvedValueOnce([{ name: "new", isInstalled: false }]);
  const capability: SkillInstallation = {
    description: "fixture",
    resolveDirectory: () => Promise.resolve("D:/destination"),
    install: vi.fn(),
    scan,
  };
  const skills = createTestSkills({ installer: () => capability });
  try {
    skills.setSourceDirectory("D:/old");
    skills.watchInstaller();
    await vi.advanceTimersByTimeAsync(400);
    expect(scan).toHaveBeenCalledOnce();
    skills.setSourceDirectory("D:/new");
    finish([{ name: "old", isInstalled: true }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(skills.state.getState().entries).toEqual([]);
    await vi.advanceTimersByTimeAsync(400);
    expect(skills.state.getState().entries).toEqual([
      { name: "new", isInstalled: false },
    ]);
    skills.setSourceDirectory("D:/never");
    await skills.dispose();
    await vi.advanceTimersByTimeAsync(400);
    expect(scan).toHaveBeenCalledTimes(2);
  } finally {
    await skills.dispose();
    vi.useRealTimers();
  }
});

it("waits for a committed skills install on disposal and ignores its late progress", async () => {
  let finish!: (result: { total: number }) => void;
  const install = vi.fn<SkillInstallation["install"]>(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const scan = vi.fn<SkillInstallation["scan"]>();
  const capability: SkillInstallation = {
    description: "fixture",
    resolveDirectory: () => Promise.resolve("D:/skills"),
    install,
    scan,
  };
  const skills = createTestSkills({
    host: createDemoHost(),
    installer: () => capability,
  });
  skills.setSourceDirectory("D:/source");
  const task = skills.install();
  await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
  expect(skills.install()).toBe(task);
  const oldListener = vi.fn();
  skills.state.subscribe(oldListener);
  const disposed = vi.fn();
  const cleanup = skills.dispose().then(disposed);
  install.mock.calls[0]?.[1].onProgress?.({
    done: 1,
    total: 1,
    current: "skill",
  });
  expect(skills.state.getState().progress).toBeNull();
  expect(disposed).not.toHaveBeenCalled();
  finish({ total: 1 });
  await cleanup;
  expect(disposed).toHaveBeenCalledOnce();
  expect(scan).not.toHaveBeenCalled();
  expect(oldListener).not.toHaveBeenCalled();
  expect(skills.state.getState().lastInstallSummary).toBeNull();
});

it("invalidates installation progress when the source changes with the view closed", async () => {
  let finish!: (result: { total: number }) => void;
  const pending = new Promise<{ total: number }>((resolve) => {
    finish = resolve;
  });
  const install = vi.fn<SkillInstallation["install"]>(() => pending);
  const scan = vi.fn<SkillInstallation["scan"]>();
  const capability: SkillInstallation = {
    description: "fixture",
    resolveDirectory: () => Promise.resolve("D:/destination"),
    install,
    scan,
  };
  const skills = createTestSkills({ installer: () => capability });

  try {
    skills.setSourceDirectory("D:/source");
    const stop = skills.watchInstaller();
    const installing = skills.install();
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
    stop();
    skills.setSourceDirectory("D:/replacement");
    install.mock.calls[0]?.[1].onProgress?.({ done: 1, total: 1, current: "old" });
    expect(skills.state.getState().progress).toBeNull();
    finish({ total: 1 });
    await installing;
    expect(scan).not.toHaveBeenCalled();
    expect(skills.state.getState().lastInstallSummary).toBeNull();
  } finally {
    finish({ total: 1 });
    await skills.dispose();
  }
});
