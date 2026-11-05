import { sessionPinKey, parseSessionPinKey } from "../core/sessionPin.ts";
import { guardMarkdownNavigation } from "./markdownDocumentStore.ts";
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
 * - recent / pinned / toolPaths 持久化到 localStorage，模块加载即恢复。
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
import { create } from "zustand";

import { createLogger } from "../core/logger.ts";
import { pathKey } from "../core/panelPaths.ts";
import {
  defaultToolPaths,
  runWorkspaceHealthChecks,
  type HealthCheckItem,
  type WorkspaceToolPaths,
} from "../aaw/healthChecks.ts";
import { defaultProcessRunner } from "../aaw/tauriProcessRunner.ts";
import type { ProcessRunner } from "../aaw/processRunner.ts";

const logger = createLogger("store");

/** 最近打开列表上限。 */
const RECENT_LIMIT = 8;

/** localStorage 持久化键（带版本号，形状变更时升版本）。 */
const STORAGE_KEY = "aaw-desktop/workspace/v1";

/** 会话置顶的持久化键：pathKey 归一 + \u0000 分隔（路径不产生该控制符，
 *  会话 id 是 agent 的 UUID 形态同样不含）。UI 经 resolvePinnedSession
 *  反查展示路径与标题（见 ProjectTree）。 */
export { sessionPinKey } from "../core/sessionPin.ts";

/** 一个最近打开的工作区。 */
export interface WorkspaceEntry {
  readonly path: string;
  /** 最近一次打开时间（ISO 8601）。 */
  readonly lastOpenedAt: string;
}

/** 针对所选目录的健康检查报告。 */
export interface HealthReport {
  readonly path: string;
  readonly items: readonly HealthCheckItem[];
  readonly checkedAt: string;
}

/** 一次「打开项目」连接失败的用户可见错误（含修复指引）。 */
export interface ConnectError {
  readonly path: string;
  readonly message: string;
}

interface WorkspaceStoreState {
  recentWorkspaces: readonly WorkspaceEntry[];
  pinnedPaths: readonly string[];
  /** 会话级置顶集合（sessionPinKey 键；持久化，序 = 置顶先后，最新在前）。 */
  pinnedSessions: readonly string[];
  /** 当前选中（未打开）的工作区目录。 */
  selectedPath: string | null;
  /** 已打开的工作区：ACP session 的 cwd 绑定点。 */
  activePath: string | null;
  health: HealthReport | null;
  isCheckingHealth: boolean;
  /** 外部工具路径（设置页的「工具路径」落点；持久化）。 */
  toolPaths: WorkspaceToolPaths;
  /** 最近一次连接失败（按项目匹配展示；成功连接或用户关闭即清除）。 */
  lastConnectError: ConnectError | null;

  selectWorkspace: (path: string) => void;
  clearSelection: () => void;
  openWorkspace: (path?: string) => void;
  closeWorkspace: () => void;
  togglePinned: (path: string) => void;
  /** 会话级置顶开关（ZCode task.pinned 语义；会话菜单 pin/unpin 用）。 */
  toggleSessionPinned: (
    path: string,
    sessionId: string,
    agentKey?: string,
  ) => void;
  removeFromRecent: (path: string) => void;
  setToolPaths: (paths: WorkspaceToolPaths) => void;
  /** 连接失败回填入口（realRuntime 调用；UI 据此渲染错误横幅与徽标）。 */
  reportConnectFailure: (path: string, message: string) => void;
  /** 清除某项目的连接失败态（连接成功 / 用户关闭横幅时调用）。 */
  dismissConnectError: (path: string) => void;
  /** 健康检查服务回填入口。 */
  applyHealthReport: (path: string, items: readonly HealthCheckItem[]) => void;
  /**
   * 异步执行健康检查（不阻塞 UI；runner 可注入，缺省 Tauri IPC）。
   * pathsOverride 供组件层把「设置里的路径」（chrys 可执行路径、由
   * skills 源目录推导的 aaw 脚本路径）合入本次执行，不落盘。
   */
  runHealthChecks: (
    runner?: ProcessRunner,
    pathsOverride?: Partial<WorkspaceToolPaths>,
  ) => Promise<void>;
  /** 从 localStorage 恢复持久化字段（测试与初始化用）。 */
  hydrateFromStorage: () => void;
}

// --------------------------------------------------------------- 持久化辅助

interface PersistedShape {
  readonly version: 1;
  readonly recent: readonly WorkspaceEntry[];
  readonly favorites: readonly string[];
  /** 可选新增（不升版本，见文件头）：会话级置顶键集合。 */
  readonly pinnedSessions?: readonly string[];
  readonly toolPaths: WorkspaceToolPaths;
}

function readPersisted(): Partial<PersistedShape> | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
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

