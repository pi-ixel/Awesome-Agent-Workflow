import { describe, expect, it, vi } from "vitest";
import { createTestDesktopRuntime as createDesktopRuntime } from "../helpers/desktopRuntime.ts";
import { createTransportPair } from "../../src/runtime/acpBase/protocol/transport/inMemoryTransport.ts";

describe("Cordis desktop lifecycle", () => {
  it("owns pooled connections through shutdown without closing them twice", async () => {
    const runtime = createDesktopRuntime({
      attachPreloading: () => () => {},
      close: async () => {},
    });
    const { acpBase } = await runtime.ready;
    const closes: ReturnType<typeof vi.spyOn>[] = [];
    const pool = acpBase.createPool(() => {
      const pair = createTransportPair();
      closes.push(vi.spyOn(pair.client, "close"));
      return Promise.resolve(acpBase.createConnection(pair.client, 3));
    });
    await pool.warm();
    const targetCloses: ReturnType<typeof vi.spyOn>[] = [];
    const revision = await pool.prepareSwitch(() => {
      const pair = createTransportPair();
      targetCloses.push(vi.spyOn(pair.client, "close"));
      return Promise.resolve(acpBase.createConnection(pair.client, 3));
    });
    // Aborting also transfers ownership out of the standalone connection set.
    await pool.abortSwitch(revision);
    await runtime.shutdown();
    expect(closes).toHaveLength(4);
    for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
    for (const close of targetCloses) expect(close).toHaveBeenCalledTimes(1);
    expect(() => acpBase.createPool(() => Promise.reject(new Error()))).toThrow(
      "stopping",
    );
  });
  it("registers stable services and shares preload subscription across consumers", async () => {
    const detach = vi.fn();
    const attachPreloading = vi.fn(() => detach);
    const close = vi.fn(() => Promise.resolve());
    const runtime = createDesktopRuntime({ attachPreloading, close });
    const services = await runtime.ready;
    expect(await runtime.ready).toBe(services);
    const first = services.acp.attachPreloading();
    const second = services.acp.attachPreloading();
    expect(attachPreloading).toHaveBeenCalledTimes(1);
    first();
    first();
    expect(detach).not.toHaveBeenCalled();
    second();
    expect(detach).toHaveBeenCalledTimes(1);
    await runtime.shutdown();
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => services.acp.attachPreloading()).toThrow("stopping");
  });

  it("awaits business shutdown before closing base connections and is idempotent", async () => {
    const pair = createTransportPair();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const close = vi.fn(() => gate);
    const runtime = createDesktopRuntime({
      attachPreloading: () => () => {},
      close,
    });
    const { acpBase } = await runtime.ready;
    acpBase.createConnection(pair.client, 3);
    const shutdown = runtime.shutdown({ force: true });
    expect(runtime.shutdown()).toBe(shutdown);
    await Promise.resolve();
    expect(close).toHaveBeenCalledWith({ force: true });
    expect(pair.client.isClosed).toBe(false);
    finish();
    await shutdown;
    expect(pair.client.isClosed).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => acpBase.createConnection(pair.client, 3)).toThrow("stopping");
  });

  it("still closes base resources when business cleanup fails", async () => {
    const pair = createTransportPair();
    const runtime = createDesktopRuntime({
      attachPreloading: () => () => {},
      close: () => Promise.reject(new Error("cleanup failed")),
    });
    const { acpBase } = await runtime.ready;
    acpBase.createConnection(pair.client, 3);
    await expect(runtime.shutdown()).rejects.toThrow("shutdown failed");
    expect(pair.client.isClosed).toBe(true);
  });

  it("shutdown during installation waits for both services then closes once", async () => {
    const close = vi.fn(() => Promise.resolve());
    const runtime = createDesktopRuntime({
      attachPreloading: () => () => {},
      close,
    });
    await runtime.shutdown();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

it("routes project discovery, draft and focus operations through the Service and closes admission on shutdown", async () => {
  const draft = { isCurrent: () => true, fail: vi.fn() };
  const preloadSessionList = vi.fn(() => Promise.resolve());
  const renameSession = vi.fn();
  const beginDraft = vi.fn(() => draft);
  const focusSession = vi.fn(() => true);
  const runtime = createDesktopRuntime({
    attachPreloading: () => () => {},
    close: () => Promise.resolve(),
    preloadSessionList,
    renameSession,
    beginDraft,
    focusSession,
  });
  const { acp } = await runtime.ready;
  await acp.preloadSessionList("/project", true);
  acp.renameSession("owner", "same", "title");
  expect(acp.beginDraft("/project")).toBe(draft);
  expect(acp.focusSession("/project", "same", "owner")).toBe(true);
  expect(preloadSessionList).toHaveBeenCalledWith("/project", true);
  expect(renameSession).toHaveBeenCalledWith("owner", "same", "title");
  expect(focusSession).toHaveBeenCalledWith("/project", "same", "owner");
  await runtime.shutdown();
  expect(() => acp.beginDraft("/project")).toThrow("stopping");
  expect(() => acp.focusSession("/project", "same", "owner")).toThrow(
    "stopping",
  );
  expect(() => acp.renameSession("owner", "same", "late")).toThrow("stopping");
  expect(() => acp.preloadSessionList("/project")).toThrow("stopping");
});
