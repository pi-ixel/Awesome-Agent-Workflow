import { describe, expect, it, vi } from "vitest";
import type { WorkflowEvent } from "../../../src/plugins/workflow/engine/protocol.ts";
import { NativeBridgeHub } from "../../../src/plugins/workflow/sessionHost/nativeBridge.ts";
import { WorkflowSessionMap } from "../../../src/plugins/workflow/sessionHost/sessionMap.ts";
import { createWorkflowService } from "../../../src/plugins/workflow/status/workflowService.ts";
import { emptyCanvasSnapshot } from "../../../src/plugins/workflow/status/snapshot.ts";

/**
 * 引擎线 WorkflowService 的行为面：bindWorkspace 作用域、事件驱动的
 * 去抖刷新、站点身份解析、reconcile 的 executed 分派、只读会话流缓冲。
 * 引擎客户端以桩驱动（request 记录方法与参数；emit 手动泵事件）。
 */
function harness() {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let respond: ((method: string, params: Record<string, unknown>) => unknown) | null = null;
  const client = {
    request: async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      requests.push({ method, params });
      return (respond?.(method, params) ?? null) as T;
    },
    subscribe: (listener: (event: WorkflowEvent) => void) => {
      pump.push(listener);
      return () => {};
    },
    hasActiveRuns: () => false,
    hasActiveRunsFromHost: async () => false,
  };
  const pump: Array<(event: WorkflowEvent) => void> = [];
  const bridge = new NativeBridgeHub();
  const sessions = new WorkflowSessionMap();
  const logger = { debug: vi.fn(), warn: vi.fn() };
  const agentLaunch = vi.fn((...args: [runId?: string]) => { void args; return { command: ["icode", "acp"], mcpServers: [] }; });
  const { service, onSessionActivity, dispose } = createWorkflowService({
    client: client as never,
    bridge,
    sessions,
    logger,
    agentLaunch,
  });
  return {
    service, onSessionActivity, dispose, requests, pump, bridge, sessions, logger, agentLaunch,
    respondWith(fn: (method: string, params: Record<string, unknown>) => unknown) {
      respond = fn;
    },
    emit(event: WorkflowEvent) {
      for (const listener of pump) listener(event);
    },
  };
}

