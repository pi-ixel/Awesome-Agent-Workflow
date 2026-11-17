import { bindTestLayout, useWorkbenchUiStore } from "../helpers/layout.ts";
import { useApprovalStore, useSessionStore } from "../helpers/foreground.ts";
import type * as ProjectOperationsModule from "../../src/plugins/project/sessions/operations.ts";
import { startDesktopRuntime } from "../../src/bootstrap/mainRuntime.ts";
import type * as AcpSessionModule from "../../src/plugins/acpRuntime/protocol/session.ts";
import type { AcpTransport } from "../../src/plugins/host/types.ts";
import { createTestDesktopRuntime as createDesktopRuntime } from "../helpers/desktopRuntime.ts";
import {
  bindRuntimeServices,
  switchRuntimeAgent,
  projectFactory,
  projectIndexes,
} from "../helpers/projectCoordinatorFixture.ts";
import { standardAcpPeer } from "../helpers/standardAcpPeer.ts";
import { AcpClosedError } from "../../src/plugins/acpRuntime/service.ts";
import { createDemoHost } from "../../src/plugins/host/adapters/host.ts";
import {
  recoverSessionRuntime,
  stopSessionRecoveryRuntime,
  renameCatalogSession,
  busyRuntimeSessionIds,
} from "../helpers/projectCoordinatorFixture.ts";
import { manualTitleOf } from "../../src/plugins/project/sessions/sessionTitles.ts";
import { AcpResponseError } from "../../src/plugins/acpRuntime/service.ts";
import { FakeAcpSession } from "../fixtures/fakeAcpSession.ts";
import { attachSessionPreloading } from "../helpers/projectCoordinatorFixture.ts";
import {
  sessionActivityKey,
} from "../../src/plugins/project/sessions/sessionActivityStore.ts";
import {
  hasRunningSessions,
  preloadSessionList,
} from "../helpers/projectCoordinatorFixture.ts";
/**
 * realRuntime 装配测试（F1 会话历史持久化的协议侧装配）：
 *
 * - initialize 后先 session/list；有历史会话则 loadSession 恢复最近一个，
 *   且会话列表不含 UUID 标题（首条用户消息 / 时间兜底）；
 * - loadSession 失败（会话过期 / 能力缺失）回落 newSession，打开不失败；
 * - 无历史会话直接新建，并把本地消息快照灌回（专用 restore action）；
 * - loadSession 已回放历史时，本地快照不覆盖回放结果；
 * - switchRealSession：切换历史会话成功；失败回滚当前视图且不聚焦；
 * - P0-1：早退 / spawn 失败一律解除「连接中」并回填连接失败态（UI 横幅
 *   / 徽标数据源），成功连接清除失败态；
 * - P0-4：权限请求按设置的「审批默认模式」分派（ask 弹窗 / auto-allow
 *   放行，白名单落空回退弹窗）；
 * - P1-8：恢复历史会话后内容区自动切到会话视图，全新会话保持总览。
 *
 * 替身说明：AcpSession 以脚本化 fake 替换（tests/fixtures/fakeAcpSession.ts），
 * transport 打桩，宿主经 window.__TAURI_INTERNALS__ 伪装成 Tauri 环境。
 */
import {
  afterEach,
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { readChrysArchive } from "../../src/plugins/agents/enhancements/icode/chrysArchive.ts";

vi.mock("../../src/plugins/agents/enhancements/icode/chrysArchive.ts", () => ({
  readChrysArchive: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../../src/plugins/acpRuntime/protocol/session.ts", async (importOriginal) => {
  const { FakeAcpSession } = await import("../fixtures/fakeAcpSession.ts");
  const actual = await importOriginal<typeof AcpSessionModule>();
  return { ...actual, AcpSession: FakeAcpSession };
});

vi.mock(
  "../../src/plugins/acpConnection/protocol/transport/tauriStdioTransport.ts",
  () => ({
    createTauriStdioTransport: vi.fn(),
  }),
);

import {
  closeRealRuntime,
  openRealWorkspace,
  projectPreferences,
  switchRealSession,
} from "../helpers/projectCoordinatorFixture.ts";
import type { AgentsService } from "../../src/plugins/agents/service.ts";
import { mutableWorkspace } from "../helpers/workspace.ts";
let useWorkspaceStore: ReturnType<typeof mutableWorkspace>;
import {
  fakeSessionControl,
  resetFakeSessionControl,
} from "../fixtures/fakeAcpSession.ts";
import { createTauriStdioTransport } from "../../src/plugins/acpConnection/protocol/transport/tauriStdioTransport.ts";
import type { ProjectService } from "../../src/plugins/project/service.ts";
let navigationProject: ProjectService;

// transport 工厂的打桩句柄：按用例脚本化 spawn 失败
const spawnTransport = vi.mocked(
  createTauriStdioTransport as (
    ...args: Parameters<typeof createTauriStdioTransport>
  ) => Promise<AcpTransport>,
);

const WORKSPACE = "D:/demo-project";
const LOG_KEY = `aaw-desktop/session-log/${encodeURIComponent(WORKSPACE)}`;

/** chrys 实际下发的两项权限选项（server.py _request_permission）。 */
const CHRYS_PERMISSION_OPTIONS = [
  { optionId: "allow", name: "Allow once", kind: "allow_once" as const },
  { optionId: "reject", name: "Reject once", kind: "reject_once" as const },
];

const TOOL_CALL = { toolCallId: "call-1", title: "执行命令" };

type MutableWindow = Record<string, unknown>;

function resetAll(): void {
  window.localStorage.clear();
  resetFakeSessionControl();
  spawnTransport
    .mockReset()
    .mockImplementation(() => Promise.resolve(standardAcpPeer().client));
  const session = useSessionStore.getState();
  void session.setSessionLogTarget(null);
  session.clear();
  session.bindSession(null);
  session.setSessions([]);
  useSessionStore.setState({
    activeSessionId: null,
    sessionsByPath: {},
    modelLabel: null,
    approvalMode: null,
  });
  const workspace = useWorkspaceStore.getState();
  workspace.closeWorkspace();
  workspace.clearSelection();
  useWorkspaceStore.setState({
    lastConnectError: null,
    recentWorkspaces: [],
    pinnedPaths: [],
  });
  useApprovalStore.getState().clear();
  useWorkbenchUiStore.setState({
    viewId: "project-overview",
    contextPath: null,
    overlay: null,
    sidebarCollapsed: false,
  });
  agentService.resetPreferences();
  projectPreferences.reset();
}

const demoHost = createDemoHost();

const desktopRuntime = createDesktopRuntime({
  attachPreloading: () => () => {},
  close: closeRealRuntime,
}, undefined, undefined, demoHost);
let agentService: AgentsService;
beforeAll(async () => {
  const { acpRuntime, agents } = await desktopRuntime.ready;
  agentService = agents;
  bindRuntimeServices(acpRuntime.protocol, agents);
});
afterAll(async () => desktopRuntime.shutdown());

beforeEach(() => {
  vi.mocked(readChrysArchive).mockReset().mockResolvedValue([]);
  resetAll();
  // 伪装 Tauri 宿主（realRuntime 的 isTauriEnv 探测点）
  (window as unknown as MutableWindow).__TAURI_INTERNALS__ = {};
});

afterEach(async () => {
  // 收掉模块级单例，避免用例间互串（幂等跳过路径）
  await closeRealRuntime();
});

function recoveryTarget() {
  const state = useSessionStore.getState();
  return {
    workspacePath: WORKSPACE,
    agentKey: state.agentKey!,
    sessionId: state.activeSessionId!,
  };
}
function reconnectActiveSession(): void {
  void recoverSessionRuntime(recoveryTarget());
}
function stopActiveRecovery(): void {
  void stopSessionRecoveryRuntime(recoveryTarget());
}

function workingSession() {
  return (
    [...fakeSessionControl.instances]
      .reverse()
      .find(
        (session) =>
          session.sessionId !== null &&
          session.sessionId === useSessionStore.getState().activeSessionId,
      ) ?? null
  );
}

it("内置 CodeAgent 实际草稿启动也校验并解析旧版无扩展名路径", async () => {
  demoHost.addDir("G:/Code AgentCLI");
  await demoHost.writeTextFile("G:/Code AgentCLI/codeagent", "#!/bin/sh");
  await demoHost.writeTextFile("G:/Code AgentCLI/codeagent.cmd", "@echo off");
  try {
    agentService.executableConfiguration("codeagent")!.setValue("G:/Code AgentCLI/codeagent");
    agentService.select("codeagent");
    const opened = await openRealWorkspace(WORKSPACE, {
      forceNew: true,
      draft: true,
    });
    expect(opened).not.toBeNull();
    expect(spawnTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        command: ["G:/Code AgentCLI/codeagent.cmd", "acp"],
        cwd: undefined,
      }),
      expect.anything(),
    );
    expect(
      agentService.executableConfiguration("codeagent")?.value,
    ).toBe("G:/Code AgentCLI/codeagent");
  } finally {
    await closeRealRuntime();
    demoHost.reset();
  }
});

it("CodeAgent 显式路径失效时实际会话启动失败，不调用 spawn 或回退其他安装", async () => {
  agentService.executableConfiguration("codeagent")!.setValue("G:/missing/codeagent.exe");
  agentService.select("codeagent");
  expect(
    await openRealWorkspace(WORKSPACE, { forceNew: true, draft: true }),
  ).toBeNull();
  expect(spawnTransport).not.toHaveBeenCalled();
  expect(useWorkspaceStore.getState().lastConnectError?.message).toContain(
    "路径不存在",
  );
});

function seedLocalLog(items: readonly unknown[]): void {
  window.localStorage.setItem(
    LOG_KEY,
    JSON.stringify({ version: 1, savedAt: "2026-10-20T10:00:00Z", items }),
  );
}

