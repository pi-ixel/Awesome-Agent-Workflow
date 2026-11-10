import type { AawNextPayload, AawPlanPayload, AawWorkflowStatus } from "./models.ts";
import type { AcpSessionEvent } from "../../acpRuntime/events.ts";
/**
 * AAW 工作流状态 store：`aaw status / next --json` 只读视图的唯一状态源。
 *
 * 数据流（与 architecture.md 的上行数据流一致）：
 *   数据源 loader（src/aaw/statusLoader.ts 的 CLI 封装，由组装层在
 *   选定工作区后注入）→ 领域解析器（src/aaw）→ 本 store → 面板组件按
 *   选择器渲染。
 *
 * 严格只读：本 store 的所有读取走 `next --peek` 语义（loader 契约由注入方
 * 保证），不提供任何推进 / 回退 / 放行类写操作。
 */
import { emptyWorkflowStatus } from "./snapshot.ts";
import type { WorkflowStatusValues } from "../types.ts";
import { createStore, type StoreApi } from "zustand";
import { createLogger } from "../../../shared/logging/logger.ts";
import type { AawStatusLoader } from "./statusLoader.ts";
import { AawQueryError } from "../cli/aawCli.ts";
import { parseCliError, parseNextPayload, parsePlanPayload, parseSrList, parseWorkflowStatus, type AawSrList } from "./workflowModel.ts";

/** loader 注入接口归 aaw 层所有（src/aaw/statusLoader.ts）；此处再导出
 * 供既有调用方（测试、组装层）按原路径引用。 */
export type { AawStatusLoader };


export interface AawStatusStoreState extends WorkflowStatusValues {
  loader: AawStatusLoader | null;
  /** 绑定 / 解绑数据源。 */
  bindLoader: (
    loader: AawStatusLoader | null,
    workspacePath?: string | null,
  ) => void;
  /** 切换当前跟踪的 SR（并立即刷新该 SR）。 */
  selectSr: (sr: string) => void;
  /** 手动刷新：srs 列表 + 当前 SR 的 status / next。 */
  refresh: () => Promise<void>;
  setAutoRefresh: (enabled: boolean) => void;
  /**
   * 会话事件入口：由会话层把 AcpSession 事件流接到这里，面板据此自动
   * 刷新（节流）。任何事件都可能意味着 agent 在推进工作流，统一节流
   * 而不细分类型。
   */
  handleSessionEvent: (event: AcpSessionEvent) => void;
  /** 清空全部状态（测试现场清理用）。 */
  reset: () => void;
}

/** 自动刷新的最小间隔（会话事件密集，尾随节流防止刷新风暴）。 */
const AUTO_REFRESH_MIN_INTERVAL_MS = 2_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeQueryFailure(source: string, error: unknown): string {
  // status / next 被同一个领域门禁拦住时只呈现一份完整原因。
  return error instanceof AawQueryError
    ? error.message
    : `${source} 读取失败：${errorMessage(error)}`;
}

function describeUnparsable(source: string, raw: unknown): string {
  const cliError = parseCliError(raw);
  if (cliError !== null) {
    return `${source}：${cliError.message}（${cliError.code}）`;
  }
  return `${source} 输出无法解析`;
}

