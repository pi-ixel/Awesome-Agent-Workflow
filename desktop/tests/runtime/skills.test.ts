import { expect, it, vi } from "vitest";
import type { Context } from "cordis";
import { desktopSettingsKey } from "../../src/contracts/configuration.ts";
import type { SkillInstallation } from "../../src/contracts/skills.ts";
import { createDemoHost } from "../../src/plugins/host/host.ts";
import { installDesktopWorkbench } from "../../src/bootstrap/installDesktopWorkbench.ts";
import { createTestDesktopRuntime } from "../helpers/desktopRuntime.ts";
import { createTestSkills } from "../helpers/skills.tsx";
import * as skillsPlugin from "../../src/plugins/skills/plugin.ts";

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
    expect(workbench.getSnapshot().chrome.map(({ id }) => id)).toContain(
      "skills-installer",
    );
    expect(skills.installer()).toBe(agents.resolve()?.skillInstallation);
    expect(
      skills.candidates(["declared", "unknown"], { declared: "run this" }),
    ).toEqual(["declared"]);
    expect(skills.candidates(["undeclared"])).toEqual([]);
    expect(skills.source.getSnapshot()).toBe("D:/legacy");
    expect(workbench.getSnapshot().skills[0]?.service).toBe(skills);
    skills.source.set("D:/persisted");
    await fiber.dispose();
    expect(skills.source.getSnapshot()).toBe("");
    skills.source.set("D:/stale");
    expect(workbench.getSnapshot().skills).toEqual([]);
    expect(
      workbench.getSnapshot().chrome.some(({ id }) => id.startsWith("skills-")),
    ).toBe(false);
    expect(root.configuration.read(desktopSettingsKey)).toMatchObject({
      skillsSourceDir: "D:/persisted",
      theme: "warm",
    });
    await root.plugin(skillsPlugin);
    expect(root.skills).not.toBe(skills);
    expect(workbench.getSnapshot().skills[0]?.service).toBe(root.skills);
    expect(root.skills.source.getSnapshot()).toBe("D:/persisted");
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
    skills.source.set("D:/old");
    skills.watchInstaller();
    await vi.advanceTimersByTimeAsync(400);
    expect(scan).toHaveBeenCalledOnce();
    skills.source.set("D:/new");
    finish([{ name: "old", isInstalled: true }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(skills.state.getState().entries).toEqual([]);
    await vi.advanceTimersByTimeAsync(400);
    expect(skills.state.getState().entries).toEqual([
      { name: "new", isInstalled: false },
    ]);
    skills.source.set("D:/never");
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
  const task = skills.state.getState().install("D:/source", capability);
  await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
  expect(skills.state.getState().install("D:/source", capability)).toBe(task);
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
  expect(skills.state.getState().lastInstallSummary).toBeNull();
});
