import type * as ProjectOperationsModule from "../../../src/plugins/project/sessions/operations.ts";
import type * as CoordinatorFixtureModule from "../../helpers/projectCoordinatorFixture.ts";
import type { Context } from "cordis";
import * as projectPlugin from "../../../src/plugins/project/index.ts";
import { expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  detach: vi.fn(),
  close: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../helpers/projectCoordinatorFixture.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof CoordinatorFixtureModule>()),
  attachSessionPreloading: vi.fn(() => hooks.detach),
  closeRealRuntime: hooks.close,
}));

it("main-window bootstrap is singleton and each Project Fiber owns one preload subscription", async () => {
  const { startDesktopRuntime } = await import("../../../src/bootstrap/mainRuntime.ts");
  const { attachSessionPreloading } =
    await import("../../helpers/projectCoordinatorFixture.ts");
  let root: Context | undefined;
  const first = startDesktopRuntime(undefined, (context) => { root = context; }, { startProjectBackground: true });
  try {
    expect(startDesktopRuntime()).toBe(first);
    await first.ready;
    expect(attachSessionPreloading).toHaveBeenCalledTimes(1);
    const [fiber] = root?.registry.get(projectPlugin)?.fibers ?? [];
    if (!root || !fiber) throw new Error("Project Fiber is missing");
    expect(fiber.getEffects().map(({ label }) => label)).toContain("project:preloading");
    await fiber.dispose();
    expect(hooks.detach).toHaveBeenCalledTimes(1);
    expect(hooks.close).toHaveBeenCalledTimes(1);
    await root.plugin(projectPlugin, fiber.config as Parameters<typeof projectPlugin.apply>[1]);
    expect(attachSessionPreloading).toHaveBeenCalledTimes(2);
    expect(hooks.detach).toHaveBeenCalledTimes(1);
    const shutdown = first.shutdown();
    expect(first.shutdown()).toBe(shutdown);
    await shutdown;
    expect(hooks.detach).toHaveBeenCalledTimes(2);
    expect(hooks.close).toHaveBeenCalledTimes(2);
  } finally {
    await first.shutdown();
  }
});

vi.mock("../../../src/plugins/project/sessions/operations.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof ProjectOperationsModule>();
  const fixture = await import("../../helpers/projectCoordinatorFixture.ts");
  return {
    ...actual,
    createProjectOperations: (dependencies: Parameters<typeof actual.createProjectOperations>[0]) => ({
      ...actual.projectOperationsFrom(fixture, dependencies.workspace),
      dispose: undefined,
    }),
  };
});
