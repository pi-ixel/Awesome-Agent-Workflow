/**
 * src/ui/SettingsPage 测试（侧边 Tab 版）：Tab 分片渲染与切换、字段
 * 渲染与默认值、变更写 store、「测试连接」成功/失败反馈、语言单选项
 * 呈静态值、skills 安装器区块挂载。
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import SettingsPage from "../../src/ui/SettingsPage";
import { demoHost } from "../../src/core/host";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useSkillsStore } from "../../src/stores/skillsStore";
import { useSessionStore } from "../../src/stores/sessionStore";

/**
 * 渲染设置页并等待挂载期的异步扫描落定（skills 安装器 + Agent 本机扫描）：
 * 提前结束测试会让 store→组件的更新逃逸 act（RTL 警告 + stderr 噪声）。
 */
async function renderSettingsPage(): Promise<void> {
  render(<SettingsPage />);
  await waitFor(() => {
    expect(useSkillsStore.getState().isScanning).toBe(false);
    expect(useSettingsStore.getState().isScanningAgents).toBe(false);
  });
}

/** 切到指定 Tab（侧边导航）。 */
async function openTab(name: string): Promise<void> {
  await userEvent.click(screen.getByRole("tab", { name }));
}

describe("SettingsPage（侧边 Tab 版）", () => {
  beforeEach(() => {
    window.localStorage.clear();
    demoHost.reset();
    useSettingsStore.getState().resetToDefaults();
    useSettingsStore.setState({
      connection: { status: "idle", message: "尚未检测", checkedAt: null },
      isProbingChrysPath: false,
      discoveredAgents: [],
      isScanningAgents: false,
    });
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
    });

    await userEvent.click(select);
    expect(useSettingsStore.getState().activeAgentId).toBe("native-opencode");
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
    await userEvent.type(screen.getByLabelText("自定义 Agent 启动参数"), "acp");
    await userEvent.click(screen.getByRole("button", { name: "添加" }));

    const row = await screen.findByLabelText("agent-内网 Agent");
    // 双引号路径成组：首段不带引号
    expect(
      within(row).getByText("C:/Program Files/intranet/agent.exe acp"),
    ).toBeInTheDocument();
    expect(useSettingsStore.getState().agents).toHaveLength(1);

    // 点行切到自定义项再删除：回落内置 iCode
    await userEvent.click(
      within(row).getByRole("button", { name: /内网 Agent/ }),
    );
    expect(useSettingsStore.getState().activeAgentId).toBe("custom-agent");
    await userEvent.click(within(row).getByRole("button", { name: "删除" }));
    expect(useSettingsStore.getState().agents).toHaveLength(0);
    expect(useSettingsStore.getState().activeAgentId).toBe("chrys");
  });

  it("空名称 / 空命令的添加被拒并给出错误文案", async () => {
    await renderSettingsPage();
    await openTab("Agent");
    // 名称留空：先报名称
    await userEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(await screen.findByText("名称不能为空")).toBeInTheDocument();
    // 名称合法、命令留空：报命令
    await userEvent.type(
      screen.getByLabelText("自定义 Agent 名称"),
      "内网 Agent",
    );
    await userEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(await screen.findByText("启动命令不能为空")).toBeInTheDocument();
    expect(useSettingsStore.getState().agents).toHaveLength(0);
  });

  it("四枚 Tab 切换分片；默认落在「通用」", async () => {
    await renderSettingsPage();
    // 默认 Tab：通用（语言 / 主题 / 关于在位，工具路径行不可见）
    expect(screen.getByRole("tab", { name: "通用" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("界面语言")).toBeInTheDocument();
    expect(screen.getByText("版本")).toBeInTheDocument();
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
    const input = screen.getByLabelText("iCode 路径");
    await userEvent.type(input, "X:/Program Files/icode.exe");
    expect(useSettingsStore.getState().chrysPath).toBe(
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
    expect(useSettingsStore.getState().agents[0]?.command).toEqual([
      "opencode",
      "acp",
    ]);
    const row = screen.getByLabelText("agent-另一个 OpenCode");
    await userEvent.click(within(row).getByRole("button", { name: "编辑" }));
    const program = screen.getByLabelText("自定义 Agent 程序或路径");
    await userEvent.clear(program);
    await userEvent.type(program, "C:/Agent Tools/opencode.cmd");
    await userEvent.click(screen.getByRole("button", { name: "保存修改" }));
    expect(useSettingsStore.getState().agents[0]?.command).toEqual([
      "C:/Agent Tools/opencode.cmd",
      "acp",
    ]);
  });

  it("语言仅一项可选时呈静态值，不渲染单选项选单（English 预留未下发）", async () => {
    await renderSettingsPage();
    expect(screen.getByText("界面语言")).toBeInTheDocument();
    expect(screen.getByText("中文")).toBeInTheDocument();
    expect(useSettingsStore.getState().language).toBe("zh-CN");
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
    expect(useSettingsStore.getState().approvalMode).toBe("auto-allow");
    expect(autoAllow).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/自动放行 —/)).toBeInTheDocument();
  });

  it("任务步骤默认关闭，切换后持久化并可恢复默认", async () => {
    await renderSettingsPage();
    await openTab("会话与审批");
    const group = screen.getByRole("group", { name: "在消息流中显示任务步骤" });
    expect(useSettingsStore.getState().messageStreamShowTodos).toBe(false);
    await userEvent.click(within(group).getByRole("button", { name: "开启" }));
    expect(useSettingsStore.getState().messageStreamShowTodos).toBe(true);
    const persisted: unknown = JSON.parse(
      window.localStorage.getItem("aaw-desktop.settings.v1") ?? "{}",
    );
    expect(persisted).toMatchObject({ messageStreamShowTodos: true });
    useSettingsStore.getState().resetToDefaults();
    expect(useSettingsStore.getState().messageStreamShowTodos).toBe(false);
  });

  it("通用分片：切换主题写入 store 并持久化，分段按钮呈按下态", async () => {
    await renderSettingsPage();
    const warm = screen.getByRole("button", { name: "暖白" });
    const dark = screen.getByRole("button", { name: "暗夜" });
    // 默认暗夜：暗夜呈按下态
    expect(dark).toHaveAttribute("aria-pressed", "true");
    expect(warm).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(warm);
    expect(useSettingsStore.getState().theme).toBe("warm");
    expect(window.localStorage.getItem("aaw-desktop.settings.v1")).toContain(
      '"warm"',
    );
    expect(warm).toHaveAttribute("aria-pressed", "true");
    expect(dark).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(dark);
    expect(useSettingsStore.getState().theme).toBe("dark");
    expect(dark).toHaveAttribute("aria-pressed", "true");
  });

  it("页头呈「修改即时生效」说明与「恢复默认设置」入口", async () => {
    await renderSettingsPage();
    expect(screen.getByText("修改即时生效，自动保存")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "恢复默认设置" }),
    ).toBeInTheDocument();
  });

  it("归档管理页：自动归档默认关；已归档会话列表可恢复（回侧栏三列表）", async () => {
    // 预置一条已归档会话（覆盖层 + 会话缓存齐全）
    useSessionStore.setState({
      sessionsByPath: {
        "D:/dev/demo": [
          { id: "s1", title: "被归档的会话", updatedAt: "2026-09-01T00:00:00Z" },
        ],
      },
    });
    useSessionStore.getState().archiveSession("D:/dev/demo", "s1");

    await renderSettingsPage();
    await openTab("归档管理");

    // 自动归档默认关（静默收起历史会话必须由用户显式开启）
    const off = screen.getByRole("button", { name: "关闭" });
    expect(off).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/默认关闭——静默收起历史会话/)).toBeInTheDocument();

    // 归档列表呈标题与项目路径，「恢复」写回覆盖层（SettingCard 的 label
    // 是 aria-label，不是可见文本）
    expect(screen.getByLabelText("已归档会话（1）")).toBeInTheDocument();
    expect(screen.getByText("被归档的会话")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "恢复会话 被归档的会话" }));
    const archived = useSessionStore.getState().archivedSessions;
    expect(archived.size).toBe(0);
    // 数据层缓存不动（铁律：过滤只在渲染层）
    expect(useSessionStore.getState().sessionsByPath["D:/dev/demo"]).toHaveLength(1);
  });

  it("归档管理页：开启自动归档并写天数阈值，持久化生效", async () => {
    await renderSettingsPage();
    await openTab("归档管理");
    await userEvent.click(screen.getByRole("button", { name: "开启" }));
    expect(useSettingsStore.getState().sessionAutoArchiveEnabled).toBe(true);

    const days = screen.getByLabelText("自动归档闲置天数");
    await userEvent.clear(days);
    await userEvent.type(days, "7");
    await userEvent.tab();
    expect(useSettingsStore.getState().sessionAutoArchiveOlderThanDays).toBe(7);
    expect(window.localStorage.getItem("aaw-desktop.settings.v1")).toContain(
      '"sessionAutoArchiveEnabled":true',
    );
  });
});