it("压缩归档先于 ACP 历史，切换后不会累积旧刻度", async () => {
  fakeSessionControl.listed = [
    { sessionId: "archive-session", cwd: WORKSPACE },
  ];
  vi.mocked(readChrysArchive).mockImplementation((_host, sessionId) =>
    Promise.resolve([
      {
        type: "user_message_chunk",
        sessionId,
        messageId: "archived",
        text: "压缩前提问",
      },
      { type: "agent_message_chunk", sessionId, text: "压缩前回复" },
    ]),
  );
  fakeSessionControl.replayOnLoad = [
    {
      type: "user_message_chunk",
      sessionId: "archive-session",
      text: "当前提问",
    },
  ];
  await openRealWorkspace(WORKSPACE, { sessionId: "archive-session" });
  expect(
    useSessionStore.getState().items.map((i) => ("text" in i ? i.text : "")),
  ).toEqual(["压缩前提问", "压缩前回复", "当前提问"]);
  fakeSessionControl.replayOnLoad = [];
  await switchRealSession("other-session");
  expect(
    useSessionStore.getState().items.filter((i) => i.kind === "user"),
  ).toHaveLength(1);
  fakeSessionControl.replayOnLoad = [
    {
      type: "user_message_chunk",
      sessionId: "archive-session",
      text: "当前提问",
    },
  ];
  await switchRealSession("archive-session");
  expect(
    useSessionStore.getState().items.filter((i) => i.kind === "user"),
  ).toHaveLength(2);
});

it("归档读取失败保留 ACP 历史并提示不完整", async () => {
  fakeSessionControl.listed = [{ sessionId: "saved", cwd: WORKSPACE }];
  vi.mocked(readChrysArchive).mockRejectedValue(new Error("文件不可读"));
  fakeSessionControl.replayOnLoad = [
    { type: "user_message_chunk", sessionId: "saved", text: "仍能恢复" },
  ];
  await openRealWorkspace(WORKSPACE, { sessionId: "saved" });
  expect(
    useSessionStore
      .getState()
      .items.some((i) => i.kind === "user" && i.text === "仍能恢复"),
  ).toBe(true);
  expect(
    useSessionStore
      .getState()
      .items.some(
        (i) => i.kind === "system" && i.text.includes("历史可能不完整"),
      ),
  ).toBe(true);
});

it.each([false, true])(
  "非 iCode 会话恢复不读取 chrys 归档（预热：%s）",
  async (warm) => {
    expect(agentService.addCustomAgent("Other", "other acp")).toBeNull();
    agentService.select("custom-other");
    fakeSessionControl.replayOnLoad = [
      {
        type: "user_message_chunk",
        sessionId: "saved",
        text: "其他 agent 的历史",
      },
    ];
    if (warm) await openRealWorkspace(WORKSPACE, { listOnly: true });
    await openRealWorkspace(WORKSPACE, { sessionId: "saved" });
    expect(readChrysArchive).not.toHaveBeenCalled();
    expect(fakeSessionControl.loadCalls).toContain("saved");
    expect(
      useSessionStore
        .getState()
        .items.some(
          (item) => item.kind === "user" && item.text === "其他 agent 的历史",
        ),
    ).toBe(true);
  },
);

