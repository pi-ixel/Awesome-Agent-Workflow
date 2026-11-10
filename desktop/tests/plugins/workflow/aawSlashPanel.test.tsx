import { mutableProjectForeground } from "../../helpers/foreground.ts";
import type { PropsWithChildren } from "react";
import type { Context } from "cordis";
import { createTestDesktopRuntime } from "../../helpers/desktopRuntime.ts";
import { installDesktopWorkbench } from "../../../src/bootstrap/installDesktopWorkbench.ts";
import { WorkbenchContext } from "../../../src/plugins/workbench/ui/bindings/react.ts";
import * as workflowPlugin from "../../../src/plugins/workflow/index.ts";
import {
  bindTestLayout,
  useRightPanelStore,
  useWorkbenchUiStore,
} from "../../helpers/layout.ts";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PanelWorkspace } from "../../../src/plugins/workbench/ui/right-panel/RightPanel.tsx";
import type { WorkbenchContributions } from "../../../src/plugins/workbench/types.ts";
import { sendAawToTarget } from "../../../src/plugins/workflow/ui/aawTarget.ts";

vi.mock("../../../src/plugins/workflow/ui/aawTarget.ts", () => ({
  sendAawToTarget: vi.fn(() => Promise.resolve({ ok: true })),
}));
const mockSend = vi.mocked(sendAawToTarget);
let root: Context;
const runtime = createTestDesktopRuntime(
  { attachPreloading: () => () => {}, close: () => Promise.resolve() },
  undefined,
  (context) => {
    root = context;
    return installDesktopWorkbench(context);
  },
);
let workbench: Awaited<typeof runtime.ready>["workbench"];
let SessionPage: WorkbenchContributions["pages"]["View"];
let foreground: ReturnType<typeof mutableProjectForeground>;
beforeAll(async () => {
  ({ workbench } = await runtime.ready);
  foreground = mutableProjectForeground(root.project);
  bindTestLayout(workbench);
  const session = workbench.getSnapshot().pages.find(({ id }) => id === "session");
  if (!session) throw new Error("Project did not register its session page");
  SessionPage = session.View;
});
afterAll(() => runtime.shutdown());
function Wrapper({ children }: PropsWithChildren) {
  return (
    <WorkbenchContext.Provider value={workbench}>
      {children}
    </WorkbenchContext.Provider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  useRightPanelStore.setState({ projects: {} });
  useWorkbenchUiStore.setState({
    contextPath: null,
    viewId: "project-overview",
    overlay: null,
  });
  foreground.session.getState().clear();
  foreground.session.setState({
    activeSessionId: "slash-session",
    isBound: true,
    isConnecting: false,
  });
});
function mount(project: string) {
  root.project.projects.openWorkspace(project);
  useWorkbenchUiStore.getState().openView("session", project);
  return render(
    <PanelWorkspace project={project} enabled>
      <SessionPage project={project} />
    </PanelWorkspace>,
    { wrapper: Wrapper },
  );
}
describe("斜杠命令打开项目 AAW 向导", () => {
  it("注册的工作流面板直接接收分段能力，过期面板无法写回", async () => {
    const project = "D:/registered-workflow-panel";
    workbench.navigation.getState().openView("session", project);
    root.workflowUi.entries.find(({ label }) => label === "dev")?.run();
    const Panel = workbench.getSnapshot().panels.find(({ id }) => id === "aaw")?.View;
    if (!Panel) throw new Error("Workflow did not register its panel");
    render(<Panel project={project} visible tab={undefined} openPath={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "启动", selected: true })).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: "进度" }));
    expect(screen.getByRole("tab", { name: "进度", selected: true })).toBeVisible();
    act(() => workbench.navigation.getState().openView("project-overview", "D:/other-panel-project"));
    await userEvent.click(screen.getByRole("tab", { name: "启动" }));
    expect(screen.getByRole("tab", { name: "进度", selected: true })).toBeVisible();
  });

  it.each([
    ["sr", "需求原文（保持原文，不总结不改写）"],
    ["ar", "AR 描述"],
    ["dev", "一句话需求"],
  ])("/%s 直接打开右栏启动页和对应变量表单", async (command, field) => {
    const project = `D:/slash-${command}`;
    mount(project);
    const input = screen.getByLabelText("消息输入框");
    await userEvent.type(input, `/${command}{Enter}`);
    const panel = await screen.findByLabelText("AAW 面板");
    expect(
      within(panel).getByRole("tab", { name: "启动", selected: true }),
    ).toBeInTheDocument();
    expect(within(panel).getByLabelText(field)).toBeInTheDocument();
    expect(
      useRightPanelStore.getState().projects[project.toLowerCase()],
    ).toMatchObject({ open: true, active: "aaw", toolViews: { aaw: "launch" } });
    expect(screen.getByLabelText("消息输入框")).toBe(input);
    expect(input).toHaveValue("");
  });
  it("相同命令再次打开向导，切换入口后继续隔离项目草稿", async () => {
    const view = mount("D:/slash-project-a");
    const input = screen.getByLabelText("消息输入框");
    await userEvent.type(input, "/sr{Enter}");
    await userEvent.type(screen.getByLabelText("SR 编号"), "SR-101");
    act(() => {
      useRightPanelStore.getState().collapse("D:/slash-project-a");
    });
    // 关闭后常见的同项目视图/侧栏状态更新不应重放旧的斜杠请求。
    act(() => {
      useWorkbenchUiStore.getState().openView("session", "D:/slash-project-a");
      useWorkbenchUiStore.setState({ sidebarCollapsed: true });
    });
    expect(
      useRightPanelStore.getState().projects["d:/slash-project-a"]?.open,
    ).toBe(false);
    await userEvent.type(input, "/sr{Enter}");
    expect(screen.getByLabelText("SR 编号")).toHaveValue("SR-101");
    await userEvent.type(input, "/ar{Enter}");
    expect(screen.getByLabelText("AR 描述")).toBeInTheDocument();
    expect(screen.getByLabelText("SR 编号")).toHaveValue("SR-101");
    act(() =>
      useWorkbenchUiStore.getState().openView("session", "D:/slash-project-b"),
    );
    view.rerender(
      <PanelWorkspace project="D:/slash-project-b" enabled>
        <SessionPage project="D:/slash-project-b" />
      </PanelWorkspace>,
    );
    expect(
      screen.queryByRole("tab", { name: "启动", selected: true }),
    ).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("消息输入框"), "/dev{Enter}");
    expect(screen.getByLabelText("一句话需求")).toBeInTheDocument();
    expect(screen.getByLabelText("SR 编号")).toHaveValue("");
    expect(
      useRightPanelStore.getState().projects["d:/slash-project-a"]?.active,
    ).toBe("aaw");
    expect(
      useRightPanelStore.getState().projects["d:/slash-project-b"]?.active,
    ).toBe("aaw");
  });
  it("上下文已切换而右栏尚未重渲染时，请求只应用到目标项目", async () => {
    const view = mount("D:/slash-stale-a");
    act(() => {
      useWorkbenchUiStore.getState().openView("session", "D:/slash-stale-b");
      root.workflowUi.entries.find(({ label }) => label === "ar")
        ?.run();
    });
    expect(
      useRightPanelStore.getState().projects["d:/slash-stale-a"]?.open,
    ).not.toBe(true);
    view.rerender(
      <PanelWorkspace project="D:/slash-stale-b" enabled>
        <SessionPage project="D:/slash-stale-b" />
      </PanelWorkspace>,
    );
    expect(await screen.findByLabelText("AR 描述")).toBeInTheDocument();
    expect(
      useRightPanelStore.getState().projects["d:/slash-stale-b"],
    ).toMatchObject({ open: true, active: "aaw", toolViews: { aaw: "launch" } });
    expect(
      useRightPanelStore.getState().projects["d:/slash-stale-a"]?.open,
    ).not.toBe(true);
  });
  it("卸载后撤销入口，重装隔离旧向导草稿与命令", async () => {
    const project = "D:/slash-reload";
    mount(project);
    const input = screen.getByLabelText("消息输入框");
    await userEvent.type(input, "/sr{Enter}");
    await userEvent.type(screen.getByLabelText("SR 编号"), "SR-321");
    const previous = root.workflowUi.entries[0];
    const [fiber] = root.registry.get(workflowPlugin)?.fibers ?? [];
    if (!fiber || !previous) throw new Error("Workflow did not register");
    await act(() => fiber.dispose());
    act(() => {
      useRightPanelStore.getState().collapse(project);
      previous.run();
    });
    expect(
      useRightPanelStore.getState().projects["d:/slash-reload"]?.open,
    ).toBe(false);
    await userEvent.type(input, "/sr");
    expect(screen.queryByRole("option", { name: /\/sr/ })).toBeNull();
    await userEvent.clear(input);
    await act(async () => {
      await root.plugin(workflowPlugin);
    });
    await userEvent.type(input, "/sr{Enter}");
    expect(screen.getByLabelText("SR 编号")).toHaveValue("");
  });

  it("向导发送后可查看会话并收起右栏", async () => {
    mount("D:/slash-submit");
    const chat = screen.getByLabelText("消息输入框");
    await userEvent.type(chat, "/dev{Enter}");
    await userEvent.type(screen.getByLabelText("SR 编号"), "SR-009");
    await userEvent.type(screen.getByLabelText("一句话需求"), "增加设置开关");
    await userEvent.click(
      screen.getByRole("button", { name: "下一步：确认发送" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "交给会话发送" }));
    expect(mockSend).toHaveBeenCalledTimes(1);
    await userEvent.click(await screen.findByRole("button", { name: "查看" }));
    expect(useWorkbenchUiStore.getState().viewId).toBe("session");
    expect(
      useRightPanelStore.getState().projects["d:/slash-submit"]?.open,
    ).toBe(false);
    expect(screen.getByLabelText("消息输入框")).toBe(chat);
  });
});
