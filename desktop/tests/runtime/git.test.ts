import { expect, it, vi } from "vitest";
import { panelService } from "../../src/plugins/host/panelService.ts";
import { installDesktopWorkbench } from "../../src/bootstrap/installDesktopWorkbench.ts";
import type { Context } from "cordis";
import * as gitPlugin from "../../src/plugins/git/plugin.ts";
import { createTestDesktopRuntime } from "../helpers/desktopRuntime.ts";

it("installs Git panels, shares a project query and releases a late watcher on shutdown", async () => {
  const status = vi.spyOn(panelService, "gitStatus").mockResolvedValue({
    repoRoot: "D:/repo",
    branch: "main",
    changes: [],
    watchPaths: ["D:/repo"],
  });
  let finish!: (release: () => void) => void;
  const stop = vi.fn();
  const watch = vi.spyOn(panelService, "watch").mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const runtime = createTestDesktopRuntime(
    {
      attachPreloading: () => () => {},
      close: () => Promise.resolve(),
    },
    undefined,
    installDesktopWorkbench,
  );
  try {
    const { git, workbench } = await runtime.ready;
    expect(workbench.getSnapshot().panels.map(({ id }) => id)).toEqual(
      expect.arrayContaining(["git", "diff"]),
    );
    const query = git.query("D:/repo");
    expect(
      workbench.getSnapshot().gitReview[0]?.service.query("d:\\REPO"),
    ).toBe(query);
    const unsubscribe = query.subscribe(vi.fn());
    const another = query.subscribe(vi.fn());
    await vi.waitFor(() => expect(watch).toHaveBeenCalledOnce());
    expect(status).toHaveBeenCalledExactlyOnceWith("D:/repo");
    expect(query.getSnapshot().data?.branch).toBe("main");
    const done = vi.fn();
    const shutdown = runtime.shutdown().then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    finish(stop);
    await shutdown;
    expect(stop).toHaveBeenCalledOnce();
    unsubscribe();
    another();
    expect(query.getSnapshot()).toEqual({ loading: false });
    await expect(git.status("D:/repo")).rejects.toThrow("disposed");
  } finally {
    finish(stop);
    await runtime.shutdown();
    status.mockRestore();
    watch.mockRestore();
  }
});

it("revokes optional Git review queries and panels on unload and publishes the new service on reload", async () => {
  const key = "aaw-desktop/layout/git-review-rail-w";
  const previous = localStorage.getItem(key);
  localStorage.setItem(key, "300");
  let root: Context | undefined;
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    async (context) => {
      root = context;
      await installDesktopWorkbench(context);
    },
  );
  try {
    const { git, workbench } = await runtime.ready;
    const [fiber] = root?.registry.get(gitPlugin)?.fibers ?? [];
    if (!root || !fiber) throw new Error("Git fiber is missing");
    const before = workbench.getSnapshot();
    const files = before.panels.find(({ id }) => id === "files");
    expect(before.gitReview[0]?.service).toBe(git);
    expect(files).toBeDefined();
    expect(git.reviewRailWidth).toBe(300);
    git.setReviewRailWidth(370);

    await fiber.dispose();
    const unloaded = workbench.getSnapshot();
    expect(unloaded.gitReview).toEqual([]);
    expect(unloaded.panels.map(({ id }) => id)).not.toContain("git");
    expect(unloaded.panels.find(({ id }) => id === "files")).toBe(files);
    expect(() => git.query("D:/repo")).toThrow("disposed");
    git.setReviewRailWidth(400);

    await root.plugin(gitPlugin);
    await vi.waitFor(() => {
      const current = workbench.getSnapshot();
      expect(current.gitReview[0]?.service).toBe(root?.git);
      expect(current.gitReview[0]?.service).not.toBe(git);
      expect(current.panels.map(({ id }) => id)).toContain("git");
      expect(current.panels.find(({ id }) => id === "files")).toBe(files);
      expect(root?.git.reviewRailWidth).toBe(370);
    });
  } finally {
    await runtime.shutdown();
    if (previous === null) localStorage.removeItem(key);
    else localStorage.setItem(key, previous);
  }
});
