import { expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  detach: vi.fn(),
  close: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../src/runtime/acp/runtimeHost.ts", () => ({
  attachSessionPreloading: vi.fn(() => hooks.detach),
  closeRealRuntime: hooks.close,
}));

it("main-window bootstrap is singleton and cancelled mounts do not attach late", async () => {
  const {
    startDesktopRuntime,
    attachDesktopPreloading,
    shutdownDesktopRuntime,
  } = await import("../../src/runtime/mainRuntime.ts");
  const { attachSessionPreloading } =
    await import("../../src/runtime/acp/runtimeHost.ts");
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
