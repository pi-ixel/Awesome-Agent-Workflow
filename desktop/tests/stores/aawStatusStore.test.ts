import type { AcpSessionEvent } from "../../src/plugins/acpRuntime/events.ts";
/**
 * aawStatusStore 回归：真实通路（loader → 解析 → 状态）、容错处理
 * 与会话事件节流自动刷新。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAawStatusStore,
  type AawStatusLoader,
} from "../../src/plugins/workflow/status/statusStore.ts";
import { AawQueryError } from "../../src/plugins/workflow/cli/aawCli.ts";
import {
  sampleNextJson,
  sampleSrListJson,
  sampleStatusJson,
} from "../fixtures/aawWorkflowSamples.ts";

/** 最小会话事件样本（agent 消息块，自动刷新的典型触发源）。 */
const chunkEvent: AcpSessionEvent = {
  type: "agent_message_chunk",
  sessionId: "s-1",
  text: "正在执行 aaw next…",
};

interface LoaderCounts {
  listSrs: number;
  readStatus: number;
  readNext: number;
}

/** 可计数的假数据源：缺省返回夹具样本，可按需覆写。 */
function makeLoader(
  overrides: Partial<
    Record<"listSrs" | "readStatus" | "readNext" | "readPlan", unknown>
  > = {},
): AawStatusLoader & { counts: LoaderCounts } {
  const counts: LoaderCounts = { listSrs: 0, readStatus: 0, readNext: 0 };
  return {
    counts,
    listSrs: () => {
      counts.listSrs += 1;
      return Promise.resolve(overrides.listSrs ?? sampleSrListJson);
    },
    readStatus: () => {
      counts.readStatus += 1;
      return Promise.resolve(overrides.readStatus ?? sampleStatusJson);
    },
    readNext: () => {
      counts.readNext += 1;
      return Promise.resolve(overrides.readNext ?? sampleNextJson);
    },
    readPlan: () => {
      // 老口径默认：plan 不可用（null 输出会被解析为不可解析并记错误，
      // 测试断言按需覆写）
      return Promise.resolve(overrides.readPlan ?? { ok: false });
    },
  };
}

const store = createAawStatusStore();

