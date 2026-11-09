import { readICodeConfiguredPath } from "../../src/plugins/agents/enhancements/icode/settings.ts";
import { version as desktopVersion } from "../../package.json";
import type { ProjectService } from "../../src/contracts/project.ts";
import { mutableProjectCatalog } from "../helpers/projectIndexes.ts";
/**
 * src/ui/SettingsPage 测试（侧边 Tab 版）：Tab 分片渲染与切换、字段
 * 渲染与默认值、变更写 store、「测试连接」成功/失败反馈、语言单选项
 * 呈静态值、skills 安装器区块挂载。
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentAdapters, type AgentAdapter } from "../../src/plugins/agents/registry.ts";
import SettingsPage from "../../src/plugins/workbench/ui/SettingsPage";
import { createDemoHost } from "../../src/plugins/host/host";
import type { AgentsService } from "../../src/contracts/agents.ts";
import { WorkbenchContext } from "../../src/plugins/workbench/react.ts";
import { createTestDesktopRuntime } from "../helpers/desktopRuntime.ts";
import { installDesktopWorkbench } from "../../src/bootstrap/installDesktopWorkbench.ts";
import type { WorkbenchService } from "../../src/contracts/workbench.ts";
import type { ProjectPreferences } from "../../src/contracts/project.ts";
import type { SkillsService } from "../../src/contracts/skills.ts";

const demoHost = createDemoHost();

// UI confirmation is tested here; transport preparation and rollback are covered by pooledRuntime.
const switchAgentFixture = vi.fn((agentId: string) => {
  agentService.select(agentId);
  return Promise.resolve();
});

/**
 * 渲染设置页并等待挂载期的异步扫描落定（skills 安装器 + Agent 本机扫描）：
 * 提前结束测试会让 store→组件的更新逃逸 act（RTL 警告 + stderr 噪声）。
 */
let projectService: ProjectService;
let agentService: AgentsService;
let settingsWorkbench: WorkbenchService;
let projectPreferences: ProjectPreferences;
let skillsService: SkillsService;

async function renderSettingsPage(): Promise<void> {
  render(
    <WorkbenchContext.Provider value={settingsWorkbench}>
      <SettingsPage />
    </WorkbenchContext.Provider>,
  );
  await waitFor(() => {
    expect(skillsService.state.getState().isScanning).toBe(false);
    expect(agentService.configuration.getState().isScanningAgents).toBe(false);
  });
}

/** 切到指定 Tab（侧边导航）。 */
async function openTab(name: string): Promise<void> {
  await userEvent.click(screen.getByRole("tab", { name }));
}

it("设置页随 Cordis 注册项加入和移除动态更新", async () => {
  const runtime = createTestDesktopRuntime({
    attachPreloading: () => () => {},
    close: () => Promise.resolve(),
  });
  const { workbench } = await runtime.ready;
  const { unmount } = render(
    <WorkbenchContext.Provider value={workbench}>
      <SettingsPage />
    </WorkbenchContext.Provider>,
  );
  try {
    expect(screen.queryByRole("tab", { name: "通用" })).not.toBeInTheDocument();
    let release!: () => void;
    act(() => {
      release = workbench.register("settings", {
        id: "custom",
        label: "扩展设置",
        Icon: () => null,
        View: () => <p>扩展内容</p>,
      });
    });
    expect(screen.getByRole("tabpanel", { name: "扩展设置" })).toHaveTextContent("扩展内容");
    act(release);
    expect(screen.queryByRole("tab", { name: "扩展设置" })).not.toBeInTheDocument();
  } finally {
    unmount();
    await runtime.shutdown();
  }
});

