import { StrictMode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StartupGate, STARTUP_MAX_WAIT_MS } from "../../src/ui/StartupGate.tsx";
import {
  useSessionCatalogStore,
  type SessionListStatus,
} from "../../src/stores/sessionCatalogStore.ts";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import { useWorkspaceStore } from "../../src/stores/workspaceStore.ts";
import { knownWorkspacePaths } from "../../src/ui/workspaces/knownWorkspacePaths.ts";
import { pathKey } from "../../src/core/panelPaths.ts";

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
    useSessionCatalogStore.setState({
      agentKey: "test-agent",
      statusByPath: { [pathKey(PROJECT)]: first, [pathKey(SECOND)]: second },
    }),
  );
}
function mount() {
  return render(
    <StrictMode>
      <StartupGate>
        <button>工作区操作</button>
      </StartupGate>
    </StrictMode>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  useWorkspaceStore.setState({
    selectedPath: null,
    activePath: null,
    recentWorkspaces: [],
    pinnedPaths: [],
  });
  useSessionCatalogStore.setState({
    agentKey: null,
    sessionsByPath: {},
    statusByPath: {},
  });
});
afterEach(() => {
  cleanup();
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
      useSessionCatalogStore.getState().statusByPath[pathKey(PROJECT)],
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
      useSessionCatalogStore.getState().statusByPath[pathKey(PROJECT)]?.state,
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
    act(() => useSettingsStore.setState({ activeAgentId: "another" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
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