describe("openRealWorkspace：会话恢复装配", () => {
  it("切换 Agent 停止旧工作会话，同项目同 ID 的新会话独立运行", async () => {
    fakeSessionControl.newSessionId = "same";
    await openRealWorkspace(WORKSPACE, { forceNew: true });
    const old = [...projectFactory.sessions()][0]!;
    const ownerA = old.agentKey;
    old.store.getState().beginTurn("A work");
    expect(agentService.addCustomAgent("B", "b acp")).toBeNull();
    const stages: string[] = [];
    const counts = { starting: 0, handshake: 0, ready: 0, stopped: -1 };
    await switchRuntimeAgent("custom-b", (event) => {
      if (event.type === "stage") stages.push(event.stage);
      if (event.type === "connection" && event.event.kind !== "failed") counts[event.event.kind]++;
      if (event.type === "stopRequested") counts.stopped = event.count;
    });
    expect(stages).toEqual(["queued", "target", "openQueue", "commit", "dispose", "select"]);
    expect(counts).toEqual({ starting: 4, handshake: 4, ready: 4, stopped: 1 });
    expect(old.disposed).toBe(true);
    expect(busyRuntimeSessionIds(ownerA, WORKSPACE).size).toBe(0);
    await openRealWorkspace(WORKSPACE, { forceNew: true });
    const ownerB = useSessionStore.getState().agentKey!;
    expect(ownerB).not.toBe(ownerA);
    expect(busyRuntimeSessionIds(ownerB, WORKSPACE).size).toBe(0);
    useSessionStore.getState().beginTurn("B work");
    expect(busyRuntimeSessionIds(ownerB, WORKSPACE).has("same")).toBe(true);
    expect(old.store.getState().sendPrompt("stale A")).toBe(false);
  });

  it("切换后重命名只写入 B，清空恢复 B 原生名", async () => {
    fakeSessionControl.listed = [
      { sessionId: "same", cwd: WORKSPACE, title: "A native" },
    ];
    await openRealWorkspace(WORKSPACE, { sessionId: "same" });
    const ownerA = useSessionStore.getState().agentKey!;
    expect(agentService.addCustomAgent("B", "b acp")).toBeNull();
    fakeSessionControl.listed = [
      { sessionId: "same", cwd: WORKSPACE, title: "B native" },
    ];
    await switchRuntimeAgent("custom-b");
    await preloadSessionList(WORKSPACE);
    const ownerB = projectIndexes.catalog.store.getState().agentKey!;
    void renameCatalogSession(ownerB, "same", "B manual");
    expect(manualTitleOf("same", ownerB)).toBe("B manual");
    expect(manualTitleOf("same", ownerA)).toBeNull();
    expect(
      projectIndexes.catalog.store.getState().sessionsByPath[WORKSPACE]?.[0]?.title,
    ).toBe("B manual");
    void renameCatalogSession(ownerB, "same", "");
    expect(
      projectIndexes.catalog.store.getState().sessionsByPath[WORKSPACE]?.[0]?.title,
    ).toBe("B native");
  });

  it("Agent A 创建会话的迟到结果不能污染切换后的 B 目录", async () => {
    await openRealWorkspace(WORKSPACE, { forceNew: true, draft: true });
    const old = useSessionStore.getState();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = vi
      .spyOn(FakeAcpSession.prototype, "newSession")
      .mockImplementationOnce(async function (this: FakeAcpSession) {
        await gate;
        this.sessionId = "a-late";
        return { sessionId: "a-late", modes: null, models: null };
      });
    try {
      old.sendPrompt("A first");
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(agentService.addCustomAgent("B", "b acp")).toBeNull();
      fakeSessionControl.listed = [
        { sessionId: "b-only", cwd: WORKSPACE, title: "B session" },
      ];
      await switchRuntimeAgent("custom-b");
      await preloadSessionList(WORKSPACE);
      release();
      await vi.waitFor(() => expect(old.sendPrompt("stale A")).toBe(false));
      expect(
        projectIndexes.catalog.store
          .getState()
          .sessionsByPath[WORKSPACE]?.map((entry) => entry.id),
      ).toEqual(["b-only"]);
    } finally {
      release();
      create.mockRestore();
    }
  });

  it("未发送的新会话切走后可复用连接，发送前不创建会话", async () => {
    const create = vi.spyOn(FakeAcpSession.prototype, "newSession");
    await openRealWorkspace(WORKSPACE, { forceNew: true, draft: true });
    const firstSend = useSessionStore.getState().sendPrompt;
    expect(create).not.toHaveBeenCalled();
    await openRealWorkspace("D:/other-project", {
      forceNew: true,
      draft: true,
    });
    const count = fakeSessionControl.instances.length;
    await openRealWorkspace(WORKSPACE, { forceNew: true, draft: true });
    expect(fakeSessionControl.instances).toHaveLength(count);
    expect(useSessionStore.getState().sendPrompt).toBe(firstSend);
    expect(useSessionStore.getState().activeSessionId).toBeNull();
    expect(create).not.toHaveBeenCalled();
    useSessionStore.getState().sendPrompt("第一条消息");
    await vi.waitFor(() =>
      expect(useSessionStore.getState().activeSessionId).not.toBeNull(),
    );
    expect(create).toHaveBeenCalledTimes(1);
    create.mockRestore();
  });

  it("草稿切换 Agent 后首次发送只使用新连接，并发布到新 Agent 目录", async () => {
    await openRealWorkspace(WORKSPACE, { forceNew: true, draft: true });
    const old = useSessionStore.getState();
    const oldInstances = [...fakeSessionControl.instances];
    const create = vi.spyOn(FakeAcpSession.prototype, "newSession");
    const prompt = vi.spyOn(FakeAcpSession.prototype, "prompt");
    try {
      expect(agentService.addCustomAgent("B", "b acp")).toBeNull();
      const switching = switchRuntimeAgent("custom-b");
      expect(old.sendPrompt("切换中")).toBe(false);
      await switching;
      await openRealWorkspace(WORKSPACE, { forceNew: true, draft: true });
      expect(create).not.toHaveBeenCalled();
      expect(useSessionStore.getState().agentKey).not.toBe(old.agentKey);
      expect(useSessionStore.getState().sendPrompt("B 的第一条消息")).toBe(
        true,
      );
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
      expect(create).toHaveBeenCalledTimes(1);
      expect(oldInstances).not.toContain(create.mock.contexts[0]);
      expect(prompt.mock.contexts[0]).toBe(create.mock.contexts[0]);
      expect(
        projectIndexes.catalog.store
          .getState()
          .sessionsByPath[WORKSPACE]?.map((entry) => entry.id),
      ).toContain("new-session-id");
    } finally {
      create.mockRestore();
      prompt.mockRestore();
    }
  });

  it("切换准备失败保留旧草稿，显式重试成功后才能使用新 Agent", async () => {
    await openRealWorkspace(WORKSPACE, { forceNew: true, draft: true });
    const oldAgent = agentService.selectedId;
    const oldOwner = useSessionStore.getState().agentKey;
    expect(agentService.addCustomAgent("B", "b acp")).toBeNull();
    spawnTransport.mockRejectedValue(new Error("B 启动失败"));
    await expect(switchRuntimeAgent("custom-b")).rejects.toThrow("B 启动失败");
    expect(agentService.selectedId).toBe(oldAgent);
    expect(useSessionStore.getState().agentKey).toBe(oldOwner);
    expect(useSessionStore.getState().isBound).toBe(true);
    expect(useSessionStore.getState().operationsBlocked).toBe(false);
    expect(useSessionStore.getState().queuePaused).toBe(true);
    spawnTransport.mockImplementation(() =>
      Promise.resolve(standardAcpPeer().client),
    );
    await switchRuntimeAgent("custom-b");
    await openRealWorkspace(WORKSPACE, { forceNew: true, draft: true });
    expect(useSessionStore.getState().sendPrompt("重试")).toBe(true);
    await vi.waitFor(() =>
      expect(useSessionStore.getState().activeSessionId).toBe("new-session-id"),
    );
  });

  it("切换准备期间再次确认 A，只保留最后一次确认", async () => {
    await openRealWorkspace(WORKSPACE, { forceNew: true, draft: true });
    const agentA = agentService.selectedId;
    const ownerA = useSessionStore.getState().agentKey;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const initialize = vi
      .spyOn(FakeAcpSession.prototype, "initialize")
      .mockImplementationOnce(async function () {
        await gate;
        return {
          protocolVersion: 1,
          agentInfo: { name: "B" },
          agentCapabilities: {},
        };
      });
    let switching: Promise<void> | undefined;
    try {
      expect(agentService.addCustomAgent("B", "b acp")).toBeNull();
      switching = switchRuntimeAgent("custom-b");
      const superseded = expect(switching).rejects.toThrow("后续确认替代");
      await vi.waitFor(() => expect(initialize).toHaveBeenCalled());
      const latest = switchRuntimeAgent(agentA);
      expect(agentService.selectedId).toBe(agentA);
      release();
      await superseded;
      await latest;
      await openRealWorkspace(WORKSPACE, { forceNew: true, draft: true });
      expect(useSessionStore.getState().agentKey).toBe(ownerA);
      expect(useSessionStore.getState().isBound).toBe(true);
    } finally {
      release();
      await switching?.catch(() => {});
      initialize.mockRestore();
    }
  });

  it("指定恢复的会话载入内容，列表标题不含 UUID", async () => {
    // updatedAt 用无时区后缀的本地时间串：列表标题的 HH:MM 按本地时区格式化
    fakeSessionControl.listed = [
      {
        sessionId: "sess-old",
        cwd: WORKSPACE,
        updatedAt: "2026-10-19T09:00:00",
      },
      {
        sessionId: "sess-latest",
        cwd: WORKSPACE,
        updatedAt: "2026-10-20T11:30:00",
      },
    ];

    await openRealWorkspace(WORKSPACE, { sessionId: "sess-latest" });

    expect(fakeSessionControl.loadCalls).toEqual(["sess-latest"]);
    const state = useSessionStore.getState();
    expect(state.activeSessionId).toBe("sess-latest");
    expect(state.sessions[0]?.id).toBe("sess-latest");
    // 无首条用户消息时标题回落时间，绝不露出 UUID
    expect(state.sessions[0]?.title).toMatch(/^会话 · \d{2}:\d{2}$/);
    // 其余历史会话在列表中（无 title 用 updatedAt 时间兜底）
    const old = state.sessions.find((entry) => entry.id === "sess-old");
    expect(old?.title).toBe("会话 · 09:00");
  });

  it("指定 sessionId 时直接恢复那一条，不先恢复最近一个（单次回放）", async () => {
    fakeSessionControl.listed = [
      {
        sessionId: "sess-old",
        cwd: WORKSPACE,
        updatedAt: "2026-10-19T09:00:00",
        title: "旧会话权威标题",
      },
      {
        sessionId: "sess-latest",
        cwd: WORKSPACE,
        updatedAt: "2026-10-20T11:30:00",
      },
    ];

    // 冷连接下点开旧会话：只回放点名的那条，别的会话不涌进视图
    await openRealWorkspace(WORKSPACE, { sessionId: "sess-old" });

    expect(fakeSessionControl.loadCalls).toEqual(["sess-old"]);
    expect(useSessionStore.getState().activeSessionId).toBe("sess-old");
    // 列表仍完整回填（左栏树需要）；排序对齐 ZCode（updatedAt 倒序）：
    // 打开老会话不置顶，它按最后活动时间留在原位，列表不跳
    expect(
      useSessionStore.getState().sessions.map((entry) => entry.id),
    ).toEqual(["sess-latest", "sess-old"]);
    // 恢复的历史会话用 list 的权威标题——回放未到时不得兜底成
    // 「会话 · 当前时刻」（看起来像新开的会话）
    expect(
      useSessionStore
        .getState()
        .sessions.find((entry) => entry.id === "sess-old")?.title,
    ).toBe("旧会话权威标题");
  });

  it("指定的 sessionId 不在列表中（chrys 列表滞后）仍直接 load 点名那条，不偷换最近一个", async () => {
    fakeSessionControl.listed = [
      {
        sessionId: "sess-latest",
        cwd: WORKSPACE,
        updatedAt: "2026-10-20T11:30:00",
      },
    ];

    await openRealWorkspace(WORKSPACE, { sessionId: "sess-gone" });

    // 点名优先：列表只是树的数据源，不是 load 的白名单
    expect(fakeSessionControl.loadCalls).toEqual(["sess-gone"]);
    expect(useSessionStore.getState().activeSessionId).toBe("sess-gone");
  });

  it("点名 sessionId 恢复失败保留原会话且不新建", async () => {
    fakeSessionControl.listed = [
      {
        sessionId: "sess-latest",
        cwd: WORKSPACE,
        updatedAt: "2026-10-20T11:30:00",
      },
    ];
    fakeSessionControl.loadShouldFail = true;

    await openRealWorkspace(WORKSPACE, { sessionId: "sess-gone" });

    expect(fakeSessionControl.loadCalls).toEqual(["sess-gone"]);
    expect(useSessionStore.getState().activeSessionId).toBe("sess-gone");
  });

  it("原会话过期显式失败，不静默新建", async () => {
    fakeSessionControl.listed = [
      {
        sessionId: "sess-expired",
        cwd: WORKSPACE,
        updatedAt: "2026-10-20T08:00:00",
      },
    ];
    fakeSessionControl.loadShouldFail = true;

    await openRealWorkspace(WORKSPACE, { sessionId: "sess-expired" });

    expect(fakeSessionControl.loadCalls).toEqual(["sess-expired"]);
    const state = useSessionStore.getState();
    expect(state.activeSessionId).toBe("sess-expired");
    expect(state.recovery.state).toBe("failed");
    // 新建会话置顶；过期的历史条目保留在列表中（点击可重试，失败不致命）
    expect(state.sessions.map((entry) => entry.id)).toEqual(["sess-expired"]);
  });

  it("session/list 失败：激活模式不回落新建（连接只为列表服务），树为空", async () => {
    fakeSessionControl.listShouldFail = true;
    await openRealWorkspace(WORKSPACE, { listOnly: true });
    expect(fakeSessionControl.loadCalls).toEqual([]);
    expect(useSessionStore.getState().activeSessionId).toBeNull();
  });

  it.each([true, false])(
    "无历史会话直接新建：不回灌项目旧快照（forceNew=%s）",
    async (forceNew) => {
      seedLocalLog([
        {
          kind: "user",
          id: "u1",
          text: "上次的问题",
          createdAt: "2026-10-19T10:00:00Z",
        },
        { kind: "assistant", id: "a1", text: "上次的回答", isStreaming: true },
      ]);

      await openRealWorkspace(WORKSPACE, { forceNew });

      expect(fakeSessionControl.loadCalls).toEqual([]);
      // 新会话始终不能读入项目中上一条会话的快照。
      expect(useSessionStore.getState().items).toEqual([]);
      expect(useSessionStore.getState().activeSessionId).toBe("new-session-id");
    },
  );

  it("loadSession 已回放历史时，本地快照不覆盖回放结果", async () => {
    fakeSessionControl.listed = [{ sessionId: "sess-latest", cwd: WORKSPACE }];
    fakeSessionControl.replayOnLoad = [
      {
        type: "agent_message_chunk",
        sessionId: "sess-latest",
        text: "回放的回复",
      },
    ];
    seedLocalLog([
      { kind: "user", id: "u1", text: "本地快照消息", createdAt: "" },
    ]);

    await openRealWorkspace(WORKSPACE, { sessionId: "sess-latest" });

    const items = useSessionStore.getState().items;
    expect(
      items.some(
        (item) => item.kind === "assistant" && item.text === "回放的回复",
      ),
    ).toBe(true);
    expect(
      items.some(
        (item) => item.kind === "user" && item.text === "本地快照消息",
      ),
    ).toBe(false);
  });

  it("恢复历史时接收用户提问并保留顺序，回放结束后不重复处理实时回显", async () => {
    fakeSessionControl.listed = [{ sessionId: "sess-latest", cwd: WORKSPACE }];
    fakeSessionControl.replayOnLoad = [
      {
        type: "user_message_chunk",
        sessionId: "sess-latest",
        text: "第一个问题",
      },
      {
        type: "agent_message_chunk",
        sessionId: "sess-latest",
        text: "第一条",
      },
      {
        type: "agent_message_chunk",
        sessionId: "sess-latest",
        text: "回复",
      },
      {
        type: "user_message_chunk",
        sessionId: "sess-latest",
        text: "第二个问题",
      },
      {
        type: "agent_message_chunk",
        sessionId: "sess-latest",
        text: "第二条回复",
      },
    ];
    await openRealWorkspace(WORKSPACE, { sessionId: "sess-latest" });
    expect(useSessionStore.getState().items.map((item) => item.kind)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(useSessionStore.getState().items[3]).toMatchObject({
      isStreaming: false,
    });
    expect(
      useSessionStore
        .getState()
        .items.map((item) => ("text" in item ? item.text : null)),
    ).toEqual(["第一个问题", "第一条回复", "第二个问题", "第二条回复"]);
    expect(useSessionStore.getState().sessions[0]?.title).toBe(
      "会话 · 第一个问题",
    );
    workingSession()?.emit({
      type: "user_message_chunk",
      sessionId: "sess-latest",
      text: "实时回显",
    });
    expect(useSessionStore.getState().items).toHaveLength(4);
  });

  it("非 Tauri 环境：不启动会话，store 保持空", async () => {
    delete (window as unknown as MutableWindow).__TAURI_INTERNALS__;
    await openRealWorkspace(WORKSPACE);
    expect(useSessionStore.getState().sessions).toEqual([]);
    expect(useSessionStore.getState().items).toEqual([]);
  });
});

describe("openRealWorkspace：新建会话语义（forceNew）", () => {
  it("forceNew 跳过历史恢复：直接走 session/new，仍回填完整历史列表", async () => {
    fakeSessionControl.listed = [
      {
        sessionId: "sess-latest",
        cwd: WORKSPACE,
        updatedAt: "2026-10-20T11:30:00",
      },
    ];
    seedLocalLog([
      { kind: "user", id: "u1", text: "上次的问题", createdAt: "" },
    ]);

    await openRealWorkspace(WORKSPACE, { forceNew: true });

    // 不恢复历史（这是「新建」与「打开」的分水岭）
    expect(fakeSessionControl.loadCalls).toEqual([]);
    const state = useSessionStore.getState();
    expect(state.activeSessionId).toBe("new-session-id");
    // 历史列表照旧完整（列表数据不能少，只是不自动载入任何一条）
    expect(state.sessions.map((entry) => entry.id)).toEqual([
      "new-session-id",
      "sess-latest",
    ]);
    // 上一条会话的本地快照绝不灌进新会话（那是内容错位）
    expect(state.items).toEqual([]);
  });

  it("同一路径已打开时默认幂等跳过，forceNew 下重新新建", async () => {
    await openRealWorkspace(WORKSPACE);
    const firstId = useSessionStore.getState().activeSessionId;

    // 默认：同路径幂等——不重连、不换会话
    await openRealWorkspace(WORKSPACE);
    expect(useSessionStore.getState().activeSessionId).toBe(firstId);

    // forceNew：真的另开一条
    await openRealWorkspace(WORKSPACE, { forceNew: true });
    const state = useSessionStore.getState();
    expect(state.activeSessionId).toBe("new-session-id");
  });

  it("forceNew 不把内容区自动切到会话视图（是否进会话由调用方决定）", async () => {
    fakeSessionControl.listed = [{ sessionId: "sess-latest", cwd: WORKSPACE }];
    await openRealWorkspace(WORKSPACE, { forceNew: true });
    expect(useWorkbenchUiStore.getState().viewId).toBe("project-overview");
  });
});

describe("switchRealSession：左栏点击历史会话的切换", () => {
  it("切换历史会话时恢复用户提问，失败和成功后都退出回放模式", async () => {
    fakeSessionControl.listed = [{ sessionId: "sess-latest", cwd: WORKSPACE }];
    await openRealWorkspace(WORKSPACE);
    fakeSessionControl.loadShouldFail = true;
    expect(await switchRealSession("sess-failed")).toBe(false);
    workingSession()?.emit({
      type: "user_message_chunk",
      sessionId: "sess-failed",
      text: "失败后的回显",
    });
    expect(useSessionStore.getState().items).toHaveLength(0);
    fakeSessionControl.loadShouldFail = false;
    fakeSessionControl.replayOnLoad = [
      { type: "user_message_chunk", sessionId: "sess-2", text: "旧会话提问" },
      { type: "agent_message_chunk", sessionId: "sess-2", text: "旧会话回复" },
      { type: "user_message_chunk", sessionId: "sess-2", text: "后续提问" },
    ];
    expect(await switchRealSession("sess-2")).toBe(true);
    expect(useSessionStore.getState().items.map((item) => item.kind)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    workingSession()?.emit({
      type: "user_message_chunk",
      sessionId: "sess-2",
      text: "实时回显",
    });
    expect(useSessionStore.getState().items).toHaveLength(3);
  });
  it("运行中切换只改变聚焦，切回保留消息、排队和运行态", async () => {
    fakeSessionControl.listed = [{ sessionId: "sess-latest", cwd: WORKSPACE }];
    await openRealWorkspace(WORKSPACE, { sessionId: "sess-latest" });
    useSessionStore.getState().beginTurn("仍在运行");
    useSessionStore.getState().enqueuePrompt("稍后执行");
    expect(await switchRealSession("sess-other")).toBe(true);
    expect(useSessionStore.getState().isAgentRunning).toBe(false);
    expect(
      fakeSessionControl.instances
        .filter((session) => session.sessionId !== null)
        .every((session) => !session.isReleased),
    ).toBe(true);
    expect(await switchRealSession("sess-latest")).toBe(true);
    expect(fakeSessionControl.loadCalls).toEqual(["sess-latest", "sess-other"]);
    expect(useSessionStore.getState().isAgentRunning).toBe(true);
    expect(useSessionStore.getState().queuedPrompts.map((entry) => typeof entry === "string" ? entry : entry.text)).toEqual(["稍后执行"]);
    expect(useSessionStore.getState().items[0]).toMatchObject({
      text: "仍在运行",
    });
  });

  it("切换成功载入目标会话；失败回滚当前视图且不切换聚焦", async () => {
    fakeSessionControl.listed = [{ sessionId: "sess-latest", cwd: WORKSPACE }];
    await openRealWorkspace(WORKSPACE, { sessionId: "sess-latest" });

    // 当前视图有一份内容
    useSessionStore.getState().beginTurn("当前会话内容");
    useSessionStore.getState().endTurn({ stopReason: "end_turn" });

    // 失败路径：loadSession 抛错 → 返回 false，视图按快照回滚
    fakeSessionControl.loadShouldFail = true;
    const failed = await switchRealSession("sess-other");
    expect(failed).toBe(false);
    const afterFailure = useSessionStore.getState();
    expect(afterFailure.activeSessionId).toBe("sess-latest");
    expect(afterFailure.items.map((item) => item.kind)).toEqual(["user"]);
    expect(afterFailure.items[0]).toMatchObject({ text: "当前会话内容" });

    // 成功路径：协议会话切到目标 id
    fakeSessionControl.loadShouldFail = false;
    const ok = await switchRealSession("sess-2");
    expect(ok).toBe(true);
    expect(workingSession()?.sessionId).toBe("sess-2");
  });

  it("切换到当前已绑定的会话为幂等（不重复 load）", async () => {
    fakeSessionControl.listed = [{ sessionId: "sess-latest", cwd: WORKSPACE }];
    await openRealWorkspace(WORKSPACE);
    const ok = await switchRealSession("sess-latest");
    expect(ok).toBe(true);
    // 打开工作区时已 load 过一次，幂等切换不再追加
    expect(fakeSessionControl.loadCalls).toEqual(["sess-latest"]);
  });
});

describe("openRealWorkspace：失败收口（P0-1）", () => {
  it("非 Tauri 环境早退：解除「连接中」并回填带指引的连接失败态", async () => {
    delete (window as unknown as MutableWindow).__TAURI_INTERNALS__;
    await openRealWorkspace(WORKSPACE);

    // 早退不复位 connecting 是本项修复的根因：现在必须复位
    expect(useSessionStore.getState().isConnecting).toBe(false);
    const error = useWorkspaceStore.getState().lastConnectError;
    expect(error?.path).toBe(WORKSPACE);
    // 多 agent 化后错误文案不再点名具体 agent（iCode），统一说 agent
    expect(error?.message).toContain("无法启动 agent 进程");
    expect(error?.message).toContain("请在设置中检查 agent 可执行路径");
  });

  it("spawn 失败：解除「连接中」、回填失败态并清理现场", async () => {
    spawnTransport.mockRejectedValue(new Error("chrys.exe 不存在"));
    await openRealWorkspace(WORKSPACE);

    expect(useSessionStore.getState().isConnecting).toBe(false);
    expect(useSessionStore.getState().isBound).toBe(false);
    const error = useWorkspaceStore.getState().lastConnectError;
    expect(error?.path).toBe(WORKSPACE);
    expect(error?.message).toContain("chrys.exe 不存在");
    expect(error?.message).toContain("请在设置中检查 agent 可执行路径");
  });

  it("成功连接后清除该项目此前的失败态", async () => {
    useWorkspaceStore
      .getState()
      .reportConnectFailure(
        WORKSPACE,
        "上一次失败：请在设置中检查 agent 可执行路径",
      );
    await openRealWorkspace(WORKSPACE);
    expect(useWorkspaceStore.getState().lastConnectError).toBeNull();
    expect(useSessionStore.getState().isConnecting).toBe(false);
  });
});

describe("openRealWorkspace：恢复后切会话视图（P1-8）", () => {
  it("恢复历史会话后内容区自动切到该项目会话视图", async () => {
    fakeSessionControl.listed = [
      {
        sessionId: "sess-latest",
        cwd: WORKSPACE,
        updatedAt: "2026-10-20T11:30:00",
      },
    ];
    await openRealWorkspace(WORKSPACE, { sessionId: "sess-latest" });
    const ui = useWorkbenchUiStore.getState();
    expect(ui.viewId).toBe("session");
    expect(ui.contextPath).toBe(WORKSPACE);
  });

  it("全新 newSession 不切视图（保持项目总览）", async () => {
    // 无历史（list 空）→ 直接新建
    await openRealWorkspace(WORKSPACE);
    const ui = useWorkbenchUiStore.getState();
    expect(ui.viewId).toBe("project-overview");

    // 有历史但 load 失败回落新建，同样保持总览
    useWorkbenchUiStore.setState({ viewId: "project-overview" });
    fakeSessionControl.listed = [{ sessionId: "sess-expired", cwd: WORKSPACE }];
    fakeSessionControl.loadShouldFail = true;
    await openRealWorkspace("D:/other-project");
    expect(useWorkbenchUiStore.getState().viewId).toBe("project-overview");
  });
});

describe("openRealWorkspace：审批默认模式分派（P0-4）", () => {
  /** 打开会话并取出装配时注入的权限审批回调。 */
  async function openAndGetResponder() {
    await openRealWorkspace(WORKSPACE);
    const responder = workingSession()!.permissionResponder;
    if (responder === null) {
      throw new Error("装配应注入权限审批回调");
    }
    return responder;
  }

  it("ask（默认）：走人工弹窗（offerPermission 挂起待办）", async () => {
    projectPreferences.setApprovalMode("ask");
    const responder = await openAndGetResponder();

    const pending = responder("s1", TOOL_CALL, CHRYS_PERMISSION_OPTIONS);
    // 挂起进 approvalStore（人工决策），不自动应答
    expect(useApprovalStore.getState().pending).toHaveLength(1);
    useApprovalStore.getState().decidePermission("permission:call-1", "allow");
    await expect(pending).resolves.toEqual({
      outcome: "selected",
      optionId: "allow",
    });
  });

  it("auto-allow：自动回 allow_once 选项（不弹窗）", async () => {
    const responder = await openAndGetResponder();
    projectPreferences.setApprovalMode("auto-allow");

    const outcome = await responder("s1", TOOL_CALL, CHRYS_PERMISSION_OPTIONS);
    expect(outcome).toEqual({ outcome: "selected", optionId: "allow" });
    expect(useApprovalStore.getState().pending).toHaveLength(0);
  });

  it("白名单落空（只有未知 kind 选项）：回退人工弹窗，绝不静默取消", async () => {
    projectPreferences.setApprovalMode("auto-allow");
    const responder = await openAndGetResponder();

    const pending = responder("s1", TOOL_CALL, [
      { optionId: "mystery", name: "Unknown", kind: "unknown" },
    ]);
    expect(useApprovalStore.getState().pending).toHaveLength(1);
    useApprovalStore
      .getState()
      .decidePermission("permission:call-1", "mystery");
    await expect(pending).resolves.toEqual({
      outcome: "selected",
      optionId: "mystery",
    });
  });
});

describe("后台会话执行隔离", () => {
  it("在 A 和加载中的 B 之间切换时立即显示 B 的加载态及已有名称", async () => {
    await openRealWorkspace(WORKSPACE, { sessionId: "A" });
    useWorkspaceStore.setState({ activePath: WORKSPACE });
    useSessionStore.getState().setSessions(
      [
        { id: "A", title: "A 标题", updatedAt: null },
        { id: "B", title: "B 标题", updatedAt: null },
      ],
      WORKSPACE,
    );
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(readChrysArchive).mockImplementation(async (_host, id) => {
      if (id === "B") await wait;
      return [];
    });
    const openingB = navigationProject.sessions.openSessionFromEntry(WORKSPACE, "B");
    await vi.waitFor(() =>
      expect(readChrysArchive).toHaveBeenCalledWith(
        expect.anything(),
        "B",
        WORKSPACE,
      ),
    );
    await navigationProject.sessions.openSessionFromEntry(WORKSPACE, "A");
    expect(useSessionStore.getState().activeSessionId).toBe("A");
    await navigationProject.sessions.openSessionFromEntry(WORKSPACE, "B");
    expect(useSessionStore.getState().isConnecting).toBe(true);
    expect(useSessionStore.getState().openingSessionId).toBe("B");
    expect(
      useSessionStore
        .getState()
        .sessionsByPath[WORKSPACE]?.find((entry) => entry.id === "B")?.title,
    ).toBe("B 标题");
    release();
    await openingB;
    expect(useSessionStore.getState().activeSessionId).toBe("B");
    expect(
      useSessionStore
        .getState()
        .sessionsByPath[WORKSPACE]?.find((entry) => entry.id === "B")?.title,
    ).toBe("B 标题");
  });
  it.each([false, true])(
    "A 加载期间切回 B，A 结束后不抢焦点（失败：%s）",
    async (fail) => {
      await openRealWorkspace(WORKSPACE, { sessionId: "B" });
      useWorkspaceStore.setState({ activePath: WORKSPACE });
      useSessionStore.getState().beginTurn("B 的工作");
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.mocked(readChrysArchive).mockImplementation(async (_host, id) => {
        if (id === "A") await wait;
        return [];
      });
      const openingA = navigationProject.sessions.openSessionFromEntry(WORKSPACE, "A");
      await vi.waitFor(() =>
        expect(readChrysArchive).toHaveBeenCalledWith(
          expect.anything(),
          "A",
          WORKSPACE,
        ),
      );
      await navigationProject.sessions.openSessionFromEntry(WORKSPACE, "B");
      expect(useSessionStore.getState().activeSessionId).toBe("B");
      fakeSessionControl.loadShouldFail = fail;
      release();
      await openingA;
      expect(useSessionStore.getState().activeSessionId).toBe("B");
      expect(
        useSessionStore
          .getState()
          .items.some(
            (item) => item.kind === "user" && item.text === "B 的工作",
          ),
      ).toBe(true);
    },
  );
  it("项目列表预热后打开会话复用四条连接，不额外启动进程", async () => {
    await openRealWorkspace(WORKSPACE, { listOnly: true });
    const warm = fakeSessionControl.lastInstance;
    expect(spawnTransport).toHaveBeenCalledTimes(4);
    await openRealWorkspace(WORKSPACE, { sessionId: "A" });
    expect(workingSession()).not.toBe(warm);
    expect(spawnTransport).toHaveBeenCalledTimes(4);
    expect(fakeSessionControl.loadCalls).toEqual(["A"]);
    expect(useSessionStore.getState().isBound).toBe(true);
    expect(useSessionStore.getState().isConnecting).toBe(false);
    await closeRealRuntime();
    expect(fakeSessionControl.closeCount).toBe(2);
  });

  it("激活项目的 effect 不会把已点开的 B 焦点抢回同项目先打开的 A", async () => {
    await openRealWorkspace(WORKSPACE, { sessionId: "A" });
    await openRealWorkspace(WORKSPACE, { sessionId: "B" });
    await openRealWorkspace(WORKSPACE, { listOnly: true });
    expect(useSessionStore.getState().activeSessionId).toBe("B");
    expect(spawnTransport).toHaveBeenCalledTimes(4);
    expect(
      fakeSessionControl.instances
        .filter((session) => session.sessionId !== null)
        .every((session) => !session.isReleased),
    ).toBe(true);
  });

  it.each([WORKSPACE, "D:/another-project"])(
    "空闲 A 切到 %s 的 B 后再激活 A 项目，复用后台连接且不重放历史",
    async (projectB) => {
      await openRealWorkspace(WORKSPACE, { sessionId: "A" });
      const a = workingSession();
      useSessionStore.getState().beginTurn("A 的已有内容");
      useSessionStore.getState().endTurn({ stopReason: "end_turn" });
      await openRealWorkspace(projectB, { sessionId: "B" });
      await openRealWorkspace(WORKSPACE, { listOnly: true });
      await openRealWorkspace(WORKSPACE, { sessionId: "A" });
      expect(spawnTransport).toHaveBeenCalledTimes(4);
      expect(
        fakeSessionControl.instances
          .filter((session) => session.sessionId !== null)
          .every((session) => !session.isReleased),
      ).toBe(true);
      expect(fakeSessionControl.loadCalls).toEqual(["A", "B"]);
      expect(a?.sessionId).toBe("A");
      expect(useSessionStore.getState().activeSessionId).toBe("A");
      expect(useSessionStore.getState().items[0]).toMatchObject({
        text: "A 的已有内容",
      });
    },
  );

  it("预热加载失败只回收预热连接，不关闭另一项目的运行会话", async () => {
    await openRealWorkspace(WORKSPACE, { sessionId: "A" });
    useSessionStore.getState().beginTurn("A 正在运行");
    await openRealWorkspace("D:/warm-project", { listOnly: true });
    fakeSessionControl.loadShouldFail = true;
    await openRealWorkspace("D:/warm-project", { sessionId: "expired" });
    await openRealWorkspace(WORKSPACE, { sessionId: "A" });
    expect(useSessionStore.getState().isAgentRunning).toBe(true);
    expect(useSessionStore.getState().items[0]).toMatchObject({
      text: "A 正在运行",
    });
  });

  it.each([WORKSPACE, "D:/another-project"])(
    "A 运行时切到 %s 的 B，消息、停止、自动出队均不串线",
    async (projectB) => {
      fakeSessionControl.newSessionId = "A";
      await openRealWorkspace(WORKSPACE, { forceNew: true });
      const a = workingSession()!;
      let finishA!: (value: { stopReason: "end_turn" }) => void;
      const promptA = vi
        .spyOn(a, "prompt")
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishA = resolve;
            }),
        )
        .mockResolvedValue({ stopReason: "end_turn" });
      const cancelA = vi.spyOn(a, "cancel");
      useSessionStore.getState().sendPrompt("任务 A");
      useSessionStore.getState().enqueuePrompt("A 的后续任务");
      fakeSessionControl.newSessionId = "B";
      await openRealWorkspace(projectB, { forceNew: true });
      const b = workingSession()!;
      const cancelB = vi.spyOn(b, "cancel");
      let finishB!: (value: { stopReason: "end_turn" }) => void;
      vi.spyOn(b, "prompt").mockImplementation(
        () =>
          new Promise((resolve) => {
            finishB = resolve;
          }),
      );
      useSessionStore.getState().sendPrompt("任务 B");
      a.emit({
        type: "agent_message_chunk",
        sessionId: "A",
        text: "A 的后台结果",
      });
      b.emit({ type: "agent_message_chunk", sessionId: "B", text: "B 的结果" });
      // 流式写入按帧合并，收口后确认正文归属。
      useSessionStore.getState().sealStreamingItems();
      expect(
        useSessionStore
          .getState()
          .items.some(
            (item) => "text" in item && item.text.includes("A 的后台结果"),
          ),
      ).toBe(false);
      expect(
        fakeSessionControl.instances
          .filter((session) => session.sessionId !== null)
          .every((session) => !session.isReleased),
      ).toBe(true);
      expect(hasRunningSessions()).toBe(true);
      useSessionStore.getState().requestCancel();
      expect(cancelB).toHaveBeenCalledOnce();
      expect(cancelA).not.toHaveBeenCalled();
      finishB({ stopReason: "end_turn" });
      await vi.waitFor(() =>
        expect(useSessionStore.getState().isAgentRunning).toBe(false),
      );
      finishA({ stopReason: "end_turn" });
      await vi.waitFor(() => expect(promptA).toHaveBeenCalledTimes(2));
      await openRealWorkspace(WORKSPACE, { sessionId: "A" });
      await vi.waitFor(() =>
        expect(useSessionStore.getState().isAgentRunning).toBe(false),
      );
      expect(
        useSessionStore
          .getState()
          .items.some(
            (item) => "text" in item && item.text.includes("A 的后台结果"),
          ),
      ).toBe(true);
      expect(
        useSessionStore
          .getState()
          .items.some((item) => "text" in item && item.text.includes("任务 B")),
      ).toBe(false);
      expect(fakeSessionControl.loadCalls).toEqual([]);
      expect(useSessionStore.getState().queuedPrompts).toEqual([]);
      await closeRealRuntime();
      expect(fakeSessionControl.closeCount).toBe(
        projectB === WORKSPACE ? 3 : 4,
      );
    },
  );

  it("后台审批不抢焦点，同名工具请求在两条会话中分别决策", async () => {
    fakeSessionControl.newSessionId = "A";
    await openRealWorkspace(WORKSPACE, { forceNew: true });
    const offerA = workingSession()!.permissionResponder!;
    fakeSessionControl.newSessionId = "B";
    await openRealWorkspace(WORKSPACE, { forceNew: true });
    const offerB = workingSession()!.permissionResponder!;
    const answerA = offerA("A", TOOL_CALL, CHRYS_PERMISSION_OPTIONS);
    expect(useApprovalStore.getState().pending).toEqual([]);
    expect(
      projectIndexes.activity.getState().entries[
        sessionActivityKey(WORKSPACE, "A", useSessionStore.getState().agentKey)
      ],
    ).toMatchObject({ status: "waiting", unread: true });
    const answerB = offerB("B", TOOL_CALL, CHRYS_PERMISSION_OPTIONS);
    expect(useApprovalStore.getState().pending).toHaveLength(1);
    useApprovalStore.getState().decidePermission("permission:call-1", "reject");
    await expect(answerB).resolves.toEqual({
      outcome: "selected",
      optionId: "reject",
    });
    expect(hasRunningSessions()).toBe(true);
    await switchRealSession("A");
    expect(useApprovalStore.getState().pending[0]?.sessionId).toBe("A");
    expect(
      projectIndexes.activity.getState().entries[
        sessionActivityKey(WORKSPACE, "A", useSessionStore.getState().agentKey)
      ]?.unread,
    ).toBe(false);
    useApprovalStore.getState().decidePermission("permission:call-1", "allow");
    await expect(answerA).resolves.toEqual({
      outcome: "selected",
      optionId: "allow",
    });
  });

  it("连接 B 失败和路径大小写变化不关闭运行中的 A", async () => {
    fakeSessionControl.newSessionId = "A";
    await openRealWorkspace(WORKSPACE, { forceNew: true });
    useSessionStore.getState().beginTurn("不能中断");
    const spawnCount = spawnTransport.mock.calls.length;
    await openRealWorkspace("d:\\DEMO-project/", { sessionId: "A" });
    expect(spawnTransport).toHaveBeenCalledTimes(spawnCount);
    const createB = vi
      .spyOn(FakeAcpSession.prototype, "newSession")
      .mockRejectedValueOnce(new Error("无法创建 B"));
    expect(await openRealWorkspace("D:/B", { forceNew: true })).toBeNull();
    createB.mockRestore();
    expect(useSessionStore.getState().activeSessionId).toBe("A");
    expect(useSessionStore.getState().isAgentRunning).toBe(true);
    expect(
      fakeSessionControl.instances
        .filter((session) => session.sessionId !== null)
        .every((session) => !session.isReleased),
    ).toBe(true);
  });

  it("同项目两条会话的本地快照使用独立键", async () => {
    for (const id of ["A", "B"]) {
      fakeSessionControl.newSessionId = id;
      await openRealWorkspace(WORKSPACE, { forceNew: true });
      useSessionStore.getState().beginTurn(`仅属于 ${id}`);
      useSessionStore.getState().endTurn({ stopReason: "end_turn" });
      void useSessionStore.getState().flushSessionLog();
    }
    const a = localStorage.getItem(
      `aaw-desktop/session-log/${encodeURIComponent(JSON.stringify([useSessionStore.getState().agentKey, "d:/demo-project#A"]))}`,
    );
    const b = localStorage.getItem(
      `aaw-desktop/session-log/${encodeURIComponent(JSON.stringify([useSessionStore.getState().agentKey, "d:/demo-project#B"]))}`,
    );
    expect(a).toContain("仅属于 A");
    expect(a).not.toContain("仅属于 B");
    expect(b).toContain("仅属于 B");
    expect(b).not.toContain("仅属于 A");
    expect(
      useSessionStore.getState().sessions.map((entry) => entry.id),
    ).toContain("A");
  });
});

