/**
 * 工作区 store：工作区选择、最近打开与收藏（本地持久化）、健康检查，
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
 * - recent / favorites / toolPaths 持久化到 localStorage，模块加载即恢复。
 */
import { create } from "zustand";

import { createLogger } from "../core/logger.ts";
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
  favoritePaths: readonly string[];
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
  toggleFavorite: (path: string) => void;
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
  if (typeof record["toolPaths"] === "object" && record["toolPaths"] !== null) {
    const paths = record["toolPaths"] as Record<string, unknown>;
    out.toolPaths = {
      // 持久化里的裸 "chrys" 是旧版缺省值（整包 toolPaths 落盘时被顺带写
      // 入）：iCode 0.30 起命令改名 icode，按未配置处理回落新缺省；用户显
      // 式写过的绝对路径或其他命令名原样保留
      chrysCommand:
        typeof paths["chrysCommand"] === "string" &&
        paths["chrysCommand"] !== "chrys"
          ? paths["chrysCommand"]
          : defaultToolPaths.chrysCommand,
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
      favorites: state.favoritePaths,
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
  favoritePaths: [],
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

  toggleFavorite: (path) => {
    set((state) => ({
      favoritePaths: state.favoritePaths.includes(path)
        ? state.favoritePaths.filter((item) => item !== path)
        : [...state.favoritePaths, path],
    }));
    writePersisted(get());
  },

  removeFromRecent: (path) => {
    set((state) => ({
      recentWorkspaces: state.recentWorkspaces.filter(
        (entry) => entry.path !== path,
      ),
      favoritePaths: state.favoritePaths.filter((item) => item !== path),
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
      favoritePaths: persisted.favorites ?? state.favoritePaths,
      toolPaths: persisted.toolPaths ?? state.toolPaths,
    }));
  },
}));

// 模块加载即恢复最近打开 / 收藏 / 工具路径
useWorkspaceStore.getState().hydrateFromStorage();
