import { getProjectGitQuery } from "../../src/core/projectGitQuery.ts";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionStatusOverlay } from "../../src/ui/session/SessionStatusOverlay.tsx";
import { GitPanel } from "../../src/ui/right-panel/GitPanel.tsx";
import { panelService, type GitSnapshot } from "../../src/core/panelService.ts";
import {
  useSessionStore,
  type PlanItem,
} from "../../src/stores/sessionStore.ts";
import { useAawStatusStore } from "../../src/stores/aawStatusStore.ts";
import { useRightPanelStore } from "../../src/stores/rightPanelStore.ts";
import { useSessionStatusUiStore } from "../../src/stores/sessionStatusUiStore.ts";
import { useWorkspaceStore } from "../../src/stores/workspaceStore.ts";

const snapshot: GitSnapshot = {
  repoRoot: "D:/floating",
  branch: "feature/review",
  watchPaths: [],
  changes: [
    {
      path: "a.ts",
      oldPath: null,
      source: "staged",
      status: "修改",
      added: 4,
      removed: 2,
    },
    {
      path: "b.ts",
      oldPath: null,
      source: "untracked",
      status: "未跟踪",
      added: 3,
      removed: 0,
    },
  ],
};
const plan: PlanItem = {
  kind: "plan",
  id: "p1",
  sourceSessionId: "s1",
  entries: Array.from({ length: 9 }, (_, i) => ({
    content: `步骤 ${i + 1}`,
    priority: "medium",
    status: i < 5 ? "completed" : i === 5 ? "in_progress" : "pending",
  })),
};
const view = (project = "D:/floating") => (
  <SessionStatusOverlay project={project} enabled>
    <textarea aria-label="消息草稿" defaultValue="保持草稿" />
  </SessionStatusOverlay>
);

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(panelService, "gitStatus").mockResolvedValue(snapshot);
  vi.spyOn(panelService, "watch").mockResolvedValue(() => {});
  useSessionStatusUiStore.setState({ mode: "panel" });
  useRightPanelStore.setState({ projects: {} });
  useWorkspaceStore.setState({ activePath: "D:/floating" });
  useSessionStore.setState({
    activeSessionId: "s1",
    items: [plan],
    isConnecting: false,
    openingSessionId: null,
  });
  useAawStatusStore.getState().reset();
});

