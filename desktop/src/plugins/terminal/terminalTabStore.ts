/**
 * 终端页签 store（zustand）：页签数组 + 激活 id + 每页签的 spawn 错误。
 * 每个 Terminal 实例持有一组跨项目共享的页签。
 * 数据底座（纯函数）见 terminalTabState.ts，本模块只做薄封装。
 *
 * attachHandle 是 handle 的唯一写入口：TerminalSessionView spawn 成功后
 * 写入，页签壳层关闭页签时从被关页签读 handle 由 Terminal 服务释放 PTY。
 * closeShellTab 返回被关页签（而非在 store 内触 Tauri）——保持 store 纯 UI，
 * 收尾动作留在调用侧。
 */
import { createStore } from "zustand";
import type { TerminalTabState } from "../../contracts/terminal.ts";

import {
  attachShellName as attachShellNamePure,
  closeShellTab as closeShellTabPure,
  createTerminalTabs,
  markExited as markExitedPure,
  openShellTab as openShellTabPure,
} from "./terminalTabState.ts";

export function createTerminalTabStore() {
  const initial = createTerminalTabs();
  let active = true;
  let sequence = 0;
  const store = createStore<TerminalTabState>((update, get) => {
    const set: typeof update = (patch) => {
      if (active) update(patch);
    };
    return {
      tabs: initial.tabs,
      activeTabId: initial.activeTabId,
      connectionErrors: {},

      openShellTab: (project) => {
        if (!active) return;
        const result = openShellTabPure(
          get().tabs,
          project,
          `shell-${++sequence}`,
        );
        set({ tabs: result.tabs, activeTabId: result.tab.id });
      },

      closeShellTab: (tabId) => {
        if (!active) return null;
        const result = closeShellTabPure(get().tabs, get().activeTabId, tabId);
        if (result.closed === null) {
          return null;
        }
        set((state) => {
          const connectionErrors = { ...state.connectionErrors };
          delete connectionErrors[tabId];
          return {
            tabs: result.tabs,
            activeTabId: result.activeTabId,
            connectionErrors,
          };
        });
        return result.closed;
      },

      setActiveTab: (tabId) => {
        if (get().activeTabId !== tabId) {
          set({ activeTabId: tabId });
        }
      },

      attachHandle: (tabId, handle) => {
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.id === tabId && tab.handle !== handle
              ? { ...tab, handle }
              : tab,
          ),
        }));
      },

      attachShellName: (tabId, shellName) => {
        set((state) => ({
          tabs: attachShellNamePure(state.tabs, tabId, shellName),
        }));
      },

      markExited: (tabId, exitCode) => {
        set((state) => ({ tabs: markExitedPure(state.tabs, tabId, exitCode) }));
      },

      setConnectionError: (tabId, message) => {
        set((state) => {
          if (state.connectionErrors[tabId] === message) {
            return state;
          }
          const connectionErrors = { ...state.connectionErrors };
          if (message === null) {
            delete connectionErrors[tabId];
          } else {
            connectionErrors[tabId] = message;
          }
          return { connectionErrors };
        });
      },
    };
  });
  return {
    store,
    isActive: () => active,
    dispose() {
      active = false;
      store.setState({ ...initial, connectionErrors: {} });
    },
  };
}