it("关闭过程中拒绝新开会话，避免创建逃出关闭快照的进程", async () => {
  fakeSessionControl.newSessionId = "A";
  await openRealWorkspace(WORKSPACE, { forceNew: true });
  const a = workingSession()!;
  const originalClose = a.closeSession.bind(a);
  let finish!: () => void;
  vi.spyOn(a, "closeSession").mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return originalClose();
  });
  const closing = closeRealRuntime();
  await vi.waitFor(() => expect(finish).toBeDefined());
  const count = spawnTransport.mock.calls.length;
  expect(await openRealWorkspace("D:/C", { forceNew: true })).toBeNull();
  expect(spawnTransport).toHaveBeenCalledTimes(count);
  finish();
  await closing;
  expect(useSessionStore.getState().isBound).toBe(false);
  expect(fakeSessionControl.closeCount).toBe(2);
});

describe("preloadSessionList：项目会话列表查询", () => {
  it("预加载无标题的会话时保留已有名称和当前焦点", async () => {
    const { agents } = await desktopRuntime.ready;
    const agentKey = agents.selectionKey(useWorkspaceStore.getState().toolPaths);
    projectIndexes.catalog.store.setState({
      agentKey,
      sessionsByPath: {
        ["D:\\demo-project"]: [
          { id: "saved", title: "已有名称", updatedAt: null },
        ],
      },
    });
    useSessionStore.setState({ activeSessionId: "current", agentKey });
    fakeSessionControl.listed = [{ sessionId: "saved", cwd: WORKSPACE }];
    await preloadSessionList(WORKSPACE);
    expect(
      useSessionStore.getState().sessionsByPath[WORKSPACE]?.[0]?.title,
    ).toBe("已有名称");
    expect(useSessionStore.getState().activeSessionId).toBe("current");
  });
  it("项目列表查询不加载消息，释放查询会话并保留四条连接", async () => {
    fakeSessionControl.listed = [{ sessionId: "sess-pre", cwd: WORKSPACE }];
    const spawnsBefore = spawnTransport.mock.calls.length;

    await preloadSessionList(WORKSPACE);

    // 单独查询项目列表，不触发历史会话 load。
    expect(
      useSessionStore
        .getState()
        .sessionsByPath[WORKSPACE]?.map((entry) => entry.id),
    ).toEqual(["sess-pre"]);
    expect(useSessionStore.getState().activeSessionId).toBeNull();
    expect(fakeSessionControl.loadCalls).toEqual([]);
    expect(spawnTransport.mock.calls.length).toBe(spawnsBefore + 4);
    // 列表查询会话立即释放，连接由 Pool 保留。
    expect(fakeSessionControl.lastInstance?.isReleased).toBe(true);
    expect(fakeSessionControl.closeCount).toBe(1);
  });

  it("同一项目去重：进行中的预加载不重复 spawn", async () => {
    fakeSessionControl.listed = [{ sessionId: "sess-pre", cwd: WORKSPACE }];
    const spawnsBefore = spawnTransport.mock.calls.length;

    const first = preloadSessionList(WORKSPACE);
    const second = preloadSessionList(WORKSPACE);
    await Promise.all([first, second]);
    expect(spawnTransport.mock.calls.length).toBe(spawnsBefore + 4);
  });

  it("项目已有 runtime 在管：跳过预加载（列表由 runtime 权威回填）", async () => {
    fakeSessionControl.listed = [{ sessionId: "sess-latest", cwd: WORKSPACE }];
    await openRealWorkspace(WORKSPACE, { sessionId: "sess-latest" });
    const spawnsAfterOpen = spawnTransport.mock.calls.length;
    useSessionStore
      .getState()
      .setSessions(
        [{ id: "sess-latest", title: "权威标题", updatedAt: null }],
        WORKSPACE,
      );

    await preloadSessionList(WORKSPACE);

    expect(spawnTransport.mock.calls.length).toBe(spawnsAfterOpen);
    expect(useSessionStore.getState().sessions[0]?.title).toBe("权威标题");
  });

  it("预加载失败：静默记日志，树呈空态（不污染 store）", async () => {
    fakeSessionControl.listShouldFail = true;

    await preloadSessionList(WORKSPACE);

    expect(
      useSessionStore.getState().sessionsByPath[WORKSPACE],
    ).toBeUndefined();
  });
});