describe("会话状态悬浮卡", () => {
  it("Git 只读汇总点击定位来源，和右栏共用快照；开关不重挂草稿", async () => {
    render(
      <>
        {view()}
        <GitPanel project="D:/floating" />
      </>,
    );
    const draft = screen.getByLabelText("消息草稿");
    expect(
      await screen.findByRole("button", { name: "查看 Git 更改" }),
    ).toHaveTextContent("+4−2");
    expect(panelService.gitStatus).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("提交或推送")).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "查看 Git 更改" }),
    );
    expect(useRightPanelStore.getState().projects["d:/floating"]).toMatchObject(
      { active: "git", open: true, gitSource: "changes" },
    );
    const untracked = screen.getByRole("button", {
      name: "查看 Unversioned Files",
    });
    expect(untracked).toHaveTextContent("Unversioned Files (1)+3");
    await userEvent.click(untracked);
    expect(
      useRightPanelStore.getState().projects["d:/floating"]?.gitSource,
    ).toBe("untracked");
    await userEvent.click(screen.getByRole("button", { name: "收起会话状态" }));
    expect(
      screen.getByRole("button", { name: /展开会话状态：步骤 6/ }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("消息草稿")).toBe(draft);
    expect(draft).toHaveValue("保持草稿");
    await userEvent.click(screen.getByRole("button", { name: /展开会话状态/ }));
    await userEvent.click(
      screen.getByRole("button", { name: "状态卡显示选项" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "恢复自动展开" }));
    expect(useSessionStatusUiStore.getState().mode).toBe("auto");
  });
  it("Git 后台刷新保留摘要，不显示刷新按钮或重复加载提示", async () => {
    render(view());
    await screen.findByRole("button", { name: "查看 Git 更改" });
    let finish: ((value: GitSnapshot) => void) | undefined;
    vi.mocked(panelService.gitStatus).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    act(() => getProjectGitQuery("D:/floating").refresh());
    expect(
      screen.getByRole("button", { name: "查看 Git 更改" }),
    ).toHaveTextContent("+4−2");
    expect(screen.queryByText("正在读取 Git 状态…")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "刷新 Git 摘要" }),
    ).not.toBeInTheDocument();
    await act(async () => {
      finish?.({ ...snapshot });
      await Promise.resolve();
    });
  });
  it("长清单支持焦点预览、Esc关闭；计划更新撤销旧浮层，切会话不串计划", async () => {
    render(view());
    await screen.findByRole("button", { name: "查看 Git 更改" });
    expect(screen.getByText("5/9")).toBeInTheDocument();
    expect(screen.queryByText("步骤 1")).not.toBeInTheDocument();
    const group = screen.getByRole("button", { name: "已完成 5 项 ›" });
    act(() => group.focus());
    expect(
      await screen.findByRole("tooltip", { name: "隐藏任务步骤" }),
    ).toHaveTextContent("步骤 1");
    fireEvent.keyDown(group, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await userEvent.click(group);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    act(() =>
      useSessionStore.setState({
        items: [
          {
            ...plan,
            entries: plan.entries.map((item) => ({
              ...item,
              status: "completed",
            })),
          },
        ],
      }),
    );
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(screen.getByText("9/9")).toBeInTheDocument();
    act(() => useSessionStore.setState({ activeSessionId: "s2" }));
    expect(screen.queryByText("任务进度")).not.toBeInTheDocument();
    act(() =>
      useSessionStore.setState({
        activeSessionId: "s1",
        items: [{ ...plan, sourceSessionId: undefined }],
      }),
    );
    expect(screen.queryByText("任务进度")).not.toBeInTheDocument();
  });
  it("AAW 点击打开进度页，项目切换排除旧SR；失败保留旧摘要并标明", async () => {
    useAawStatusStore.setState({
      workspacePath: "D:/floating",
      currentSr: "SR-001",
      status: {
        sr: "SR-001",
        entry: "sr",
        status: "in_progress",
        pendingUserConfirm: null,
        definitionDrift: null,
        steps: [],
      },
      lastError: "CLI 暂时不可用",
    });
    useRightPanelStore.getState().aawSegment("D:/floating", "launch");
    const rendered = render(view());
    expect(screen.getByText("SR-001")).toBeInTheDocument();
    expect(screen.getByText(/刷新失败，显示上次读取结果/)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "查看 AAW 工作流进度" }),
    );
    expect(useRightPanelStore.getState().projects["d:/floating"]).toMatchObject(
      { active: "aaw", aawSegment: "progress", open: true },
    );
    rendered.rerender(view("D:/other"));
    expect(screen.queryByText("SR-001")).not.toBeInTheDocument();
    expect(screen.queryByText("任务进度")).not.toBeInTheDocument();
  });
  it("无增删/无计划/无工作流隐藏整卡；无会话草稿不发起Git查询", async () => {
    vi.spyOn(panelService, "gitStatus").mockResolvedValue({
      ...snapshot,
      changes: [],
    });
    useSessionStore.setState({ items: [] });
    const rendered = render(view());
    await waitFor(() =>
      expect(screen.queryByLabelText("会话状态悬浮卡")).not.toBeInTheDocument(),
    );
    rendered.unmount();
    vi.mocked(panelService.gitStatus).mockClear();
    render(
      <SessionStatusOverlay project="D:/fresh" enabled={false}>
        <span>草稿</span>
      </SessionStatusOverlay>,
    );
    expect(panelService.gitStatus).not.toHaveBeenCalled();
  });
});
