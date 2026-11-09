import type * as ProjectOperationsModule from "../../src/plugins/project/operations.ts";
import type * as CoordinatorFixtureModule from "../helpers/projectCoordinatorFixture.ts";
import { expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  detach: vi.fn(),
  close: vi.fn(() => Promise.resolve()),
}));
vi.mock("../helpers/projectCoordinatorFixture.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof CoordinatorFixtureModule>()),
  attachSessionPreloading: vi.fn(() => hooks.detach),
  closeRealRuntime: hooks.close,
}));

it("main-window bootstrap is singleton and cancelled mounts do not attach late", async () => {
  const {
    startDesktopRuntime,
    attachDesktopPreloading,
    shutdownDesktopRuntime,
  } = await import("../../src/bootstrap/mainRuntime.ts");
  const { attachSessionPreloading } =
    await import("../helpers/projectCoordinatorFixture.ts");
  const first = startDesktopRuntime();
  expect(startDesktopRuntime()).toBe(first);
  const cancelled = attachDesktopPreloading();
  cancelled();
  const mounted = attachDesktopPreloading();
  await first.ready;
  await Promise.resolve();
  expect(attachSessionPreloading).toHaveBeenCalledTimes(1);
  mounted();
  expect(hooks.detach).toHaveBeenCalledTimes(1);
  await shutdownDesktopRuntime();
  expect(hooks.close).toHaveBeenCalledTimes(1);
});

vi.mock("../../src/plugins/project/operations.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof ProjectOperationsModule>();
  const fixture = await import("../helpers/projectCoordinatorFixture.ts");
  return {
    ...actual,
    createProjectOperations: (dependencies: Parameters<typeof actual.createProjectOperations>[0]) => ({
      ...actual.projectOperationsFrom(fixture, dependencies.workspace),
      dispose: undefined,
    }),
  };
});
