/**
 * 侧栏会话分组扩展点：发布方推送分组（store），侧栏把组内会话收进一行
 * 可折叠的分组行（排列纯函数 + ProjectTree 渲染），会话视角只在副行注明
 * 所属分组。
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindTestLayout, useRightPanelStore, useWorkbenchUiStore } from "../../../helpers/layout.ts";
import { useSessionStore } from "../../../helpers/foreground.ts";
import { createTestProjectIndexes } from "../../../helpers/projectIndexes.ts";
import { createTestProjectWorkbench } from "../../../helpers/projectWorkbench.tsx";
import { createTestWorkspace } from "../../../helpers/workspace.ts";
import { ProjectTree } from "../../../../src/plugins/project/ui/ProjectTree.tsx";
import { arrangeSessionChildren } from "../../../../src/plugins/project/ui/sessionGroupLayout.ts";
import { createSessionGroups, type SessionGroup } from "../../../../src/plugins/project/sessions/sessionGroups.ts";
import { pathKey } from "../../../../src/shared/panelPaths.ts";

const PATH = "D:/dev/pager";
const session = (id: string, title = id) => ({ id, title, updatedAt: null });
const group = (id: string, members: string[], extra: Partial<SessionGroup> = {}): SessionGroup => ({
  id,
  title: `运行 ${id}`,
  status: "completed",
  members: members.map((sessionId) => ({ sessionId, title: `角色 ${sessionId}` })),
  ...extra,
});

describe("session group store", () => {
  it("merges publishers per project path and withdraws a publisher's groups on dispose", () => {
    const store = createSessionGroups();
    const first = store.register();
    const second = store.register();
    first.publish("D:\\dev\\pager", [group("a", ["s1"])]);
    second.publish(PATH, [group("b", ["s2"])]);
    expect(store.snapshot.getState().byPath[pathKey(PATH)]?.map((item) => item.id)).toEqual(["a", "b"]);
    first.publish(PATH, []);
    expect(store.snapshot.getState().byPath[pathKey(PATH)]?.map((item) => item.id)).toEqual(["b"]);
    second.dispose();
    expect(store.snapshot.getState().byPath[pathKey(PATH)]).toBeUndefined();
    // 撤下后的发布方不再生效。
    second.publish(PATH, [group("c", ["s3"])]);
    expect(store.snapshot.getState().byPath).toEqual({});
    store.dispose();
  });
});

describe("arrangeSessionChildren", () => {
  it("puts a group where its most recent member is and keeps the other sessions in order", () => {
    const items = arrangeSessionChildren(
      [session("mine-1"), session("s2"), session("mine-2"), session("s1")],
      [group("run", ["s1", "s2"])],
      () => false,
    );
    expect(items.map((item) => (item.kind === "group" ? `group:${item.group.id}` : item.session.id)))
      .toEqual(["mine-1", "group:run", "mine-2"]);
    const run = items[1];
    expect(run?.kind === "group" ? run.members.map((item) => item.member.sessionId) : []).toEqual(["s1", "s2"]);
  });

  it("puts groups with no listed member first, drops empty finished groups, and skips archived members", () => {
    const items = arrangeSessionChildren(
      [session("mine"), session("s1")],
      [
        group("fresh", ["new-session"], { status: "running" }),
        group("empty-done", []),
        group("empty-running", [], { status: "running" }),
        group("run", ["s1", "archived"]),
      ],
      (id) => id === "archived",
    );
    expect(items.map((item) => (item.kind === "group" ? `group:${item.group.id}` : item.session.id)))
      .toEqual(["group:fresh", "group:empty-running", "mine", "group:run"]);
    const fresh = items[0];
    // 列表里还没有的会话以成员显示名补位。
    expect(fresh?.kind === "group" ? fresh.members[0]?.session.title : "").toBe("角色 new-session");
    const run = items[3];
    expect(run?.kind === "group" ? run.members.map((item) => item.member.sessionId) : []).toEqual(["s1"]);
  });

  it("pins running and waiting groups to the top even when their sessions sort far back", () => {
    const history = Array.from({ length: 30 }, (_, index) => session(`old-${index}`));
    const items = arrangeSessionChildren(
      [...history, session("live-1"), session("done-1"), session("live-2")],
      [
        group("live", ["live-1", "live-2"], { status: "waiting" }),
        group("done", ["done-1"]),
        group("busy", ["missing"], { status: "running" }),
      ],
      () => false,
    );
    const ids = items.map((item) => (item.kind === "group" ? `group:${item.group.id}` : item.session.id));
    expect(ids.slice(0, 3)).toEqual(["group:live", "group:busy", "old-0"]);
    // 已结束的分组仍占它最近一条会话的位置。
    expect(ids.at(-1)).toBe("group:done");
  });

  it("hides an archived group together with its sessions", () => {
    const items = arrangeSessionChildren(
      [session("mine"), session("s1"), session("s2")],
      [group("old", ["s1", "s2"], { hidden: true })],
      () => false,
    );
    expect(items.map((item) => (item.kind === "group" ? `group:${item.group.id}` : item.session.id))).toEqual(["mine"]);
  });

  it("gives a session claimed by two groups to the first one", () => {
    const items = arrangeSessionChildren([session("s1"), session("s2")], [group("a", ["s1"]), group("b", ["s1", "s2"])], () => false);
    const members = items.flatMap((item) => (item.kind === "group" ? [`${item.group.id}:${item.members.map((m) => m.member.sessionId).join(",")}`] : []));
    expect(members).toEqual(["a:s1", "b:s2"]);
  });
});

describe("ProjectTree session groups", () => {
  const useWorkspaceStore = createTestWorkspace();
  let indexes: ReturnType<typeof createTestProjectIndexes>;
  let fixture: ReturnType<typeof createTestProjectWorkbench>;

  beforeEach(() => {
    window.localStorage.clear();
    indexes = createTestProjectIndexes();
    fixture = createTestProjectWorkbench({ sessions: indexes, projects: { workspace: useWorkspaceStore } });
    bindTestLayout(fixture.workbench);
    useWorkspaceStore.setState({
      selectedPath: null,
      activePath: null,
      recentWorkspaces: [{ path: PATH, lastOpenedAt: "2026-10-20T10:00:00Z" }],
      pinnedPaths: [],
      pinnedSessions: [],
    });
    useSessionStore.setState({ sessionsByPath: {}, agentKey: undefined });
    useWorkbenchUiStore.setState({ contextPath: null, viewId: "project-overview" });
    useRightPanelStore.setState({ projects: {} });
    indexes.catalog.setState({
      sessionsByPath: { [PATH]: [session("mine", "我自己的会话"), session("s-design", "chrys 标题 A"), session("s-review", "chrys 标题 B")] },
    });
  });

  afterEach(() => {
    bindTestLayout(undefined);
    fixture.dispose();
    indexes.dispose();
  });

  it("folds a run's sessions into one group row with the attention chip, expands to role rows and opens the run", () => {
    const open = vi.fn();
    const publisher = indexes.registerSessionGroups();
    render(<ProjectTree />, { wrapper: fixture.Wrapper });
    // 同一个已完成会话：分组前显示「已完成未读」点。
    act(() => {
      indexes.activity.getState().update({ project: PATH, sessionId: "s-design", status: "completed", unread: true, pending: 0 });
    });
    expect(screen.getByLabelText("已完成，未查看")).toBeInTheDocument();
    act(() => {
      publisher.publish(PATH, [{
        id: "run-1",
        title: "AAW dev · run-1",
        status: "waiting",
        attention: "等你回复",
        defaultExpanded: true,
        open,
        openLabel: "在 AAW 面板中查看",
        members: [
          { sessionId: "s-design", title: "设计", note: "设计修正", attention: "等你回复" },
          { sessionId: "s-review", title: "独立设计检查" },
        ],
      }]);
    });
    const row = screen.getByRole("button", { name: "AAW dev · run-1，2 个会话" });
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(within(row).getByText("等你回复")).toBeInTheDocument();
    const members = screen.getByRole("list", { name: "AAW dev · run-1 的会话" });
    expect(within(members).getByText("设计")).toBeInTheDocument();
    expect(within(members).getByText("· 设计修正")).toBeInTheDocument();
    // 提醒胶囊替换了误导人的「已完成未读」点；组内会话不再平铺。
    expect(screen.queryByLabelText("已完成，未查看")).not.toBeInTheDocument();
    expect(screen.queryByText("chrys 标题 A")).not.toBeInTheDocument();
    expect(screen.getByText("我自己的会话")).toBeInTheDocument();
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "AAW dev · run-1 的会话" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "在 AAW 面板中查看" }));
    expect(open).toHaveBeenCalledTimes(1);
    // 撤下分组后会话回到平铺。
    act(() => publisher.dispose());
    expect(screen.getByText("chrys 标题 A")).toBeInTheDocument();
  });

  it("tucks finished members into a collapsed 已完成 section and shows them on demand", () => {
    const publisher = indexes.registerSessionGroups();
    publisher.publish(PATH, [group("live", [], {
      title: "AAW dev · live",
      status: "running",
      defaultExpanded: true,
      members: [
        { sessionId: "s-design", title: "设计" },
        { sessionId: "s-review", title: "需求确认", done: true },
      ],
    })]);
    render(<ProjectTree />, { wrapper: fixture.Wrapper });
    const members = screen.getByRole("list", { name: "AAW dev · live 的会话" });
    expect(within(members).getByText("设计")).toBeInTheDocument();
    expect(within(members).queryByText("需求确认")).not.toBeInTheDocument();
    const toggle = within(members).getByRole("button", { name: "已完成的会话，1 个" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(within(screen.getByRole("list", { name: "AAW dev · live 已完成的会话" })).getByText("需求确认")).toBeInTheDocument();
  });

  it("does not split when every member is done", () => {
    const publisher = indexes.registerSessionGroups();
    publisher.publish(PATH, [group("all", [], {
      title: "AAW dev · all",
      status: "running",
      defaultExpanded: true,
      members: [{ sessionId: "s-design", title: "设计", done: true }],
    })]);
    render(<ProjectTree />, { wrapper: fixture.Wrapper });
    expect(screen.getByText("设计")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /已完成的会话/ })).not.toBeInTheDocument();
  });

  it("expands the group and its 已完成 section when the open session is inside", () => {
    const publisher = indexes.registerSessionGroups();
    publisher.publish(PATH, [group("live", [], {
      title: "AAW dev · live",
      status: "running",
      members: [
        { sessionId: "s-design", title: "设计" },
        { sessionId: "s-review", title: "需求确认", done: true },
      ],
    })]);
    render(<ProjectTree />, { wrapper: fixture.Wrapper });
    expect(screen.getByRole("button", { name: "AAW dev · live，2 个会话" })).toHaveAttribute("aria-expanded", "false");
    act(() => {
      useSessionStore.setState({ activeSessionId: "s-review" });
      useWorkbenchUiStore.setState({ viewId: "session", contextPath: PATH });
    });
    expect(screen.getByRole("button", { name: "AAW dev · live，2 个会话" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "已完成的会话，1 个" })).toHaveAttribute("aria-expanded", "true");
    // 展开之后用户仍可以收起。
    fireEvent.click(screen.getByRole("button", { name: "已完成的会话，1 个" }));
    expect(screen.getByRole("button", { name: "已完成的会话，1 个" })).toHaveAttribute("aria-expanded", "false");
  });

  it("expands a collapsed project when one of its sessions is opened", () => {
    render(<ProjectTree />, { wrapper: fixture.Wrapper });
    const project = screen.getByRole("button", { name: /pager/, expanded: true });
    fireEvent.click(project);
    expect(project).toHaveAttribute("aria-expanded", "false");
    act(() => {
      useSessionStore.setState({ activeSessionId: "mine" });
      useWorkbenchUiStore.setState({ viewId: "session", contextPath: PATH });
    });
    expect(screen.getByRole("button", { name: /pager/, expanded: true })).toBeInTheDocument();
    expect(screen.getByText("我自己的会话")).toBeInTheDocument();
  });

  it("archives a whole run from its group row after confirming", () => {
    const archive = vi.fn();
    const publisher = indexes.registerSessionGroups();
    publisher.publish(PATH, [group("old", ["s-design", "s-review"], { title: "AAW dev · old", archive, archiveLabel: "归档这次运行" })]);
    render(<ProjectTree />, { wrapper: fixture.Wrapper });
    fireEvent.click(screen.getByRole("button", { name: "归档这次运行" }));
    expect(archive).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认归档这次运行" }));
    expect(archive).toHaveBeenCalledTimes(1);
  });

  it("starts a finished run collapsed with its session count", () => {
    const publisher = indexes.registerSessionGroups();
    publisher.publish(PATH, [group("old", ["s-design", "s-review"], { title: "AAW dev · old" })]);
    render(<ProjectTree />, { wrapper: fixture.Wrapper });
    const row = screen.getByRole("button", { name: "AAW dev · old，2 个会话" });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(within(row).getByText("2 个会话")).toBeInTheDocument();
  });
});
