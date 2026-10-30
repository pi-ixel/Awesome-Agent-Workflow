import {
  useSessionActivityStore,
  sessionActivityKey,
} from "../../src/stores/sessionActivityStore.ts";
import { hasRunningSessions } from "../../src/ui/realRuntime.ts";
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readChrysArchive } from "../../src/agents/chrysArchive.ts";

vi.mock("../../src/agents/chrysArchive.ts", () => ({
  readChrysArchive: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../../src/acp/session.ts", async () => {
  const { FakeAcpSession } = await import("../fixtures/fakeAcpSession.ts");
  return { AcpSession: FakeAcpSession };
});

vi.mock("../../src/acp/transport/tauriStdioTransport.ts", () => ({
  createTauriStdioTransport: vi.fn(() =>
    Promise.resolve({ fake: true, onExit: () => () => undefined }),
  ),
}));

import {
  closeRealRuntime,
  openRealWorkspace,
  switchRealSession,
} from "../../src/ui/realRuntime.ts";
import { useApprovalStore } from "../../src/stores/approvalStore.ts";
import { useSessionStore } from "../../src/stores/sessionStore.ts";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import { useWorkspaceStore } from "../../src/stores/workspaceStore.ts";
import { useWorkbenchUiStore } from "../../src/stores/workbenchUiStore.ts";
import {
  fakeSessionControl,
  resetFakeSessionControl,
} from "../fixtures/fakeAcpSession.ts";
import { createTauriStdioTransport } from "../../src/acp/transport/tauriStdioTransport.ts";
import { openSessionFromEntry } from "../../src/ui/workbench/sessionEntry.ts";

// transport 工厂的打桩句柄：按用例脚本化 spawn 失败
const spawnTransport = vi.mocked(createTauriStdioTransport);

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
  spawnTransport.mockClear();
  const session = useSessionStore.getState();
  session.setSessionLogTarget(null);
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
  useWorkspaceStore.setState({ lastConnectError: null });
  useApprovalStore.getState().clear();
  useWorkbenchUiStore.setState({
    treeView: "project-overview",
    contextPath: null,
    overlay: null,
    expandedOverrides: {},
    sidebarCollapsed: false,
    treeViewMode: "projects",
    isAddPanelOpen: false,
  });
  // 审批默认模式复位为 ask（人工弹窗）
  useSettingsStore.getState().resetToDefaults();
}

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
    useSettingsStore.setState({
      agents: [
        { id: "custom-other", name: "Other", command: ["other", "acp"] },
      ],
      activeAgentId: "custom-other",
    });
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
    // 列表仍完整回填（左栏树需要），当前会话置顶
    expect(useSessionStore.getState().sessions[0]?.id).toBe("sess-old");
    // 恢复的历史会话用 list 的权威标题——回放未到时不得兜底成
    // 「会话 · 当前时刻」（看起来像新开的会话）
    expect(useSessionStore.getState().sessions[0]?.title).toBe(
      "旧会话权威标题",
    );
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

  it("点名的 sessionId load 失败（会话真不存在）回落 newSession 并公告", async () => {
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
    expect(useSessionStore.getState().activeSessionId).toBe("new-session-id");
  });

  it("loadSession 失败（会话过期）回落 newSession，打开工作区不失败", async () => {
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
    expect(state.activeSessionId).toBe("new-session-id");
    // 新建会话置顶；过期的历史条目保留在列表中（点击可重试，失败不致命）
    expect(state.sessions.map((entry) => entry.id)).toEqual([
      "new-session-id",
      "sess-expired",
    ]);
  });

  it("session/list 失败：激活模式不回落新建（连接只为列表服务），树为空", async () => {
    fakeSessionControl.listShouldFail = true;
    await openRealWorkspace(WORKSPACE, { listOnly: true });
    expect(fakeSessionControl.loadCalls).toEqual([]);
    expect(useSessionStore.getState().activeSessionId).toBeNull();
  });

  it("无历史会话直接新建：空对话起步，不回灌旧快照（内容错位防护）", async () => {
    seedLocalLog([
      {
        kind: "user",
        id: "u1",
        text: "上次的问题",
        createdAt: "2026-10-19T10:00:00Z",
      },
      { kind: "assistant", id: "a1", text: "上次的回答", isStreaming: true },
    ]);

    await openRealWorkspace(WORKSPACE, { forceNew: true });

    expect(fakeSessionControl.loadCalls).toEqual([]);
    // forceNew 例外：旧快照灌进全新会话就是内容错位，绝不回灌
    expect(useSessionStore.getState().items).toEqual([]);
    expect(useSessionStore.getState().activeSessionId).toBe("new-session-id");
  });

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
    fakeSessionControl.lastInstance?.emit({
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
    expect(useWorkbenchUiStore.getState().treeView).toBe("project-overview");
  });
});

