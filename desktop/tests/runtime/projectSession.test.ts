import { describe, expect, it, vi } from "vitest";
import { ProjectFactory } from "../../src/plugins/project/ProjectFactory.ts";
import { SessionFactory } from "../../src/plugins/project/conversation/SessionFactory.ts";
import { session } from "../helpers/sessionRuntime.ts";
import { createTestDesktopRuntime } from "../helpers/desktopRuntime.ts";

async function projectFor(runtime: ReturnType<typeof session>) {
  const desktop = createTestDesktopRuntime({
    attachPreloading: () => () => {},
    close: () => Promise.resolve(),
    findSession: () => runtime,
  });
  const { project } = await desktop.ready;
  const target = {
    workspacePath: runtime.workspacePath,
    agentKey: runtime.agentKey,
    sessionId: runtime.session.sessionId,
  };
  return { project, target, shutdown: () => desktop.shutdown() };
}

describe("project and session ownership", () => {
  it("finishes local cleanup and reports failures when resource release fails", async () => {
    const runtime = session("D:/a");
    const { project, target, shutdown } = await projectFor(runtime);
    const detach = vi.fn();
    const activity = vi.fn();
    runtime.detachViews = detach;
    runtime.disposeActivity = activity;
    runtime.store.getState().enqueuePrompt("queued");
    const release = vi.fn(() => Promise.reject(new Error("release failed")));
    const closing = runtime.close({ release });
    expect(runtime.disposed).toBe(true);
    expect(project.send(target, "late")).toBe(false);
    await expect(closing).rejects.toThrow("Session cleanup failed");
    expect(detach).toHaveBeenCalledTimes(1);
    expect(activity).toHaveBeenCalledTimes(1);
    expect(runtime.store.getState().queuedPrompts).toEqual([]);
    expect(runtime.close({ release })).toBe(closing);
    expect(release).toHaveBeenCalledTimes(1);
    await shutdown();
  });

  it("stops recovery through the supplied release operation without killing its session", async () => {
    const runtime = session("D:/a"),
      candidate = session("D:/a").session;
    expect(candidate).not.toHaveProperty("kill");
    const wake = vi.fn();
    runtime.recoveryControl = { stopped: false, wake, replacement: candidate };
    const release = vi.fn(() => Promise.resolve());
    await runtime.stopRecovery(release);
    expect(runtime.recoveryControl.stopped).toBe(true);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(candidate, true);
  });
  it("reuses project identity across Agents and isolates project shutdown", async () => {
    const factory = new ProjectFactory();
    const a = session("D:/a"),
      anotherAgent = session("D:/a", "two"),
      b = session("D:/b");
    factory.addSession(a);
    factory.addSession(anotherAgent);
    factory.addSession(b);
    expect(factory.open("D:/a").sessions.size).toBe(2);
    const dispose = vi.fn(() => Promise.resolve());
    await factory.close("D:/a", dispose);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect([...factory.sessions()]).toEqual([b]);
    expect(factory.hasSession(b)).toBe(true);
  });

  it("blocks attachment during project close and reuses session close work", async () => {
    const factory = new ProjectFactory(),
      a = session("D:/a");
    factory.addSession(a);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const cleanup = vi.fn(() => gate);
    const first = a.close({ release: cleanup });
    expect(a.close({ release: cleanup })).toBe(first);
    const closing = factory.close("D:/a", () => first);
    expect(() => factory.addSession(session("D:/a"))).toThrow("closing");
    finish();
    await closing;
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(factory.list()).toHaveLength(0);
  });

  it("deduplicates an in-flight history load but permits retries after failure", async () => {
    const factory = new SessionFactory(() => Promise.resolve([]));
    let finish!: (value: number) => void;
    const work = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    const first = factory.open("agent/project/history", work);
    expect(factory.open("agent/project/history", work)).toBe(first);
    await Promise.resolve();
    finish(1);
    await expect(first).resolves.toBe(1);
    expect(work).toHaveBeenCalledTimes(1);
    await expect(
      factory.open("agent/project/history", () =>
        Promise.reject(new Error("load failed")),
      ),
    ).rejects.toThrow("load failed");
    await expect(
      factory.open("agent/project/history", () => Promise.resolve(2)),
    ).resolves.toBe(2);
  });

  it("project commands and store actions share one queue consumer", async () => {
    const runtime = session("D:/a");
    const { project, target, shutdown } = await projectFor(runtime);
    const prompt = vi.fn(() =>
      Promise.resolve({ stopReason: "end_turn" as const }),
    );
    runtime.store.getState().bindSession({ prompt, cancel: () => {} });
    project.send(target, "first");
    runtime.store.getState().enqueuePrompt("second");
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    expect(prompt.mock.calls).toEqual([["first"], ["second"]]);
    expect(runtime.store.getState().queuedPrompts).toEqual([]);
    await shutdown();
  });
});
