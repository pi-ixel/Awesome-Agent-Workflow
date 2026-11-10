import { expect, it, vi } from "vitest";
import { NativePanelService } from "../../src/plugins/host/filesystem/panelService.ts";
import { installDesktopWorkbench } from "../../src/bootstrap/installDesktopWorkbench.ts";
import type { Context } from "cordis";
import * as gitPlugin from "../../src/plugins/git/index.ts";
import { createGitService } from "../../src/plugins/git/repository/git.ts";
import { createTestDesktopRuntime } from "../helpers/desktopRuntime.ts";
import { createGitReviewNavigation } from "../../src/plugins/git/ui/reviewNavigation.ts";
import { createNavigationGuard } from "../../src/plugins/workbench/navigation/navigationGuard.ts";
import { createRightPanelStore } from "../../src/plugins/workbench/layout/rightPanelStore.ts";
import { webviewStorage } from "../../src/plugins/host/storage/storage.ts";

it("drops a review opening queued for confirmation when its provider retires", () => {
  const guard = createNavigationGuard();
  const panels = createRightPanelStore(webviewStorage, guard);
  const review = createGitReviewNavigation({ panels: panels.snapshot });
  let resume!: () => void;
  let pending = true;
  guard.register({
    pending: () => pending,
    confirm: () => Promise.resolve(true),
    guard(action) {
      if (!pending) return true;
      resume = action;
      return false;
    },
  });
  const observer = vi.fn();
  review.requests.subscribe(observer);
  review.navigation.open("D:/git-waiting", "changes");
  expect(resume).toBeTypeOf("function");
  expect(observer).toHaveBeenCalledOnce();
  review.dispose();
  pending = false;
  resume();
  expect(observer).toHaveBeenCalledOnce();
  expect(panels.snapshot.getState().projects["d:/git-waiting"]).toBeUndefined();
  panels.dispose();
  guard.dispose();
});

it("releases a reactivated query even after its idle cache entry was evicted", async () => {
  const stop = vi.fn();
  const status = vi.fn((project: string) => Promise.resolve({
    repoRoot: project,
    branch: "main",
    changes: [],
    watchPaths: [project],
  }));
  const watch = vi.fn(() => Promise.resolve(stop));
  const git = createGitService(
    { status, watch, diff: vi.fn() },
    { getItem: () => null, setItem: () => {} },
  );
  const old = git.query("D:/old");
  for (let index = 0; index < 50; index++) git.query(`D:/repo-${index}`);
  expect(git.query("D:/old")).not.toBe(old);

  const listener = vi.fn();
  const unsubscribe = old.subscribe(listener);
  try {
    await vi.waitFor(() => expect(watch).toHaveBeenCalledOnce());
    expect(old.getSnapshot().data?.branch).toBe("main");
    listener.mockClear();
    git.dispose();
    await old.refresh();
    expect(stop).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
    expect(old.getSnapshot()).toEqual({ loading: false });
  } finally {
    unsubscribe();
    git.dispose();
  }
});

it("installs Git panels, shares a project query and releases a late watcher on shutdown", async () => {
  const status = vi.spyOn(NativePanelService.prototype, "gitStatus").mockResolvedValue({
    repoRoot: "D:/repo",
    branch: "main",
    changes: [],
    watchPaths: ["D:/repo"],
  });
  let finish!: (release: () => void) => void;
  const stop = vi.fn();
  const watch = vi.spyOn(NativePanelService.prototype, "watch").mockReturnValue(
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
    expect(query).not.toHaveProperty("dispose");
    expect(git.query("d:\\REPO")).toBe(query);
    const unsubscribe = query.subscribe(vi.fn());
    const observed = vi.fn();
    const another = query.subscribe(observed);
    await vi.waitFor(() => expect(watch).toHaveBeenCalledOnce());
    expect(status).toHaveBeenCalledExactlyOnceWith("D:/repo");
    expect(query.getSnapshot().data?.branch).toBe("main");
    observed.mockClear();
    const done = vi.fn();
    const shutdown = runtime.shutdown().then(done);
    await vi.waitFor(() => expect(query.getSnapshot()).toEqual({ loading: false }));
    expect(done).not.toHaveBeenCalled();
    finish(stop);
    await shutdown;
    expect(stop).toHaveBeenCalledOnce();
    expect(observed).not.toHaveBeenCalled();
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
    const review = before.panels.find(({ id }) => id === "git");
    const navigation = root.gitUi;
    expect(review).toBeDefined();
    expect(files).toBeDefined();
    expect(git.reviewRailWidth).toBe(300);
    git.setReviewRailWidth(370);
    expect(git.reviewRailWidth).toBe(370);

    await fiber.dispose();
    expect(root.get("gitUi")).toBeUndefined();
    const unloaded = workbench.getSnapshot();
    expect(unloaded.panels.map(({ id }) => id)).not.toContain("git");
    expect(unloaded.panels.find(({ id }) => id === "files")).toBe(files);
    expect(() => git.query("D:/repo")).toThrow("disposed");
    git.setReviewRailWidth(400);

    await root.plugin(gitPlugin);
    navigation.open("D:/retired", "changes");
    expect(workbench.panels.getState().projects["d:/retired"]).toBeUndefined();
    await vi.waitFor(() => {
      const current = workbench.getSnapshot();
      expect(root?.git).not.toBe(git);
      expect(root?.gitUi).not.toBe(navigation);
      expect(current.panels.find(({ id }) => id === "git")).not.toBe(review);
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