describe("SettingsPage（侧边 Tab 版）", () => {
  it("renders another registered adapter's executable editor without ICode keys", async () => {
    const setValue = vi.fn();
    const probe = vi.fn(async () => {});
    const adapter: AgentAdapter = {
      id: "test-configurable",
      displayName: "Test Worker",
      clientInfo: { name: "test" },
      notes: [],
      buildLaunch: () => ({
        command: ["test-worker", "--acp"],
        cwd: null,
        extraEnv: {},
      }),
      executableConfiguration: () => ({
        label: "Worker executable",
        placeholder: "worker",
        value: "worker-path",
        probing: false,
        setValue,
        probe,
      }),
    };
    const registry = agentAdapters as AgentAdapter[];
    registry.push(adapter);
    try {
      await renderSettingsPage();
      await openTab("Agent");
      await userEvent.click(
        screen.getByRole("button", { name: "编辑 Test Worker" }),
      );
      const input = screen.getByLabelText("Worker executable");
      expect(input).toHaveValue("worker-path");
      await userEvent.type(input, "x");
      expect(setValue).toHaveBeenCalledWith("worker-pathx");
      await userEvent.click(
        within(screen.getByLabelText("agent-Test Worker")).getByRole("button", {
          name: "重新检测路径",
        }),
      );
      expect(probe).toHaveBeenCalledOnce();
    } finally {
      registry.splice(registry.indexOf(adapter), 1);
    }
  });
  it("allows another confirmed choice while preparing and ignores the older failure", async () => {
    const switching = switchAgentFixture;
    const original = switching.getMockImplementation()!;
    let fail!: (error: Error) => void;
    const first = new Promise<void>((_, reject) => {
      fail = reject;
    });
    switching.mockImplementationOnce(() => first);
    try {
      await renderSettingsPage();
      await openTab("Agent");
      await userEvent.click(
        within(screen.getByLabelText("agent-CodeAgent")).getByRole("button", {
          name: /CodeAgent.*内置/,
        }),
      );
      await userEvent.click(screen.getByRole("button", { name: "确认切换" }));
      expect(
        screen.queryByRole("dialog", { name: "切换 Agent 确认" }),
      ).not.toBeInTheDocument();
      await userEvent.click(
        within(screen.getByLabelText("agent-iCode")).getByRole("button", {
          name: /iCode.*内置/,
        }),
      );
      await userEvent.click(screen.getByRole("button", { name: "取消" }));
      expect(screen.getByText(/正在准备 Agent/)).toBeInTheDocument();
      await userEvent.click(
        within(screen.getByLabelText("agent-iCode")).getByRole("button", {
          name: /iCode.*内置/,
        }),
      );
      await userEvent.click(screen.getByRole("button", { name: "确认切换" }));
      fail(new Error("stale failure"));
      await waitFor(() =>
        expect(screen.queryByText(/正在准备 Agent/)).not.toBeInTheDocument(),
      );
      expect(screen.queryByText("stale failure")).not.toBeInTheDocument();
      expect(agentService.configuration.getState().activeAgentId).toBe("chrys");
    } finally {
      fail(new Error("settled"));
      switching.mockImplementation(original);
    }
  });

  beforeEach(async ({ onTestFinished }) => {
    window.localStorage.clear();
    demoHost.reset();
    const runtime = createTestDesktopRuntime(
      {
        attachPreloading: () => () => {},
        close: () => Promise.resolve(),
        switchAgent: switchAgentFixture,
      },
      undefined,
      installDesktopWorkbench,
      demoHost,
    );
    onTestFinished(() => runtime.shutdown());
    const { agents, workbench, project, skills } = await runtime.ready;
    projectService = project;
    agentService = agents;
    settingsWorkbench = workbench;
    projectPreferences = project.preferences;
    skillsService = skills;
  });

  it("CodeAgent 内置行可选择并保存自己的可执行路径", async () => {
    await renderSettingsPage();
    await openTab("Agent");
    const row = screen.getByLabelText("agent-CodeAgent");
    await userEvent.click(
      within(row).getByRole("button", { name: /CodeAgent.*内置/ }),
    );
    expect(agentService.configuration.getState().activeAgentId).toBe("chrys");
    await userEvent.click(
      within(screen.getByRole("dialog", { name: "切换 Agent 确认" })).getByRole(
        "button",
        { name: "取消" },
      ),
    );
    expect(agentService.configuration.getState().activeAgentId).toBe("chrys");
    await userEvent.click(
      within(row).getByRole("button", { name: /CodeAgent.*内置/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: "确认切换" }));
    expect(agentService.configuration.getState().activeAgentId).toBe("codeagent");
    await userEvent.click(
      within(row).getByRole("button", { name: "编辑 CodeAgent" }),
    );
    const input = screen.getByLabelText("CodeAgent 路径");
    await userEvent.type(input, "X:/CodeAgent/codeagent.cmd");
    expect(
      agentService.configuration.getState().getAgentSettings("codeagent").executablePath,
    ).toBe("X:/CodeAgent/codeagent.cmd");
  });

  it("CodeAgent 扫描结果只展示，用户采纳后才保存路径，清空后保留 PATH 模式", async () => {
    demoHost.addDir("G:/Code AgentCLI");
    await demoHost.writeTextFile("G:/Code AgentCLI/codeagent", "#!/bin/sh");
    await demoHost.writeTextFile("G:/Code AgentCLI/codeagent.cmd", "@echo off");
    demoHost.scriptCommand("where", ["codeagent"], {
      code: 0,
      stdout: "G:/Code AgentCLI/codeagent\nG:/Code AgentCLI/codeagent.cmd\n",
      stderr: "",
    });
    await renderSettingsPage();
    await openTab("Agent");
    const row = screen.getByLabelText("agent-CodeAgent");
    await userEvent.click(
      within(row).getByRole("button", { name: /CodeAgent.*内置/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: "确认切换" }));
    await userEvent.click(
      within(row).getByRole("button", { name: "编辑 CodeAgent" }),
    );
    expect(
      await within(row).findByText("检测到：G:/Code AgentCLI/codeagent.cmd"),
    ).toBeVisible();
    const input = screen.getByLabelText("CodeAgent 路径");
    expect(input).toHaveValue("");
    expect(
      agentService.configuration.getState().getAgentSettings("codeagent").executablePath,
    ).toBe("");
    await userEvent.click(
      within(row).getByRole("button", { name: "使用检测路径" }),
    );
    expect(input).toHaveValue("G:/Code AgentCLI/codeagent.cmd");
    expect(
      agentService.configuration.getState().getAgentSettings("codeagent").executablePath,
    ).toBe("G:/Code AgentCLI/codeagent.cmd");
    await userEvent.clear(input);
    await userEvent.click(
      within(row).getByRole("button", { name: "重新检测路径" }),
    );
    await within(row).findByText("检测到：G:/Code AgentCLI/codeagent.cmd");
    expect(input).toHaveValue("");
  });

  it("Agent 分片：内置项在列且默认选中 iCode，报告卡呈空态", async () => {
    await renderSettingsPage();
    await openTab("Agent");
    expect(screen.getByText("会话 Agent")).toBeInTheDocument();
    const row = screen.getByLabelText("agent-iCode");
    expect(row).toBeInTheDocument();
    // 内置行带「当前使用」徽标
    expect(within(row).getByText("当前使用")).toBeInTheDocument();
    // demo 宿主未脚本化 where：扫描结论为「未发现」
    expect(screen.getByText(/未发现其他原生 ACP CLI/)).toBeInTheDocument();
    // 报告卡空态
    expect(screen.getByLabelText("协议自检报告")).toBeInTheDocument();
    expect(screen.getByText(/尚未自检/)).toBeInTheDocument();
  });

  it("本机扫描：where 命中 OpenCode 时列出发现行，点行即切换会话 Agent", async () => {
    demoHost.scriptCommand("where", ["opencode"], {
      code: 0,
      stdout: "C:/Users/demo/npm/opencode.exe\r\n",
      stderr: "",
    });
    await renderSettingsPage();
    await openTab("Agent");
    const row = await screen.findByLabelText("agent-OpenCode");
    expect(within(row).getByText("本机发现")).toBeInTheDocument();
    // 行内选择按钮含 agent 名与命令（radio 语义，aria-pressed 表选中）
    const select = within(row).getByRole("button", {
      name: /OpenCode/,
      pressed: false,
    });

    await userEvent.click(select);
    expect(agentService.configuration.getState().activeAgentId).toBe("chrys");
    await userEvent.click(screen.getByRole("button", { name: "确认切换" }));
    expect(agentService.configuration.getState().activeAgentId).toBe("native-opencode");
    expect(window.localStorage.getItem("aaw-desktop.settings.v1")).toContain(
      "native-opencode",
    );
    expect(within(row).getByText("当前使用")).toBeInTheDocument();
  });

  it("添加自定义 agent：入列、持久化、可删除（删除当前项回落内置）", async () => {
    await renderSettingsPage();
    await openTab("Agent");
    await userEvent.type(
      screen.getByLabelText("自定义 Agent 名称"),
      "内网 Agent",
    );
    await userEvent.type(
      screen.getByLabelText("自定义 Agent 程序或路径"),
      "C:/Program Files/intranet/agent.exe",
    );
    const args = screen.getByLabelText("自定义 Agent 启动参数");
    expect(args).not.toBeVisible();
    await userEvent.click(screen.getByText("高级配置"));
    expect(args).toBeVisible();
    await userEvent.type(args, "acp");
    await userEvent.click(screen.getByText("高级配置"));
    expect(args).not.toBeVisible();
    // 收起高级配置仍保留参数，提交时不能丢失。

    await userEvent.click(screen.getByRole("button", { name: "添加" }));

    const row = await screen.findByLabelText("agent-内网 Agent");
    // 双引号路径成组：首段不带引号
    expect(
      within(row).queryByText("C:/Program Files/intranet/agent.exe acp"),
    ).toBeNull();
    expect(agentService.configuration.getState().agents[0]?.command).toEqual([
      "C:/Program Files/intranet/agent.exe",
      "acp",
    ]);
    expect(agentService.configuration.getState().agents).toHaveLength(1);

    // 点行切到自定义项再删除：回落内置 iCode
    await userEvent.click(
      within(row).getByRole("button", { name: /内网 Agent/, pressed: false }),
    );
    await userEvent.click(screen.getByRole("button", { name: "确认切换" }));
    expect(agentService.configuration.getState().activeAgentId).toBe("custom-agent");
    await userEvent.click(within(row).getByRole("button", { name: "删除" }));
    expect(agentService.configuration.getState().agents).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "确认切换" }));
    expect(agentService.configuration.getState().agents).toHaveLength(0);
    expect(agentService.configuration.getState().activeAgentId).toBe("chrys");
  });

  it("空名称 / 空命令的添加被拒并给出错误文案", async () => {
    await renderSettingsPage();
    await openTab("Agent");
    // 名称留空：先报名称
    await userEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(await screen.findByText("名称不能为空")).toBeInTheDocument();
    expect(screen.getByLabelText("自定义 Agent 启动参数")).toBeVisible();
    // 名称合法、命令留空：报命令
    await userEvent.type(
      screen.getByLabelText("自定义 Agent 名称"),
      "内网 Agent",
    );
    await userEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(await screen.findByText("启动命令不能为空")).toBeInTheDocument();
    expect(agentService.configuration.getState().agents).toHaveLength(0);
  });

  it("侧栏 Tab 切换分片；默认落在「通用」", async () => {
    await renderSettingsPage();
    // 默认 Tab：通用（语言 / 主题 / 关于在位，工具路径行不可见）
    expect(screen.getByRole("tab", { name: "通用" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("界面语言")).toBeInTheDocument();
    expect(screen.getByText("版本")).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("关于")).getByText(desktopVersion),
    ).toBeVisible();
    expect(screen.getByRole("img", { name: "AAW" })).toBeVisible();
    expect(screen.getByRole("button", { name: "返回工作区" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("自动保存");
    expect(screen.getByRole("status")).toHaveClass(
      "absolute",
      "bottom-4",
      "right-6",
    );
    expect(document.getElementById("settings-panel-updates")).not.toBeVisible();
    await openTab("更新");
    expect(screen.getByRole("tabpanel", { name: "更新" })).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "更新", level: 1 }),
    ).toBeVisible();
    expect(screen.getByText("界面语言")).not.toBeVisible();
    await openTab("通用");
    // 工具路径面板 hidden（仍在 DOM，但不可见）
    expect(screen.getByLabelText("iCode 路径")).not.toBeVisible();

    await openTab("Agent");
    expect(screen.getByRole("tab", { name: "Agent" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("会话 Agent")).toBeInTheDocument();

    await openTab("工具路径");
    expect(screen.getByRole("tab", { name: "工具路径" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByLabelText("iCode 路径")).not.toBeVisible();

    await openTab("会话与审批");
    expect(screen.getByText("审批默认模式")).toBeInTheDocument();
    expect(screen.getByLabelText("iCode 路径")).not.toBeVisible();
  });

  it("工具路径只显示工作流工具，iCode 路径在 Agent 页保存", async () => {
    await renderSettingsPage();
    await openTab("工具路径");
    expect(screen.getByLabelText("iCode 路径")).not.toBeVisible();
    expect(screen.getByLabelText("uv 命令")).toBeVisible();
    expect(screen.getByLabelText("aaw 脚本路径")).toBeVisible();
    await openTab("Agent");
    expect(screen.getByLabelText("iCode 路径")).not.toBeVisible();
    expect(
      screen.getByRole("button", { name: "编辑 iCode" }),
    ).toHaveTextContent("");
    await userEvent.click(screen.getByRole("button", { name: "编辑 iCode" }));
    const input = screen.getByLabelText("iCode 路径");
    await userEvent.type(input, "X:/Program Files/icode.exe");
    expect(readICodeConfiguredPath(agentService.configuration.getState())).toBe(
      "X:/Program Files/icode.exe",
    );
  });

  it("没有项目时也能测试连接，并直接显示启动错误", async () => {
    await renderSettingsPage();
    await openTab("Agent");
    const row = screen.getByLabelText("agent-iCode");
    await userEvent.click(
      within(row).getByRole("button", { name: "测试连接" }),
    );
    expect(await within(row).findByText(/启动进程失败/)).toBeInTheDocument();
  });

  it("只填 OpenCode 程序时补上 ACP 参数", async () => {
    await renderSettingsPage();
    await openTab("Agent");
    await userEvent.type(
      screen.getByLabelText("自定义 Agent 名称"),
      "另一个 OpenCode",
    );
    await userEvent.type(
      screen.getByLabelText("自定义 Agent 程序或路径"),
      "opencode",
    );
    await userEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(agentService.configuration.getState().agents[0]?.command).toEqual([
      "opencode",
      "acp",
    ]);
    const row = screen.getByLabelText("agent-另一个 OpenCode");
    await userEvent.click(
      within(row).getByRole("button", { name: "编辑 另一个 OpenCode" }),
    );
    expect(screen.getByLabelText("自定义 Agent 启动参数")).toBeVisible();
    const program = screen.getByLabelText("自定义 Agent 程序或路径");
    await userEvent.clear(program);
    await userEvent.type(program, "C:/Agent Tools/opencode.cmd");
    await userEvent.click(screen.getByRole("button", { name: "保存修改" }));
    expect(agentService.configuration.getState().agents[0]?.command).toEqual([
      "C:/Agent Tools/opencode.cmd",
      "acp",
    ]);
  });

  it("语言仅一项可选时呈静态值，不渲染单选项选单（English 预留未下发）", async () => {
    await renderSettingsPage();
    expect(screen.getByText("界面语言")).toBeInTheDocument();
    expect(screen.getByText("中文")).toBeInTheDocument();
    expect(settingsWorkbench.appearance.getSnapshot().language).toBe("zh-CN");
    // 伪控件检查：不出现只有一个方向可选的分组按钮
    expect(
      screen.queryByRole("group", { name: "界面语言" }),
    ).not.toBeInTheDocument();
  });

  it("会话与审批分片：分段控件切换审批默认模式写入 store", async () => {
    await renderSettingsPage();
    await openTab("会话与审批");
    const autoAllow = screen.getByRole("button", { name: "自动放行" });
    expect(autoAllow).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText(/手动确认 —/)).toBeInTheDocument();

    await userEvent.click(autoAllow);
    expect(projectPreferences.getState().approvalMode).toBe("auto-allow");
    expect(autoAllow).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/自动放行 —/)).toBeInTheDocument();
  });

  it("任务步骤默认关闭，切换后持久化并可恢复默认", async () => {
    await renderSettingsPage();
    await openTab("会话与审批");
    const toggle = screen.getByRole("switch", {
      name: "在消息流中显示任务步骤",
    });
    expect(toggle).not.toBeChecked();
    expect(projectPreferences.getState().messageStreamShowTodos).toBe(false);
    await userEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(projectPreferences.getState().messageStreamShowTodos).toBe(true);
    const persisted: unknown = JSON.parse(
      window.localStorage.getItem("aaw-desktop.settings.v1") ?? "{}",
    );
    expect(persisted).toMatchObject({ messageStreamShowTodos: true });
    act(() => projectPreferences.reset());
    expect(projectPreferences.getState().messageStreamShowTodos).toBe(false);
  });

  it("通用分片：切换主题写入 store 并持久化，分段按钮呈按下态", async () => {
    await renderSettingsPage();
    const warm = screen.getByRole("button", { name: "暖白" });
    const dark = screen.getByRole("button", { name: "暗夜" });
    // 默认暗夜：暗夜呈按下态
    expect(dark).toHaveAttribute("aria-pressed", "true");
    expect(warm).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(warm);
    expect(settingsWorkbench.appearance.getSnapshot().theme).toBe("warm");
    expect(window.localStorage.getItem("aaw-desktop.settings.v1")).toContain(
      '"warm"',
    );
    expect(warm).toHaveAttribute("aria-pressed", "true");
    expect(dark).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(dark);
    expect(settingsWorkbench.appearance.getSnapshot().theme).toBe("dark");
    expect(dark).toHaveAttribute("aria-pressed", "true");
  });

  it("页头显示自动保存，并能同时重置外观和其他设置", async () => {
    await renderSettingsPage();
    expect(screen.getByText("自动保存")).toBeInTheDocument();
    act(() => {
      settingsWorkbench.appearance.setTheme("warm");
      settingsWorkbench.appearance.setUiFontSize(20);
      projectPreferences.setApprovalMode("auto-allow");
      skillsService.source.set("D:/skills");
    });
    await userEvent.click(screen.getByRole("button", { name: "恢复默认设置" }));
    const confirm = screen.getByRole("alertdialog", { name: "恢复默认设置确认" });
    await userEvent.click(within(confirm).getByRole("button", { name: "恢复默认" }));
    expect(settingsWorkbench.appearance.getSnapshot()).toMatchObject({ theme: "dark", uiFontSize: 14 });
    expect(screen.getByRole("spinbutton", { name: "界面字号" })).toHaveValue(14);
    expect(projectPreferences.getState().approvalMode).toBe("ask");
    expect(skillsService.source.getSnapshot()).toBe("");
  });

  it("归档管理页：自动归档默认关；已归档会话列表可恢复（回侧栏三列表）", async () => {
    // 预置一条已归档会话（覆盖层 + 会话缓存齐全）
    mutableProjectCatalog(projectService).setState({
      sessionsByPath: {
        "D:/dev/demo": [
          {
            id: "s1",
            title: "被归档的会话",
            updatedAt: "2026-09-01T00:00:00Z",
          },
        ],
      },
    });
    projectService.archive.getState().archiveSession("D:/dev/demo", "s1");

    await renderSettingsPage();
    await openTab("归档管理");

    // 自动归档默认关（静默收起历史会话必须由用户显式开启）
    const off = screen.getByRole("switch", { name: "自动归档闲置会话" });
    expect(off).not.toBeChecked();
    expect(screen.getByText(/默认关闭——静默收起历史会话/)).toBeInTheDocument();

    // 归档列表呈标题与项目路径，「恢复」写回覆盖层（SettingCard 的 label
    // 是 aria-label，不是可见文本）
    expect(screen.getByLabelText("已归档会话（1）")).toBeInTheDocument();
    expect(screen.getByText("被归档的会话")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "取消归档 被归档的会话" }),
    );
    const archived = projectService.archive.getState().archivedSessions;
    expect(archived.size).toBe(0);
    // 数据层缓存不动（铁律：过滤只在渲染层）
    expect(
      projectService.catalog.getState().sessionsByPath["D:/dev/demo"],
    ).toHaveLength(1);
  });

  it("归档管理页：开启自动归档并写天数阈值，持久化生效", async () => {
    await renderSettingsPage();
    await openTab("归档管理");
    await userEvent.click(
      screen.getByRole("switch", { name: "自动归档闲置会话" }),
    );
    expect(projectPreferences.getState().sessionAutoArchiveEnabled).toBe(true);

    const days = screen.getByLabelText("自动归档闲置天数");
    await userEvent.clear(days);
    await userEvent.type(days, "7");
    await userEvent.tab();
    expect(projectPreferences.getState().sessionAutoArchiveOlderThanDays).toBe(7);
    expect(window.localStorage.getItem("aaw-desktop.settings.v1")).toContain(
      '"sessionAutoArchiveEnabled":true',
    );
  });
});
