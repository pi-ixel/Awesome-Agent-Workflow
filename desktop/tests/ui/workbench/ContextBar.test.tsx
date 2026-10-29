/**
 * 上下文条（ContextBar）测试（经 ContentArea 集成渲染，覆盖条与视图
 * 主体的组合）。上下文条是全应用唯一顶栏（无全局挂件区——agent 标识
 * 与待办下拉已退役）：
 * - 会话态：会话标题 + 所属项目名 + 连接徽标（badge 形态，点 + 文字）+
 *   关闭会话图标按钮（真实调 closeWorkspace）；无 AAW 数据时无 SR 快捷；
 * - AAW 开关：会话态常驻，有 AAW 状态数据时标签变成「SR-xxx · 步骤 n」；
 *   点开只开合会话内 AAW 面板，不离开对话；
 * - 总览态：返回按钮（有活跃会话回会话视图；无会话回落空态）+ 项目名 +
 *   路径 + 关闭项目（连接中禁闭，未连接不出现）；
 * - 设置 / 诊断全屏页：返回按钮 + 页名；
 * - 空态（未选中项目的总览）上下文部分留空，空态引导占满下方内容区。
 *
 * 异步探测的 defaultProcessRunner 以「永不完成」的 fake 替身注入
 * （点击 SR 快捷会切到总览），保持现场稳定。
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useRightPanelStore } from "../../../src/stores/rightPanelStore.ts";
import ContentArea from "../../../src/ui/workbench/ContentArea.tsx";
import { useAawStatusStore } from "../../../src/stores/aawStatusStore.ts";
import { useSessionStore } from "../../../src/stores/sessionStore.ts";
import { useWorkspaceStore } from "../../../src/stores/workspaceStore.ts";
import { useWorkbenchUiStore } from "../../../src/stores/workbenchUiStore.ts";
import type {
  CliRunResult,
  ProcessRunner,
} from "../../../src/aaw/processRunner.ts";

vi.mock("../../../src/aaw/tauriProcessRunner.ts", () => {
  const neverResolvingRunner: ProcessRunner = {
    run: () => new Promise<CliRunResult>(() => {}),
    exists: () => new Promise<boolean>(() => {}),
  };
  return {
    createTauriProcessRunner: () => neverResolvingRunner,
    defaultProcessRunner: neverResolvingRunner,
  };
});

const PATH = "D:/dev/demo-project";
const NAME = "demo-project";

function resetAll(): void {
  window.localStorage.clear();
  useRightPanelStore.setState({ projects: {} });
  useWorkbenchUiStore.setState({
    treeView: "project-overview",
    contextPath: null,
    overlay: null,
    expandedOverrides: {},
    sidebarCollapsed: false,
    treeViewMode: "projects",
    isAddPanelOpen: false,
  });
  useSessionStore.getState().clear();
  useSessionStore.getState().bindSession(null);
  useSessionStore.setState({
    activeSessionId: null,
    modelLabel: null,
    approvalMode: null,
    sessionsByPath: {},
    isConnecting: false,
    isBound: false,
  });
  useWorkspaceStore.getState().closeWorkspace();
  useWorkspaceStore.getState().clearSelection();
  useWorkspaceStore.setState({
    recentWorkspaces: [],
    favoritePaths: [],
    lastConnectError: null,
  });
  useAawStatusStore.getState().reset();
  useAawStatusStore.setState({ loader: null });
  useWorkbenchUiStore.setState({ isAawOpen: false });
}

/** 预置会话态：树选中该项目 + 活跃会话 + 已连接。 */
function seedSessionView(): void {
  useSessionStore.setState({
    activeSessionId: "sess-1",
    sessionsByPath: {
      [PATH]: [
        {
          id: "sess-1",
          title: "总结 SR-001 的进度",
          nativeTitle: "总结 SR-001 的进度",
          updatedAt: null,
        },
      ],
    },
  });
  useWorkbenchUiStore.setState({ treeView: "session", contextPath: PATH });
  useWorkspaceStore.setState({ activePath: PATH });
  useSessionStore.setState({ isBound: true });
}

beforeEach(() => {
  resetAll();
});