describe("项目目录缓存与共享连接", () => {
  it("首次点击复用四条连接和已缓存列表，创建独立会话通道", async () => {
    const list = vi.spyOn(FakeAcpSession.prototype, "listSessions");
    await preloadSessionList(WORKSPACE);
    const prepared = fakeSessionControl.lastInstance!;
    const initialize = vi.spyOn(prepared, "initialize");
    await openRealWorkspace(WORKSPACE, { sessionId: "A" });
    expect(workingSession()).not.toBe(prepared);
    expect(initialize).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(1);
    expect(spawnTransport).toHaveBeenCalledTimes(4);
    list.mockRestore();
  });

  it("activePath 已恢复但尚无工作会话时，点击也会真正加载内容", async () => {
    useWorkspaceStore.setState({ activePath: WORKSPACE });
    await preloadSessionList(WORKSPACE);
    await navigationProject.sessions.openSessionFromEntry(WORKSPACE, "saved");
    expect(fakeSessionControl.loadCalls).toEqual(["saved"]);
    expect(useSessionStore.getState().activeSessionId).toBe("saved");
  });

  it("读取所有分页并去重，空列表不能冲掉已知会话", async () => {
    const list = vi
      .spyOn(FakeAcpSession.prototype, "listSessions")
      .mockResolvedValueOnce({
        sessions: [{ sessionId: "one", cwd: WORKSPACE }],
        nextCursor: "next",
      })
      .mockResolvedValueOnce({
        sessions: [{ sessionId: "two", cwd: WORKSPACE }],
      });
    await preloadSessionList(WORKSPACE);
    expect(list).toHaveBeenNthCalledWith(
      2,
      WORKSPACE,
      expect.objectContaining({ cursor: "next" }),
    );
    expect(
      projectIndexes.catalog.store
        .getState()
        .sessionsByPath[WORKSPACE]!.map((item) => item.id),
    ).toEqual(["one", "two"]);
    list.mockResolvedValue({ sessions: [] });
    await preloadSessionList(WORKSPACE, true);
    expect(
      projectIndexes.catalog.store
        .getState()
        .sessionsByPath[WORKSPACE]?.map((item) => item.id),
    ).toEqual(["one", "two"]);
    list.mockRestore();
  });

  it("区分查询失败、不支持和空列表，并能在原连接上重试", async () => {
    fakeSessionControl.listShouldFail = true;
    await preloadSessionList(WORKSPACE);
    expect(
      projectIndexes.catalog.store.getState().statusByPath[WORKSPACE.toLowerCase()]
        ?.state,
    ).toBe("error");
    const list = vi
      .spyOn(FakeAcpSession.prototype, "listSessions")
      .mockRejectedValueOnce(
        new AcpResponseError("session/list", -32601, "unsupported"),
      );
    await preloadSessionList(WORKSPACE, true);
    expect(
      projectIndexes.catalog.store.getState().statusByPath[WORKSPACE.toLowerCase()]
        ?.state,
    ).toBe("unsupported");
    fakeSessionControl.listShouldFail = false;
    await preloadSessionList(WORKSPACE, true);
    expect(
      projectIndexes.catalog.store.getState().statusByPath[WORKSPACE.toLowerCase()]
        ?.state,
    ).toBe("ready");
    expect(projectIndexes.catalog.store.getState().sessionsByPath[WORKSPACE]).toEqual(
      [],
    );
    expect(spawnTransport).toHaveBeenCalledTimes(4);
    list.mockRestore();
  });

  it("切换 Agent 清理旧会话，新的同 ID 会话重新加载", async () => {
    await openRealWorkspace(WORKSPACE, { sessionId: "A" });
    const a = workingSession()!;
    const oldRuntime = [...projectFactory.sessions()][0]!;
    const transports = await Promise.all(
      spawnTransport.mock.results.map(
        (result) => result.value as Promise<AcpTransport>,
      ),
    );
    const kills = transports.map((transport) => vi.spyOn(transport, "kill"));
    useSessionStore.getState().beginTurn("旧任务");
    expect(agentService.addCustomAgent("Other", "other acp")).toBeNull();
    await switchRuntimeAgent("custom-other");
    expect(oldRuntime.disposed).toBe(true);
    expect(kills.every((kill) => kill.mock.calls.length === 1)).toBe(true);
    expect(hasRunningSessions()).toBe(false);
    await preloadSessionList(WORKSPACE);
    expect(projectIndexes.catalog.store.getState().sessionsByPath[WORKSPACE]).toEqual(
      [],
    );
    await openRealWorkspace(WORKSPACE, { sessionId: "A" });
    expect(workingSession()).not.toBe(a);
    expect(fakeSessionControl.loadCalls).toEqual(["A", "A"]);
    kills.forEach((kill) => kill.mockRestore());
  });

  it("新项目替换最近列表中的旧项目，即使数量不变也会预加载", async () => {
    useWorkspaceStore.setState({
      selectedPath: null,
      activePath: null,
      pinnedPaths: [],
      recentWorkspaces: [{ path: WORKSPACE, lastOpenedAt: "now" }],
    });
    const stop = attachSessionPreloading();
    try {
      await preloadSessionList(WORKSPACE);
      useWorkspaceStore.setState({
        recentWorkspaces: [{ path: "D:/replacement", lastOpenedAt: "now" }],
      });
      await preloadSessionList("D:/replacement");
      expect(spawnTransport).toHaveBeenCalledTimes(4);
      await vi.waitFor(() => expect(fakeSessionControl.closeCount).toBe(2));
      expect(
        projectIndexes.catalog.store.getState().sessionsByPath["D:/replacement"],
      ).toEqual([]);
    } finally {
      stop();
    }
  });
});

