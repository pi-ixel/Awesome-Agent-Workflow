import type { AcpSessionEvent } from "../../src/plugins/acpRuntime/events.ts";
import { createTestDocuments } from "../helpers/documents.ts";
import { createTestProjectWorkbench } from "../helpers/projectWorkbench.tsx";
import { registerDocumentPaths } from "../../src/plugins/documents/ui/workbench.tsx";
import { selectRuntimeStatusStore } from "../helpers/foreground.ts";
import { createAcpSession } from "../../src/plugins/acpRuntime/sessions/channelSession.ts";
import { createOwnedSession, sessionConnection } from "../helpers/ownedSession.ts";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { parseToolLocations } from "../../src/contracts/acp/toolLocations.ts";
import { createCodeAgentDialect } from "../../src/plugins/agents/enhancements/codeagent/dialect.ts";
import { attachSession, createSessionStore } from "../../src/plugins/project/conversation/sessionStore.ts";
import { createRuntimeStatusStore } from "../../src/plugins/project/conversation/runtimeStatusStore.ts";
import { createTestWorkspace } from "../helpers/workspace.ts";
const useWorkspaceStore = createTestWorkspace();
import { panelService } from "../../src/plugins/host/filesystem/panelService.ts";
import { ContextRing } from "../../src/plugins/project/conversation/ui/InputStatusBar.tsx";
import { ToolCallCard } from "../../src/plugins/project/conversation/ui/ToolCallCard.tsx";
import { ConversationDocumentContext } from "../../src/plugins/project/conversation/ui/documentView.ts";
import { PlanCard } from "../../src/plugins/project/conversation/ui/PlanCard.tsx";
import { standardAcpPeer } from "../helpers/standardAcpPeer.ts";

const meta = (toolName: string) => ({ codeAgentCLI: { toolName } });
const sid = "same-session";
const root = "D:/phase3";
const disposals: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  cleanup();
  for (const dispose of disposals.splice(0)) await dispose();
  selectRuntimeStatusStore(createRuntimeStatusStore());
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function fixture(enhanced = true, lists = true) {
  const f = standardAcpPeer();
  f.handlers.set("initialize", () => ({
    protocolVersion: 1,
    agentInfo: { name: "local-peer" },
    agentCapabilities: lists ? { sessionCapabilities: { list: {} } } : {},
  }));
  const session = createOwnedSession(f.client, {
    dialect: enhanced ? createCodeAgentDialect() : undefined,
  });
  const events: AcpSessionEvent[] = [];
  session.onEvent((event) => events.push(event));
  await session.initialize();
  await session.newSession(root);
  const store = createSessionStore(`phase3-${Math.random()}`);
  const detach = attachSession(session, store);
  disposals.push(
    detach,
    () => {
      store.getState().setSessionLogTarget(null);
    },
    () => sessionConnection(session).kill(),
  );
  return { ...f, session, events, store };
}
const todos = [
  { content: "核对协议边界", status: "in_progress" },
  { content: "补充测试", status: "pending" },
];

it("turns successful TodoWrite into one plan while retaining raw evidence, updating and restoring history", async () => {
  const f = await fixture();
  f.store.getState().setSessionLogTarget(root);
  f.update({
    sessionUpdate: "tool_call",
    toolCallId: "todo",
    kind: "think",
    title: "Task",
    status: "pending",
    rawInput: { todos },
    _meta: meta("TodoWrite"),
  });
  await waitFor(() => expect(f.store.getState().items).toHaveLength(1));
  expect(f.events.some((event) => event.type === "plan")).toBe(false);
  f.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "todo",
    status: "completed",
  });
  await waitFor(() =>
    expect(f.events.filter((event) => event.type === "plan")).toHaveLength(1),
  );
  const plan = f.store.getState().items.find((item) => item.kind === "plan")!;
  expect(plan).toMatchObject({
    entries: [{ priority: "medium" }, { priority: "medium" }],
  });
  if (plan.kind !== "plan") throw new Error("missing plan");
  render(<PlanCard item={plan} />);
  expect(screen.getByText("核对协议边界")).toBeInTheDocument();
  const completed = todos.map((todo) => ({ ...todo, status: "completed" }));
  f.update({
    sessionUpdate: "tool_call",
    toolCallId: "todo2",
    status: "completed",
    rawInput: JSON.stringify({ todos: completed }),
    _meta: meta("TodoWrite"),
  });
  f.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "todo2",
    status: "completed",
  });
  await waitFor(() =>
    expect(
      f.store.getState().items.find((item) => item.kind === "plan"),
    ).toMatchObject({
      entries: [{ status: "completed" }, { status: "completed" }],
    }),
  );
  expect(
    f.store.getState().items.filter((item) => item.kind === "plan"),
  ).toHaveLength(1);
  f.store.getState().endTurn({ stopReason: "end_turn" });
  f.store.getState().clear();
  f.store.getState().restoreSessionLog(root);
  expect(
    f.store.getState().items.find((item) => item.kind === "tool"),
  ).toMatchObject({ rawInput: { todos }, toolName: "TodoWrite" });
  expect(
    f.store.getState().items.filter((item) => item.kind === "plan"),
  ).toHaveLength(1);
});

