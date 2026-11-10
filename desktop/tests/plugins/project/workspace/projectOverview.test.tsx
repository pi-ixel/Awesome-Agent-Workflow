import { mutableWorkspace } from "../../../helpers/workspace.ts";
import { bindTestLayout, useWorkbenchUiStore } from "../../../helpers/layout.ts";
import { startDesktopRuntime } from "../../../../src/bootstrap/mainRuntime.ts";
import { installDesktopWorkbench } from "../../../../src/bootstrap/installDesktopWorkbench.ts";
import type { WorkbenchService } from "../../../../src/plugins/workbench/service.ts";
import { WorkbenchContext } from "../../../../src/plugins/workbench/ui/bindings/react.ts";
/**
 * 项目总览界面测试（内容区的项目视图）：
 * - 空态引导与「添加项目」主行动入口；
 * - 状态行：健康摘要 chip（✓ / ⚠ / ✕）+ 连接态与「新建会话」主行动按钮
 *   （按钮不点名具体 agent：用户的心智是「开始一条会话」，不是「建立
 *   ACP 长连接」）；
 * - 明细默认收起、检查有问题或检查中自动展开、点 chip 可手动开合；
 * - 进总览不自动重查（首次检查只发生在添加项目那一刻，之后靠手动）；
 * - 健康报告渲染为 通过/失败/警告 与修复指引；
 * - AAW 工作流状态由 AawStatusPanel 单点渲染；项目没有 .sdd/（体检结论为
 *   警告）时收成一行，不占正文；
 * - 会话入口不在总览（会话挂在树上，总览只管管理 + 发起）：
 *   唯一主动作是「新建会话」，已连接也一样。
 *
 * 项目名 / 路径 / 「关闭项目」按钮已收编至内容区上下文条（ContextBar），
 * 其行为在 workbench/ContextBar.test.tsx 覆盖。树侧的选中交互见
 * workbench.test.tsx。
 *
 * 异步探测以「永不完成」的 runner 替身注入
 * （vi.mock tauriProcessRunner 模块），保证 store 回填的数据不被真实检查
 * 结果覆盖——真实通路已由 store 测试覆盖。
 */
import { render as renderReact, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkbenchContributions } from "../../../../src/plugins/workbench/types.ts";
let OverviewPage: WorkbenchContributions["pages"]["View"];
let useWorkspaceStore: ReturnType<typeof mutableWorkspace>;
import type { CliRunResult, ProcessRunner } from "../../../../src/plugins/host/types.ts";
import type { HealthCheckItem } from "../../../../src/plugins/project/types.ts";

let workbench: WorkbenchService;
function render(ui: ReactElement) {
  return renderReact(ui, {
    wrapper: ({ children }) => (
      <WorkbenchContext.Provider value={workbench}>
        {children}
      </WorkbenchContext.Provider>
    ),
  });
}

/** 永不完成的 runner：让手动检查挂起，保持注入的现场稳定。
 * （定义在工厂内部：vi.mock 工厂被提升，不能引用外部顶层变量；
 * 替换 runner 工厂即可控制工作区检查，
 * 直接整体替换，不需要 importOriginal 保留原实现。） */
vi.mock("../../../../src/plugins/host/process/processRunner.ts", () => {
  const neverResolvingRunner: ProcessRunner = {
    run: () => new Promise<CliRunResult>(() => {}),
    exists: () => new Promise<boolean>(() => {}),
  };
  return {
    createTauriProcessRunner: () => neverResolvingRunner,
    createHostProcessRunner: () => neverResolvingRunner,
  };
});

const DEMO_PATH = "D:/dev/demo-project";

const DEMO_HEALTH_ITEMS: readonly HealthCheckItem[] = [
  {
    id: "chrys",
    label: "chrys 可执行",
    status: "pass",
    summary: "chrys 1.2.3（耗时 12ms）",
    fixHint: "",
    durationMs: 12,
  },
  {
    id: "uv",
    label: "uv 可执行",
    status: "fail",
    summary: "命令启动失败（不存在或不可执行）",
    fixHint: "无法执行 uv（uv）。请到「设置」页核对 uv 工具路径。",
    durationMs: 5,
  },
  {
    id: "aaw-cli",
    label: "aaw CLI（uv run）",
    status: "fail",
    summary: "已跳过：uv 不可用",
    fixHint: "先修复上方的 uv 检查项。",
    durationMs: 0,
  },
  {
    id: "sdd-dir",
    label: ".sdd/ 流程目录",
    status: "warn",
    summary: "所选目录下没有 .sdd/",
    fixHint: "该目录尚未初始化 AAW 工作流。",
    durationMs: 1,
  },
];

function resetWorkspaceState(): void {
  window.localStorage.clear();
  useWorkbenchUiStore.setState({
    viewId: "project-overview",
    contextPath: null,

  });
  useWorkspaceStore.setState({
    recentWorkspaces: [],
    pinnedPaths: [],
    pinnedSessions: [],
    selectedPath: null,
    activePath: null,
    health: null,
    isCheckingHealth: false,
    toolPaths: {
      chrysCommand: "chrys",
      uvCommand: "uv",
      aawScriptPath: "D:/repo/skills/aaw-workflow/scripts/aaw.py",
    },
  });
}