describe("createWorkflowService", () => {
  it("selects the launch configuration using the run being resumed", async () => {
    const h = harness();
    h.service.bindWorkspace("D:/project");
    await h.service.resume("run-original");
    expect(h.agentLaunch).toHaveBeenCalledWith("run-original");
    expect(h.requests.find((item) => item.method === "resume")?.params).toMatchObject({ runId: "run-original", command: ["icode", "acp"] });
    h.dispose();
  });
  it("scopes list and snapshot requests to the bound workspace and resets on rebinding", async () => {
    const h = harness();
    h.respondWith((method) => (method === "list" ? [] : null));
    const unbind = h.service.bindWorkspace("D:/project");
    await vi.waitFor(() => expect(h.requests.some((r) => r.method === "list" && r.params.cwd === "D:/project")).toBe(true));

    const store = h.service.snapshot("run-1");
    expect(store.getState().runId).toBe("");
    h.respondWith((method) => {
      if (method !== "snapshot") return null;
      return {
        run: { runId: "run-1", name: "AAW dev", status: "running", args: null, result: null, failure: null },
        active: true, hasLease: false, retries: [], nodes: [], actors: [],
      };
    });
    h.emit({ type: "run-starting", runId: "run-1" });
    await vi.waitFor(() => expect(store.getState().runId).toBe("run-1"));

    // 重绑到另一工作区：快照流与列表按新作用域重建
    unbind();
    h.service.bindWorkspace("D:/other");
    await vi.waitFor(() => expect(h.requests.some((r) => r.method === "list" && r.params.cwd === "D:/other")).toBe(true));
    h.dispose();
  });

  it("debounces engine events into snapshot and list refreshes", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.respondWith((method) => (method === "list" ? [] : null));
      h.service.bindWorkspace("D:/project");
      // 打开快照流即取一次（占位快照的首次拉取）
      h.service.snapshot("run-1");
      await vi.advanceTimersByTimeAsync(1);
      const baseline = h.requests.filter((r) => r.method === "snapshot" && r.params.runId === "run-1").length;
      expect(baseline).toBe(1);
      h.emit({ type: "run-settled", runId: "run-1" });
      h.emit({ type: "run-starting", runId: "run-1" });
      // 去抖窗口内的连续事件只安排一次刷新
      expect(h.requests.filter((r) => r.method === "snapshot" && r.params.runId === "run-1")).toHaveLength(baseline);
      await vi.advanceTimersByTimeAsync(250);
      expect(h.requests.filter((r) => r.method === "snapshot" && r.params.runId === "run-1")).toHaveLength(baseline + 1);
      h.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  // 真机 2026-11-12：侧栏点开会话 → 导航重绑同一工作区 → 面板持有的快照流
  // 被清掉、此后不再随引擎事件刷新（画布停在节点一）。流的生命周期跟随订阅者。
  it("keeps a held snapshot stream live across workspace unbind/rebind", async () => {
    const h = harness();
    let status = "running";
    h.respondWith((method) =>
      method === "snapshot"
        ? { run: { runId: "run-1", name: "AAW dev", status, args: null, result: null, failure: null }, active: true, hasLease: false, retries: [], nodes: [], actors: [] }
        : [],
    );
    let unbind = h.service.bindWorkspace("D:/project");
    const store = h.service.snapshot("run-1");
    const seen: string[] = [];
    store.subscribe((state) => seen.push(state.run?.status ?? ""));
    await vi.waitFor(() => expect(store.getState().run?.status).toBe("running"));

    unbind();
    unbind = h.service.bindWorkspace("D:/project");
    status = "completed";
    h.emit({ type: "engine-event", runId: "run-1" });
    await vi.waitFor(() => expect(store.getState().run?.status).toBe("completed"));
    expect(seen.at(-1)).toBe("completed");
    unbind();
    h.dispose();
  });

  it("pins a stream to its run's project even after switching workspace", async () => {
    const h = harness();
    h.respondWith((method) =>
      method === "snapshot"
        ? { run: { runId: "run-1", name: "AAW dev", status: "running", args: null, result: null, failure: null }, active: true, hasLease: false, retries: [], nodes: [], actors: [] }
        : [],
    );
    h.service.bindWorkspace("D:/project");
    const store = h.service.snapshot("run-1");
    store.subscribe(() => {});
    await vi.waitFor(() => expect(store.getState().runId).toBe("run-1"));
    h.service.bindWorkspace("D:/other");
    const before = h.requests.length;
    h.emit({ type: "engine-event", runId: "run-1" });
    // 切项目后的列表刷新也会发请求（list / session-links）：只等快照刷新本身。
    await vi.waitFor(() => expect(h.requests.slice(before).some((r) => r.method === "snapshot")).toBe(true));
    const refresh = h.requests.slice(before).find((r) => r.method === "snapshot");
    expect(refresh?.params).toMatchObject({ runId: "run-1", cwd: "D:/project" });
    h.dispose();
  });

  it("re-attaches an evicted stream when it gains a subscriber again", async () => {
    const h = harness();
    let status = "running";
    h.respondWith((method) =>
      method === "snapshot"
        ? { run: { runId: "run-1", name: "AAW dev", status, args: null, result: null, failure: null }, active: true, hasLease: false, retries: [], nodes: [], actors: [] }
        : [],
    );
    h.service.bindWorkspace("D:/project");
    const store = h.service.snapshot("run-1");
    // React StrictMode：订阅 → 退订（订阅者归零，流被回收）→ 再订阅同一个流。
    store.subscribe(() => {})();
    store.subscribe(() => {});
    status = "completed";
    h.emit({ type: "engine-event", runId: "run-1" });
    await vi.waitFor(() => expect(store.getState().run?.status).toBe("completed"));
    h.dispose();
  });

  it("parses the siteId#ordinal site identity and requires evidence", async () => {
    const h = harness();
    h.service.bindWorkspace("D:/project");
    h.respondWith(() => null);
    await h.service.authorizeRetry("run-1", "world-read#1#2", "已核对记录");
    expect(h.requests.at(-1)).toMatchObject({
      method: "authorize-retry",
      params: { cwd: "D:/project", runId: "run-1", siteId: "world-read#1", ordinal: 2, evidence: "已核对记录" },
    });
    await expect(h.service.authorizeRetry("run-1", "ask#1", "  ")).rejects.toThrow("WORKFLOW_EVIDENCE_REQUIRED");
    await expect(h.service.authorizeRetry("run-1", "no-ordinal", "e")).rejects.toThrow("WORKFLOW_SITE_INVALID");
    await expect(h.service.reconcile("run-1", "ask#1", { executed: true, evidence: "e" })).resolves.toBeUndefined();
    h.dispose();
  });

  it("routes not-executed reconciliation to authorize-retry and executed to reconcile", async () => {
    const h = harness();
    h.service.bindWorkspace("D:/project");
    h.respondWith(() => null);
    const result = { status: "ready" };
    await h.service.reconcile("run-1", "ask#1#3", { executed: true, result, evidence: "evidence" });
    expect(h.requests.at(-1)).toMatchObject({
      method: "reconcile",
      params: { runId: "run-1", siteId: "ask#1", ordinal: 3, evidence: "evidence", result },
    });
    await h.service.reconcile("run-1", "ask#1#3", { executed: false, evidence: "未执行" });
    expect(h.requests.at(-1)).toMatchObject({
      method: "authorize-retry",
      params: { siteId: "ask#1", ordinal: 3, evidence: "未执行" },
    });
    h.dispose();
  });

  it("projects native session events into the session map and the subscribe channel", async () => {
    const h = harness();
    const events: WorkflowEvent[] = [];
    h.service.subscribe((event) => events.push(event));
    // 服务已在工厂里注册为 bridge 的投影登记处：经 projectNativeEvent 喂入
    // 即走真实管线（nativeSessionHost 的 emitSessionCreated/emitSessionEvent
    // 同一形状）。会话呈现归收养的 SessionView，服务只登记绑定表。
    h.bridge.projectNativeEvent({
      type: "acp-session-created",
      runId: "run-1",
      actor: "ask#1@1",
      sessionId: "session-1",
      persona: "需求确认",
    });
    h.bridge.projectNativeEvent({
      type: "acp-event",
      runId: "run-1",
      actor: "ask#1@1",
      instance: { siteId: "ask#1", ordinal: 1 },
      event: { type: "agent_message_chunk", sessionId: "session-1", text: "你好" },
    });
    expect(events.filter((event) => event.type === "acp-event")).toHaveLength(1);
    // 绑定表登记（引擎侧写入路径）
    expect(h.sessions.get("session-1")?.runId).toBe("run-1");
    expect(h.sessions.get("session-1")?.siteId).toBe("ask#1");
    h.dispose();
    // dispose 后投影断开
    const after = events.length;
    h.bridge.projectNativeEvent({
      type: "acp-event",
      runId: "run-1",
      actor: "ask#1@1",
      instance: { siteId: "ask#1", ordinal: 2 },
      event: { type: "agent_message_chunk", sessionId: "session-1", text: "再次" },
    });
    expect(events.length).toBe(after);
  });

  it("updates the session map from platform activity broadcasts (titles only)", () => {
    const h = harness();
    h.bridge.projectNativeEvent({
      type: "acp-session-created",
      runId: "run-1",
      actor: "ask#1@1",
      sessionId: "session-1",
      persona: "需求确认",
    });
    h.onSessionActivity("D:/project", {
      type: "session_info_update",
      sessionId: "session-1",
      title: "评审会话",
    } as never);
    expect(h.sessions.get("session-1")?.title).toBe("评审会话");
    expect(h.sessions.get("session-1")?.lastActivityAt).not.toBeNull();
    h.dispose();
  });

  it("exposes an empty snapshot stream placeholder before the engine answers", async () => {
    const h = harness();
    h.service.bindWorkspace("D:/project");
    const store = h.service.snapshot("run-9");
    expect(store.getState()).toEqual(emptyCanvasSnapshot());
    expect(store.getInitialState()).toEqual(emptyCanvasSnapshot());
    h.dispose();
    // dispose 后 isActive 翻转，动作方法拒绝执行
    expect(h.service.isActive()).toBe(false);
    await expect(h.service.stop("run-1")).rejects.toThrow("disposed");
  });
});

describe("session links for the sidebar groups", () => {
  it("fetches session-links with the run list for the bound workspace and parses it tolerantly", async () => {
    const h = harness();
    h.respondWith((method) => {
      if (method === "list") return [];
      if (method === "session-links") {
        return [
          { runId: "run-1", workflowName: "AAW dev", status: "running", active: true, links: [
            { sessionId: "s-1", actorName: "设计", nodes: [{ siteId: "ask#2", ordinal: 1, status: "completed", label: "设计" }, { siteId: "ask#4", ordinal: 2, status: "running", label: "设计修正", awaitingInput: true }] },
            { sessionId: "", actorName: "无会话" },
          ] },
          { runId: "" },
          "junk",
        ];
      }
      return null;
    });
    h.service.bindWorkspace("D:/project");
    await vi.waitFor(() => expect(h.service.sessionLinks().runs).toHaveLength(1));
    expect(h.requests.find((r) => r.method === "session-links")?.params).toEqual({ cwd: "D:/project" });
    const links = h.service.sessionLinks();
    expect(links.workspace).toBe("D:/project");
    expect(links.runs[0]).toEqual({
      runId: "run-1", workflowName: "AAW dev", title: "AAW dev", status: "running", active: true,
      links: [{ sessionId: "s-1", actorName: "设计", nodes: [
        { siteId: "ask#2", ordinal: 1, status: "completed", label: "设计", awaitingInput: false },
        { siteId: "ask#4", ordinal: 2, status: "running", label: "设计修正", awaitingInput: true },
      ] }],
    });
    // 切项目：旧项目的关联立即清掉。
    h.service.bindWorkspace("D:/other");
    expect(h.service.sessionLinks()).toEqual({ workspace: "D:/other", runs: [] });
    h.dispose();
  });

  it("keeps the run list when session-links fails", async () => {
    const h = harness();
    h.respondWith((method) => {
      if (method === "list") return [{ runId: "run-1", name: "AAW dev", status: "running", args: null, result: null, failure: null }];
      if (method === "session-links") throw new Error("boom");
      return null;
    });
    h.service.bindWorkspace("D:/project");
    await vi.waitFor(() => expect(h.service.runs()).toHaveLength(1));
    expect(h.service.sessionLinks().runs).toEqual([]);
    expect(h.logger.warn).toHaveBeenCalledWith("运行会话关联刷新失败", { reason: "boom" });
    h.dispose();
  });

  it("remembers a focus-run request until the panel takes it", () => {
    const h = harness();
    const events: WorkflowEvent[] = [];
    h.service.subscribe((event) => events.push(event));
    h.service.focusRun("run-9");
    expect(events).toContainEqual({ type: "focus-run", runId: "run-9" });
    expect(h.service.takeFocusRun()).toBe("run-9");
    expect(h.service.takeFocusRun()).toBe("");
    h.dispose();
  });
});