describe("switchRealSession：左栏点击历史会话的切换", () => {
  it("切换历史会话时恢复用户提问，失败和成功后都退出回放模式", async () => {
    fakeSessionControl.listed = [{ sessionId: "sess-latest", cwd: WORKSPACE }];
    await openRealWorkspace(WORKSPACE);
    fakeSessionControl.loadShouldFail = true;
    expect(await switchRealSession("sess-failed")).toBe(false);
    fakeSessionControl.lastInstance?.emit({
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
    fakeSessionControl.lastInstance?.emit({
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
    expect(fakeSessionControl.closeCount).toBe(0);
    expect(await switchRealSession("sess-latest")).toBe(true);
    expect(fakeSessionControl.loadCalls).toEqual(["sess-latest", "sess-other"]);
    expect(useSessionStore.getState().isAgentRunning).toBe(true);
    expect(useSessionStore.getState().queuedPrompts).toEqual(["稍后执行"]);
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
    expect(fakeSessionControl.lastInstance?.sessionId).toBe("sess-2");
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
    spawnTransport.mockRejectedValueOnce(new Error("chrys.exe 不存在"));
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
    expect(ui.treeView).toBe("session");
    expect(ui.contextPath).toBe(WORKSPACE);
  });

  it("全新 newSession 不切视图（保持项目总览）", async () => {
    // 无历史（list 空）→ 直接新建
    await openRealWorkspace(WORKSPACE);
    const ui = useWorkbenchUiStore.getState();
    expect(ui.treeView).toBe("project-overview");

    // 有历史但 load 失败回落新建，同样保持总览
    useWorkbenchUiStore.setState({ treeView: "project-overview" });
    fakeSessionControl.listed = [{ sessionId: "sess-expired", cwd: WORKSPACE }];
    fakeSessionControl.loadShouldFail = true;
    await openRealWorkspace("D:/other-project");
    expect(useWorkbenchUiStore.getState().treeView).toBe("project-overview");
  });
});

describe("openRealWorkspace：审批默认模式分派（P0-4）", () => {
  /** 打开会话并取出装配时注入的权限审批回调。 */
  async function openAndGetResponder() {
    await openRealWorkspace(WORKSPACE);
    const responder = fakeSessionControl.lastPermissionResponder;
    if (responder === null) {
      throw new Error("装配应注入权限审批回调");
    }
    return responder;
  }

  it("ask（默认）：走人工弹窗（offerPermission 挂起待办）", async () => {
    useSettingsStore.getState().setApprovalMode("ask");
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
    useSettingsStore.getState().setApprovalMode("auto-allow");
    const responder = await openAndGetResponder();

    const outcome = await responder("s1", TOOL_CALL, CHRYS_PERMISSION_OPTIONS);
    expect(outcome).toEqual({ outcome: "selected", optionId: "allow" });
    expect(useApprovalStore.getState().pending).toHaveLength(0);
  });

  it("白名单落空（只有未知 kind 选项）：回退人工弹窗，绝不静默取消", async () => {
    useSettingsStore.getState().setApprovalMode("auto-allow");
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
    const openingB = openSessionFromEntry(WORKSPACE, "B");
    await vi.waitFor(() =>
      expect(readChrysArchive).toHaveBeenCalledWith(
        expect.anything(),
        "B",
        WORKSPACE,
      ),
    );
    await openSessionFromEntry(WORKSPACE, "A");
    expect(useSessionStore.getState().activeSessionId).toBe("A");
    await openSessionFromEntry(WORKSPACE, "B");
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
      const openingA = openSessionFromEntry(WORKSPACE, "A");
      await vi.waitFor(() =>
        expect(readChrysArchive).toHaveBeenCalledWith(
          expect.anything(),
          "A",
          WORKSPACE,
        ),
      );
      await openSessionFromEntry(WORKSPACE, "B");
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
  it("预热连接在启动新进程前就地消费，不遗留候选进程", async () => {
    await openRealWorkspace(WORKSPACE, { listOnly: true });
    const warm = fakeSessionControl.lastInstance;
    expect(spawnTransport).toHaveBeenCalledTimes(1);
    await openRealWorkspace(WORKSPACE, { sessionId: "A" });
    expect(fakeSessionControl.lastInstance).toBe(warm);
    expect(spawnTransport).toHaveBeenCalledTimes(1);
    expect(fakeSessionControl.loadCalls).toEqual(["A"]);
    expect(useSessionStore.getState().isBound).toBe(true);
    expect(useSessionStore.getState().isConnecting).toBe(false);
    await closeRealRuntime();
    expect(fakeSessionControl.closeCount).toBe(1);
  });

  it("激活项目的 effect 不会把已点开的 B 焦点抢回同项目先打开的 A", async () => {
    await openRealWorkspace(WORKSPACE, { sessionId: "A" });
    await openRealWorkspace(WORKSPACE, { sessionId: "B" });
    await openRealWorkspace(WORKSPACE, { listOnly: true });
    expect(useSessionStore.getState().activeSessionId).toBe("B");
    expect(spawnTransport).toHaveBeenCalledTimes(2);
    expect(fakeSessionControl.closeCount).toBe(0);
  });

  it.each([WORKSPACE, "D:/another-project"])(
    "空闲 A 切到 %s 的 B 后再激活 A 项目，复用后台连接且不重放历史",
    async (projectB) => {
      await openRealWorkspace(WORKSPACE, { sessionId: "A" });
      const a = fakeSessionControl.lastInstance;
      useSessionStore.getState().beginTurn("A 的已有内容");
      useSessionStore.getState().endTurn({ stopReason: "end_turn" });
      await openRealWorkspace(projectB, { sessionId: "B" });
      await openRealWorkspace(WORKSPACE, { listOnly: true });
      await switchRealSession("A");
      expect(spawnTransport).toHaveBeenCalledTimes(2);
      expect(fakeSessionControl.closeCount).toBe(0);
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
      const a = fakeSessionControl.lastInstance!;
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
      const b = fakeSessionControl.lastInstance!;
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
      expect(fakeSessionControl.closeCount).toBe(0);
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
      expect(fakeSessionControl.closeCount).toBe(2);
    },
  );

  it("后台审批不抢焦点，同名工具请求在两条会话中分别决策", async () => {
    fakeSessionControl.newSessionId = "A";
    await openRealWorkspace(WORKSPACE, { forceNew: true });
    const offerA = fakeSessionControl.lastPermissionResponder!;
    fakeSessionControl.newSessionId = "B";
    await openRealWorkspace(WORKSPACE, { forceNew: true });
    const offerB = fakeSessionControl.lastPermissionResponder!;
    const answerA = offerA("A", TOOL_CALL, CHRYS_PERMISSION_OPTIONS);
    expect(useApprovalStore.getState().pending).toEqual([]);
    expect(
      useSessionActivityStore.getState().entries[
        sessionActivityKey(WORKSPACE, "A")
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
      useSessionActivityStore.getState().entries[
        sessionActivityKey(WORKSPACE, "A")
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
    spawnTransport.mockRejectedValueOnce(new Error("无法启动 B"));
    expect(await openRealWorkspace("D:/B", { forceNew: true })).toBeNull();
    expect(useSessionStore.getState().activeSessionId).toBe("A");
    expect(useSessionStore.getState().isAgentRunning).toBe(true);
    expect(fakeSessionControl.closeCount).toBe(0);
  });

  it("同项目两条会话的本地快照使用独立键", async () => {
    for (const id of ["A", "B"]) {
      fakeSessionControl.newSessionId = id;
      await openRealWorkspace(WORKSPACE, { forceNew: true });
      useSessionStore.getState().beginTurn(`仅属于 ${id}`);
      useSessionStore.getState().endTurn({ stopReason: "end_turn" });
      useSessionStore.getState().flushSessionLog();
    }
    const a = localStorage.getItem(
      `aaw-desktop/session-log/${encodeURIComponent("d:/demo-project#A")}`,
    );
    const b = localStorage.getItem(
      `aaw-desktop/session-log/${encodeURIComponent("d:/demo-project#B")}`,
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
  const a = fakeSessionControl.lastInstance!;
  const originalClose = a.close.bind(a);
  let finish!: () => void;
  vi.spyOn(a, "close").mockImplementation(async () => {
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
  expect(fakeSessionControl.closeCount).toBe(1);
});