describe("ProjectOverview", () => {
  beforeEach(() => {
    resetWorkspaceState();
  });

  it("未选择项目（path=null）：显示引导空态", () => {
    render(<OverviewPage project={null} />);
    expect(
      screen.getByText(/从左侧选择或新建一个项目目录/),
    ).toBeInTheDocument();
  });

  it("空态带「添加项目」主行动入口与一行价值说明（冷启动可行动）", async () => {
    render(<OverviewPage project={null} />);
    const addButton = screen.getByRole("button", { name: "添加项目" });
    expect(addButton).toBeEnabled();
    expect(screen.getByText(/添加后自动健康检查/)).toBeInTheDocument();

    // jsdom 下目录对话框不可用（pickDirectory 捕获后按取消处理）：
    // 点击给出重试提示而非无响应
    await userEvent.click(addButton);
    expect(
      await screen.findByText(/目录选择不可用或已取消/),
    ).toBeInTheDocument();
  });

  it("连接前后唯一主动作都是「新建会话」；总览不放「进入会话」（会话入口在树上）", () => {
    useWorkspaceStore.getState().selectWorkspace(DEMO_PATH);
    const { rerender } = render(<OverviewPage project={DEMO_PATH} />);
    // 未连接：唯一主动作就是新建会话（连接是它的内部步骤，不单独成按钮）
    expect(
      screen.getByRole("button", { name: "新建会话" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "进入会话" }),
    ).not.toBeInTheDocument();

    // 已连接：同样只有新建会话——会话是工作流那一层的概念，项目级的
    // 「进入会话」说不清要进哪条，进哪条对话由树上的会话行承担
    useWorkspaceStore.getState().openWorkspace(DEMO_PATH);
    rerender(<OverviewPage project={DEMO_PATH} />);
    expect(
      screen.getByRole("button", { name: "新建会话" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "进入会话" }),
    ).not.toBeInTheDocument();
  });

  it("界面文案不点名具体 agent（后续要接更多 agent）", () => {
    useWorkspaceStore.getState().selectWorkspace(DEMO_PATH);
    render(<OverviewPage project={DEMO_PATH} />);
    expect(screen.queryByText(/连接 chrys/)).not.toBeInTheDocument();
  });

  it("未检查态安静：无 chip、无解释文案，检查由手动「重新检查」发起", async () => {
    useWorkspaceStore.getState().selectWorkspace(DEMO_PATH);
    render(<OverviewPage project={DEMO_PATH} />);
    // 未检查不是需要陈述的结论：不占 chip、不自动展开、不自我解释，
    // 行上只有「重新检查」这一颗入口
    expect(screen.queryByText("未检查")).not.toBeInTheDocument();
    expect(screen.queryByText("检查中…")).not.toBeInTheDocument();
    expect(screen.queryByText(/尚未执行检查/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "新建会话" }),
    ).toBeInTheDocument();

    // 手动「重新检查」发起：检查中 chip 出现，进度明细展开
    await userEvent.click(screen.getByRole("button", { name: "重新检查" }));
    expect(screen.getByText("检查中…")).toBeInTheDocument();
    expect(
      screen.getByText(/正在逐项探测 iCode \/ uv \/ aaw CLI/),
    ).toBeInTheDocument();
  });

  it("回填的健康报告渲染为 通过/失败/警告 与修复指引，且明细自动展开", () => {
    useWorkspaceStore.getState().selectWorkspace(DEMO_PATH);
    useWorkspaceStore
      .getState()
      .applyHealthReport(DEMO_PATH, DEMO_HEALTH_ITEMS);
    render(<OverviewPage project={DEMO_PATH} />);
    // 摘要 chip 点名未通过的项（不通过时自动展开明细）
    expect(
      screen.getByText(/uv 可执行、aaw CLI（uv run） 未通过/),
    ).toBeInTheDocument();
    expect(screen.getByText("chrys 1.2.3（耗时 12ms）")).toBeInTheDocument();
    expect(screen.getByText("通过")).toBeInTheDocument();
    expect(screen.getByText("警告")).toBeInTheDocument();
    expect(screen.getAllByText("失败").length).toBeGreaterThanOrEqual(2);
    expect(
      screen.getByText(/请到「设置」页核对 uv 工具路径/),
    ).toBeInTheDocument();
    expect(screen.getByText(/该目录尚未初始化 AAW 工作流/)).toBeInTheDocument();
  });

  it("全部通过时明细默认收起，点摘要 chip 展开 / 收起", async () => {
    useWorkspaceStore.getState().selectWorkspace(DEMO_PATH);
    const allPass = DEMO_HEALTH_ITEMS.map((item) => ({
      ...item,
      status: "pass" as const,
      fixHint: "",
    }));
    useWorkspaceStore.getState().applyHealthReport(DEMO_PATH, allPass);
    render(<OverviewPage project={DEMO_PATH} />);

    // 全通过：摘要为 ✓n/n，明细收起（检查项行不在）
    const chip = screen.getByRole("button", { name: /全部检查通过|✓/ });
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByText("chrys 1.2.3（耗时 12ms）"),
    ).not.toBeInTheDocument();

    await userEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("chrys 1.2.3（耗时 12ms）")).toBeInTheDocument();

    await userEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "false");
  });

  it("AAW 工作流状态只有一处渲染（旧的「工作流状态（aaw status）」卡已合并）", () => {
    useWorkspaceStore.getState().selectWorkspace(DEMO_PATH);
    render(<OverviewPage project={DEMO_PATH} />);
    // 唯一状态面板 + 其空态引导（未绑定 loader 时）
    expect(screen.getAllByRole("region", { name: "工作流状态" })).toHaveLength(
      1,
    );
    expect(
      screen.queryByRole("heading", { name: "工作流状态（aaw status）" }),
    ).not.toBeInTheDocument();
  });

  it("已连接：唯一动作「新建会话」；关闭入口仍在上下文条（总览体内无关闭）", () => {
    useWorkspaceStore.getState().selectWorkspace(DEMO_PATH);
    useWorkspaceStore.getState().openWorkspace(DEMO_PATH);
    render(<OverviewPage project={DEMO_PATH} />);
    expect(
      screen.getByRole("button", { name: "新建会话" }),
    ).toBeInTheDocument();
    // 关闭动作在 ContextBar（见 ContextBar.test），总览体内不放
    expect(
      screen.queryByRole("button", { name: "关闭项目" }),
    ).not.toBeInTheDocument();
  });

  it("总览体不再有任何「进入会话」按钮（进哪条对话由树上的会话行承担）", () => {
    useWorkspaceStore.getState().selectWorkspace(DEMO_PATH);
    useWorkspaceStore.getState().openWorkspace(DEMO_PATH);
    render(<OverviewPage project={DEMO_PATH} />);
    expect(
      screen.queryByRole("button", { name: "进入会话" }),
    ).not.toBeInTheDocument();
  });

  it("没有 .sdd/（体检为警告）：工作流面板收成一行，可「仍然查看」手动展开", async () => {
    useWorkspaceStore.getState().selectWorkspace(DEMO_PATH);
    useWorkspaceStore
      .getState()
      .applyHealthReport(DEMO_PATH, DEMO_HEALTH_ITEMS);
    render(<OverviewPage project={DEMO_PATH} />);

    // 无工作流可看：面板本体退场，只留一行说明 + 手动展开入口
    expect(
      screen.queryByRole("region", { name: "工作流状态" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/还没有 AAW 工作流/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "仍然查看" }));
    expect(
      screen.getByRole("region", { name: "工作流状态" }),
    ).toBeInTheDocument();
  });

  it("有 .sdd/：工作流面板正常在位（不被折叠规则收走）", () => {
    useWorkspaceStore.getState().selectWorkspace(DEMO_PATH);
    useWorkspaceStore.getState().applyHealthReport(
      DEMO_PATH,
      DEMO_HEALTH_ITEMS.map((item) =>
        item.id === "sdd-dir"
          ? {
              ...item,
              status: "pass" as const,
              summary: ".sdd/ 已存在",
              fixHint: "",
            }
          : item,
      ),
    );
    render(<OverviewPage project={DEMO_PATH} />);
    expect(
      screen.getByRole("region", { name: "工作流状态" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/还没有 AAW 工作流/)).not.toBeInTheDocument();
  });

  it("「新建会话」走真新建通路（forceNew，不落进上一次的对话）", async () => {
    useWorkspaceStore.getState().selectWorkspace(DEMO_PATH);
    render(<OverviewPage project={DEMO_PATH} />);
    await userEvent.click(screen.getByRole("button", { name: "新建会话" }));
    expect(useWorkspaceStore.getState().activePath).toBe(DEMO_PATH);
  });

  it("检查未通过时状态行给出「去设置工具路径」出口（点开设置覆盖层）", async () => {
    const { useWorkbenchUiStore } =
      await import("../../../helpers/layout.ts");
    useWorkbenchUiStore.setState({ overlay: null });
    useWorkspaceStore.getState().selectWorkspace(DEMO_PATH);
    useWorkspaceStore
      .getState()
      .applyHealthReport(DEMO_PATH, DEMO_HEALTH_ITEMS);
    render(<OverviewPage project={DEMO_PATH} />);

    await userEvent.click(
      screen.getByRole("button", { name: "去设置工具路径" }),
    );
    expect(useWorkbenchUiStore.getState().overlay).toBe("settings");
  });
});

beforeAll(async () => {
  const ready = await startDesktopRuntime(undefined, installDesktopWorkbench)
    .ready;
  workbench = ready.workbench;
  bindTestLayout(workbench);
  const overview = workbench.getSnapshot().pages.find(({ id }) => id === "project-overview");
  if (!overview) throw new Error("Project did not register its overview page");
  OverviewPage = overview.View;
  useWorkspaceStore = mutableWorkspace(ready.project);
});
