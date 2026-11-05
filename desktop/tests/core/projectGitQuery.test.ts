import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectGitQuery } from "../../src/core/projectGitQuery.ts";
import type { GitSnapshot } from "../../src/core/panelService.ts";

const data: GitSnapshot = {
  repoRoot: "D:/repo",
  branch: "main",
  changes: [],
  watchPaths: ["D:/repo", "D:/repo/.git"],
};
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());

describe("项目 Git 共享查询", () => {
  it("手动刷新 Promise 等待进行中的读取及排队的新一轮，不提前报告完成", async () => {
    const finishes: ((value: GitSnapshot) => void)[] = [];
    const status = vi.fn(
      () => new Promise<GitSnapshot>((resolve) => finishes.push(resolve)),
    );
    const query = createProjectGitQuery("D:/repo", { status, watch: vi.fn() });
    const release = query.subscribe(vi.fn());
    await flush();
    let done = false;
    const manual = query.refresh().then(() => {
      done = true;
    });
    finishes[0]?.({ ...data, watchPaths: [] });
    await flush();
    expect(status).toHaveBeenCalledTimes(2);
    expect(done).toBe(false);
    finishes[1]?.({ ...data, branch: "fresh", watchPaths: [] });
    await manual;
    expect(query.getSnapshot().data?.branch).toBe("fresh");
    expect(done).toBe(true);
    release();
    await flush();
  });

  it("元数据监听降级不阻塞变更数据，注册成功后保留提示，刷新恢复后清除", async () => {
    const stop = vi.fn();
    const status = vi.fn().mockResolvedValue({
      ...data,
      watchWarning: "Git 公共目录监听受限",
    });
    const watch = vi.fn().mockResolvedValue(stop);
    const query = createProjectGitQuery("D:/repo", { status, watch });
    const release = query.subscribe(vi.fn());
    await flush();
    expect(query.getSnapshot()).toMatchObject({
      data: { branch: "main" },
      loading: false,
      watchError: "Git 公共目录监听受限",
    });
    expect(query.getSnapshot().error).toBeUndefined();
    status.mockResolvedValue(data);
    void query.refresh();
    await flush();
    expect(query.getSnapshot().watchError).toBeUndefined();
    expect(watch).toHaveBeenCalledOnce();
    release();
    await flush();
  });

  it("原生降级和监听注册错误分别恢复，手动刷新始终可用", async () => {
    const status = vi.fn().mockResolvedValue({
      ...data,
      watchWarning: "元数据目录不可用",
    });
    const watch = vi
      .fn()
      .mockRejectedValueOnce(new Error("注册失败"))
      .mockResolvedValue(vi.fn());
    const query = createProjectGitQuery("D:/repo", { status, watch });
    const release = query.subscribe(vi.fn());
    await flush();
    expect(query.getSnapshot().watchError).toContain("元数据目录不可用");
    expect(query.getSnapshot().watchError).toContain("注册失败");
    void query.refresh();
    await flush();
    expect(query.getSnapshot().watchError).toBe("元数据目录不可用");
    expect(query.getSnapshot().error).toBeUndefined();
    release();
    await flush();
  });

  it("两个消费者共享读取和监听，最后一位退出才释放，突发事件只刷新一次", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const stop = vi.fn();
    const status = vi.fn().mockResolvedValue(data);
    let changed: (() => void) | undefined;
    const watch = vi.fn((_paths, callback: () => void) => {
      changed = callback;
      return Promise.resolve(stop);
    });
    const query = createProjectGitQuery("D:/repo", { status, watch });
    const first = query.subscribe(vi.fn()),
      second = query.subscribe(vi.fn());
    await flush();
    expect(status).toHaveBeenCalledTimes(1);
    expect(watch).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 30; i++) changed?.();
    await vi.advanceTimersByTimeAsync(400);
    expect(status).toHaveBeenCalledTimes(2);
    first();
    await flush();
    expect(stop).not.toHaveBeenCalled();
    second();
    await flush();
    expect(stop).toHaveBeenCalledOnce();
    changed?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(status).toHaveBeenCalledTimes(2);
  });
  it("卸载后的迟到注册被释放，旧查询不能覆盖重新进入的项目快照", async () => {
    const finishes: ((snapshot: GitSnapshot) => void)[] = [];
    const status = vi.fn(
      () => new Promise<GitSnapshot>((resolve) => finishes.push(resolve)),
    );
    let finishWatch: ((stop: () => void) => void) | undefined;
    const watch = vi.fn(
      () =>
        new Promise<() => void>((resolve) => {
          finishWatch = resolve;
        }),
    );
    const query = createProjectGitQuery("D:/repo", { status, watch });
    const release = query.subscribe(vi.fn());
    await flush();
    release();
    await flush();
    const releaseAgain = query.subscribe(vi.fn());
    await flush();
    finishes[1]?.({ ...data, branch: "fresh" });
    await flush();
    finishes[0]?.({ ...data, branch: "old" });
    await flush();
    expect(query.getSnapshot().data?.branch).toBe("fresh");
    releaseAgain();
    await flush();
    const stop = vi.fn();
    finishWatch?.(stop);
    await flush();
    expect(stop).toHaveBeenCalledOnce();
  });
  it("刷新失败保留旧数据并标错；StrictMode重放不重复创建查询", async () => {
    const status = vi.fn().mockResolvedValue({ ...data, watchPaths: [] });
    const query = createProjectGitQuery("D:/repo", { status, watch: vi.fn() });
    query.subscribe(vi.fn())();
    const release = query.subscribe(vi.fn());
    await flush();
    expect(status).toHaveBeenCalledTimes(1);
    status.mockRejectedValueOnce(new Error("Git unavailable"));
    void query.refresh();
    await flush();
    expect(query.getSnapshot()).toMatchObject({
      data: { branch: "main" },
      error: "Git unavailable",
      loading: false,
    });
    release();
    await flush();
  });
  it("监听注册失败后刷新会重试，即使监听路径没有变化", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const stop = vi.fn();
    const status = vi.fn().mockResolvedValue(data);
    const watch = vi
      .fn()
      .mockRejectedValueOnce(new Error("暂时不可用"))
      .mockResolvedValue(stop);
    const query = createProjectGitQuery("D:/repo", { status, watch });
    const release = query.subscribe(vi.fn());
    await flush();
    expect(query.getSnapshot().watchError).toContain("暂时不可用");
    void query.refresh();
    await flush();
    expect(watch).toHaveBeenCalledTimes(2);
    expect(query.getSnapshot().watchError).toBeUndefined();
    release();
    await flush();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("注册前的错误使该代失效，迟到成功与旧错误不能破坏新监听", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const pending: {
      fail: (message: string) => void;
      finish: (stop: () => void) => void;
    }[] = [];
    const status = vi.fn().mockResolvedValue(data);
    const watch = vi.fn(
      (_paths, _changed, fail: (message: string) => void) =>
        new Promise<() => void>((finish) => pending.push({ fail, finish })),
    );
    const query = createProjectGitQuery("D:/repo", { status, watch });
    const release = query.subscribe(vi.fn());
    await flush();
    pending[0]?.fail("提前出错");
    expect(query.getSnapshot().watchError).toContain("提前出错");
    void query.refresh();
    await flush();
    expect(watch).toHaveBeenCalledTimes(2);
    const oldStop = vi.fn(),
      newStop = vi.fn();
    pending[1]?.finish(newStop);
    await flush();
    expect(query.getSnapshot().watchError).toBeUndefined();
    pending[0]?.finish(oldStop);
    await flush();
    pending[0]?.fail("迟到错误");
    expect(oldStop).toHaveBeenCalledOnce();
    expect(query.getSnapshot().watchError).toBeUndefined();
    expect(newStop).not.toHaveBeenCalled();
    pending[1]?.fail("运行时失败");
    expect(newStop).toHaveBeenCalledOnce();
    expect(query.getSnapshot().watchError).toContain("运行时失败");
    status.mockResolvedValueOnce({ ...data, watchPaths: [] });
    void query.refresh();
    await flush();
    expect(query.getSnapshot().watchError).toBeUndefined();
    release();
    await flush();
  });
});
