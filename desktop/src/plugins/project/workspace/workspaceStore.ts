import { sessionPinKey, parseSessionPinKey } from "../sessions/sessionPin.ts";
/**
 * 工作区 store：工作区选择、最近打开与置顶（本地持久化）、健康检查，
 * 以及「打开项目」（activePath 即 ACP session 的 cwd 绑定点，参考 chrys
 * 服务端 session/new 的 cwd 参数）。
 *
 * 数据流约定（docs/conventions.md）：
 * - 异步探测（runWorkspaceHealthChecks）完成后的回填统一走
 *   applyHealthReport，UI 数据流单一路径；
 * - 回填带 path：与 selectedPath 不一致（用户已切走）的结果直接丢弃，
 *   防过期覆盖；
 * - AAW 工作流状态不在这里：唯一状态源是 aawStatusStore（loader 注入式
 *   只读视图，见 src/aaw/statusLoader.ts）；
 * - recent / pinned / toolPaths 持久化到本机记录，Project 实例创建时恢复。
 *
 * 置顶语义对齐 ZCode：置顶首先是**会话级**——task.pinned 使会话进入
 * 侧栏最顶的「置顶任务带」（project-sidebar/index.tsx:252-257
 * TID_PROJECT_PINNED_TASKS，会话菜单带 pin/unpin，TaskActionMenuContent
 * .tsx:89），项目级置顶带在其下（index.tsx:258-262）。desktop 的两组
 * 置顶各自持久化：
 * - pinnedPaths：项目钉选。JSON 持久化键仍是 `favorites`（不升版本、
 *   不写迁移脚本）——老用户的收藏集合原样恢复为置顶集合，「收藏 =
 *   置顶标记」数据等价，仅展示语义升级；
 * - pinnedSessions：会话钉选（键见 sessionPinKey）。v1 形状的**可选
 *   新增字段**，不升版本：老数据缺省为空集，老版本读取时忽略未知字段
 *   ——读写双向兼容，升版本反而会把 v1 的 recent / favorites / toolPaths
 *   全部作废。
 */
import { createStore } from "zustand";
import { createSnapshotView, type ReadonlySnapshot } from "../../../shared/state/readonlySnapshot.ts";

import { createLogger, type Logger } from "../../../shared/logging/logger.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import type { HostStorage } from "../../host/types.ts";
import { defaultToolPaths, emptyWorkspace } from "./types.ts";
import type {
  WorkspaceEntry,
  WorkspaceHealthCheck,
  WorkspaceSnapshot,
  WorkspaceStoreState,
  WorkspaceToolPaths,
} from "./types.ts";
import type { ProcessRunner } from "../../host/types.ts";


/** 最近打开列表上限。 */
const RECENT_LIMIT = 8;

/** localStorage 持久化键（带版本号，形状变更时升版本）。 */
const STORAGE_KEY = "aaw-desktop/workspace/v1";

/** 会话置顶的持久化键：pathKey 归一 + \u0000 分隔（路径不产生该控制符，
 *  会话 id 是 agent 的 UUID 形态同样不含）。UI 经 resolvePinnedSession
 *  反查展示路径与标题（见 ProjectTree）。 */
export { sessionPinKey } from "../sessions/sessionPin.ts";

// --------------------------------------------------------------- 持久化辅助

interface PersistedShape {
  readonly version: 1;
  readonly recent: readonly WorkspaceEntry[];
  readonly favorites: readonly string[];
  /** 可选新增（不升版本，见文件头）：会话级置顶键集合。 */
  readonly pinnedSessions?: readonly string[];
  readonly toolPaths: WorkspaceToolPaths;
}

function readPersisted(storage: HostStorage): Partial<PersistedShape> | null {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 1
    ) {
      return null;
    }
    return sanitizePersisted(parsed as Record<string, unknown>);
  } catch {
    // 损坏数据按「无历史」处理
    return null;
  }
}

