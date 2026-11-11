import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mutableProjectCatalog } from "../../helpers/projectIndexes.ts";
import {
  openTab,
  projectPreferences,
  projectService,
  renderSettingsPage,
  setupSettingsRuntime,
} from "../../helpers/settingsPageFixture.tsx";

describe("SettingsPage（侧边 Tab 版）", () => {
  beforeEach(({ onTestFinished }) => setupSettingsRuntime(onTestFinished));

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

  it("同步循环播放两种信息流，播完停一秒，并可保存选择", async () => {
    await renderSettingsPage();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      expect(screen.queryByText("怎么启动桌面开发模式？")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("tab", { name: "会话与审批" }));
      const picker = screen.getByRole("group", { name: "信息流呈现方式" });
      expect(screen.getByLabelText("会话策略")).not.toContainElement(picker);
      const process = within(picker).getByRole("button", { name: "过程与结论" });
      const conclusion = within(picker).getByRole("button", { name: "仅结论" });
      expect(screen.getAllByText("怎么启动桌面开发模式？")).toHaveLength(2);
      expect(screen.queryByText("Agent 处理了一些内容")).not.toBeInTheDocument();
      expect(screen.queryByText("npm run tauri -- dev")).not.toBeInTheDocument();

      act(() => vi.advanceTimersByTime(900));
      expect(screen.getAllByText("我先查看桌面应用的启动配置。")).toHaveLength(2);
      expect(screen.queryByText("Agent 处理了一些内容")).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(360));
      expect(screen.getAllByText("Agent 处理了一些内容")).toHaveLength(2);
      expect(screen.queryByText("npm run tauri -- dev")).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(2_040));
      expect(screen.queryByText("npm run tauri -- dev")).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(260));
      expect(process.nextElementSibling).toHaveTextContent("Agent 处理了一些内容");
      expect(conclusion.nextElementSibling).not.toHaveTextContent("Agent 处理了一些内容");
      expect(screen.getAllByText("npm run tauri -- dev")).toHaveLength(2);

      expect(process).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(conclusion);
      expect(conclusion).toHaveAttribute("aria-pressed", "true");
      expect(projectPreferences.getState().messageStreamMode).toBe("conclusion");
      expect(JSON.parse(window.localStorage.getItem("aaw-desktop.settings.v1") ?? "{}"))
        .toMatchObject({ messageStreamMode: "conclusion" });
      expect(screen.queryByRole("button", { name: "重播" })).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(999));
      expect(screen.getAllByText("npm run tauri -- dev")).toHaveLength(2);
      act(() => vi.advanceTimersByTime(1));
      expect(screen.getAllByText("npm run tauri -- dev")).toHaveLength(2);
      act(() => vi.advanceTimersByTime(200));
      expect(screen.getAllByText("怎么启动桌面开发模式？")).toHaveLength(2);
      expect(screen.queryByText("npm run tauri -- dev")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("开启减少动态效果时直接展示两种最终布局", async () => {
    await renderSettingsPage();
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    try {
      await openTab("会话与审批");
      expect(screen.getAllByText("怎么启动桌面开发模式？")).toHaveLength(2);
      expect(screen.getAllByText("npm run tauri -- dev")).toHaveLength(2);
      expect(screen.getAllByText("Agent 处理了一些内容")).toHaveLength(1);
      expect(screen.queryByRole("button", { name: "重播" })).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("归档管理页：自动归档默认关；已归档会话列表可恢复（回侧栏三列表）", async () => {
    // 预置一条已归档会话（覆盖层 + 会话缓存齐全）
    mutableProjectCatalog(projectService.sessions).setState({
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
    projectService.sessions.archiveWithNotice("D:/dev/demo", "s1");

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
    const archived =
      projectService.sessions.archive.getState().archivedSessions;
    expect(archived.size).toBe(0);
    // 数据层缓存不动（铁律：过滤只在渲染层）
    expect(
      projectService.sessions.catalog.getState().sessionsByPath["D:/dev/demo"],
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
    expect(projectPreferences.getState().sessionAutoArchiveOlderThanDays).toBe(
      7,
    );
    expect(window.localStorage.getItem("aaw-desktop.settings.v1")).toContain(
      '"sessionAutoArchiveEnabled":true',
    );
  });
});