export function createAawStatusStore(logger = createLogger("aaw")) {
  let active = true;
  // 节流与请求代际由工作流服务实例持有。
  let autoRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let lastAutoRefreshAt = 0;
  /** refresh 重入保护（手动刷新与自动刷新并发时只跑一份）。 */
  let refreshInFlight: number | null = null;
  let queryGeneration = 0;
  let boundWorkspace: string | null = null;

  /** 换项目、配置或 SR 后，旧请求不再允许落地，也不能释放新请求的锁。 */
  function invalidateQueries(): void {
    queryGeneration += 1;
    refreshInFlight = null;
    if (autoRefreshTimer !== null) clearTimeout(autoRefreshTimer);
    autoRefreshTimer = null;
    lastAutoRefreshAt = 0;
  }

  const store = createStore<AawStatusStoreState>((set, get) => {
    /** 节流自动刷新：首个事件立即触发，冷却期内的后续事件尾随补一次。 */
    function scheduleAutoRefresh(): void {
      if (autoRefreshTimer !== null) {
        return;
      }
      const elapsed = Date.now() - lastAutoRefreshAt;
      const wait = Math.max(0, AUTO_REFRESH_MIN_INTERVAL_MS - elapsed);
      if (wait === 0) {
        fireAutoRefresh();
        return;
      }
      autoRefreshTimer = setTimeout(() => {
        autoRefreshTimer = null;
        fireAutoRefresh();
      }, wait);
    }

    function fireAutoRefresh(): void {
      const state = get();
      if (
        !state.autoRefresh ||
        state.loader === null ||
        state.currentSr === null
      ) {
        return;
      }
      lastAutoRefreshAt = Date.now();
      logger.debug("会话事件触发自动刷新");
      void state.refresh();
    }

    /** 解析结果 → store（refresh 的唯一写入口）。 */
    function chooseSr(parsed: AawSrList): string | null {
      const { currentSr, srs: previous } = get();
      // 新出现的 SR 优先：会话中刚创建的 SR 就是「正在运行的需求」——陈旧
      // 的首个 SR（如早期演示数据）不应一直占着时间线。初次加载（旧列表为
      // 空）不算「新出现」，仍取首个，否则全部 SR 都会被当成新 SR
      const created =
        previous.length > 0
          ? parsed.srs.filter((sr) => !previous.includes(sr))
          : [];
      let next: string | null;
      if (created.length > 0) {
        next = created[created.length - 1] ?? null;
      } else if (currentSr !== null && parsed.srs.includes(currentSr)) {
        next = currentSr;
      } else {
        next = parsed.srs[0] ?? null;
      }
      return next;
    }

    return {
      ...emptyWorkflowStatus,
      loader: null,

      bindLoader: (loader, workspacePath = boundWorkspace) => {
        if (!active) return;
        invalidateQueries();
        const changedProject = workspacePath !== boundWorkspace;
        boundWorkspace = workspacePath;
        set({
          loader,
          hasSource: loader !== null,
          workspacePath,
          isLoading: false,
          lastError: null,
          ...(changedProject
            ? {
                srs: [],
                currentSr: null,
                status: null,
                next: null,
                plan: null,
                lastRefreshedAt: null,
              }
            : {}),
        });
        logger.info(loader === null ? "AAW 数据源已解绑" : "AAW 数据源已绑定");
      },

      selectSr: (sr) => {
        if (!active) return;
        if (get().currentSr === sr) {
          return;
        }
        invalidateQueries();
        set({
          currentSr: sr,
          status: null,
          next: null,
          plan: null,
          lastRefreshedAt: null,
        });
        void get().refresh();
      },

      refresh: async () => {
        if (!active) return;
        const { loader } = get();
        if (loader === null) {
          logger.debug("未绑定 AAW 数据源，跳过刷新");
          return;
        }
        if (refreshInFlight !== null) {
          return;
        }
        const generation = queryGeneration;
        refreshInFlight = generation;
        const isCurrent = (): boolean =>
          generation === queryGeneration && get().loader === loader;
        set({ isLoading: true, lastError: null });
        const errors: string[] = [];
        try {
          let parsedSrs: AawSrList | null = null;
          try {
            const rawSrs = await loader.listSrs();
            if (!isCurrent()) return;
            parsedSrs = parseSrList(rawSrs);
            if (parsedSrs === null) {
              errors.push(describeUnparsable("status", rawSrs));
            }
          } catch (error) {
            errors.push(describeQueryFailure("status", error));
          }
          if (!isCurrent()) return;
          if (parsedSrs === null) {
            set({ isLoading: false, lastError: errors.join("；") });
            return;
          }
          const sr = chooseSr(parsedSrs);
          // 列表成功即可用于选择 SR。详情失败不能把其他 SR 也锁在空下拉里；
          // 换 SR 时清空旧详情，同一 SR 刷新失败才保留之前的快照。
          set({
            srs: parsedSrs.srs,
            currentSr: sr,
            ...(sr !== get().currentSr
              ? { status: null, next: null, plan: null, lastRefreshedAt: null }
              : {}),
          });
          let status: AawWorkflowStatus | null = null;
          let next: AawNextPayload | null = null;
          let plan: AawPlanPayload | null = null;
          if (sr !== null) {
            const [statusResult, nextResult, planResult] =
              await Promise.allSettled([
                loader.readStatus(sr),
                loader.readNext(sr),
                loader.readPlan(sr),
              ]);
            if (!isCurrent()) return;
            if (statusResult.status === "fulfilled") {
              const parsed = parseWorkflowStatus(statusResult.value);
              if (parsed === null) {
                errors.push(
                  describeUnparsable(`status --sr ${sr}`, statusResult.value),
                );
              } else {
                status = parsed;
              }
            } else {
              errors.push(
                describeQueryFailure(`status --sr ${sr}`, statusResult.reason),
              );
            }
            if (nextResult.status === "fulfilled") {
              const parsed = parseNextPayload(nextResult.value);
              if (parsed === null) {
                errors.push(
                  describeUnparsable(`next --sr ${sr}`, nextResult.value),
                );
              } else {
                next = parsed;
              }
            } else {
              errors.push(
                describeQueryFailure(`next --sr ${sr}`, nextResult.reason),
              );
            }
            // plan 是完整图的增强来源：失败**静默降级**（老 CLI 没有该命令
            // 不是错误，按仅 status 的旧口径呈现，不进 lastError）
            if (planResult.status === "fulfilled") {
              const parsed = parsePlanPayload(planResult.value);
              if (parsed !== null) {
                plan = parsed;
              } else {
                logger.debug(`plan --sr ${sr} 输出不可解析，按旧口径呈现`);
              }
            } else {
              logger.debug(`plan --sr ${sr} 读取失败，按旧口径呈现`, {
                reason: errorMessage(planResult.reason),
              });
            }
          }
          if (!isCurrent()) return;
          // 同一 SR 的详情整轮成功后一起替换，避免不同刷新时刻的数据混用。
          set({
            isLoading: false,
            lastError:
              errors.length === 0 ? null : [...new Set(errors)].join("\n\n"),
            ...(errors.length === 0
              ? {
                  srs: parsedSrs.srs,
                  currentSr: sr,
                  status,
                  next,
                  plan,
                  lastRefreshedAt: new Date().toISOString(),
                }
              : {}),
          });
        } finally {
          if (refreshInFlight === generation) refreshInFlight = null;
        }
      },

      setAutoRefresh: (enabled) => {
        if (!active) return;
        set({ autoRefresh: enabled });
      },

      handleSessionEvent: () => {
        if (!active) return;
        // 事件内容本身不消费：任何会话活动都可能是工作流推进的信号，
        // 统一进入节流器决定是否刷新（签名见 AawStatusStoreState）。
        scheduleAutoRefresh();
      },

      reset: () => {
        if (!active) return;
        invalidateQueries();
        boundWorkspace = null;
        set({
          loader: null,
          hasSource: false,
          workspacePath: null,
          srs: [],
          currentSr: null,
          status: null,
          next: null,
          plan: null,
          isLoading: false,
          lastError: null,
          lastRefreshedAt: null,
        });
      },
    };
  });
  const setState: StoreApi<AawStatusStoreState>["setState"] = (state, replace) => {
    if (active) store.setState(state as AawStatusStoreState, replace as true);
  };
  return {
    ...store,
    setState,
    dispose() {
      if (!active) return;
      active = false;
      invalidateQueries();
      boundWorkspace = null;
      store.setState({ ...emptyWorkflowStatus, loader: null });
    },
  };
}