it.each([
  ["TodoWrite", "failed", { todos }],
  ["Read", "completed", { todos }],
  ["TodoWrite", "completed", {}],
  [
    "TodoWrite",
    "completed",
    { todos: [{ content: "bad", status: "mystery" }] },
  ],
  ["TodoWrite", "completed", { todos: [{ content: "", status: "pending" }] }],
  [
    "TodoWrite",
    "completed",
    { todos: [{ content: "bad", status: "pending", priority: "urgent" }] },
  ],
])(
  "does not invent plans for %s/%s or malformed inputs",
  async (name, status, rawInput) => {
    const f = await fixture();
    f.update({
      sessionUpdate: "tool_call",
      toolCallId: "t",
      title: "TodoWrite",
      status,
      rawInput,
      _meta: meta(name),
    });
    await waitFor(() =>
      expect(f.events.some((event) => event.type === "tool_call")).toBe(true),
    );
    expect(f.events.some((event) => event.type === "plan")).toBe(false);
  },
);

it("keeps vendor TodoWrite inert without enhancement and deduplicates standard plans", async () => {
  const plain = await fixture(false);
  plain.update({
    sessionUpdate: "tool_call",
    toolCallId: "t",
    status: "completed",
    rawInput: { todos },
    _meta: meta("TodoWrite"),
  });
  await waitFor(() => expect(plain.events).toHaveLength(1));
  expect(
    plain.store.getState().items.filter((item) => item.kind === "plan"),
  ).toHaveLength(0);
  const f = await fixture();
  const entries = [
    { content: "same", status: "completed", priority: "medium" },
  ];
  f.update({ sessionUpdate: "plan", entries });
  f.update({
    sessionUpdate: "tool_call",
    toolCallId: "t",
    status: "completed",
    rawInput: { todos: entries },
    _meta: meta("TodoWrite"),
  });
  f.update({ sessionUpdate: "plan", entries });
  await waitFor(() => expect(f.events).toHaveLength(3));
  expect(
    f.store.getState().items.filter((item) => item.kind === "plan"),
  ).toHaveLength(1);
});

it.each([{ used: 78089, size: 0 }, { used: 0, size: 0 }, { size: 120000 }])(
  "shows unknown context honestly for %j",
  async (wire) => {
    const f = await fixture();
    const status = createRuntimeStatusStore();
    selectRuntimeStatusStore(status);
    f.session.onEvent(status.getState().handleSessionEvent);
    f.update({ sessionUpdate: "usage_update", ...wire });
    await waitFor(() => expect(status.getState().usage).not.toBeNull());
    render(<ContextRing />);
    fireEvent.focus(screen.getByRole("button", { name: /上下文用量/ }));
    expect(screen.getByLabelText("上下文容量")).toHaveTextContent("比例未知");
    expect(screen.getByLabelText("上下文容量")).not.toHaveTextContent("0%");
    expect(status.getState().usage?.totalSessionTokens).toBeNull();
    if (wire.used === 78089)
      expect(screen.getByLabelText("上下文容量")).toHaveTextContent("7.8万");
    act(() =>
      status.getState().handleSessionEvent({
        type: "usage_update",
        sessionId: sid,
        contextUsed: 60000,
        contextSize: 120000,
      }),
    );
    expect(screen.getByLabelText("上下文容量")).toHaveTextContent("50%");
  },
);

