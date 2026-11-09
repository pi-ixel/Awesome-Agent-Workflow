import { StrictMode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StartupGate, STARTUP_MAX_WAIT_MS } from "../../src/plugins/workbench/ui/StartupGate.tsx";
import type { SessionListStatus } from "../../src/contracts/projectSessions.ts";
import { createTestProjectIndexes, mutableProjectCatalog } from "../helpers/projectIndexes.ts";
import { createTestProjectWorkbench } from "../helpers/projectWorkbench.tsx";
import { installDesktopWorkbench } from "../../src/bootstrap/installDesktopWorkbench.ts";
import { WorkbenchContext } from "../../src/plugins/workbench/react.ts";
import type { WorkbenchService } from "../../src/contracts/workbench.ts";
import { createTestDesktopRuntime } from "../helpers/desktopRuntime.ts";
import { mutableWorkspace, createTestWorkspace } from "../helpers/workspace.ts";
let useWorkspaceStore: ReturnType<typeof mutableWorkspace>;
import { knownWorkspacePaths } from "../../src/shared/knownWorkspacePaths.ts";
import { pathKey } from "../../src/shared/panelPaths.ts";

let indexes: ReturnType<typeof createTestProjectIndexes>;
let catalog: ReturnType<typeof mutableProjectCatalog>;
let fixture: ReturnType<typeof createTestProjectWorkbench>;

const PROJECT = "D:/project",
  SECOND = "D:/second";
function seedProjects() {
  useWorkspaceStore.setState({
    recentWorkspaces: [
      { path: PROJECT, lastOpenedAt: "now" },
      { path: SECOND, lastOpenedAt: "now" },
    ],
  });
}
function status(first: SessionListStatus, second: SessionListStatus) {
  act(() =>
    catalog.setState({
      agentKey: "test-agent",
      statusByPath: { [pathKey(PROJECT)]: first, [pathKey(SECOND)]: second },
    }),
  );
}
function mount(workbench: WorkbenchService = fixture.workbench) {
  return render(
    <StrictMode>
      <WorkbenchContext.Provider value={workbench}>
        <StartupGate>
          <button>工作区操作</button>
        </StartupGate>
      </WorkbenchContext.Provider>
    </StrictMode>,
  );
}

beforeEach(() => {
  useWorkspaceStore = createTestWorkspace();
  indexes = createTestProjectIndexes();
  catalog = indexes.catalog;
  fixture = createTestProjectWorkbench({ ...indexes, workspace: useWorkspaceStore });
  vi.useFakeTimers();
  useWorkspaceStore.setState({
    selectedPath: null,
    activePath: null,
    recentWorkspaces: [],
    pinnedPaths: [],
  });
  catalog.setState({
    agentKey: null,
    sessionsByPath: {},
    statusByPath: {},
  });
});
afterEach(() => {
  cleanup();
  fixture.dispose();
  indexes.dispose();
  vi.useRealTimers();
});

describe("启动欢迎页", () => {
  it("没有项目时直接呈现工作区，之后添加项目不补放启动动画", () => {
    mount();
    expect(
      screen.getByRole("button", { name: "工作区操作" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(seedProjects);
    status({ state: "loading" }, { state: "loading" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("首帧遮住工作区，等待所有初始项目结束，无最短播放时长", () => {
    seedProjects();
    mount();
    expect(
      screen.getByRole("heading", { name: "Awesome Agent Workspace" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "工作区操作" }),
    ).not.toBeInTheDocument();
    status({ state: "ready" }, { state: "loading" });
    expect(screen.getByRole("status")).toBeInTheDocument();
    status({ state: "ready" }, { state: "ready" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "工作区操作" }),
    ).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("查询失败和不支持查询也算结束，不让动效一直挂住", () => {
    seedProjects();
    mount();
    status({ state: "error", message: "离线" }, { state: "unsupported" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(
      catalog.getState().statusByPath[pathKey(PROJECT)],
    ).toEqual({ state: "error", message: "离线" });
  });

  it("最多 8 秒放行，保留后台查询状态且后续不重新遮挡", () => {
    seedProjects();
    mount();
    status({ state: "loading" }, { state: "loading" });
    act(() => {
      vi.advanceTimersByTime(STARTUP_MAX_WAIT_MS - 1);
    });
    expect(screen.getByRole("status")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(
      catalog.getState().statusByPath[pathKey(PROJECT)]?.state,
    ).toBe("loading");
    status({ state: "ready" }, { state: "loading" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("只等待启动批次，后来添加的项目不会延长等待", () => {
    seedProjects();
    mount();
    act(() => useWorkspaceStore.setState({ pinnedPaths: ["D:/later"] }));
    status({ state: "ready" }, { state: "ready" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    status({ state: "loading" }, { state: "loading" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("启动期间切换已注册的 Agent 后结束原来的等待批次", async () => {
    const runtime = createTestDesktopRuntime(
      { attachPreloading: () => () => {}, close: () => Promise.resolve() },
      undefined,
      installDesktopWorkbench,
    );
    try {
      const { workbench, agents, project } = await runtime.ready;
      catalog = mutableProjectCatalog(project);
      useWorkspaceStore = mutableWorkspace(project);
      agents.select("native-opencode");
      seedProjects();
      mount(workbench);
      status({ state: "loading" }, { state: "loading" });
      expect(screen.getByRole("status")).toBeInTheDocument();
      act(() => agents.select("codeagent"));
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "工作区操作" })).toBeInTheDocument();
    } finally {
      cleanup();
      await runtime.shutdown();
    }
  });

  it("卸载时清理超时定时器", () => {
    seedProjects();
    const view = mount();
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("置顶、最近、选中和当前项目采用相同的归一化去重规则", () => {
    expect(
      knownWorkspacePaths({
        selectedPath: "D:\\project",
        activePath: PROJECT,
        pinnedPaths: [SECOND],
        recentWorkspaces: [{ path: "d:/PROJECT" }],
      }),
    ).toEqual(["D:\\project", SECOND]);
  });
});
