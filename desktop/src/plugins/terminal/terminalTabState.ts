/**
 * 终端页签的纯状态底座：类型 + 纯函数（无 React / zustand / Tauri 依赖），
 * terminalTabStore 是它的一层薄壳。页签只一类：`shell`（xterm 交互
 * shell，打开面板 / Plus 创建，可关闭）——ZCode Terminal.tsx 同构，无回放
 * 概念（agent 命令执行的输出在会话消息流的工具卡里，不在终端）。
 *
 * handle 的唯一真相在页签上（pty_spawn 成功后经 store attachHandle 写入）
 * ——页签壳层关闭页签时据此调 ptyHost.closeConnection。退出（markExited）
 * 不清 handle：Rust 侧表项在退出后保留，必须等页签关闭（自然退出即自动
 * 关，见 TerminalPanel 的 onExit 接线）走 kill→release 链显式释放
 * （pty_kill 对已登记终态幂等）。
 */

import type { TerminalTab } from "../../contracts/terminal.ts";

export type { TerminalTab } from "../../contracts/terminal.ts";

/** 初始页签组：空（首次打开面板 / 点 Plus 时创建第一个 shell）。 */
export function createTerminalTabs(): {
  readonly tabs: TerminalTab[];
  readonly activeTabId: string | null;
} {
  return { tabs: [], activeTabId: null };
}

/** 打开新 shell 页签：序号取最小空位，展示名由项目定格；返回新数组与新页签。 */
export function openShellTab(
  tabs: readonly TerminalTab[],
  project: string | null,
  id: string,
): { readonly tabs: TerminalTab[]; readonly tab: TerminalTab } {
  const usedIndexes = new Set(
    tabs.filter((tab) => tab.kind === "shell").map((tab) => tab.index),
  );
  let index = 1;
  while (usedIndexes.has(index)) {
    index += 1;
  }
  const tab: TerminalTab = {
    id,
    kind: "shell",
    project,
    index,
    shellLabel: formatTerminalTabTitle(index, project),
    shellName: null,
    handle: null,
    status: "running",
    exitCode: null,
  };
  return { tabs: [...tabs, tab], tab };
}

/**
 * 关闭 shell 页签：返回新数组、新激活 id（被关页签正激活时取相邻页签——
 * 先左后右）与被关页签（壳层据其 handle 收尾 PTY）。
 */
export function closeShellTab(
  tabs: readonly TerminalTab[],
  activeTabId: string | null,
  tabId: string,
): {
  readonly tabs: TerminalTab[];
  readonly activeTabId: string | null;
  readonly closed: TerminalTab | null;
} {
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) {
    return { tabs: [...tabs], activeTabId, closed: null };
  }
  const closed = tabs[index];
  if (closed === undefined || closed.kind !== "shell") {
    return { tabs: [...tabs], activeTabId, closed: null };
  }
  const next = tabs.filter((tab) => tab.id !== tabId);
  let nextActiveTabId = activeTabId;
  if (activeTabId === tabId) {
    const neighbor = next[index - 1] ?? next[index] ?? null;
    nextActiveTabId = neighbor?.id ?? null;
  }
  return { tabs: next, activeTabId: nextActiveTabId, closed };
}

/**
 * 进程退出：置 exited 态与退出码。handle **保留**——Rust 侧表项（持 master
 * ConPTY 句柄）在退出后并不自动删除，需等页签关闭时经 ptyHost.closeConnection
 * 走 kill→release 显式释放（kill 对已登记终态幂等，见 terminal_pty.rs）。
 */
export function markExited(
  tabs: readonly TerminalTab[],
  tabId: string,
  exitCode: number | null,
): TerminalTab[] {
  return tabs.map((tab) =>
    tab.id === tabId && tab.kind === "shell"
      ? { ...tab, status: "exited" as const, exitCode }
      : tab,
  );
}

/** spawn 成功后写回 shell 显示名（工具栏「终端」旁展示；页签标题不变）。 */
export function attachShellName(
  tabs: readonly TerminalTab[],
  tabId: string,
  shellName: string,
): TerminalTab[] {
  return tabs.map((tab) =>
    tab.id === tabId && tab.kind === "shell" && tab.shellName !== shellName
      ? { ...tab, shellName }
      : tab,
  );
}

/**
 * spawn 返回的 shellName → 展示名（对齐 ZCode formatShellLabel：pwsh /
 * powershell 统一显示 "PowerShell"，其余取小写文件主名）。防御性再走一遍
 * 末段 + 去 .exe（Rust shell_display_name 已是主名，此处兜底显式 file 入参）。
 */
export function formatShellDisplayName(shellName: string): string {
  const stem =
    shellName
      .split(/[\\/]/)
      .at(-1)
      ?.replace(/\.exe$/i, "") ?? shellName;
  const name = stem.toLowerCase();
  return name === "powershell" || name === "pwsh" ? "PowerShell" : name;
}

/**
 * shell 页签展示名：序号 1 = 项目名；>1 追加「 N」（项目名 2）。
 * 无项目上下文回落「终端」。
 */
export function formatTerminalTabTitle(
  index: number,
  project: string | null,
): string {
  const trimmed = project?.trim() ?? "";
  const base =
    trimmed === ""
      ? "终端"
      : (trimmed
          .split(/[\\/]/)
          .filter((segment) => segment !== "")
          .at(-1) ?? trimmed);
  return index === 1 ? base : `${base} ${index}`;
}
