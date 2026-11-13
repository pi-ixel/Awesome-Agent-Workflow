/**
 * 侧栏会话分组（扩展点）：其他插件把一组会话归到一个分组下，侧栏把组内
 * 会话收进一行可折叠的分组行，不再平铺。
 *
 * 推送模型：发布方按「项目路径」整体替换自己的分组（publish），project
 * 只存储与渲染，不理解分组的业务含义。一个会话同时出现在多个分组里时，
 * 先注册的发布方优先，侧栏渲染时去重。
 */
import { pathKey } from "../../../shared/panelPaths.ts";
import type { ReadonlySnapshot } from "../../../shared/state/readonlySnapshot.ts";

/** 分组状态：沿用侧栏已有的状态徽标（运行中 / 失败 / 已停止…）。 */
export type SessionGroupStatus = "running" | "waiting" | "completed" | "failed" | "stopped" | "idle";

export interface SessionGroupMember {
  readonly sessionId: string;
  /** 组内显示名（如工作流角色名）；会话自己的标题仍在悬停提示里。 */
  readonly title: string;
  /** 标题后的附注（如「设计修正 · 第 1 轮」）。 */
  readonly note?: string;
  /** 提醒胶囊（如「等你回复」）：显示时替换会话自身的完成 / 未读徽标。 */
  readonly attention?: string;
  /** 这个会话在组里的工作已结束：组内收进默认折叠的「已完成」区，不占眼前位置。 */
  readonly done?: boolean;
}

export interface SessionGroup {
  /** 发布方内唯一（如 runId）。 */
  readonly id: string;
  readonly title: string;
  readonly status: SessionGroupStatus;
  /** 分组行的提醒胶囊：收起时也看得到组内有事等人处理。 */
  readonly attention?: string;
  readonly members: readonly SessionGroupMember[];
  /** 首次出现时是否展开（之后以用户的展开 / 收起为准）。 */
  readonly defaultExpanded?: boolean;
  /** 分组行上的「打开」动作（如打开工作流面板并切到这次运行）。 */
  readonly open?: () => void;
  readonly openLabel?: string;
}

export interface SessionGroupsState {
  /** pathKey → 该项目下全部分组（按发布方注册顺序拼接）。 */
  readonly byPath: Readonly<Record<string, readonly SessionGroup[]>>;
}

export interface SessionGroupPublisher {
  /** 整体替换本发布方在该项目下的分组；传空数组即清空。 */
  publish(path: string, groups: readonly SessionGroup[]): void;
  /** 撤下本发布方的全部分组。 */
  dispose(): void;
}

const emptyState: SessionGroupsState = { byPath: {} };

export function createSessionGroups() {
  const owners = new Map<number, Map<string, readonly SessionGroup[]>>();
  const listeners = new Set<(state: SessionGroupsState, previous: SessionGroupsState) => void>();
  let state = emptyState;
  let nextOwner = 0;
  let disposed = false;

  function rebuild(): void {
    const byPath: Record<string, SessionGroup[]> = {};
    for (const paths of owners.values()) {
      for (const [key, groups] of paths) {
        if (groups.length === 0) continue;
        (byPath[key] ??= []).push(...groups);
      }
    }
    const previous = state;
    state = { byPath };
    for (const listener of [...listeners]) listener(state, previous);
  }

  const snapshot: ReadonlySnapshot<SessionGroupsState> = {
    getState: () => state,
    getInitialState: () => emptyState,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  function register(): SessionGroupPublisher {
    const id = nextOwner++;
    const paths = new Map<string, readonly SessionGroup[]>();
    if (!disposed) owners.set(id, paths);
    return {
      publish(path, groups) {
        if (disposed || !owners.has(id)) return;
        const key = pathKey(path);
        if (groups.length === 0 && !paths.has(key)) return;
        if (groups.length === 0) paths.delete(key);
        else paths.set(key, groups);
        rebuild();
      },
      dispose() {
        if (!owners.delete(id) || disposed) return;
        rebuild();
      },
    };
  }

  return {
    snapshot,
    register,
    dispose() {
      if (disposed) return;
      owners.clear();
      rebuild();
      disposed = true;
      listeners.clear();
    },
  };
}
