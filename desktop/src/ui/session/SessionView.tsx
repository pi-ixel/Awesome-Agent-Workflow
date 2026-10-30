import { useConnectionIntro } from "./useConnectionIntro.ts";
/**
 * 会话视图：上下文条 + 中央聊天流 + 悬浮输入区（项目右栏由外层工作台持有）。
 *
 * - 顶部：上下文条（ContextBar：会话标题 / 项目名 / 连接徽标 / SR 快捷
 *   / 关闭会话，模型与审批模式元信息移至输入区下行）；
 * - 中部：消息流（用户 / 助手 / 思考 / 工具卡 / 系统提示）——**窗口化
 *   渲染**：只挂最近 WINDOW_CHUNK 条，滚动到顶按块向前补载（锚定补载：
 *   前插不把视口顶飞）；**跟随状态机**（移植 ZCode timelineScrollAnchor，
 *   见 timelineScrollAnchor.ts）：following 只由真实用户滚动输入改变，
 *   贴底时新内容自动滚入，用户上翻即解除跟随并浮出「回到底部」按钮，
 *   回底即恢复——长会话回看与追新互不打架；
 * - 底部：ChatInput（Enter 发送，运行中变圆形「停止」钮；↑/↓ 历史、
 *   @ 文件提及、预填通道见其文件头）；
 * - 空会话：问候 hero 与输入区作为一组垂直居中（ZCode 式空态），常用
 *   入口 chips 移到输入框下方（点击预填输入框，过目后自己发送）；首条
 *   消息落地即回落贴底布局，composer 节点全程不重挂；
 * - 时间线 / 消息流 / AAW 面板各自挂局部错误边界：单块崩不白屏全局。
 *
 * 组件只订阅 sessionStore 的选择器；数据折叠全部在 store 层完成。
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useSessionStore,
  type SessionItem,
  type SessionSummary,
} from "../../stores/sessionStore.ts";
import { useApprovalStore } from "../../stores/approvalStore.ts";
import { useWorkspaceStore } from "../../stores/workspaceStore.ts";
import { useWorkbenchUiStore } from "../../stores/workbenchUiStore.ts";
import { openSettingsOverlayTab } from "../SettingsPage.tsx";
import { useAawStatusStore } from "../../stores/aawStatusStore.ts";
import {
  chatWidthClassOf,
  chatWidthOptions,
  useSettingsStore,
} from "../../stores/settingsStore.ts";
import { btnPrimary } from "../controls.tsx";
import { ScopedErrorBoundary } from "../ErrorBoundary.tsx";
import {
  ArrowDownIcon,
  ChevronRightIcon,
  SparkleIcon,
  WidthFullIcon,
  WidthStandardIcon,
  WidthWideIcon,
  XIcon,
} from "../icons.tsx";
import { AssistantMessage } from "./AssistantMessage.tsx";
import { ChatInput } from "./ChatInput.tsx";
import { PlanCard } from "./PlanCard.tsx";
import { QuestionDock } from "./QuestionDock.tsx";
import { QueueDock } from "./QueueDock.tsx";
import { SessionDock } from "./SessionDock.tsx";
import { TurnStatusRow } from "./InputStatusBar.tsx";
import { BrandLoading } from "../BrandLoading.tsx";
import { openRealWorkspace } from "../realRuntime.ts";
import { AawTimeline } from "../workbench/timeline/AawTimeline.tsx";
import { prefillComposer } from "./composerPrefill.ts";
import { SystemNotice } from "./SystemNotice.tsx";
import { ThoughtBlock } from "./ThoughtBlock.tsx";
import { ToolCallCard } from "./ToolCallCard.tsx";
import { conversationTurns } from "./conversationTurns.ts";
import { openSessionFromEntry } from "../workbench/sessionEntry.ts";
import { ConversationTurnView } from "./ConversationTurnView.tsx";
import { ExpansionScopeProvider } from "./expansionState.tsx";
import {
  shouldLoadOlder,
  FIRST_MOUNT_TURNS,
  MOUNT_STEP,
  WINDOW_CHUNK,
} from "./sessionWindow.ts";
import {
  anchorActionAfterContentChange,
  initialFollowing,
  reconcileFollowingForContentAnchor,
  resolveFollowingAfterScroll,
  timelineKeyboardScrollIntent,
  timelineTouchScrollIntent,
  timelineWheelScrollIntent,
  type TimelineUserScrollIntent,
} from "./timelineScrollAnchor.ts";
import { UserMessage } from "./UserMessage.tsx";
import { SessionStatusOverlay } from "./SessionStatusOverlay.tsx";
import { ConversationNavigator } from "./ConversationNavigator.tsx";
import {
  activeQueryAt,
  createQueryNavigationBuilder,
  type QueryNavigationItem,
} from "./conversationNavigation.ts";

/** 用户滚动意图的有效期：过期后的 scroll 事件不再当作用户输入（ZCode 同值）。 */
const USER_SCROLL_INTENT_TTL_MS = 1200;
/** 布局补偿 guard：窗口内的 scroll 事件视为布局/程序产生，不改跟随态（ZCode 同值）。 */
const LAYOUT_SCROLL_GUARD_MS = 250;

/** memo：条目对象引用不变即跳过——流式 chunk 只改末尾条目，历史条目
 * 的分发开销也省掉。 */