describe("ContextBar 会话态", () => {
  it("显示会话标题 + 所属项目名 + 连接徽标；无 AAW 数据时无 SR 快捷按钮", () => {
    seedSessionView();
    render(<ContentArea />);

    expect(screen.getByText("总结 SR-001 的进度")).toBeInTheDocument();
    expect(screen.getByText(NAME)).toBeInTheDocument();
    expect(screen.getByText("已连接")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /SR-001/ }),
    ).not.toBeInTheDocument();
  });

  it("连接中徽标为蓝点「连接中」", () => {
    seedSessionView();
    useSessionStore.setState({ isConnecting: true, isBound: false });
    render(<ContentArea />);
    expect(screen.getByText("连接中")).toBeInTheDocument();
    expect(screen.queryByText("已连接")).not.toBeInTheDocument();
  });

  it("会话态不设返回按钮：进总览走项目树（顶栏不重复树导航）", () => {
    seedSessionView();
    render(<ContentArea />);
    expect(
      screen.queryByRole("button", { name: "返回总览" }),
    ).not.toBeInTheDocument();
  });
});

describe("ContextBar 总览态", () => {
  it("返回按钮 + 项目名 + 路径（mono 小字）；已连接时显示「关闭项目」次级按钮", () => {
    useWorkbenchUiStore.setState({
      treeView: "project-overview",
      contextPath: PATH,
    });
    useWorkspaceStore.setState({ activePath: PATH });
    useSessionStore.setState({ isBound: true });
    render(<ContentArea />);

    expect(screen.getByRole("heading", { name: NAME })).toBeInTheDocument();
    expect(screen.getByTitle(PATH)).toHaveTextContent(PATH);
    expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "关闭项目" }),
    ).toBeInTheDocument();
  });

  it("关闭项目按钮在连接中禁闭；项目未打开时不出现", () => {
    useWorkbenchUiStore.setState({
      treeView: "project-overview",
      contextPath: PATH,
    });
    const { rerender } = render(<ContentArea />);
    // 未打开：无关闭入口
    expect(
      screen.queryByRole("button", { name: "关闭项目" }),
    ).not.toBeInTheDocument();

    // 连接中：按钮出现但禁闭
    useWorkspaceStore.setState({ activePath: PATH });
    useSessionStore.setState({ isConnecting: true });
    rerender(<ContentArea />);
    expect(screen.getByRole("button", { name: "关闭项目" })).toBeDisabled();
  });

  it("返回：该项目有活跃会话时回会话视图", async () => {
    seedSessionView();
    useWorkbenchUiStore.setState({
      treeView: "project-overview",
      contextPath: PATH,
    });
    render(<ContentArea />);

    await userEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(useWorkbenchUiStore.getState().treeView).toBe("session");
    expect(useWorkbenchUiStore.getState().contextPath).toBe(PATH);
  });

  it("返回：无活跃会话时清空上下文回落空态（空态只有全局区，无返回按钮）", async () => {
    useWorkbenchUiStore.setState({
      treeView: "project-overview",
      contextPath: PATH,
    });
    render(<ContentArea />);

    await userEvent.click(screen.getByRole("button", { name: "返回" }));
    const ui = useWorkbenchUiStore.getState();
    expect(ui.contextPath).toBeNull();
    expect(ui.treeView).toBe("project-overview");
    // 空态：无上下文部分（无标题、无返回按钮），顶栏也不再有全局挂件
    // （agent 标识 / 待办已退役），空态引导占满下方内容区
    expect(
      screen.queryByRole("button", { name: "返回" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("上下文条")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "待办" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/从左侧选择或新建一个项目目录/),
    ).toBeInTheDocument();
  });
});

