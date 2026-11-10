import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentAdapters,
  type AgentAdapter,
} from "../../../src/plugins/agents/registry/registry.ts";
import {
  agentService,
  demoHost,
  openTab,
  renderSettingsPage,
  setupSettingsRuntime,
  switchAgentFixture,
} from "../../helpers/settingsPageFixture.tsx";

it("renders another registered adapter's executable editor without ICode keys", async ({
  onTestFinished,
}) => {
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
    await setupSettingsRuntime(onTestFinished);
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

describe("SettingsPage（侧边 Tab 版）", () => {
  beforeEach(({ onTestFinished }) => setupSettingsRuntime(onTestFinished));

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
    expect(agentService.configuration.getState().activeAgentId).toBe(
      "codeagent",
    );
    await userEvent.click(
      within(row).getByRole("button", { name: "编辑 CodeAgent" }),
    );
    const input = screen.getByLabelText("CodeAgent 路径");
    await userEvent.type(input, "X:/CodeAgent/codeagent.cmd");
    expect(agentService.executableConfiguration("codeagent")?.value).toBe(
      "X:/CodeAgent/codeagent.cmd",
    );
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
    expect(agentService.executableConfiguration("codeagent")?.value).toBe("");
    await userEvent.click(
      within(row).getByRole("button", { name: "使用检测路径" }),
    );
    expect(input).toHaveValue("G:/Code AgentCLI/codeagent.cmd");
    expect(agentService.executableConfiguration("codeagent")?.value).toBe(
      "G:/Code AgentCLI/codeagent.cmd",
    );
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
    expect(agentService.configuration.getState().activeAgentId).toBe(
      "native-opencode",
    );
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
    expect(agentService.configuration.getState().activeAgentId).toBe(
      "custom-agent",
    );
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
});
