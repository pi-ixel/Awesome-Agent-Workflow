/* eslint-disable @typescript-eslint/require-await -- Immediate async test operations exercise scheduler admission. */
import { describe, expect, it } from "vitest";
import { RequestScheduler } from "../../../src/plugins/acpConnection/pool/RequestScheduler.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("connection request admission", () => {
  it.each([3, 5])("caps concurrent requests at %i", async (capacity) => {
    const scheduler = new RequestScheduler(capacity);
    const gates = Array.from({ length: capacity + 2 }, deferred);
    const started: number[] = [];
    const jobs = gates.map((gate, index) =>
      scheduler.request(async () => {
        started.push(index);
        await gate.promise;
      }),
    );
    await Promise.resolve();
    expect(started).toEqual(Array.from({ length: capacity }, (_, i) => i));
    gates[0]!.resolve();
    await jobs[0];
    expect(started).toEqual(Array.from({ length: capacity + 1 }, (_, i) => i));
    gates.forEach((gate) => gate.resolve());
    await Promise.all(jobs);
  });

  it("admits only one background request and prioritizes queued foreground work", async () => {
    const scheduler = new RequestScheduler(2);
    const first = deferred();
    const foreground = deferred();
    const order: string[] = [];
    const background1 = scheduler.request(() => first.promise, {
      background: true,
    });
    const background2 = scheduler.request(
      async () => {
        order.push("background");
      },
      { background: true },
    );
    const foreground1 = scheduler.request(() => foreground.promise);
    const foreground2 = scheduler.request(async () => {
      order.push("foreground");
    });
    first.resolve();
    await background1;
    await foreground2;
    await background2;
    expect(order).toEqual(["foreground", "background"]);
    foreground.resolve();
    await foreground1;
  });

  it("removes aborted queued work and rejects queued work on shutdown", async () => {
    const scheduler = new RequestScheduler(1);
    const gate = deferred();
    const running = scheduler.request(() => gate.promise);
    const controller = new AbortController();
    let executed = false;
    const aborted = scheduler.request(
      async () => {
        executed = true;
      },
      { signal: controller.signal },
    );
    const rejected = expect(aborted).rejects.toThrow("cancel waiting");
    controller.abort(new Error("cancel waiting"));
    await rejected;
    const queued = scheduler.request(async () => {
      executed = true;
    });
    const closed = expect(queued).rejects.toThrow("scheduler closed");
    scheduler.close();
    await closed;
    gate.resolve();
    await running;
    expect(executed).toBe(false);
    await expect(scheduler.request(async () => {})).rejects.toThrow(
      "scheduler closed",
    );
  });

  it("returns capacity after a synchronous failure", async () => {
    const scheduler = new RequestScheduler(1);
    await expect(
      scheduler.request(() => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    await expect(scheduler.request(async () => 42)).resolves.toBe(42);
  });

  it("does not free a running request slot merely because its caller aborts", async () => {
    const scheduler = new RequestScheduler(1);
    const controller = new AbortController();
    const gate = deferred();
    const running = scheduler.request(() => gate.promise, {
      signal: controller.signal,
    });
    await Promise.resolve();
    let nextStarted = false;
    const next = scheduler.request(async () => {
      nextStarted = true;
    });
    controller.abort();
    await Promise.resolve();
    expect(nextStarted).toBe(false);
    gate.resolve();
    await Promise.all([running, next]);
    expect(nextStarted).toBe(true);
  });

  it("preserves rejection even when the operation rejects with undefined", async () => {
    const scheduler = new RequestScheduler(1);
    await expect(
      scheduler.request(
        () =>
          new Promise((_, reject) => {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Regression: undefined rejection must not become success.
            reject();
          }),
      ),
    ).rejects.toBeUndefined();
    await expect(scheduler.request(async () => "next")).resolves.toBe("next");
  });

  it("promotes a queued preload without waiting for another background load", async () => {
    const scheduler = new RequestScheduler(2);
    const gate = deferred();
    const background = scheduler.request(() => gate.promise, {
      background: true,
    });
    const controller = new AbortController();
    let calls = 0;
    const preload = scheduler.request(
      async () => {
        calls++;
      },
      { background: true, signal: controller.signal },
    );
    await Promise.resolve();
    expect(calls).toBe(0);
    scheduler.promote(controller.signal);
    await preload;
    expect(calls).toBe(1);
    gate.resolve();
    await background;
  });
});
