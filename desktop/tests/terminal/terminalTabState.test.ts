/**
 * 终端页签纯状态（terminalTabState）测试：初始空页签组、shell 创建的
 * 编号最小空位与展示名定格、关闭时的相邻激活（先左后右）、退出态落定
 * （handle 保留至页签关闭）、shell 显示名写回与归一化。
 * terminalTabStore 只是这层纯函数的薄壳。
 */
import { describe, expect, it } from "vitest";

import {
  attachShellName,
  closeShellTab,
  createTerminalTabs,
  formatShellDisplayName,
  formatTerminalTabTitle,
  markExited,
  openShellTab,
  type TerminalTab,
} from "../../src/plugins/terminal/terminalTabState.ts";

/** 布置两张 shell 页签的现场，返回各页签 id 便于断言。 */
function seedTwoShells(): {
  readonly tabs: readonly TerminalTab[];
  readonly firstId: string;
  readonly secondId: string;
} {
  const initial = createTerminalTabs();
  const first = openShellTab(initial.tabs, "D:/dev/demo", "shell-1");
  const second = openShellTab(first.tabs, "D:/dev/demo", "shell-2");
  return { tabs: second.tabs, firstId: first.tab.id, secondId: second.tab.id };
}

describe("createTerminalTabs（初始页签组）", () => {
  it("空页签组、无激活（shell 在打开面板 / 点 Plus 时创建）", () => {
    const { tabs, activeTabId } = createTerminalTabs();
    expect(tabs).toHaveLength(0);
    expect(activeTabId).toBeNull();
  });
});

describe("openShellTab（编号最小空位 + 展示名定格）", () => {
  it("序号顺延；展示名 index 1 = 项目名、>1 追加 N", () => {
    const initial = createTerminalTabs();
    const first = openShellTab(initial.tabs, "D:/dev/demo", "shell-1");
    expect(first.tab.index).toBe(1);
    expect(first.tab.shellLabel).toBe("demo");
    expect(first.tab.handle).toBeNull();
    expect(first.tab.status).toBe("running");

    const second = openShellTab(first.tabs, "D:/dev/demo", "shell-2");
    expect(second.tab.index).toBe(2);
    expect(second.tab.shellLabel).toBe("demo 2");
  });

  it("关闭后空出的最小编号被复用", () => {
    const { tabs, firstId } = seedTwoShells();
    const closed = closeShellTab(tabs, null, firstId);
    const reopened = openShellTab(closed.tabs, "D:/dev/demo", "shell-3");
    expect(reopened.tab.index).toBe(1);
  });

  it("无项目上下文回落「终端」；Windows / POSIX 路径都取末段", () => {
    expect(formatTerminalTabTitle(1, null)).toBe("终端");
    expect(formatTerminalTabTitle(2, null)).toBe("终端 2");
    expect(formatTerminalTabTitle(1, "D:/dev/demo")).toBe("demo");
    expect(formatTerminalTabTitle(1, "D:\\dev\\demo\\")).toBe("demo");
    expect(formatTerminalTabTitle(3, "/home/u/repo")).toBe("repo 3");
  });
});

describe("closeShellTab（相邻激活 + 被关页签回传）", () => {
  it("关闭激活页签：相邻先左（这里落到第一张 shell）", () => {
    const { tabs, firstId, secondId } = seedTwoShells();
    const closed = closeShellTab(tabs, secondId, secondId);
    expect(closed.closed?.id).toBe(secondId);
    expect(closed.tabs).toHaveLength(1);
    expect(closed.activeTabId).toBe(firstId);
  });

  it("被关页签非激活时激活保持；关到空组时激活落 null（面板空态）", () => {
    const { tabs, firstId, secondId } = seedTwoShells();
    // 激活第二张，关第一张：激活保持第二张
    const keepActive = closeShellTab(tabs, secondId, firstId);
    expect(keepActive.closed?.id).toBe(firstId);
    expect(keepActive.activeTabId).toBe(secondId);

    // 关最后一张：页签组空，激活落 null
    const final = closeShellTab(keepActive.tabs, secondId, secondId);
    expect(final.tabs).toHaveLength(0);
    expect(final.activeTabId).toBeNull();
  });

  it("未知页签 id 关闭为 no-op（closed 为 null，原样返回）", () => {
    const { tabs, secondId } = seedTwoShells();
    const result = closeShellTab(tabs, secondId, "unknown-id");
    expect(result.closed).toBeNull();
    expect(result.tabs).toEqual(tabs);
    expect(result.activeTabId).toBe(secondId);
  });
});

describe("markExited（退出态落定）", () => {
  it("置 exited + 退出码；handle 保留（Rust 表项要等页签关闭 kill→release 收尾）；其他页签原样", () => {
    const { tabs, firstId, secondId } = seedTwoShells();
    // 先布置 handle（模拟 spawn 后的现场），退出后应原样保留
    const seeded = tabs.map((tab) =>
      tab.kind === "shell"
        ? { ...tab, handle: tab.id === firstId ? 11 : 22 }
        : tab,
    );
    const exited = markExited(seeded, firstId, 0);
    const target = exited.find((tab) => tab.id === firstId);
    expect(target?.status).toBe("exited");
    expect(target?.exitCode).toBe(0);
    expect(target?.handle).toBe(11);
    expect(exited.find((tab) => tab.id === secondId)?.handle).toBe(22);
    // 其他页签（第二张 shell）不受影响
    expect(exited.find((tab) => tab.id === secondId)?.status).toBe("running");
  });
});

describe("attachShellName / formatShellDisplayName（shell 显示名）", () => {
  it("attachShellName 只写目标 shell 页签；其他页签不动", () => {
    const { tabs, firstId, secondId } = seedTwoShells();
    const named = attachShellName(tabs, firstId, "PowerShell");
    expect(named.find((tab) => tab.id === firstId)?.shellName).toBe(
      "PowerShell",
    );
    expect(named.find((tab) => tab.id === secondId)?.shellName).toBeNull();
    // 幂等：同值再写整组不变
    expect(attachShellName(named, firstId, "PowerShell")).toEqual(named);
  });

  it("formatShellDisplayName：pwsh/powershell → PowerShell；其余小写主名并去 .exe/路径", () => {
    expect(formatShellDisplayName("pwsh")).toBe("PowerShell");
    expect(formatShellDisplayName("powershell")).toBe("PowerShell");
    expect(formatShellDisplayName("C:/tools/pwsh.exe")).toBe("PowerShell");
    expect(formatShellDisplayName("Bash")).toBe("bash");
    expect(formatShellDisplayName("/usr/bin/zsh")).toBe("zsh");
    expect(formatShellDisplayName("cmd")).toBe("cmd");
  });
});
