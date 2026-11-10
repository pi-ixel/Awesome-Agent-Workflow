import { expect, it, vi } from "vitest";
import { ProjectContext } from "../../src/plugins/project/workspace/ProjectContext.ts";
import { ProjectFactory } from "../../src/plugins/project/workspace/ProjectFactory.ts";
import type { SessionInfo } from "../../src/contracts/acp/protocol.ts";

it("loads only the two newest histories once, without replenishing", async () => {
  const project = new ProjectContext("/a");
  const query = vi.fn(() =>
    Promise.resolve([
      { sessionId: "old", cwd: "/a", updatedAt: "2025-01-01" },
      { sessionId: "new", cwd: "/a", updatedAt: "2026-01-01" },
      { sessionId: "middle", cwd: "/a", updatedAt: "2025-06-01" },
    ]),
  );
  const load = vi.fn(() => Promise.resolve());
  const first = project.warmSessions("agent", query, load, () => true);
  expect(project.warmSessions("agent", query, load, () => true)).toBe(first);
  await first;
  await project.warmSessions("agent", query, load, () => true);
  expect(load.mock.calls).toEqual([["new"], ["middle"]]);
  expect(query).toHaveBeenCalledOnce();
});

it("does not create sessions for an empty project", async () => {
  const load = vi.fn(() => Promise.resolve());
  await new ProjectContext("/a").warmSessions(
    "agent",
    () => Promise.resolve([]),
    load,
    () => true,
  );
  expect(load).not.toHaveBeenCalled();
});

it("invalidates late queries and permits a new Agent warmup", async () => {
  const project = new ProjectContext("/a");
  let finish!: (history: readonly SessionInfo[]) => void;
  const query = vi.fn(
    () =>
      new Promise<readonly SessionInfo[]>((resolve) => {
        finish = resolve;
      }),
  );
  const load = vi.fn(() => Promise.resolve());
  const old = project.warmSessions("old", query, load, () => true);
  await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
  project.invalidateWarmups(() => false);
  await project.warmSessions(
    "new",
    () => Promise.resolve([{ sessionId: "current", cwd: "/a" }]),
    load,
    () => true,
  );
  finish([{ sessionId: "stale", cwd: "/a" }]);
  await old;
  expect(load.mock.calls).toEqual([["current"]]);
});

it("project close waits for all already-started loads even when one fails", async () => {
  const project = new ProjectContext("/a");
  let finish!: () => void;
  const load = vi.fn((id: string) =>
    id === "one"
      ? Promise.reject(new Error("failed"))
      : new Promise<void>((resolve) => {
          finish = resolve;
        }),
  );
  const warming = project.warmSessions(
    "agent",
    () =>
      Promise.resolve([
        { sessionId: "one", cwd: "/a" },
        { sessionId: "two", cwd: "/a" },
      ]),
    load,
    () => true,
  );
  const rejected = expect(warming).rejects.toThrow("Session warmup failed");
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  let closed = false;
  const closing = project
    .close(() => Promise.resolve())
    .finally(() => {
      closed = true;
    });
  const closeRejected = expect(closing).rejects.toThrow(
    "Project cleanup failed",
  );
  await Promise.resolve();
  expect(closed).toBe(false);
  finish();
  await rejected;
  await closeRejected;
});

it("selects at most ten distinct projects", () => {
  const paths = new ProjectFactory().preloadPaths([
    "D:/A",
    "d:/a/",
    ...Array.from({ length: 12 }, (_, i) => `D:/p${i}`),
  ]);
  expect(paths).toHaveLength(10);
  expect(paths.at(-1)).toBe("D:/p8");
});
