import { describe, expect, it, vi } from "vitest";
import { ProjectFactory } from "../../src/plugins/project/ProjectFactory.ts";
import type { SessionInfo } from "../../src/contracts/acpProtocol.ts";
function session(cwd: string): readonly SessionInfo[] {
  return [{ sessionId: cwd, cwd }];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("project catalog preparation", () => {
  it("deduplicates startup/add/expand and caches data after query cleanup", async () => {
    const dispose = vi.fn(() => Promise.resolve());
    const pool = new ProjectFactory();
    const connection = session("/project");
    const prepare = vi.fn(async () => {
      try {
        return connection;
      } finally {
        await dispose();
      }
    });
    const a = pool.prepare("/project", "agent", prepare);
    const b = pool.prepare("/project", "agent", prepare);
    expect(a).toBe(b);
    await a;
    expect(await pool.prepare("/project", "agent", prepare)).toBe(connection);
    expect(prepare).toHaveBeenCalledTimes(1);
    await pool.closePreparations();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("prepares at most two projects and promotes the clicked project ahead of queued work", async () => {
    const pool = new ProjectFactory();
    const first = deferred<readonly SessionInfo[]>(),
      second = deferred<readonly SessionInfo[]>();
    const order: string[] = [];
    const a = pool.prepare("/a", "agent", () => {
      order.push("a");
      return first.promise;
    });
    const b = pool.prepare("/b", "agent", () => {
      order.push("b");
      return second.promise;
    });
    const c = pool.prepare("/c", "agent", () => {
      order.push("c");
      return Promise.resolve(session("/c"));
    });
    const d = pool.prepare("/d", "agent", () => {
      order.push("d");
      return Promise.resolve(session("/d"));
    });
    void pool.prepare(
      "/d",
      "agent",
      () => Promise.resolve(session("/unused")),
      true,
    );
    expect(order).toEqual(["a", "b"]);
    first.resolve(session("/a"));
    await d;
    expect(order.slice(0, 3)).toEqual(["a", "b", "d"]);
    second.resolve(session("/b"));
    await Promise.all([a, b, c]);
    await pool.closePreparations();
  });

  it("cancels queued work and disposes late catalog resources on shutdown", async () => {
    const disposed: Array<readonly SessionInfo[]> = [];
    const pool = new ProjectFactory(1);
    const pending = deferred<readonly SessionInfo[]>();
    let isCurrent!: () => boolean;
    const old = pool.prepare("/old", "agent", (valid) => {
      isCurrent = valid;
      return pending.promise.then((value) => {
        disposed.push(value);
        return value;
      });
    });
    const queued = vi.fn(() => Promise.resolve(session("/queued")));
    void pool.prepare("/queued", "agent", queued);
    const closing = pool.closePreparations();
    expect(isCurrent()).toBe(false);
    expect(await old).toBeNull();
    const late = session("/old");
    pending.resolve(late);
    await closing;
    expect(disposed).toEqual([late]);
    expect(queued).not.toHaveBeenCalled();
  });
});

it("project close waits for late preparation and keeps another project usable", async () => {
  const dispose = vi.fn(() => Promise.resolve());
  const factory = new ProjectFactory(1);
  const pending = deferred<readonly SessionInfo[]>();
  const late = session("D:/one");
  const opening = factory.prepare("D:/one", "agent", async () => {
    try {
      return await pending.promise;
    } finally {
      await dispose();
    }
  });
  const second = factory.prepare("D:/two", "agent", () =>
    Promise.resolve(session("D:/two")),
  );
  let closed = false;
  const closing = factory.close("d:/ONE/", dispose).then(() => {
    closed = true;
  });
  expect(await opening).toBeNull();
  expect(closed).toBe(false);
  expect(
    await factory.prepare("D:/one", "agent", () => Promise.resolve(late)),
  ).toBeNull();
  pending.resolve(late);
  await closing;
  expect(dispose).toHaveBeenCalledOnce();
  expect((await second)?.[0]?.cwd).toBe("D:/two");
  expect(factory.list().map((project) => project.workspacePath)).toEqual([
    "D:/two",
  ]);
  await factory.closePreparations();
});

it("invalidated preparation cannot overwrite its replacement and cleanup failures are reported", async () => {
  const old = deferred<readonly SessionInfo[]>();
  const stale = session("/project");
  const current = session("/project");
  const dispose = vi.fn((value: readonly SessionInfo[]) =>
    value === stale
      ? Promise.reject(new Error("cleanup failed"))
      : Promise.resolve(),
  );
  const factory = new ProjectFactory();
  const first = factory.prepare("/project", "agent", async () => {
    const value = await old.promise;
    await dispose(value);
    return value;
  });
  factory.invalidatePreparations(() => false);
  expect(await first).toBeNull();
  expect(
    await factory.prepare("/project", "agent", async () => {
      await dispose(current);
      return current;
    }),
  ).toBe(current);
  old.resolve(stale);
  await expect(factory.closePreparations()).rejects.toThrow(
    "Project preparation cleanup failed",
  );
  expect(dispose).toHaveBeenCalledWith(stale);
  expect(dispose).toHaveBeenCalledWith(current);
});
