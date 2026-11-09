import { openDesktopWorkspace as openRealWorkspace } from "../../runtime/mainRuntime.ts";
import {
  confirmMarkdownNavigation,
  dirtyMarkdownDocuments,
} from "../../stores/markdownDocumentStore.ts";
import { pathKey } from "../../core/panelPaths.ts";
/**
 * 「点会话自动重连」的共享入口（workbench 组装层）：
 * 项目树与会话视角（跨项目最近会话列表）共用同一条打开路径。
 *
 * **乐观 UI**：点击的瞬间内容区就切到会话视图（SessionView 的「正在
 * 连接 agent…」加载态就是即时回响）、目标行就高亮（openingSessionId）
 * ——连接与历史加载（可达数秒）在后台进行；加载成功才落
 * activeSessionId，失败回滚到点击前的视图（连接失败的详情走错误横幅
 * 通道）。绝不让人对着没反应的界面等。
 *
 * **串行队列**：连点两个会话时连接/聚焦编排按顺序落地，
 * 各会话执行互不阻塞，避免连接结果乱序覆盖当前聚焦。
 * 乐观反馈不排队（点击立即有响应），排队的只是连接编排。
 *
 * 另含会话视角的数据派生：把各项目的会话列表缓存（sessionsByPath）
 * 拍平为跨项目的「最近活跃会话」条目，按 updatedAt 降序（缺失时间
 * 视为最旧，排在末尾）。
 */
import { useSessionStore } from "../../stores/sessionStore.ts";
import type { SessionSummary } from "../../stores/sessionStore.ts";
import { useWorkspaceStore } from "../../stores/workspaceStore.ts";
import {
  useWorkbenchUiStore,
  type ContentView,
} from "../../stores/workbenchUiStore.ts";
import { focusDesktopSession as focusExistingSession } from "../../runtime/mainRuntime.ts";
import { createLogger } from "../../core/logger.ts";

const logger = createLogger("app");

/** 打开 / 新建会话共用的串行队列（sessionStart 也从这里过）。 */
let openQueue: Promise<void> = Promise.resolve();
let openGeneration = 0;

/** 把一次连接编排追加到队列尾部；前一次失败不阻塞后一次。 */
export function enqueueSessionOpen<T>(
  task: (isLatest: () => boolean) => Promise<T>,
): Promise<T> {
  const generation = ++openGeneration;
  const execute = (): Promise<T> => task(() => generation === openGeneration);
  const run = openQueue.then(execute, execute);
  openQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 测试专用：清空串行队列。队列是模块级状态，前一个用例遗留的挂起编排
 * （如永不完成的连接替身）不该拖死后续用例的打开流程。
 */
export function resetSessionOpenQueueForTests(): void {
  openQueue = Promise.resolve();
  openGeneration = 0;
}

/** 拍平后的一条最近会话：所属项目路径 + 会话摘要。 */
export interface SessionListEntry {
  readonly path: string;
  readonly session: SessionSummary;
}

/** 条目的排序时间戳：缺失或非法时间视为最旧（-∞，排末尾）。 */
function rankOf(updatedAt: string | null): number {
  if (updatedAt === null) {
    return Number.NEGATIVE_INFINITY;
  }
  const time = Date.parse(updatedAt);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/**
 * 把 sessionsByPath 拍平为跨项目的会话条目，按 updatedAt 降序。
 * 同一会话（路径 + id 相同）只保留一条。
 */
export function flattenRecentSessions(
  sessionsByPath: Readonly<Record<string, readonly SessionSummary[]>>,
): readonly SessionListEntry[] {
  const seen = new Set<string>();
  const entries: SessionListEntry[] = [];
  for (const [path, sessions] of Object.entries(sessionsByPath)) {
    for (const session of sessions) {
      const key = `${pathKey(path)}\u0000${session.id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      entries.push({ path, session });
    }
  }
  return entries.sort(
    (a, b) => rankOf(b.session.updatedAt) - rankOf(a.session.updatedAt),
  );
}

/**
 * 打开一个历史会话（项目树 / 会话视角共用的唯一入口）：点击瞬间切视图
 * + 高亮目标行（乐观），连接与加载在后台串行队列里走完；成功落聚焦，
 * 失败回滚视图（错误横幅 / 日志承接原因）。
 */
export function openSessionFromEntry(
  path: string,
  sessionId: string,
  agentKey?: string,
): Promise<void> {
  if (
    pathKey(useWorkbenchUiStore.getState().contextPath ?? "") !==
      pathKey(path) &&
    dirtyMarkdownDocuments().length
  )
    return confirmMarkdownNavigation().then((allowed) =>
      allowed ? openSessionFromEntry(path, sessionId, agentKey) : undefined,
    );
  const ui = useWorkbenchUiStore.getState();
  // 回滚锚点：点击前的视图（失败时回到「没点过」的样子）
  const previousView: {
    readonly treeView: ContentView;
    readonly contextPath: string | null;
  } = { treeView: ui.treeView, contextPath: ui.contextPath };
  const openingStore = useSessionStore.getState();
  openingStore.beginOpenSession(sessionId);
  ui.openSessionView(path);

  if (focusExistingSession(path, sessionId, agentKey)) {
    ++openGeneration;
    useWorkspaceStore.getState().openWorkspace(path);
    openingStore.endOpenSession(sessionId);
    if (useSessionStore.getState().isConnecting) {
      useSessionStore.getState().beginOpenSession(sessionId);
    }
    return Promise.resolve();
  }

  // Explicit-owner notifications may only focus their retained runtime. Never
  // reopen a same-ID session using the currently selected, unrelated Agent.
  if (agentKey !== undefined) {
    openingStore.endOpenSession(sessionId);
    ui.restoreContextView(previousView);
    return Promise.reject(
      new Error("通知所属 Agent 会话已关闭，请切换到该 Agent 后重新打开"),
    );
  }

  return enqueueSessionOpen(async (isLatest) => {
    try {
      if (!isLatest()) return;
      const workspace = useWorkspaceStore.getState();
      if (pathKey(workspace.activePath ?? "") !== pathKey(path))
        workspace.selectWorkspace(path);
      const opened = await openRealWorkspace(path, {
        sessionId,
        shouldFocus: isLatest,
      });
      if (!isLatest()) return;
      if (opened !== null) {
        useWorkspaceStore.getState().openWorkspace(path);
        useSessionStore.getState().openSession(sessionId);
      } else {
        useWorkbenchUiStore.getState().restoreContextView(previousView);
      }
    } catch (error) {
      // 编排本身的意外错误：同样回滚，不让用户停在假会话视图里
      logger.warn("打开会话编排意外失败，已回滚视图", {
        path,
        sessionId,
        reason: error instanceof Error ? error.message : String(error),
      });
      if (isLatest())
        useWorkbenchUiStore.getState().restoreContextView(previousView);
    } finally {
      openingStore.endOpenSession(sessionId);
    }
  });
}
