import type { ContentView } from "../../contracts/workbenchLayout.ts";
import type { ProjectService } from "../../contracts/project.ts";
import type { WorkbenchLayout } from "../../contracts/workbench.ts";
import { pathKey } from "../../shared/panelPaths.ts";
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
import type { SessionSummary } from "../../contracts/projectSessions.ts";
import { createLogger } from "../../shared/diagnosticEvents/logger.ts";

const logger = createLogger("app");

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
  project: Pick<
    ProjectService,
    "focusSession" | "openSession" | "enqueueSessionNavigation" | "workspace" | "foreground"
  >,
  layout: WorkbenchLayout,
  path: string,
  sessionId: string,
  agentKey: string | undefined,
  isCurrent: () => boolean,
  supersede: () => void,
): Promise<void> {
  if (!isCurrent()) return Promise.resolve();
  if (
    pathKey(layout.navigation.getState().contextPath ?? "") !==
      pathKey(path) &&
    layout.navigationGuard.pending()
  )
    return layout.navigationGuard.confirm().then((allowed) =>
      allowed
        ? openSessionFromEntry(
            project,
            layout,
            path,
            sessionId,
            agentKey,
            isCurrent,
            supersede,
          )
        : undefined,
    );
  const ui = layout.navigation.getState();
  // 回滚锚点：点击前的视图（失败时回到「没点过」的样子）
  const previousView: {
    readonly treeView: ContentView;
    readonly contextPath: string | null;
  } = { treeView: ui.treeView, contextPath: ui.contextPath };
  const { session } = project.foreground;
  const openingStore = session.getState();
  openingStore.beginOpenSession(sessionId);
  ui.openSessionView(path);

  if (project.focusSession(path, sessionId, agentKey)) {
    supersede();
    project.workspace.getState().openWorkspace(path);
    openingStore.endOpenSession(sessionId);
    if (session.getState().isConnecting) {
      session.getState().beginOpenSession(sessionId);
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

  return project.enqueueSessionNavigation(async (isLatest) => {
    const canFocus = () => isCurrent() && isLatest();
    try {
      if (!canFocus()) return;
      const workspace = project.workspace.getState();
      if (pathKey(workspace.activePath ?? "") !== pathKey(path))
        workspace.selectWorkspace(path);
      const opened = await project.openSession(path, {
        sessionId,
        shouldFocus: canFocus,
      });
      if (!canFocus()) return;
      if (opened !== null) {
        project.workspace.getState().openWorkspace(path);
        session.getState().openSession(sessionId);
      } else {
        layout.navigation.getState().restoreContextView(previousView);
      }
    } catch (error) {
      // 编排本身的意外错误：同样回滚，不让用户停在假会话视图里
      logger.warn("打开会话编排意外失败，已回滚视图", {
        path,
        sessionId,
        reason: error instanceof Error ? error.message : String(error),
      });
      if (canFocus())
        layout.navigation.getState().restoreContextView(previousView);
    } finally {
      if (isLatest()) openingStore.endOpenSession(sessionId);
    }
  }, undefined);
}