const SessionItemView = memo(function SessionItemView({
  item,
}: {
  readonly item: SessionItem;
}) {
  switch (item.kind) {
    case "user":
      return <UserMessage item={item} />;
    case "assistant":
      return <AssistantMessage item={item} />;
    case "thought":
      return <ThoughtBlock item={item} />;
    case "tool":
      return <ToolCallCard item={item} />;
    case "plan":
      return <PlanCard item={item} />;
    case "system":
      return <SystemNotice item={item} />;
  }
});

/** 模块级稳定引用：传入 memo 化的 ConversationTurnView 不因每次渲染
 * 的新箭头函数而击穿 memo。 */
const renderSessionItem = (item: SessionItem): React.JSX.Element => (
  <SessionItemView item={item} />
);

/** 模型 a 的引导空态：项目已连接但未打开任何会话时，列出最近会话供
 * 一键返回（快照先行秒开）。最多 8 条，更多走左侧树。 */
function ProjectSessionQuickList({
  path,
  sessions,
}: {
  readonly path: string;
  readonly sessions: readonly SessionSummary[];
}) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-1 py-10">
      <p className="pb-2 text-center text-sm text-ink-mute">继续该项目的工作</p>
      {sessions.slice(0, 8).map((session) => (
        <button
          key={session.id}
          type="button"
          onClick={() => {
            void openSessionFromEntry(path, session.id);
          }}
          className="group flex items-center gap-2 rounded-lg px-3 py-2 text-left text-ui-base text-ink-soft transition-colors hover:bg-surface-hover hover:text-ink"
        >
          <span className="min-w-0 flex-1 truncate">{session.title}</span>
          <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-ink-ghost transition-colors group-hover:text-ink-soft" />
        </button>
      ))}
      {sessions.length > 8 ? (
        <p className="pt-2 text-center text-xs text-ink-ghost">
          更多会话见左侧列表
        </p>
      ) : null}
    </div>
  );
}

/** 时段问候（hero 主标题的一部分；测试以系统时间驱动）。 */
function greetingOfHour(hour: number): string {
  if (hour < 5) {
    return "夜深了";
  }
  if (hour < 9) {
    return "早上好";
  }
  if (hour < 12) {
    return "上午好";
  }
  if (hour < 14) {
    return "中午好";
  }
  if (hour < 18) {
    return "下午好";
  }
  return "晚上好";
}

/** 空会话的 hero（借 ZCode 的空态设计语言）：时段问候 + 一句主旨。
 * 入口 chips 不在这里——它们跟随输入区渲染（见 DraftPromptChips）。 */
function EmptyPrompts() {
  return (
    <div className="flex flex-col items-center gap-4 pb-2 pt-1 text-center">
      <p
        aria-hidden={true}
        className="flex items-center gap-1.5 text-2xs tracking-widest text-ink-faint"
      >
        <SparkleIcon className="h-3.5 w-3.5" />
        AAW
      </p>
      <h2 className="text-lg font-medium text-ink">
        {greetingOfHour(new Date().getHours())}，今天想推进什么？
      </h2>
    </div>
  );
}

/** 空态常用入口 chips：渲染在居中输入区下方（ZCode 式空态的呈现顺序：
 * 问候 → 输入框 → chips）。点击预填输入框，过目可改，再自己发送。 */
function DraftPromptChips({
  currentSr,
  widthClass,
}: {
  readonly currentSr: string | null;
  readonly widthClass: string;
}) {
  const prompts =
    currentSr !== null
      ? [
          {
            label: `汇报 ${currentSr} 进度`,
            text: `请汇报 ${currentSr} 工作流的当前进度与下一步安排。`,
          },
          { label: "介绍这个项目", text: "请介绍当前项目的结构与主要功能。" },
          {
            label: "梳理可继续的事项",
            text: "请根据当前项目状态，梳理可以继续推进的事项。",
          },
        ]
      : [
          {
            label: "启动一条工作流",
            text: "请从 sr 入口新建一条 AAW 工作流，先与我确认需求。",
          },
          { label: "介绍这个项目", text: "请介绍当前项目的结构与主要功能。" },
          {
            label: "梳理可继续的事项",
            text: "请根据当前项目状态，梳理可以继续推进的事项。",
          },
        ];
  return (
    <div
      className={`mx-auto flex w-full flex-wrap items-center justify-center gap-2 ${widthClass}`}
    >
      {prompts.map((prompt, index) => (
        <button
          key={prompt.label}
          type="button"
          style={{ animationDelay: `${index * 60}ms` }}
          onClick={() => {
            prefillComposer(prompt.text);
          }}
          className="chip-in lift press rounded-full border border-line-strong bg-surface px-3.5 py-1.5 text-xs text-ink-mute shadow-elev-1 hover:border-ink-faint hover:text-ink"
        >
          {prompt.label}
        </button>
      ))}
    </div>
  );
}