it("roundtrips standard locations and opens the file at the reported line", async () => {
  const f = await fixture(false);
  useWorkspaceStore.setState({ activePath: root });
  const stat = vi.spyOn(panelService, "stat").mockResolvedValue({
    path: `${root}/src/a.ts`,
    name: "a.ts",
    directory: false,
    symlink: false,
  });
  f.store.getState().setSessionLogTarget(root);
  f.update({
    sessionUpdate: "tool_call",
    toolCallId: "read",
    kind: "read",
    title: "Read",
    status: "completed",
    locations: [
      { path: "src/a.ts", line: 12 },
      { path: "src/a.ts", line: 12 },
      { path: "../outside.ts", line: 2 },
    ],
  });
  f.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "read",
    title: "Read completed",
    locations: null,
  });
  await waitFor(() =>
    expect(f.store.getState().items[0]).toMatchObject({
      title: "Read completed",
      locations: [
        { path: "src/a.ts", line: 12 },
        { path: "../outside.ts", line: 2 },
      ],
    }),
  );
  f.store.getState().endTurn({ stopReason: "end_turn" });
  f.store.getState().clear();
  f.store.getState().restoreSessionLog(root);
  const item = f.store.getState().items[0]!;
  if (item.kind !== "tool") throw new Error("missing tool");
  const workbench = createTestProjectWorkbench({});
  workbench.workbench.navigation.getState().openView("project-overview", root);
  const open = vi.spyOn(workbench.workbench.panels.getState(), "openTab");
  const documents = createTestDocuments();
  registerDocumentPaths(workbench.workbench, documents);
  disposals.push(() => {
    workbench.dispose();
    documents.dispose();
  });
  render(
    <ConversationDocumentContext.Provider value={{ openPath: workbench.workbench.openPath }}>
      <ToolCallCard item={item} />
    </ConversationDocumentContext.Provider>,
    { wrapper: workbench.Wrapper },
  );
  fireEvent.click(screen.getByRole("button", { name: /Read completed/ }));
  expect(
    screen.getByRole("button", { name: "../outside.ts:2" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "src/a.ts:12" }));
  await waitFor(() =>
    expect(open).toHaveBeenCalledWith(
      root,
      expect.objectContaining({ kind: "file", data: { path: `${root}/src/a.ts`, line: 12 } }),
      expect.any(Function),
    ),
  );
  expect(stat).toHaveBeenCalledWith(`${root}/src/a.ts`);
  stat.mockRejectedValueOnce(new Error("file missing"));
  fireEvent.click(screen.getByRole("button", { name: "src/a.ts:12" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("file missing"),
  );
  expect(open).toHaveBeenCalledTimes(1);
  stat.mockResolvedValueOnce({
    path: `${root}/src/a.ts`,
    name: "a.ts",
    directory: false,
    symlink: false,
  });
  act(() => workbench.workbench.navigation.getState().openView("project-overview", "D:/other-project"));
  fireEvent.click(screen.getByRole("button", { name: "src/a.ts:12" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("项目已切换"),
  );
  expect(open).toHaveBeenCalledTimes(1);
  f.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "read",
    locations: [],
  });
  await waitFor(() =>
    expect(f.store.getState().items[0]).toMatchObject({ locations: [] }),
  );
});

it("rejects invalid locations and retains path-only locations", () => {
  expect(
    parseToolLocations([
      null,
      { path: "" },
      { path: "x", line: 0 },
      { path: "x", line: -1 },
      { path: "x", line: 1.5 },
      { path: "x", line: "2" },
      { path: "x", line: Infinity },
      { path: "x", line: 0x100000000 },
      { path: "z", line: null },
      { path: "y" },
    ]),
  ).toEqual([{ path: "x" }, { path: "z" }, { path: "y" }]);
});

it("bounds title refresh to ten pages and times out without changing the turn result", async () => {
  const f = await fixture();
  let page = 0;
  f.handlers.set("session/list", () => ({
    sessions: [],
    nextCursor: `page-${++page}`,
  }));
  await f.session.prompt("test");
  await waitFor(() => expect(page).toBe(10));
  expect(f.events.some((event) => event.type === "session_info_update")).toBe(
    false,
  );
  f.handlers.set("session/list", () => new Promise(() => {}));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await expect(f.session.prompt("test timeout")).resolves.toMatchObject({
    stopReason: "end_turn",
  });
  await vi.advanceTimersByTimeAsync(2001);
  expect(f.events.some((event) => event.type === "session_info_update")).toBe(
    false,
  );
  await expect(f.session.prompt("quarantined")).rejects.toThrow("quarantined");
  const replacement = await fixture();
  replacement.handlers.set("session/list", () => ({
    sessions: [{ sessionId: sid, cwd: root, title: "recovered title" }],
  }));
  await replacement.session.prompt("recovered");
  await vi.advanceTimersByTimeAsync(0);
  expect(replacement.events).toContainEqual(
    expect.objectContaining({
      type: "session_info_update",
      title: "recovered title",
    }),
  );
});