function writePersisted(state: WorkspaceStoreState): void {
  try {
    const payload: PersistedShape = {
      version: 1,
      recent: state.recentWorkspaces,
      favorites: state.pinnedPaths,
      pinnedSessions: state.pinnedSessions,
      toolPaths: state.toolPaths,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
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

export const useWorkspaceStore = create<WorkspaceStoreState>((set, get) => ({
  recentWorkspaces: [],
  pinnedPaths: [],
  pinnedSessions: [],
  selectedPath: null,
  activePath: null,
  health: null,
  isCheckingHealth: false,
  toolPaths: defaultToolPaths,
  lastConnectError: null,

  selectWorkspace: (path) => {
    const trimmed = path.trim();
    if (trimmed === "") {
      return;
    }
    set((state) => ({
      selectedPath: trimmed,
      // 切换目录即清空旧目录的报告，防止跨目录串数据
      health: null,
      // 切到不同目录时复位 in-flight 标志：在途检查属于旧目录，其回填
      // 必被丢弃，若不复位按钮会永久禁用（新目录的检查发起后会再次置 true）
      ...(state.selectedPath !== trimmed ? { isCheckingHealth: false } : {}),
      recentWorkspaces: withRecentEntry(state.recentWorkspaces, trimmed),
    }));
    writePersisted(get());
    logger.info("已选择项目", { path: trimmed });
  },

  clearSelection: () => {
    set({
      selectedPath: null,
      health: null,
      // 在途结果将因 selectedPath=null 被丢弃，标志一并复位
      isCheckingHealth: false,
    });
  },

  openWorkspace: (path) => {
    const target = (path ?? get().selectedPath)?.trim();
    if (target === undefined || target === "") {
      return;
    }
    set((state) => ({
      activePath: target,
      selectedPath: target,
      recentWorkspaces: withRecentEntry(state.recentWorkspaces, target),
    }));
    writePersisted(get());
    logger.info("已打开项目（绑定 ACP session cwd）", { path: target });
  },

  closeWorkspace: () => {
    if (!guardMarkdownNavigation(() => get().closeWorkspace())) return;
    const closing = get().activePath;
    set({ activePath: null, lastConnectError: null });
    if (closing !== null) {
      logger.info("已关闭项目", { path: closing });
    }
  },

  reportConnectFailure: (path, message) => {
    set({ lastConnectError: { path, message } });
    logger.warn("连接失败已回填（UI 将展示错误横幅）", { path, message });
  },

  dismissConnectError: (path) => {
    const error = get().lastConnectError;
    if (error === null || error.path !== path) {
      return;
    }
    set({ lastConnectError: null });
  },

  togglePinned: (path) => {
    set((state) => ({
      pinnedPaths: state.pinnedPaths.includes(path)
        ? state.pinnedPaths.filter((item) => item !== path)
        : [...state.pinnedPaths, path],
    }));
    writePersisted(get());
  },

  // 会话级置顶（ZCode task.pinned）：新置顶插到最前（置顶任务带 = 最新
  // 置顶在前，与项目带按 lastOpenedAt 倒序的「新在前」同拍）
  toggleSessionPinned: (path, sessionId, agentKey) => {
    const key = sessionPinKey(path, sessionId, agentKey);
    set((state) => ({
      pinnedSessions: state.pinnedSessions.includes(key)
        ? state.pinnedSessions.filter((item) => item !== key)
        : [key, ...state.pinnedSessions],
    }));
    writePersisted(get());
  },

  removeFromRecent: (path) => {
    const pathPrefix = `${pathKey(path)}\u0000`;
    set((state) => ({
      recentWorkspaces: state.recentWorkspaces.filter(
        (entry) => entry.path !== path,
      ),
      pinnedPaths: state.pinnedPaths.filter((item) => item !== path),
      // 项目移出列表时其会话级置顶一并清掉：置顶任务带不渲染幽灵行
      //（项目不在列表里，行点了也只能落失败回滚）
      pinnedSessions: state.pinnedSessions.filter(
        (item) => !item.startsWith(pathPrefix),
      ),
      // 移除的正是当前选中目录时同步清空选择，避免详情区悬挂
      //（连带复位 in-flight 标志：在途回填将因选择清空被丢弃）
      ...(state.selectedPath === path
        ? { selectedPath: null, health: null, isCheckingHealth: false }
        : {}),
    }));
    writePersisted(get());
  },

  setToolPaths: (paths) => {
    set({ toolPaths: paths });
    writePersisted(get());
    logger.info("工具路径已更新", { ...paths });
  },

  applyHealthReport: (path, items) => {
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

  runHealthChecks: async (runner = defaultProcessRunner, pathsOverride) => {
    const { selectedPath, toolPaths } = get();
    if (selectedPath === null) {
      return;
    }
    set({ isCheckingHealth: true });
    try {
      const items = await runWorkspaceHealthChecks({
        workspacePath: selectedPath,
        toolPaths: { ...toolPaths, ...pathsOverride },
        runner,
      });
      get().applyHealthReport(selectedPath, items);
    } catch (error) {
      // 领域层不抛（执行失败落 CliRunResult），这里兜底意外异常并记日志；
      // 标志复位统一交给 finally
      logger.error("健康检查执行异常", {
        path: selectedPath,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // 过期回填（applyHealthReport 的丢弃分支）不复位标志：只有本次
      // 运行结束且当前仍选中该目录时才复位，防止标志卡在 true 把
      // 「重新检查」按钮永久禁用
      if (get().selectedPath === selectedPath) {
        set({ isCheckingHealth: false });
      }
    }
  },

  hydrateFromStorage: () => {
    const persisted = readPersisted();
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

// 模块加载即恢复最近打开 / 置顶 / 会话置顶 / 工具路径
useWorkspaceStore.getState().hydrateFromStorage();