it("旧 Agent 的延迟列表结果不会覆盖新 Agent 目录", async () => {
  let release!: (value: {
    sessions: { sessionId: string; cwd: string }[];
  }) => void;
  const delayed = new Promise<{
    sessions: { sessionId: string; cwd: string }[];
  }>((resolve) => {
    release = resolve;
  });
  const list = vi
    .spyOn(FakeAcpSession.prototype, "listSessions")
    .mockImplementationOnce(() => delayed);
  const old = preloadSessionList(WORKSPACE);
  try {
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(agentService.addCustomAgent("Next", "next acp")).toBeNull();
    fakeSessionControl.listed = [{ sessionId: "new-agent", cwd: WORKSPACE }];
    const switching = switchRuntimeAgent("custom-next");
    release({ sessions: [{ sessionId: "old-agent", cwd: WORKSPACE }] });
    await old;
    await switching;
    await preloadSessionList(WORKSPACE);
    expect(fakeSessionControl.closeCount).toBe(2);
    expect(
      projectIndexes.catalog.store
        .getState()
        .sessionsByPath[WORKSPACE]?.map((item) => item.id),
    ).toEqual(["new-agent"]);
  } finally {
    release({ sessions: [] });
    list.mockRestore();
  }
});

it("离开项目不终止已经打开的工作会话", async () => {
  useWorkspaceStore.setState({
    selectedPath: WORKSPACE,
    activePath: WORKSPACE,
    recentWorkspaces: [{ path: WORKSPACE, lastOpenedAt: "now" }],
  });
  const stop = attachSessionPreloading();
  try {
    await openRealWorkspace(WORKSPACE, { sessionId: "A" });
    await preloadSessionList(WORKSPACE);
    const a = workingSession()!;
    const closeA = vi.spyOn(a, "closeSession");
    useWorkspaceStore.getState().closeWorkspace();
    await vi.waitFor(() => expect(fakeSessionControl.closeCount).toBe(1));
    expect(closeA).not.toHaveBeenCalled();
    expect(spawnTransport).toHaveBeenCalledTimes(4);
  } finally {
    stop();
  }
});