it("refreshes title from paginated session/list without overriding manual titles", async () => {
  const f = await fixture();
  f.store
    .getState()
    .setSessions([{ id: sid, title: "old", updatedAt: null }], root);
  f.store.getState().renameSession(sid, "我的标题");
  f.handlers.set("session/list", (request) =>
    request.params?.cursor
      ? {
          sessions: [
            {
              sessionId: sid,
              cwd: root,
              title: "Agent 新标题",
              updatedAt: "2026-11-06T12:00:00Z",
            },
          ],
        }
      : {
          sessions: [{ sessionId: "other", cwd: root, title: "other" }],
          nextCursor: "next",
        },
  );
  await f.session.prompt("test");
  await waitFor(() =>
    expect(f.store.getState().sessions[0]).toMatchObject({
      title: "我的标题",
      nativeTitle: "Agent 新标题",
    }),
  );
  f.store.getState().renameSession(sid, "");
  expect(f.store.getState().sessionsByPath[root]?.[0]?.title).toBe(
    "Agent 新标题",
  );
  expect(
    f.received
      .filter((wire) => wire.method === "session/list")
      .map((wire) => wire.params),
  ).toEqual([{ cwd: root }, { cwd: root, cursor: "next" }]);
});

it.each([
  [false, true],
  [true, false],
])(
  "does not poll title without enhancement=%s or capability=%s",
  async (enhanced, lists) => {
    const f = await fixture(enhanced, lists);
    await f.session.prompt("test");
    expect(f.received.some((wire) => wire.method === "session/list")).toBe(
      false,
    );
  },
);

it("list failures do not fail a successful turn; repeated cursors are bounded", async () => {
  const f = await fixture();
  f.handlers.set("session/list", () => {
    throw new Error("list unavailable");
  });
  await expect(f.session.prompt("test")).resolves.toMatchObject({
    stopReason: "end_turn",
  });
  await waitFor(() =>
    expect(
      f.received.filter((wire) => wire.method === "session/list"),
    ).toHaveLength(1),
  );
  f.handlers.set("session/list", () => ({
    sessions: [],
    nextCursor: "repeat",
  }));
  await f.session.prompt("test again");
  await waitFor(() =>
    expect(
      f.received.filter((wire) => wire.method === "session/list"),
    ).toHaveLength(3),
  );
  expect(f.events.some((event) => event.type === "session_info_update")).toBe(
    false,
  );
});

it.each(["session", "push", "prompt"])(
  "discards late list snapshots after a newer %s",
  async (change) => {
    const f = await fixture();
    let finish!: (value: unknown) => void;
    f.handlers.set(
      "session/list",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await f.session.prompt("test");
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    let current = f.session;
    if (change === "session") {
      await f.session.closeSession();
      current = createAcpSession(sessionConnection(f.session), { dialect: createCodeAgentDialect() });
      await current.loadSession("new-session", root);
    }
    else if (change === "push") {
      f.update({ sessionUpdate: "session_info_update", title: "pushed title" });
      await waitFor(() =>
        expect(
          f.events.some((event) => event.type === "session_info_update"),
        ).toBe(true),
      );
    } else {
      f.handlers.set("session/list", () => ({ sessions: [] }));
      await f.session.prompt("new turn");
    }
    finish({ sessions: [{ sessionId: sid, cwd: root, title: "stale title" }] });
    f.handlers.set("session/list", () => ({ sessions: [] }));
    // A final wire request acts as a barrier for the preceding response handlers.
    await current.listSessions(root);
    expect(
      f.events.filter((event) => event.type === "session_info_update"),
    ).not.toContainEqual(expect.objectContaining({ title: "stale title" }));
  },
);

vi.mock("../../src/plugins/project/ui/bindings/workspaceView.ts", async () => {
  const { workspaceViewFixture } = await import("../helpers/workspace.ts");
  return workspaceViewFixture(() => useWorkspaceStore);
});

vi.mock("../../src/plugins/project/ui/bindings/conversationView.ts", async () => {
  const { conversationViewFixture } = await import("../helpers/foreground.ts");
  return conversationViewFixture();
});

vi.mock(import("../../src/plugins/workbench/ui/bindings/layoutView.ts"), async (original) => {
  const { layoutViewFixture } = await import("../helpers/layout.ts");
  return { ...(await original()), ...layoutViewFixture() };
});
