import { describe, expect, it, vi } from "vitest";
import { StandbyConnections } from "../../src/ui/standbyConnections.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("standby connections", () => {
  it("deduplicates startup/add/expand and hands each connection to only one caller", async () => {
    const dispose = vi.fn(async () => {});
    const pool = new StandbyConnections<object>(dispose);
    const connection = {};
    const prepare = vi.fn(() => Promise.resolve(connection));
    const a = pool.ensure("agent/project", prepare);
    const b = pool.ensure("agent/project", prepare);
    expect(a).toBe(b);
    await a;
    const taken = await Promise.all([
      pool.take("agent/project"),
      pool.take("agent/project"),
    ]);
    expect(taken.filter(Boolean)).toEqual([connection]);
    expect(prepare).toHaveBeenCalledTimes(1);
    await pool.close();
    expect(dispose).not.toHaveBeenCalled(); // ownership transferred to the working session
  });

  it("starts at most two processes and promotes the clicked project ahead of queued work", async () => {
    const pool = new StandbyConnections<string>(async () => {});
    const first = deferred<string>(),
      second = deferred<string>();
    const order: string[] = [];
    const a = pool.ensure("a", () => {
      order.push("a");
      return first.promise;
    });
    const b = pool.ensure("b", () => {
      order.push("b");
      return second.promise;
    });
    const c = pool.ensure("c", () => {
      order.push("c");
      return Promise.resolve("c");
    });
    const d = pool.ensure("d", () => {
      order.push("d");
      return Promise.resolve("d");
    });
    void pool.ensure("d", () => Promise.resolve("unused"), true);
    expect(order).toEqual(["a", "b"]);
    first.resolve("a");
    await d;
    expect(order.slice(0, 3)).toEqual(["a", "b", "d"]);
    second.resolve("b");
    await Promise.all([a, b, c]);
    await pool.close();
  });

  it("cancels queued work, rejects late handoff, and disposes a late connection on shutdown", async () => {
    const disposed: string[] = [];
    const pool = new StandbyConnections<string>((value) => {
      disposed.push(value);
      return Promise.resolve();
    }, 1);
    const pending = deferred<string>();
    let isCurrent!: () => boolean;
    const old = pool.ensure("old", (valid) => {
      isCurrent = valid;
      return pending.promise;
    });
    const queued = vi.fn(() => Promise.resolve("queued"));
    void pool.ensure("queued", queued);
    const closing = pool.close();
    expect(isCurrent()).toBe(false);
    expect(await old).toBeNull();
    expect(await pool.take("old")).toBeNull();
    pending.resolve("late");
    await closing;
    expect(disposed).toEqual(["late"]);
    expect(queued).not.toHaveBeenCalled();
  });
});