describe("新会话草稿先行", () => {
  it("慢连接期间立即切换空草稿，旧任务保活，迟到结果不抢回焦点", async () => {
    fakeSessionControl.listed = [{ sessionId: "running-A", cwd: WORKSPACE }];
    await openRealWorkspace(WORKSPACE, { sessionId: "running-A" });
    await preloadSessionList(WORKSPACE);
    const sessionA = workingSession()!;
    useSessionStore.getState().beginTurn("A继续执行");
    const cancel = vi.spyOn(sessionA, "cancel");
    let release!: (
      value: Awaited<ReturnType<FakeAcpSession["initialize"]>>,
    ) => void;
    const gate = new Promise<Awaited<ReturnType<FakeAcpSession["initialize"]>>>(
      (resolve) => {
        release = resolve;
      },
    );
    const initialize = vi
      .spyOn(FakeAcpSession.prototype, "initialize")
      .mockImplementationOnce(() => gate);
    const pending = navigationProject.sessions.startNewSession("D:/slow-project");
    expect(useSessionStore.getState().activeSessionId).toBeNull();
    expect(useSessionStore.getState().items).toEqual([]);
    expect(useSessionStore.getState().isDraftPreparing).toBe(true);
    expect(useWorkspaceStore.getState().activePath).toBe("D:/slow-project");
    expect(hasRunningSessions()).toBe(true);
    await vi.waitFor(() => expect(initialize).toHaveBeenCalled());
    expect(await navigationProject.sessions.openSessionFromEntry(WORKSPACE, "running-A")).toBeUndefined();
    expect(useSessionStore.getState().activeSessionId).toBe("running-A");
    release({
      protocolVersion: 1,
      agentInfo: { name: "chrys" },
      agentCapabilities: {},
    });
    await pending;
    expect(useSessionStore.getState().activeSessionId).toBe("running-A");
    expect(useSessionStore.getState().isAgentRunning).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    initialize.mockRestore();
    cancel.mockRestore();
  });
  it("同项目新草稿也立即隔离旧运行态，连接失败后留在草稿并可重试", async () => {
    await openRealWorkspace(WORKSPACE, { sessionId: "A" });
    useSessionStore.getState().beginTurn("A仍运行");
    const same = navigationProject.sessions.startNewSession(WORKSPACE);
    expect(useSessionStore.getState().isDraftPreparing).toBe(true);
    expect(useSessionStore.getState().isAgentRunning).toBe(false);
    expect(useSessionStore.getState().items).toHaveLength(0);
    await same;
    expect(useSessionStore.getState().isBound).toBe(true);
    expect(useSessionStore.getState().activeSessionId).toBe(fakeSessionControl.newSessionId);
    const initialize = vi
      .spyOn(FakeAcpSession.prototype, "initialize")
      .mockRejectedValueOnce(new Error("测试连接失败"));
    const failed = await navigationProject.sessions.startNewSession("D:/failed-project");
    expect(failed.ok).toBe(false);
    expect(useSessionStore.getState().isDraftPreparing).toBe(true);
    expect(useSessionStore.getState().lastError).toContain("测试连接失败");
    expect(useWorkbenchUiStore.getState().viewId).toBe("session");
    initialize.mockRestore();
    expect((await navigationProject.sessions.startNewSession("D:/failed-project")).ok).toBe(true);
    expect(useSessionStore.getState().isDraftPreparing).toBe(false);
    expect(useSessionStore.getState().isBound).toBe(true);
  });
});