function sanitizePersisted(
  record: Record<string, unknown>,
): Partial<PersistedShape> | null {
  // 中间载体可变，返回前满足 PersistedShape 的 readonly 形状
  const out: {
    recent?: WorkspaceEntry[];
    favorites?: string[];
    pinnedSessions?: string[];
    toolPaths?: WorkspaceToolPaths;
  } = {};
  if (Array.isArray(record["recent"])) {
    const recent: WorkspaceEntry[] = [];
    for (const item of record["recent"]) {
      if (
        typeof item === "object" &&
        item !== null &&
        typeof (item as { path?: unknown }).path === "string" &&
        typeof (item as { lastOpenedAt?: unknown }).lastOpenedAt === "string"
      ) {
        recent.push({
          path: (item as { path: string }).path,
          lastOpenedAt: (item as { lastOpenedAt: string }).lastOpenedAt,
        });
      }
    }
    out.recent = recent;
  }
  if (Array.isArray(record["favorites"])) {
    out.favorites = record["favorites"].filter(
      (item): item is string => typeof item === "string",
    );
  }
  if (Array.isArray(record["pinnedSessions"])) {
    out.pinnedSessions = record["pinnedSessions"].filter(
      (item): item is string =>
        typeof item === "string" && parseSessionPinKey(item) !== null,
    );
  }
  if (typeof record["toolPaths"] === "object" && record["toolPaths"] !== null) {
    const paths = record["toolPaths"] as Record<string, unknown>;
    out.toolPaths = {
      ...Object.fromEntries(
        Object.entries(paths).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      uvCommand:
        typeof paths["uvCommand"] === "string"
          ? paths["uvCommand"]
          : defaultToolPaths.uvCommand,
      aawScriptPath:
        typeof paths["aawScriptPath"] === "string"
          ? paths["aawScriptPath"]
          : defaultToolPaths.aawScriptPath,
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

function writePersisted(
  storage: HostStorage,
  state: WorkspaceStoreState,
  logger: Logger,
): void {
  try {
    const payload: PersistedShape = {
      version: 1,
      recent: state.recentWorkspaces,
      favorites: state.pinnedPaths,
      pinnedSessions: state.pinnedSessions,
      toolPaths: state.toolPaths,
    };
    storage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    // 隐私模式 / 存储满：仅记录，不影响功能
    logger.warn("项目列表持久化写入失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 已有项目原位更新时间；只有新增项目置顶，避免切换时侧栏跳动。 */
function withRecentEntry(
  recent: readonly WorkspaceEntry[],
  path: string,
): readonly WorkspaceEntry[] {
  const lastOpenedAt = new Date().toISOString();
  if (recent.some((entry) => entry.path === path)) {
    return recent.map((entry) =>
      entry.path === path ? { ...entry, lastOpenedAt } : entry,
    );
  }
  return [{ path, lastOpenedAt }, ...recent].slice(0, RECENT_LIMIT);
}

// --------------------------------------------------------------- store 本体

export function workspaceCommands(source: ReadonlySnapshot<WorkspaceStoreState>) {
  const {
    selectWorkspace,
    openWorkspace,
    closeWorkspace,
    togglePinned,
    toggleSessionPinned,
    dismissConnectError,
    hydrateFromStorage,
  } = source.getState();
  return {
    selectWorkspace,
    openWorkspace,
    closeWorkspace,
    togglePinned,
    toggleSessionPinned,
    dismissConnectError,
    patchToolPaths(paths: Partial<WorkspaceToolPaths>) {
      const { toolPaths, setToolPaths } = source.getState();
      setToolPaths({ ...toolPaths, ...paths });
    },
    runHealthChecks: (paths?: Partial<WorkspaceToolPaths>) =>
      source.getState().runHealthChecks(undefined, paths),
    reloadWorkspacePreferences: hydrateFromStorage,
  };
}

export function createWorkspaceStore(
  storage: HostStorage,
  processRunner: ProcessRunner,
  guardNavigation: (resume: () => void, path: string) => boolean,
  logger = createLogger("store"),
) {
  const lifecycle = new AbortController();
  const { signal } = lifecycle;
  let healthProvider: { check: WorkspaceHealthCheck } | undefined;
  let healthCheck: AbortController | undefined;
  const stopHealthCheck = () => {
    healthCheck?.abort();
    healthCheck = undefined;
  };
  const store = createStore<WorkspaceStoreState>()((set, get) => ({
    ...emptyWorkspace,

    selectWorkspace: (path) => {
      if (signal.aborted) return;
      const trimmed = path.trim();
      if (trimmed === "") {
        return;
      }
      if (get().selectedPath !== trimmed) stopHealthCheck();
      set((state) => ({
        selectedPath: trimmed,
        // 切换目录即清空旧目录的报告，防止跨目录串数据
        health: null,
        // 切到不同目录时复位 in-flight 标志：在途检查属于旧目录，其回填
        // 必被丢弃，若不复位按钮会永久禁用（新目录的检查发起后会再次置 true）
        ...(state.selectedPath !== trimmed ? { isCheckingHealth: false } : {}),
        recentWorkspaces: withRecentEntry(state.recentWorkspaces, trimmed),
      }));
      if (!signal.aborted) writePersisted(storage, get(), logger);
      logger.info("已选择项目", { path: trimmed });
    },

    clearSelection: () => {
      if (signal.aborted) return;
      stopHealthCheck();
      set({
        selectedPath: null,
        health: null,
        // 在途结果将因 selectedPath=null 被丢弃，标志一并复位
        isCheckingHealth: false,
      });
    },

    openWorkspace: (path) => {
      if (signal.aborted) return;
      const target = (path ?? get().selectedPath)?.trim();
      if (target === undefined || target === "") {
        return;
      }
      const changed = get().selectedPath !== target;
      if (changed) stopHealthCheck();
      set((state) => ({
        ...(changed ? { health: null, isCheckingHealth: false } : {}),
        activePath: target,
        selectedPath: target,
        recentWorkspaces: withRecentEntry(state.recentWorkspaces, target),
      }));
      if (!signal.aborted) writePersisted(storage, get(), logger);
      logger.info("已打开项目（绑定 ACP session cwd）", { path: target });
    },

    closeWorkspace: () => {
      if (signal.aborted) return;
      const closing = get().activePath;
      if (
        closing !== null &&
        !guardNavigation(() => {
          if (get().activePath === closing) get().closeWorkspace();
        }, closing)
      )
        return;
      set({ activePath: null, lastConnectError: null });
      if (closing !== null) {
        logger.info("已关闭项目", { path: closing });
      }
    },

    reportConnectFailure: (path, message) => {
      if (signal.aborted) return;
      set({ lastConnectError: { path, message } });
      logger.warn("连接失败已回填（UI 将展示错误横幅）", { path, message });
    },

    dismissConnectError: (path) => {
      if (signal.aborted) return;
      const error = get().lastConnectError;
      if (error === null || error.path !== path) {
        return;
      }
      set({ lastConnectError: null });
    },

    togglePinned: (path) => {
      if (signal.aborted) return;
      set((state) => ({
        pinnedPaths: state.pinnedPaths.includes(path)
          ? state.pinnedPaths.filter((item) => item !== path)
          : [...state.pinnedPaths, path],
      }));
      if (!signal.aborted) writePersisted(storage, get(), logger);
    },

    // 会话级置顶（ZCode task.pinned）：新置顶插到最前（置顶任务带 = 最新
    // 置顶在前，与项目带按 lastOpenedAt 倒序的「新在前」同拍）
    toggleSessionPinned: (path, sessionId, agentKey) => {
      if (signal.aborted) return;
      const key = sessionPinKey(path, sessionId, agentKey);
      set((state) => ({
        pinnedSessions: state.pinnedSessions.includes(key)
          ? state.pinnedSessions.filter((item) => item !== key)
          : [key, ...state.pinnedSessions],
      }));
      if (!signal.aborted) writePersisted(storage, get(), logger);
    },

    removeFromRecent: (path) => {
      if (signal.aborted) return;
      const key = pathKey(path);
      const matches = (candidate: string | null) => candidate !== null && pathKey(candidate) === key;
      if (matches(get().selectedPath)) stopHealthCheck();
      const pathPrefix = `${key}\u0000`;
      set((state) => ({
        recentWorkspaces: state.recentWorkspaces.filter(
          (entry) => !matches(entry.path),
        ),
        pinnedPaths: state.pinnedPaths.filter((item) => !matches(item)),
        // 项目移出列表时其会话级置顶一并清掉：置顶任务带不渲染幽灵行
        //（项目不在列表里，行点了也只能落失败回滚）
        pinnedSessions: state.pinnedSessions.filter(
          (item) => !item.startsWith(pathPrefix),
        ),
        // 移除的正是当前选中目录时同步清空选择，避免详情区悬挂
        //（连带复位 in-flight 标志：在途回填将因选择清空被丢弃）
        ...(matches(state.selectedPath)
          ? { selectedPath: null, health: null, isCheckingHealth: false }
          : {}),
        ...(matches(state.activePath) ? { activePath: null } : {}),
        ...(matches(state.lastConnectError?.path ?? null) ? { lastConnectError: null } : {}),
      }));
      if (!signal.aborted) writePersisted(storage, get(), logger);
    },

    setToolPaths: (paths) => {
      if (signal.aborted) return;
      set({ toolPaths: paths });
      if (!signal.aborted) writePersisted(storage, get(), logger);
      logger.info("工具路径已更新", { ...paths });
    },

    applyHealthReport: (path, items) => {
      if (signal.aborted) return;
      if (get().selectedPath !== path) {
        // 用户已切换目录：过期报告丢弃
        logger.debug("丢弃过期健康检查报告", { path });
        return;
      }
      set({
        health: { path, items, checkedAt: new Date().toISOString() },
        isCheckingHealth: false,
      });
    },

    runHealthChecks: async (runner = processRunner, pathsOverride) => {
      const { selectedPath, toolPaths } = get();
      const provider = healthProvider;
      if (signal.aborted || selectedPath === null || !provider) {
        return;
      }
      stopHealthCheck();
      const check = new AbortController();
      healthCheck = check;
      const isCurrent = () =>
        healthCheck === check && get().selectedPath === selectedPath;
      set({ isCheckingHealth: true });
      try {
        const items = await provider.check({
          workspacePath: selectedPath,
          toolPaths: { ...toolPaths, ...pathsOverride },
          runner,
          signal: check.signal,
        });
        if (isCurrent()) get().applyHealthReport(selectedPath, items);
      } catch (error) {
        // 领域层不抛（执行失败落 CliRunResult），这里兜底意外异常并记日志；
        // 标志复位统一交给 finally
        if (isCurrent())
          logger.error("健康检查执行异常", {
            path: selectedPath,
            error: error instanceof Error ? error.message : String(error),
          });
      } finally {
        // 过期回填（applyHealthReport 的丢弃分支）不复位标志：只有本次
        // 运行结束且当前仍选中该目录时才复位，防止标志卡在 true 把
        // 「重新检查」按钮永久禁用
        if (isCurrent()) {
          healthCheck = undefined;
          set({ isCheckingHealth: false });
        }
      }
    },

    hydrateFromStorage: () => {
      if (signal.aborted) return;
      const persisted = readPersisted(storage);
      if (persisted === null) {
        return;
      }
      set((state) => ({
        recentWorkspaces: persisted.recent ?? state.recentWorkspaces,
        pinnedPaths: persisted.favorites ?? state.pinnedPaths,
        pinnedSessions: persisted.pinnedSessions ?? state.pinnedSessions,
        toolPaths: persisted.toolPaths ?? state.toolPaths,
      }));
    },
  }));

  store.getState().hydrateFromStorage();
  const view = createSnapshotView(store, (state): WorkspaceSnapshot => ({
    recentWorkspaces: state.recentWorkspaces,
    pinnedPaths: state.pinnedPaths,
    pinnedSessions: state.pinnedSessions,
    selectedPath: state.selectedPath,
    activePath: state.activePath,
    health: state.health,
    isCheckingHealth: state.isCheckingHealth,
    healthCheckAvailable: state.healthCheckAvailable,
    toolPaths: state.toolPaths,
    lastConnectError: state.lastConnectError,
  }));
  return {
    store,
    view: view.snapshot,
    commands: workspaceCommands(store),
    registerHealthCheck(check: WorkspaceHealthCheck): () => void {
      if (signal.aborted || healthProvider) throw new Error("无法注册工作区健康检查");
      const provider = { check };
      healthProvider = provider;
      store.setState({ healthCheckAvailable: true });
      return () => {
        if (healthProvider !== provider) return;
        healthProvider = undefined;
        stopHealthCheck();
        store.setState({ healthCheckAvailable: false, isCheckingHealth: false });
      };
    },
    dispose() {
      if (signal.aborted) return;
      lifecycle.abort();
      healthProvider = undefined;
      stopHealthCheck();
      store.setState(emptyWorkspace);
      view.dispose();
    },
  };
}