export function SessionView() {
  const items = useSessionStore((state) => state.items);
  const sessionsByPath = useSessionStore((state) => state.sessionsByPath);
  const isAgentRunning = useSessionStore((state) => state.isAgentRunning);
  const turnState = useSessionStore((state) => state.turnState);
  const showPlans = useSettingsStore((state) => state.messageStreamShowTodos);
  const sendPrompt = useSessionStore((state) => state.sendPrompt);
  const enqueuePrompt = useSessionStore((state) => state.enqueuePrompt);
  const requestCancel = useSessionStore((state) => state.requestCancel);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const openingSessionId = useSessionStore((state) => state.openingSessionId);
  // 挂起计数：有挂起的审批/提问时不再展示「会话为空」空态，
  // 否则与「会话中」标签及弹出的审批模态自相矛盾（04-approval 评审项）。
  const pendingCount = useApprovalStore((state) => state.pending.length);
  const isConnecting = useSessionStore((state) => state.isConnecting);
  const agentCrashed = useSessionStore((state) => state.agentCrashed);
  const turnError = useSessionStore((state) => state.turnError);
  const clearTurnError = useSessionStore((state) => state.clearTurnError);
  const retryLastPrompt = useSessionStore((state) => state.retryLastPrompt);
  const activePath = useWorkspaceStore((state) => state.activePath);
  // 项目已关闭（activePath 落空）时的空态改为「重新打开项目」入口
  const openWorkspace = useWorkspaceStore((state) => state.openWorkspace);
  const contextPath = useWorkbenchUiStore((state) => state.contextPath);
  const currentSr = useAawStatusStore((state) => state.currentSr);
  // ZCode 式空态居中：无消息且无挂起审批/提问时，问候与输入区作为一组
  // 垂直居中；首条消息落地（items.length > 0）即回落贴底布局——composer
  // 始终在 footer 槽位同一位置渲染，只改外层容器类，不重挂。
  const connectionPending = isConnecting || openingSessionId !== null;
  const introActive = useConnectionIntro(connectionPending, sendPrompt);
  const showConnectionIntro =
    introActive &&
    (connectionPending || (agentCrashed === null && turnError === null));
  const isCenteredEmpty =
    showConnectionIntro || (items.length === 0 && pendingCount === 0);
  // chips 只跟随「可发首条消息」的空态：连接中与项目已关闭不显示
  const showDraftChips =
    isCenteredEmpty &&
    !connectionPending &&
    !showConnectionIntro &&
    !(activePath === null && contextPath !== null);
  // 内容宽度档：消息流 / 输入卡 / 停靠坞共用（对齐），就地三档循环
  const chatWidth = useSettingsStore((state) => state.chatWidth);
  const setChatWidth = useSettingsStore((state) => state.setChatWidth);
  const widthClass = chatWidthClassOf(chatWidth);
  const nextWidth =
    chatWidthOptions[
      (chatWidthOptions.findIndex((o) => o.value === chatWidth) + 1) %
        chatWidthOptions.length
    ]?.value ?? "standard";

  // ---- 消息流窗口化 + 跟随状态机 ----
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const messageColumnRef = useRef<HTMLDivElement | null>(null);
  const navigationPausedRef = useRef(false);
  const jumpTargetRef = useRef<string | null>(null);
  const [jumpRevision, setJumpRevision] = useState(0);
  const [activeQueryId, setActiveQueryId] = useState<string | null>(null);
  const footerRef = useRef<HTMLDivElement | null>(null);
  // 消息流的原生滚动条占位也同步给底部，标准/宽/全宽均沿同一边界居中。
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const footer = footerRef.current;
    if (!scroll || !footer) return;
    const align = (): void => {
      footer.style.paddingRight = `${scroll.offsetWidth - scroll.clientWidth}px`;
    };
    align();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(align);
    observer?.observe(scroll);
    return () => observer?.disconnect();
  }, []);
  const [visibleCount, setVisibleCount] = useState(WINDOW_CHUNK);
  // 渐进上屏：首帧只挂尾部少量回合（视口在底部），其余用 rAF 分批补完。
  // 首次加载的 reconcile 从「150 条一帧做完」变成「头部立刻可见，后台追赶」。
  const [mountedTurnCount, setMountedTurnCount] = useState(FIRST_MOUNT_TURNS);
  // following 只由真实用户滚动输入改变（ZCode timelineScrollAnchor 语义）：
  // ref 是同步权威值——capture handler 与内容 commit 的 layout effect 在
  // state 落定之前就要读写；state 只驱动「回到底部」按钮的呈现。
  const [isFollowing, setIsFollowing] = useState(initialFollowing());
  const followingRef = useRef(initialFollowing());
  const commitFollowing = useCallback((following: boolean): void => {
    if (followingRef.current === following) return;
    followingRef.current = following;
    setIsFollowing(following);
  }, []);
  const lastLengthRef = useRef(0);
  // 用户滚动意图：wheel/touch/键盘在 scroll 事件派发之前登记（含有效期），
  // 内容 commit 贴底前先对账，避免「过期 following=true 吃掉用户上滚」。
  const userScrollIntentRef = useRef<{
    intent: TimelineUserScrollIntent;
    observedAt: number;
  }>({ intent: "none", observedAt: 0 });
  const touchClientYRef = useRef<number | null>(null);
  const scrollbarPointerIdRef = useRef<number | null>(null);
  const lastObservedScrollTopRef = useRef(0);
  const programmaticScrollFrameRef = useRef<number | null>(null);
  const layoutScrollGuardUntilRef = useRef(0);
  // 前插锚：补载 / 渐进挂载批之前的「scrollHeight - scrollTop」，渲染后按它
  // 平移 scrollTop（前插不顶飞视口；跟随中值为 0 → 即贴底）。
  const prependAnchorRef = useRef<number | null>(null);
  // 最近一次已账目的可见布局：折叠思考/工具的分片也更新 items 但不改可见
  // 高度——布局未变时不重复写 scrollTop，不打断贴底阈值内的阅读位置。
  const lastAnchorLayoutRef = useRef<{
    height: number;
    viewport: number;
  } | null>(null);
  const markProgrammaticScroll = useCallback((): void => {
    if (programmaticScrollFrameRef.current !== null) {
      cancelAnimationFrame(programmaticScrollFrameRef.current);
    }
    programmaticScrollFrameRef.current = requestAnimationFrame(() => {
      programmaticScrollFrameRef.current = null;
    });
  }, []);
  const markLayoutScrollGuard = useCallback((): void => {
    layoutScrollGuardUntilRef.current = Date.now() + LAYOUT_SCROLL_GUARD_MS;
  }, []);
  const clearUserScrollIntent = useCallback((): void => {
    userScrollIntentRef.current = { intent: "none", observedAt: 0 };
    touchClientYRef.current = null;
    scrollbarPointerIdRef.current = null;
  }, []);
  const getActiveUserScrollIntent =
    useCallback((): TimelineUserScrollIntent => {
      const current = userScrollIntentRef.current;
      const interactionActive =
        touchClientYRef.current !== null ||
        scrollbarPointerIdRef.current !== null;
      if (interactionActive) {
        return current.intent === "none" ? "unknown" : current.intent;
      }
      return Date.now() - current.observedAt <= USER_SCROLL_INTENT_TTL_MS
        ? current.intent
        : "none";
    }, []);
  const markUserScrollIntent = useCallback(
    (intent: TimelineUserScrollIntent): void => {
      if (intent === "none") return;
      userScrollIntentRef.current = { intent, observedAt: Date.now() };
      // 上滚必须在 scroll 事件之前先拿走滚动权：否则随后的内容 commit
      // （流式 delta / 补载 / 渐进挂载）会拿过期的 following=true 把用户拽回。
      if (intent === "awayFromBottom") {
        const element = scrollRef.current;
        if (element && element.scrollHeight > element.clientHeight) {
          commitFollowing(false);
        }
      }
    },
    [commitFollowing],
  );
  const visibleTurns = useMemo(
    () =>
      conversationTurns(
        items,
        visibleCount,
        isAgentRunning,
        turnState,
        showPlans,
      ),
    [items, visibleCount, isAgentRunning, turnState, showPlans],
  );

  // 渐进上屏追赶循环：每帧多挂一批回合，直到窗口内全部就绪。流式新回合
  // 到来时 slice(-n) 先短暂让最早的回合退场，下一帧即追回（叶子卡片 memo，
  // 重挂成本可忽略）。挂载批会让内容在顶部撑高——rAF 里先记「距底锚」，
  // 渲染后按它平移 scrollTop：跟随中即贴底，阅读中视口钉在原内容上。
  useEffect(() => {
    if (mountedTurnCount >= visibleTurns.length) {
      return;
    }
    const handle = requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (element !== null && prependAnchorRef.current === null) {
        prependAnchorRef.current = element.scrollHeight - element.scrollTop;
      }
      setMountedTurnCount((count) =>
        Math.min(count + MOUNT_STEP, visibleTurns.length),
      );
    });
    return () => cancelAnimationFrame(handle);
  }, [mountedTurnCount, visibleTurns.length]);
  const fullyMounted = mountedTurnCount >= visibleTurns.length;
  const mountedTurns = fullyMounted
    ? visibleTurns
    : visibleTurns.slice(-mountedTurnCount);

  // 项目或会话变化时创建新目录，避免同名或复用条目引用跨会话串缓存。
  const queryBuilder = useMemo(
    () => createQueryNavigationBuilder(),
    // 缓存必须随会话范围失效，依赖用于隔离而非工厂计算。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSessionId, contextPath],
  );
  const queries = useMemo(
    () => queryBuilder.build(items, isAgentRunning),
    [queryBuilder, items, isAgentRunning],
  );
  // 只让内部内容列留位，主滚动视口始终延伸到悬浮卡右边。
  const columnInsetClass = `pr-[var(--session-card-inset,0px)] ${queries.length >= 2 ? "@min-[864px]/conversation:pl-7" : ""}`;
  const syncActiveQuery = useCallback((): void => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const positions = Array.from(
      scroll.querySelectorAll<HTMLElement>("[data-query-id]"),
    ).map((node) => ({ id: node.dataset.queryId ?? "", top: node.offsetTop }));
    setActiveQueryId(
      activeQueryAt(
        queries,
        positions,
        scroll.scrollTop,
        Math.max(0, items.length - visibleCount),
      ),
    );
  }, [queries, items.length, visibleCount]);
  const scope = JSON.stringify([activeSessionId, contextPath]);
  const [viewScope, setViewScope] = useState(scope);
  if (viewScope !== scope) {
    setViewScope(scope);
    setVisibleCount(WINDOW_CHUNK);
    setMountedTurnCount(FIRST_MOUNT_TURNS);
    setIsFollowing(true);
  }
  useLayoutEffect(() => {
    navigationPausedRef.current = false;
    followingRef.current = initialFollowing();
    clearUserScrollIntent();
    prependAnchorRef.current = null;
    lastAnchorLayoutRef.current = null;
    lastLengthRef.current = 0;
    lastObservedScrollTopRef.current = scrollRef.current?.scrollTop ?? 0;
    layoutScrollGuardUntilRef.current = 0;
    programmaticScrollFrameRef.current = null;
    jumpTargetRef.current = null;
  }, [scope, clearUserScrollIntent]);
  useLayoutEffect(() => {
    syncActiveQuery();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(syncActiveQuery);
    if (messageColumnRef.current) observer?.observe(messageColumnRef.current);
    return () => observer?.disconnect();
  }, [syncActiveQuery, visibleTurns]);
  const jumpToQuery = (query: QueryNavigationItem): void => {
    navigationPausedRef.current = true;
    prependAnchorRef.current = null;
    clearUserScrollIntent();
    commitFollowing(false);
    setVisibleCount((count) => Math.max(count, items.length - query.itemIndex));
    // 导航是用户点名要看的位置：立即全量挂载，不做渐进追赶
    setMountedTurnCount(Number.MAX_SAFE_INTEGER);
    jumpTargetRef.current = query.id;
    setJumpRevision((revision) => revision + 1);
  };
  useLayoutEffect(() => {
    const jumpTarget = jumpTargetRef.current;
    if (!jumpTarget) return;
    const scroll = scrollRef.current;
    const node = Array.from(
      scroll?.querySelectorAll<HTMLElement>("[data-query-id]") ?? [],
    ).find((element) => element.dataset.queryId === jumpTarget);
    if (scroll && node) {
      const top = Math.max(0, node.offsetTop - 20);
      const reduced = window.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      markProgrammaticScroll();
      if (typeof scroll.scrollTo === "function")
        scroll.scrollTo({ top, behavior: reduced ? "auto" : "smooth" });
      else scroll.scrollTop = top;
      lastObservedScrollTopRef.current = scroll.scrollTop;
      setActiveQueryId(jumpTarget);
    }
    jumpTargetRef.current = null;
  }, [jumpRevision, visibleCount, markProgrammaticScroll]);

  // ---- Esc 全局停止：agent 运行中按 Esc 直接取消当前轮 ----
  // 让位规则（不误停）：IME 组词中；mention 面板 / 审批弹窗 / 提问面板 /
  // 关闭确认 / 项目添加浮层 / 覆盖页 / 时间线抽屉打开时——前四者各自
  // preventDefault 消费掉 Esc，这里按 defaultPrevented 让位；后三者按
  // 状态判断让位。按下的目标在输入框内（含正在编辑的草稿）也照停——
  // 「运行中一律停止」是评审确认的行为。
  useEffect(() => {
    if (!isAgentRunning) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing
      ) {
        return;
      }
      if (useApprovalStore.getState().pending.length > 0) {
        return;
      }
      const ui = useWorkbenchUiStore.getState();
      if (ui.overlay !== null || !ui.isTimelineCollapsed) {
        return;
      }
      event.preventDefault();
      requestCancel();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isAgentRunning, requestCancel]);

  // 内容变化统一锚定（ZCode ConversationTimeline 同款）：条目追加、补载
  // 前插、渐进挂载批都汇到这里——
  // 1) 会话清空 / 切换：窗口与跟随态复位；
  // 2) 阅读旧消息时固定窗口起点，新增条目不能把正在看的历史从窗口头部挤掉；
  // 3) 贴底前先对账用户滚动意图：同帧的上滚（scroll 事件尚未派发）不得被
  //    过期的 following=true 吃掉；
  // 4) 有前插锚（补载 / 渐进挂载批在顶部撑高）→ 按锚平移 scrollTop：跟随中
  //    锚为 0 → 即贴底，阅读中视口钉在原内容上；无锚且跟随中（底部追加、
  //    流式 delta）→ 贴底；未跟随 → 保持阅读位置，绝不拉回。
  useLayoutEffect(() => {
    const previous = lastLengthRef.current;
    lastLengthRef.current = items.length;
    if (items.length < previous) {
      setVisibleCount(WINDOW_CHUNK);
      setMountedTurnCount(FIRST_MOUNT_TURNS);
      followingRef.current = initialFollowing();
      setIsFollowing(true);
      lastAnchorLayoutRef.current = null;
      return;
    }
    if (items.length > previous && !followingRef.current) {
      setVisibleCount((count) =>
        Math.min(items.length, count + items.length - previous),
      );
    }
    const element = scrollRef.current;
    if (element === null) {
      return;
    }
    markLayoutScrollGuard();
    const previousFollowing = followingRef.current;
    commitFollowing(
      reconcileFollowingForContentAnchor({
        following: followingRef.current,
        metrics: {
          scrollTop: element.scrollTop,
          viewportHeight: element.clientHeight,
          contentHeight: element.scrollHeight,
        },
        lastObservedScrollTop: lastObservedScrollTopRef.current,
        userScrollIntent: getActiveUserScrollIntent(),
      }),
    );
    const layoutChanged =
      lastAnchorLayoutRef.current?.height !== element.scrollHeight ||
      lastAnchorLayoutRef.current?.viewport !== element.clientHeight;
    lastAnchorLayoutRef.current = {
      height: element.scrollHeight,
      viewport: element.clientHeight,
    };
    const anchor = prependAnchorRef.current;
    if (anchor !== null) {
      prependAnchorRef.current = null;
      markProgrammaticScroll();
      element.scrollTop = element.scrollHeight - anchor;
      lastObservedScrollTopRef.current = element.scrollTop;
    } else if (
      anchorActionAfterContentChange(followingRef.current) ===
        "stickToBottom" &&
      (layoutChanged || !previousFollowing)
    ) {
      markProgrammaticScroll();
      element.scrollTop = element.scrollHeight;
      lastObservedScrollTopRef.current = element.scrollTop;
    }
  }, [
    items,
    visibleCount,
    mountedTurnCount,
    markLayoutScrollGuard,
    markProgrammaticScroll,
    commitFollowing,
    getActiveUserScrollIntent,
  ]);

  // 视口高度变化（停靠坞出现、输入区长高、窗口缩放）：跟随中重新贴底，
  // 未跟随不动。内容撑高不经这里——它由上面的内容锚定 effect 处理。
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null || typeof ResizeObserver === "undefined") {
      return;
    }
    let lastViewport = element.clientHeight;
    const observer = new ResizeObserver(() => {
      if (element.clientHeight === lastViewport) return;
      lastViewport = element.clientHeight;
      markLayoutScrollGuard();
      if (!followingRef.current) return;
      markProgrammaticScroll();
      element.scrollTop = element.scrollHeight;
      lastObservedScrollTopRef.current = element.scrollTop;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [markLayoutScrollGuard, markProgrammaticScroll]);

  const handleScroll = (): void => {
    const element = scrollRef.current;
    if (element === null) {
      return;
    }
    syncActiveQuery();
    // 导航动画期间（刻度跳转的平滑滚动）不裁决跟随；只有用户主动滚动或
    // 回到底部才恢复。
    if (navigationPausedRef.current) {
      lastObservedScrollTopRef.current = element.scrollTop;
      return;
    }
    const programmaticScroll =
      programmaticScrollFrameRef.current !== null &&
      Math.abs(element.scrollTop - lastObservedScrollTopRef.current) < 1;
    const userScrollIntent = getActiveUserScrollIntent();
    // 用户输入优先；其余 scroll 若落在内容/布局 guard 内视为布局补偿，
    // guard 外的未分类事件继续按真实用户滚动处理（兼容原生滚动条）。
    const scrollSource =
      userScrollIntent !== "none"
        ? "user"
        : programmaticScroll
          ? "programmatic"
          : Date.now() <= layoutScrollGuardUntilRef.current
            ? "layout"
            : "user";
    lastObservedScrollTopRef.current = element.scrollTop;
    commitFollowing(
      resolveFollowingAfterScroll({
        following: followingRef.current,
        source: scrollSource,
        metrics: {
          scrollTop: element.scrollTop,
          viewportHeight: element.clientHeight,
          contentHeight: element.scrollHeight,
        },
      }),
    );
    if (
      prependAnchorRef.current === null &&
      shouldLoadOlder(element.scrollTop, items.length - visibleCount)
    ) {
      prependAnchorRef.current = element.scrollHeight - element.scrollTop;
      setVisibleCount((count) => Math.min(items.length, count + WINDOW_CHUNK));
      // 补载是用户主动上翻要看的内容：立即全量挂载（渐进只属于会话首挂）
      setMountedTurnCount(Number.MAX_SAFE_INTEGER);
    }
  };

  const backToBottom = (): void => {
    navigationPausedRef.current = false;
    jumpTargetRef.current = null;
    clearUserScrollIntent();
    const element = scrollRef.current;
    if (element !== null) {
      // 立即贴底，避免平滑滚动中间帧再次退出跟随。
      markProgrammaticScroll();
      element.scrollTop = element.scrollHeight;
      lastObservedScrollTopRef.current = element.scrollTop;
      syncActiveQuery();
    }
    commitFollowing(true);
  };

  return (
    <div className="flex h-full min-h-0">
      <section
        aria-label="会话视图"
        className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-base"
      >
        <ScopedErrorBoundary
          scope="流程时间线"
          resetKey={contextPath ?? "none"}
        >
          <AawTimeline />
        </ScopedErrorBoundary>
        {agentCrashed !== null ? (
          <div
            role="alert"
            className="flex flex-none flex-wrap items-center gap-3 border-b border-line bg-danger-bg px-4 py-2.5 text-sm text-danger-ink"
          >
            <span className="font-medium">agent 已意外退出</span>
            <span className="text-xs opacity-80">{agentCrashed.reason}</span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => {
                if (activePath !== null) {
                  const sessionId = useSessionStore.getState().activeSessionId;
                  void openRealWorkspace(activePath, {
                    sessionId: sessionId ?? undefined,
                    listOnly: sessionId === null,
                  });
                }
              }}
              className={
                "rounded-md border border-current px-2.5 py-1 text-xs font-medium hover:bg-raised"
              }
            >
              重启并恢复会话
            </button>
            <button
              type="button"
              onClick={() => {
                openSettingsOverlayTab("diagnostics");
              }}
              className="rounded-md border border-current px-2.5 py-1 text-xs font-medium hover:bg-raised"
            >
              打开诊断
            </button>
          </div>
        ) : null}
        {/* 消息流：窗口化渲染（最近 WINDOW_CHUNK 条，贴顶补载）+ 跟随
            状态机（贴底自动滚入；上翻解除并给回底按钮）；relative 承载
            回底按钮 */}
        <SessionStatusOverlay
          project={contextPath}
          enabled={
            !!activeSessionId &&
            items.length > 0 &&
            !isConnecting &&
            !showConnectionIntro
          }
          centered={isCenteredEmpty && !showConnectionIntro}
          footer={
            <div
              ref={footerRef}
              hidden={connectionPending || showConnectionIntro}
              aria-hidden={connectionPending || showConnectionIntro}
              className={isCenteredEmpty ? "mb-auto shrink-0" : "shrink-0"}
            >
              <div className={columnInsetClass}>
                <div className="relative">
                  {!isFollowing && items.length > 0 ? (
                    <button
                      type="button"
                      onClick={backToBottom}
                      aria-label="回到底部"
                      title="回到底部"
                      className="absolute bottom-full left-1/2 z-30 mb-2 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full border border-line-strong bg-surface text-ink shadow-sm transition-colors hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info"
                    >
                      <ArrowDownIcon className="h-4 w-4" />
                    </button>
                  ) : null}
                  {turnError !== null && !isAgentRunning ? (
                    <div className="px-5">
                      <div
                        role="alert"
                        className={`mx-auto mb-2 flex w-full flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-4 py-2.5 text-sm text-danger-ink ${widthClass}`}
                      >
                        <span className="font-medium">
                          {turnError.category === "auth"
                            ? "模型或密钥配置异常"
                            : turnError.category === "timeout"
                              ? "请求超时"
                              : "请求失败"}
                        </span>
                        <span
                          className="min-w-0 flex-1 truncate text-xs text-ink-mute"
                          title={turnError.message}
                        >
                          {turnError.message}
                        </span>
                        <button
                          type="button"
                          onClick={retryLastPrompt}
                          className={
                            "rounded-md border border-line-strong px-2.5 py-1 text-xs font-medium text-ink hover:border-ink-faint hover:bg-raised"
                          }
                        >
                          重试
                        </button>
                        {turnError.category === "auth" ? (
                          <button
                            type="button"
                            onClick={() => {
                              useWorkbenchUiStore
                                .getState()
                                .toggleOverlay("settings");
                            }}
                            className="rounded-md border border-line-strong px-2.5 py-1 text-xs font-medium text-ink hover:border-ink-faint hover:bg-raised"
                          >
                            打开设置
                          </button>
                        ) : null}
                        <button
                          type="button"
                          aria-label="关闭错误提示"
                          onClick={clearTurnError}
                          className="rounded p-1.5 text-ink-faint hover:text-ink"
                        >
                          <XIcon className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {/* 会话停靠坞：问答 > 队列——队列永远紧挨输入框；任务步骤在
            消息流内（PlanCard），不占停靠坞 */}
                  <SessionDock>
                    {/* 结构化问答：不弹窗、不遮会话——回答所需上下文就在上方 */}
                    <QuestionDock />
                    {/* 排队消息：运行中「稍后发送」，取消/出错后挂起等放行 */}
                    <QueueDock />
                  </SessionDock>
                  <ChatInput
                    isAgentRunning={isAgentRunning}
                    disabled={isConnecting}
                    onSend={sendPrompt}
                    onEnqueue={enqueuePrompt}
                    onCancel={requestCancel}
                  />
                  {showDraftChips ? (
                    <div className="mt-3 px-4">
                      <DraftPromptChips
                        currentSr={currentSr}
                        widthClass={widthClass}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          }
          topLeft={
            /* 宽度切换：钉在会话区左上角（外层定位容器），三档循环（标准 / 宽 / 全宽），档位持久化 */
            <button
              type="button"
              aria-label={`内容宽度：${
                chatWidthOptions.find((option) => option.value === chatWidth)
                  ?.label ?? "标准"
              }`}
              title={`内容宽度：${
                chatWidthOptions.find((option) => option.value === chatWidth)
                  ?.label ?? "标准"
              }（点击切换为${
                chatWidthOptions.find((option) => option.value === nextWidth)
                  ?.label ?? "标准"
              }）`}
              onClick={() => {
                setChatWidth(nextWidth);
              }}
              className="absolute left-3 top-2 z-10 rounded-md border border-line bg-surface/80 p-1 text-ink-faint backdrop-blur transition-colors hover:border-ink-faint hover:text-ink-soft"
            >
              {chatWidth === "wide" ? (
                <WidthWideIcon className="h-3.5 w-3.5" />
              ) : chatWidth === "full" ? (
                <WidthFullIcon className="h-3.5 w-3.5" />
              ) : (
                <WidthStandardIcon className="h-3.5 w-3.5" />
              )}
            </button>
          }
        >
          <ConversationNavigator
            key={`${contextPath}:${activeSessionId}`}
            items={queries}
            activeId={activeQueryId}
            onJump={jumpToQuery}
          />
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            onWheelCapture={(event) => {
              navigationPausedRef.current = false;
              markUserScrollIntent(timelineWheelScrollIntent(event.deltaY));
            }}
            onTouchStartCapture={(event) => {
              touchClientYRef.current = event.touches[0]?.clientY ?? null;
            }}
            onTouchMoveCapture={(event) => {
              navigationPausedRef.current = false;
              const nextClientY = event.touches[0]?.clientY;
              const previousClientY = touchClientYRef.current;
              if (nextClientY === undefined || previousClientY === null) return;
              markUserScrollIntent(
                timelineTouchScrollIntent(previousClientY, nextClientY),
              );
              touchClientYRef.current = nextClientY;
            }}
            onTouchEndCapture={() => {
              touchClientYRef.current = null;
            }}
            onKeyDownCapture={(event) => {
              const key = event.key;
              if (
                [
                  "ArrowUp",
                  "ArrowDown",
                  "PageUp",
                  "PageDown",
                  "Home",
                  "End",
                  " ",
                ].includes(key)
              )
                navigationPausedRef.current = false;
              const target = event.target as HTMLElement | null;
              const editableTarget =
                target !== null &&
                (target.isContentEditable ||
                  target.tagName === "INPUT" ||
                  target.tagName === "TEXTAREA");
              markUserScrollIntent(
                timelineKeyboardScrollIntent({
                  key,
                  shiftKey: event.shiftKey,
                  editableTarget,
                }),
              );
            }}
            onPointerDownCapture={(event) => {
              const scroll = event.currentTarget;
              if (
                event.clientX >=
                scroll.getBoundingClientRect().right -
                  (scroll.offsetWidth - scroll.clientWidth)
              ) {
                // 滚动条拖动：登记未知方向意图，随后由真实 scroll 落点裁决
                navigationPausedRef.current = false;
                scrollbarPointerIdRef.current = event.pointerId;
                markUserScrollIntent("unknown");
              }
            }}
            onPointerUpCapture={(event) => {
              if (scrollbarPointerIdRef.current === event.pointerId) {
                scrollbarPointerIdRef.current = null;
              }
            }}
            tabIndex={0}
            role="log"
            aria-live="polite"
            aria-label="消息流"
            className="conversation-scroll relative h-full overflow-x-hidden overflow-y-auto px-5 py-5 [scrollbar-gutter:stable_both-edges]"
          >
            <div
              ref={messageColumnRef}
              className={`@container/conversation min-h-full [overflow-anchor:none] ${columnInsetClass} ${showConnectionIntro ? "grid place-items-center" : ""}`}
            >
              <ScopedErrorBoundary
                scope="消息流"
                resetKey={activeSessionId ?? "none"}
              >
                {showConnectionIntro ? (
                  <div className="flex justify-center py-10">
                    <BrandLoading
                      immersive
                      caption={
                        connectionPending ? "正在连接 agent…" : "会话已就绪"
                      }
                      hint={
                        connectionPending
                          ? "正在准备你的会话，请稍候"
                          : "即将进入工作区"
                      }
                    />
                  </div>
                ) : items.length === 0 &&
                  activePath === null &&
                  contextPath !== null ? (
                  /* 项目已关闭（无 activePath）：给「重新打开项目」的可行出口，
                   替代指路不通的「连接 agent」文案 */
                  <div className="flex flex-col items-center gap-3 py-16 text-center">
                    <p className="text-sm text-ink-mute">项目已关闭</p>
                    <button
                      type="button"
                      onClick={() => {
                        openWorkspace(contextPath);
                      }}
                      className={`${btnPrimary} px-3 py-1.5 text-sm`}
                    >
                      重新打开项目
                    </button>
                    <p className="text-xs text-ink-ghost">
                      将重新连接 agent 并恢复该项目的会话。
                    </p>
                  </div>
                ) : items.length === 0 &&
                  activeSessionId === null &&
                  !connectionPending &&
                  activePath !== null &&
                  (sessionsByPath[activePath]?.length ?? 0) > 0 ? (
                  /* 模型 a：连接只为列表服务，内容不自动打开——空态给出
                     该项目最近会话的快捷入口，点一下即回（快照先行秒开） */
                  <ProjectSessionQuickList
                    path={activePath}
                    sessions={sessionsByPath[activePath]!}
                  />
                ) : items.length === 0 ? (
                  pendingCount > 0 ? (
                    <p className="py-16 text-center text-sm leading-relaxed text-ink-faint">
                      会话暂无消息，当前有 {pendingCount}{" "}
                      项审批/提问待处理——请回应弹窗或停靠面板中的提问。
                    </p>
                  ) : (
                    <EmptyPrompts />
                  )
                ) : (
                  <ExpansionScopeProvider
                    key={scope}
                    project={contextPath ?? activePath ?? ""}
                    sessionId={activeSessionId ?? ""}
                  >
                    <ol
                      className={`mx-auto flex list-none flex-col gap-5 p-0 ${widthClass}`}
                    >
                      {mountedTurns.map((turn) => (
                        <li key={turn.id}>
                          <ConversationTurnView
                            turn={turn}
                            renderItem={renderSessionItem}
                          />
                        </li>
                      ))}
                      {/* 轮次相位行长在消息流末尾：思考中 / 工具运行中 n / 生成中 */}
                      <TurnStatusRow />
                    </ol>
                  </ExpansionScopeProvider>
                )}
              </ScopedErrorBoundary>
            </div>
          </div>
        </SessionStatusOverlay>
      </section>
    </div>
  );
}