describe("ACP bounded recovery", () => {
  it("reconnects original session and preserves the store without replaying", async () => {
    await openRealWorkspace(WORKSPACE, { forceNew: true });
    const old = workingSession()!;
    const oldPrompt = vi
      .spyOn(old, "prompt")
      .mockImplementation(() => new Promise(() => {}));
    const state = useSessionStore.getState();
    state.sendPrompt("unfinished");
    state.enqueuePrompt("queued");
    const replay = vi.spyOn(FakeAcpSession.prototype, "prompt");
    reconnectActiveSession();
    await vi.waitFor(() =>
      expect(useSessionStore.getState().recovery.state).toBe("idle"),
    );
    expect(fakeSessionControl.loadCalls).toContain("new-session-id");
    expect(replay).not.toHaveBeenCalled();
    expect(useSessionStore.getState().queuePaused).toBe(true);
    expect(useSessionStore.getState().turnState).toBe("unknown");
    expect(
      useSessionStore
        .getState()
        .items.filter(
          (item) => item.kind === "user" && item.text === "unfinished",
        ),
    ).toHaveLength(1);
    old.emit({
      type: "agent_message_chunk",
      sessionId: "new-session-id",
      text: "stale output",
    });
    expect(
      useSessionStore
        .getState()
        .items.some((item) => "text" in item && item.text === "stale output"),
    ).toBe(false);
    oldPrompt.mockRestore();
    replay.mockRestore();
  });

  it("fails after three automatic attempts without creating a replacement session", async () => {
    vi.useFakeTimers();
    try {
      await openRealWorkspace(WORKSPACE, { forceNew: true });
      fakeSessionControl.loadShouldFail = true;
      useSessionStore.setState({ connectionFailure: "broken pipe" });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(fakeSessionControl.loadCalls).toEqual([
        "new-session-id",
        "new-session-id",
        "new-session-id",
      ]);
      expect(useSessionStore.getState().recovery.state).toBe("failed");
      expect(useSessionStore.getState().activeSessionId).toBe("new-session-id");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop interrupts the retry delay", async () => {
    vi.useFakeTimers();
    try {
      await openRealWorkspace(WORKSPACE, { forceNew: true });
      useSessionStore.setState({ connectionFailure: "broken pipe" });
      await vi.advanceTimersByTimeAsync(0);
      stopActiveRecovery();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(fakeSessionControl.loadCalls).toEqual([]);
      expect(useSessionStore.getState().recovery.state).toBe("stopped");
    } finally {
      vi.useRealTimers();
    }
  });
});

it("stopping during session/load prevents a late connection from taking over or replaying", async () => {
  await openRealWorkspace(WORKSPACE, { forceNew: true });
  let release!: (result: { modes: null; models: null }) => void;
  const load = vi
    .spyOn(FakeAcpSession.prototype, "loadSession")
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
  const prompt = vi.spyOn(FakeAcpSession.prototype, "prompt");
  try {
    reconnectActiveSession();
    await vi.waitFor(() => expect(load).toHaveBeenCalled());
    stopActiveRecovery();
    release({ modes: null, models: null });
    await vi.waitFor(() =>
      expect(useSessionStore.getState().recovery.state).toBe("stopped"),
    );
    expect(useSessionStore.getState().isBound).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
  } finally {
    load.mockRestore();
    prompt.mockRestore();
  }
});

it("recovers a running background session without changing the foreground session", async () => {
  vi.useFakeTimers();
  let prompt: MockInstance<FakeAcpSession["prompt"]> | undefined;
  try {
    fakeSessionControl.newSessionId = "background";
    await openRealWorkspace(WORKSPACE, { forceNew: true });
    let fail!: (error: Error) => void;
    prompt = vi.spyOn(workingSession()!, "prompt").mockImplementation(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    useSessionStore.getState().sendPrompt("background task");
    fakeSessionControl.newSessionId = "foreground";
    await openRealWorkspace("D:/other-project", { forceNew: true });
    fail(new AcpClosedError("pipe closed"));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fakeSessionControl.loadCalls).toContain("background");
    expect(useSessionStore.getState().activeSessionId).toBe("foreground");
    expect(useSessionStore.getState().recovery.state).toBe("idle");
  } finally {
    prompt?.mockRestore();
    vi.useRealTimers();
  }
});

it("does not start a replacement until the connection owner confirms termination", async () => {
  vi.useFakeTimers();
  const kills: MockInstance[] = [];
  try {
    await openRealWorkspace(WORKSPACE, { forceNew: true });
    const transports = await Promise.all(
      spawnTransport.mock.results.map(
        (result) => result.value as Promise<AcpTransport>,
      ),
    );
    for (const transport of transports)
      kills.push(
        vi
          .spyOn(transport, "kill")
          .mockRejectedValue(new Error("termination failed")),
      );
    reconnectActiveSession();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(
      kills.reduce((total, kill) => total + kill.mock.calls.length, 0),
    ).toBe(1);
    expect(spawnTransport).toHaveBeenCalledTimes(4);
    expect(fakeSessionControl.loadCalls).toEqual([]);
    expect(useSessionStore.getState().recovery.state).toBe("failed");
  } finally {
    for (const kill of kills) kill.mockRestore();
    vi.useRealTimers();
  }
});

it("does not replay a completed prompt when exit and completion arrive in the same turn", async () => {
  vi.useFakeTimers();
  const prompt = vi.spyOn(FakeAcpSession.prototype, "prompt");
  try {
    await openRealWorkspace(WORKSPACE, { forceNew: true });
    useSessionStore.getState().sendPrompt("completed task");
    useSessionStore.setState({ connectionFailure: "exit just after result" });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fakeSessionControl.loadCalls).toContain("new-session-id");
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().recovery.state).toBe("idle");
  } finally {
    prompt.mockRestore();
    vi.useRealTimers();
  }
});

it("acp Service closes only the addressed project and keeps another project usable", async () => {
  const { startDesktopRuntime } =
    await import("../../src/bootstrap/mainRuntime.ts");
  const { closeSessionRuntime, runtimeDebugSnapshot, projectFactory } =
    await import("../helpers/projectCoordinatorFixture.ts");
  const { project } = await startDesktopRuntime().ready;
  expect(project.sessions).not.toHaveProperty("closeSession");
  expect(project.projects).not.toHaveProperty("closeProject");
  await project.sessions.openSession(WORKSPACE, { forceNew: true });
  const other = "D:/service-other";
  await project.sessions.openSession(other, { forceNew: true });
  await expect(project.projects.removeProject(WORKSPACE)).resolves.toBe(true);
  expect(runtimeDebugSnapshot().map((entry) => entry.workspacePath)).toEqual([
    other,
  ]);
  const remaining = [...projectFactory.sessions()][0]!;
  const target = {
    workspacePath: other,
    agentKey: remaining.agentKey,
    sessionId: remaining.session.sessionId!,
  };
  expect(project.conversation.send(target, "still usable")).toBe(true);
  await vi.waitFor(() =>
    expect(remaining.store.getState().isAgentRunning).toBe(false),
  );
  await closeSessionRuntime(target.workspacePath, target.agentKey, target.sessionId);
  expect(runtimeDebugSnapshot()).toEqual([]);
  await closeSessionRuntime(target.workspacePath, target.agentKey, target.sessionId);
});

beforeAll(async () => {
  const services = await startDesktopRuntime().ready;
  ({ project: navigationProject } = services);
  bindTestLayout(services.workbench);
  useWorkspaceStore = mutableWorkspace(navigationProject);
});

vi.mock("../../src/plugins/project/sessions/operations.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof ProjectOperationsModule>();
  const fixture = await import("../helpers/projectCoordinatorFixture.ts");
  return {
    ...actual,
    createProjectOperations: (dependencies: Parameters<typeof actual.createProjectOperations>[0]) => {
      fixture.bindProjectDependencies(dependencies);
      return {
      ...actual.projectOperationsFrom(fixture, dependencies.workspace),
      dispose: undefined,
      };
    },
  };
});