beforeEach(() => {
  store.getState().reset();
  store.getState().setAutoRefresh(true);
  store.getState().bindLoader(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("refresh 真实通路", () => {
  it("未绑定 loader 时为安全的空操作", async () => {
    await store.getState().refresh();
    expect(store.getState().isLoading).toBe(false);
    expect(store.getState().lastError).toBeNull();
  });

  it("经 loader 读取并解析 status / next，自动选中首个 SR", async () => {
    const loader = makeLoader();
    store.getState().bindLoader(loader);
    await store.getState().refresh();

    const state = store.getState();
    expect(state.srs).toEqual(["SR-001", "SR-004"]);
    expect(state.currentSr).toBe("SR-001");
    expect(state.status?.steps).toHaveLength(6);
    expect(state.next?.ready).toHaveLength(1);
    expect(state.lastError).toBeNull();
    expect(state.lastRefreshedAt).not.toBeNull();
    expect(loader.counts).toEqual({ listSrs: 1, readStatus: 1, readNext: 1 });
  });

  it("刷新发现新 SR 时自动切换（会话里刚创建的 SR 即正在运行的需求）", async () => {
    const loader = makeLoader({
      listSrs: { srs: ["SR-123"] },
    });
    store.getState().bindLoader(loader);
    await store.getState().refresh();
    expect(store.getState().currentSr).toBe("SR-123");

    // 会话中创建了 SR-001：下一次刷新列表里出现新 SR → 时间线跟着切
    const grown = makeLoader({
      listSrs: { srs: ["SR-001", "SR-123"] },
    });
    store.getState().bindLoader(grown);
    await store.getState().refresh();
    expect(store.getState().currentSr).toBe("SR-001");
  });

  it("selectSr 切换当前 SR 并触发该 SR 的刷新", async () => {
    const loader = makeLoader();
    store.getState().bindLoader(loader);
    await store.getState().refresh();
    store.getState().selectSr("SR-004");
    await vi.waitFor(() => {
      // status 来自切换后的刷新（夹具恒返回 SR-004 的样本）
      expect(store.getState().status?.sr).toBe("SR-004");
    });
    expect(store.getState().currentSr).toBe("SR-004");
    expect(loader.counts.readStatus).toBe(2);
  });

  it("重入保护：并发 refresh 只执行一份", async () => {
    const loader = makeLoader();
    store.getState().bindLoader(loader);
    await Promise.all([store.getState().refresh(), store.getState().refresh()]);
    expect(loader.counts.listSrs).toBe(1);
  });

  it("loader 抛错时记录中文错误，不抛出", async () => {
    store.getState().bindLoader({
      listSrs: () => Promise.reject(new Error("ENOENT: aaw.py 不存在")),
      readStatus: () => Promise.resolve(sampleStatusJson),
      readNext: () => Promise.resolve(sampleNextJson),
      readPlan: () => Promise.resolve({ ok: false }),
    });
    await store.getState().refresh();
    expect(store.getState().lastError).toMatch(/status 读取失败.*ENOENT/);
  });

  it("输出无法解析或错误信封时记录原因", async () => {
    store.getState().bindLoader(
      makeLoader({
        listSrs: "not-json",
        readStatus: {
          ok: false,
          error: { code: "WORKFLOW_NOT_FOUND", message: "SR 不存在" },
        },
      }),
    );
    await store.getState().refresh();
    // listSrs 解析失败 → currentSr 保持 null，后续 status/next 不再读取
    expect(store.getState().lastError).toMatch(/无法解析/);

    store.getState().reset();
    store.getState().bindLoader(
      makeLoader({
        readStatus: {
          ok: false,
          error: { code: "WORKFLOW_NOT_FOUND", message: "SR 不存在" },
        },
      }),
    );
    await store.getState().refresh();
    const error = store.getState().lastError ?? "";
    expect(error).toMatch(/WORKFLOW_NOT_FOUND/);
    expect(error).toMatch(/SR 不存在/);
  });
});

describe("refresh 落地与容错", () => {
  it("旧 SR 被迁移门禁拦住时仍保留列表，可切换其他 SR，重复错误只显示一次", async () => {
    const migration = new AawQueryError("MIGRATION_NEEDED", "旧布局需要迁移");
    const loader = makeLoader();
    store.getState().bindLoader({
      ...loader,
      readStatus: (sr) =>
        sr === "SR-001"
          ? Promise.reject(migration)
          : Promise.resolve(sampleStatusJson),
      readNext: (sr) =>
        sr === "SR-001"
          ? Promise.reject(migration)
          : Promise.resolve(sampleNextJson),
    });
    await store.getState().refresh();
    expect(store.getState()).toMatchObject({
      srs: ["SR-001", "SR-004"],
      currentSr: "SR-001",
      status: null,
      lastError: migration.message,
    });
    store.getState().selectSr("SR-004");
    await vi.waitFor(() => expect(store.getState().status?.sr).toBe("SR-004"));
    expect(store.getState().lastError).toBeNull();
  });

  it("自动选中新 SR 后详情失败，不显示旧 SR 的进度", async () => {
    store.getState().bindLoader(makeLoader());
    await store.getState().refresh();
    store.getState().bindLoader({
      ...makeLoader({ listSrs: { srs: ["SR-001", "SR-004", "SR-NEW"] } }),
      readStatus: () => Promise.reject(new Error("详情失败")),
    });
    await store.getState().refresh();
    expect(store.getState()).toMatchObject({
      currentSr: "SR-NEW",
      status: null,
      next: null,
      plan: null,
      lastRefreshedAt: null,
    });
    expect(store.getState().srs).toContain("SR-NEW");
  });

  it("切项目清空快照，旧查询完成不能覆盖新项目或解除新请求锁", async () => {
    store.getState().bindLoader(makeLoader(), "D:/old");
    await store.getState().refresh();
    let finishOld!: (value: unknown) => void;
    store.getState().bindLoader(
      makeLoader({
        listSrs: new Promise((resolve) => {
          finishOld = resolve;
        }),
      }),
      "D:/old",
    );
    const oldQuery = store.getState().refresh();
    let finishNew!: (value: unknown) => void;
    const nextLoader = makeLoader({
      listSrs: new Promise((resolve) => {
        finishNew = resolve;
      }),
    });
    store.getState().bindLoader(nextLoader, "D:/new");
    expect(store.getState()).toMatchObject({
      srs: [],
      status: null,
      next: null,
      plan: null,
      lastRefreshedAt: null,
    });
    const newQuery = store.getState().refresh();
    finishOld({ srs: ["SR-OLD"] });
    await oldQuery;
    expect(store.getState()).toMatchObject({
      isLoading: true,
      srs: [],
      lastError: null,
    });
    await store.getState().refresh();
    expect(nextLoader.counts.listSrs).toBe(1);
    finishNew({ srs: [] });
    await newQuery;
    expect(store.getState()).toMatchObject({
      isLoading: false,
      srs: [],
      lastError: null,
    });
    expect(store.getState().lastRefreshedAt).not.toBeNull();
  });

  it("详情读取期间切换配置，旧详情不能覆盖新结果", async () => {
    let finishDetail!: (value: unknown) => void;
    store.getState().bindLoader(
      makeLoader({
        readStatus: new Promise((resolve) => {
          finishDetail = resolve;
        }),
      }),
    );
    const oldQuery = store.getState().refresh();
    await Promise.resolve();
    store.getState().bindLoader(makeLoader({ listSrs: { srs: [] } }));
    await store.getState().refresh();
    finishDetail(sampleStatusJson);
    await oldQuery;
    expect(store.getState()).toMatchObject({
      srs: [],
      currentSr: null,
      status: null,
      next: null,
      lastError: null,
    });
  });

  it("错误信封带空列表仍然是失败，保留成功快照", async () => {
    store.getState().bindLoader(makeLoader());
    await store.getState().refresh();
    const snapshot = store.getState();
    store.getState().bindLoader(
      makeLoader({
        listSrs: {
          ok: false,
          srs: [],
          error: { code: "READ_FAILED", message: "读取失败" },
        },
      }),
    );
    await store.getState().refresh();
    expect(store.getState().lastError).toContain("READ_FAILED");
    expect(store.getState().srs).toBe(snapshot.srs);
    expect(store.getState().status).toBe(snapshot.status);
    expect(store.getState().lastRefreshedAt).toBe(snapshot.lastRefreshedAt);
  });

  it("selectSr + refresh 落地该 SR 的完整数据状态", async () => {
    store.getState().bindLoader(makeLoader());
    await store.getState().refresh();
    store.getState().selectSr("SR-004");
    await vi.waitFor(() => {
      expect(store.getState().status?.sr).toBe("SR-004");
    });
    const state = store.getState();
    expect(state.srs).toEqual(["SR-001", "SR-004"]);
    expect(state.currentSr).toBe("SR-004");
    expect(state.status?.steps).toHaveLength(6);
    expect(state.next?.ready).toHaveLength(1);
    expect(state.lastError).toBeNull();
    expect(state.lastRefreshedAt).not.toBeNull();
  });

  it("输出无法解析时不落地且既有状态不被清空", async () => {
    // 第一轮：正常数据落地（夹具的 status 载荷描述的是 SR-004 的工作流）
    store.getState().bindLoader(makeLoader());
    await store.getState().refresh();
    const landedStatus = store.getState().status;
    expect(store.getState().srs).toEqual(["SR-001", "SR-004"]);
    expect(landedStatus).not.toBeNull();

    // 第二轮：status / next 返回无法解析的载荷——记录错误且不清空既有状态
    store
      .getState()
      .bindLoader(makeLoader({ readStatus: 42, readNext: "not-json" }));
    await store.getState().refresh();
    expect(store.getState().lastError).toMatch(/无法解析/);
    expect(store.getState().status).toBe(landedStatus);
    expect(store.getState().next?.ready).toHaveLength(1);
  });
});

describe("会话事件自动刷新（节流）", () => {
  it("冷却期外的首个事件立即刷新，冷却期内的事件尾随补一次", async () => {
    vi.useFakeTimers();
    // 系统时间取足够大的值，覆盖任何此前测试遗留的节流时间戳
    vi.setSystemTime(new Date("2026-10-20T23:00:00Z"));
    const loader = makeLoader();
    store.getState().bindLoader(loader);
    await store.getState().refresh();
    const before = loader.counts.listSrs;

    // 距上次刷新远超冷却窗口 → leading 立即触发
    store.getState().handleSessionEvent(chunkEvent);
    expect(loader.counts.listSrs).toBe(before + 1);

    // 冷却期内的连发事件只排一次尾随
    store.getState().handleSessionEvent(chunkEvent);
    store.getState().handleSessionEvent(chunkEvent);
    expect(loader.counts.listSrs).toBe(before + 1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(loader.counts.listSrs).toBe(before + 2);
  });

  it("关闭自动刷新后事件不再触发", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T10:00:00Z"));
    const loader = makeLoader();
    store.getState().bindLoader(loader);
    await store.getState().refresh();
    const before = loader.counts.listSrs;

    store.getState().setAutoRefresh(false);
    store.getState().handleSessionEvent(chunkEvent);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(loader.counts.listSrs).toBe(before);
  });

  it("未绑定 loader 或无当前 SR 时不刷新", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T10:00:00Z"));
    // 无 loader
    store.getState().handleSessionEvent(chunkEvent);
    // 有 loader 但无 SR（空列表）
    const loader = makeLoader({ listSrs: { ok: true, srs: [] } });
    store.getState().bindLoader(loader);
    store.getState().handleSessionEvent(chunkEvent);
    expect(loader.counts.listSrs).toBe(0);
  });
});