describe("ContextBar 连接失败横幅与徽标（P0-1）", () => {
  const FAILURE_MESSAGE =
    "连接 agent 失败：chrys.exe 不存在，请在设置中检查 agent 可执行路径";

  it("会话态：失败态展示错误横幅 + 红色「失败」徽标；「打开设置」切设置页", async () => {
    seedSessionView();
    useWorkspaceStore.getState().reportConnectFailure(PATH, FAILURE_MESSAGE);
    render(<ContentArea />);

    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent(/连接失败：连接 agent 失败/);
    expect(banner).toHaveTextContent(/请在设置中检查 agent 可执行路径/);
    // 连接徽标进入失败态（badge 文字）
    expect(screen.getByText("失败")).toBeInTheDocument();
    expect(screen.queryByText("已连接")).not.toBeInTheDocument();

    await userEvent.click(
      within(banner).getByRole("button", { name: "打开设置" }),
    );
    expect(useWorkbenchUiStore.getState().overlay).toBe("settings");
  });

  it("项目总览态同样展示错误横幅；切换目标后不再显示旧项目失败", () => {
    useWorkbenchUiStore.setState({
      treeView: "project-overview",
      contextPath: PATH,
    });
    useWorkspaceStore.getState().reportConnectFailure(PATH, FAILURE_MESSAGE);
    const { rerender } = render(<ContentArea />);
    expect(screen.getByRole("alert")).toHaveTextContent(/连接失败/);

    // 切到另一个项目上下文：旧项目的失败横幅不跟随
    useWorkbenchUiStore.setState({ contextPath: "D:/dev/other-project" });
    rerender(<ContentArea />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("横幅可关闭：关闭后横幅退场且失败态清除", async () => {
    seedSessionView();
    useWorkspaceStore.getState().reportConnectFailure(PATH, FAILURE_MESSAGE);
    render(<ContentArea />);

    await userEvent.click(screen.getByRole("button", { name: "关闭错误提示" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(useWorkspaceStore.getState().lastConnectError).toBeNull();
  });
});

describe("ContextBar 全屏页", () => {
  it("设置全屏页：页名 + 返回按钮，返回关闭覆盖层", async () => {
    useWorkbenchUiStore.setState({ overlay: "settings" });
    render(<ContentArea />);

    // 页名在上下文条内（设置页自身的 section 标题也含「设置」二字，
    // 用上下文条 landmark 收窄查询）
    const bar = screen.getByLabelText("上下文条");
    expect(
      within(bar).getByRole("heading", { name: "设置" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(useWorkbenchUiStore.getState().overlay).toBeNull();
  });

  it("诊断全屏页：页名 + 返回按钮，返回关闭覆盖层", async () => {
    useWorkbenchUiStore.setState({ overlay: "diagnostics" });
    render(<ContentArea />);

    const bar = screen.getByLabelText("上下文条");
    expect(
      within(bar).getByRole("heading", { name: "诊断" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(useWorkbenchUiStore.getState().overlay).toBeNull();
  });
});

describe("ContextBar 会话改名（双击行内编辑）", () => {
  it("双击进入编辑，回车提交：顶栏与树缓存即时更新", async () => {
    seedSessionView();
    render(<ContentArea />);

    await userEvent.dblClick(screen.getByText("总结 SR-001 的进度"));
    const input = screen.getByRole("textbox", { name: "会话名称" });
    await userEvent.clear(input);
    await userEvent.type(input, "我的会话名{Enter}");

    // 展示立即更新（顶栏 + 树缓存同源）
    expect(screen.getByText("我的会话名")).toBeInTheDocument();
    const entry = useSessionStore
      .getState()
      .sessionsByPath[PATH]?.find((session) => session.id === "sess-1");
    expect(entry?.title).toBe("我的会话名");
  });

  it("Esc 取消不提交；清空提交恢复原生名，悬停可见原生名", async () => {
    seedSessionView();
    render(<ContentArea />);

    // Esc 取消
    await userEvent.dblClick(screen.getByText("总结 SR-001 的进度"));
    const input = screen.getByRole("textbox", { name: "会话名称" });
    await userEvent.clear(input);
    await userEvent.type(input, "半截输入{Escape}");
    expect(screen.getByText("总结 SR-001 的进度")).toBeInTheDocument();

    // 手动改名后悬停提示原生名；清空提交恢复
    await userEvent.dblClick(screen.getByText("总结 SR-001 的进度"));
    await userEvent.clear(screen.getByRole("textbox", { name: "会话名称" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "会话名称" }),
      "手动名{Enter}",
    );
    expect(
      screen.getByTitle(/总结 SR-001 的进度（双击重命名/),
    ).toBeInTheDocument();

    await userEvent.dblClick(screen.getByText("手动名"));
    await userEvent.clear(screen.getByRole("textbox", { name: "会话名称" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "会话名称" }),
      "{Enter}",
    );
    expect(screen.getByText("总结 SR-001 的进度")).toBeInTheDocument();
  });
});
