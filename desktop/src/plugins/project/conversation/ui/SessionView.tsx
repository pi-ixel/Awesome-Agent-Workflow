import { IconButton } from "../../../../shared/ui/IconButton.tsx";
import type { SessionHandoff, SessionItem } from "../types.ts";
import type { SkillsService } from "../../../skills/service.ts";
import type { GitService } from "../../../git/service.ts";
import type { GitReviewNavigation } from "../../../git/types.ts";
import type { ProjectExtension, ProjectSlashEntry } from "../../ui/extension.ts";
import { useRightPanelSliding } from "../../../workbench/service.ts";
import {
  useSessionValue,
  useApprovalValue,
  useConversation,
} from "../../ui/bindings/conversationView.ts";
import { useProjectComposer } from "../../ui/bindings/composerView.ts";
import {
  useWorkspaceCommands,
  useWorkspaceValue,
} from "../../ui/bindings/workspaceView.ts";
import {
  useProjectNavigation,
  useProjectPage,
  useProjectPageValue,
  useProjectView,
} from "../../ui/bindings/projectView.tsx";
import type { ConversationDocumentView } from "./documentView.ts";
import { useRegisteredSnapshot } from "../../../../shared/state/useRegisteredSnapshot.ts";
import { useWindowDisplayed } from "../../../workbench/service.ts";
import type { ProjectService, ProjectWorkspace } from "../../service.ts";
import { useSessionCommands } from "./useSessionCommands.ts";
import type { ContentBlock } from "../../../../contracts/acp/protocol.ts";
import { ElicitationDock } from "../../interactions/ui/ElicitationModal.tsx";
import { ArchiveNotice } from "../../ui/ArchiveNotice.tsx";
import { ReconnectButton } from "./ReconnectButton.tsx";
import { useConnectionIntro } from "./useConnectionIntro.ts";
import { FindBar } from "../../../../shared/ui/controls/FindBar.tsx";
import {
  buildConversationFindIndex,
  normalizeConversationFindQuery,
  resolveConversationFindActiveIndex,
} from "../search/conversationFindIndex.ts";
import {
  applyFindHighlights,
  clearFindHighlights,
  scrollFindMatchIntoView,
} from "../search/conversationFindHighlight.ts";
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
  type CSSProperties,
} from "react";
import { chatWidthClassOf, chatWidthOptions } from "./chatWidth.ts";
import { useProjectPreferences } from "../../ui/preferencesView.tsx";
import { ActionButton, Spinner } from "../../../../shared/ui/controls.tsx";
import { Callout } from "../../../../shared/ui/Callout.tsx";
import { ScopedErrorBoundary } from "../../../../shared/ui/ErrorBoundary.tsx";
import {
  ArrowDownIcon,
  WidthFullIcon,
  WidthStandardIcon,
  WidthWideIcon,
  XIcon,
} from "../../../../shared/ui/icons.tsx";
import { AssistantMessage } from "./AssistantMessage.tsx";
import { ChatInput } from "./ChatInput.tsx";
import { projectFolderPath } from "../../../../shared/panelPaths.ts";
import { isRelatedScopeBlocked } from "../../sessions/relatedProjects.ts";
import { PlanCard } from "./PlanCard.tsx";
import { QuestionDock } from "../../interactions/ui/QuestionDock.tsx";
import { QueueDock } from "./QueueDock.tsx";
import { SessionDock } from "./SessionDock.tsx";
import { TurnStatusRow } from "./InputStatusBar.tsx";
import { BrandLoading } from "../../../../shared/ui/BrandLoading.tsx";
import { SystemNotice } from "./SystemNotice.tsx";
import { ThoughtBlock } from "./ThoughtBlock.tsx";
import { ToolCallCard } from "./ToolCallCard.tsx";
import { createConversationTurns } from "./conversationTurns.ts";
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
import { useSendMorph } from "./useSendMorph.ts";
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
    case "compaction":
      return (
        <div role="note" data-item-kind="compaction" data-item-id={item.id}
          className="flex items-center justify-center gap-2 text-xs text-ink-faint">
          <span className="h-px w-6 bg-line" />
          上下文已压缩
          <span className="h-px w-6 bg-line" />
        </div>
      );
    case "system":
      return <SystemNotice item={item} />;
  }
});

/** 模块级稳定引用：传入 memo 化的 ConversationTurnView 不因每次渲染
 * 的新箭头函数而击穿 memo。 */
/** 交接中的那一轮：用户的话照常显示，下面是扩展给的状态（如「正在启动工作流…」）。 */
function HandoffTurn({ handoff }: { readonly handoff: SessionHandoff }) {
  const [createdAt] = useState(() => new Date().toISOString());
  return (
    <div className="space-y-5" data-testid="session-handoff">
      {renderSessionItem({ kind: "user", id: "handoff", text: handoff.text, createdAt })}
      <div role="status" className="flex items-center gap-2 border-b border-line/50 pb-2 text-ui-base text-ink-soft">
        <Spinner className="ui-icon-16 shrink-0 text-ink-mute" />
        {handoff.label}
      </div>
    </div>
  );
}

const renderSessionItem = (item: SessionItem): React.JSX.Element => (
  <SessionItemView item={item} />
);

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

/** 空会话问候在窄列收缩至 20px，宽列使用共享标题字号。 */
const DRAFT_GREETING_MIN_FONT_SIZE_PX = 20;

function resolveDraftGreetingFontSizePx(
  availableWidthPx: number,
  naturalTextWidthPx: number,
  naturalFontSizePx: number,
): number | undefined {
  if (
    !Number.isFinite(availableWidthPx) ||
    !Number.isFinite(naturalTextWidthPx) ||
    availableWidthPx <= 0 ||
    naturalTextWidthPx <= 0 ||
    !Number.isFinite(naturalFontSizePx) ||
    availableWidthPx >= naturalTextWidthPx
  ) {
    return undefined;
  }
  return Math.max(
    DRAFT_GREETING_MIN_FONT_SIZE_PX,
    Math.floor(naturalFontSizePx * (availableWidthPx / naturalTextWidthPx)),
  );
}

/** 空会话的 hero（ZCode ConversationDraftEmptyState 式空态）：大 logo 水印
 * 垫底（底部渐隐）、品牌名独立行、时段问候按共享标题字号和容器宽度自适应。
 * 入口 chips 不在这里——它们跟随输入区渲染（见 DraftPromptChips）。 */
function EmptyPrompts() {
  const greeting = `${greetingOfHour(new Date().getHours())}，今天想推进什么？`;
  const [greetingFontSizePx, setGreetingFontSizePx] = useState<number>();
  const greetingContainerRef = useRef<HTMLHeadingElement | null>(null);
  const greetingMeasureRef = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    const container = greetingContainerRef.current;
    const measurement = greetingMeasureRef.current;
    if (!container || !measurement) {
      return;
    }
    let frameId: number | null = null;
    const measure = () => {
      frameId = null;
      const containerStyle = window.getComputedStyle(container);
      const horizontalPaddingPx =
        Number.parseFloat(containerStyle.paddingLeft) +
        Number.parseFloat(containerStyle.paddingRight);
      const availableWidthPx = Math.max(
        0,
        container.getBoundingClientRect().width - horizontalPaddingPx,
      );
      const naturalTextWidthPx = measurement.getBoundingClientRect().width;
      const naturalFontSizePx = Number.parseFloat(
        getComputedStyle(measurement).fontSize,
      );
      setGreetingFontSizePx((current) => {
        const next = resolveDraftGreetingFontSizePx(
          availableWidthPx,
          naturalTextWidthPx,
          naturalFontSizePx,
        );
        return current === next ? current : next;
      });
    };
    const scheduleMeasure = () => {
      if (frameId !== null) {
        return;
      }
      frameId = window.requestAnimationFrame(measure);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", scheduleMeasure);
      return () => {
        if (frameId !== null) {
          window.cancelAnimationFrame(frameId);
        }
        window.removeEventListener("resize", scheduleMeasure);
      };
    }
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(container);
    observer.observe(measurement);
    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      observer.disconnect();
    };
  }, [greeting]);

  return (
    <div
      data-testid="draft-greeting-hero"
      className="draft-greeting-hero relative flex flex-col items-center gap-4 pb-2 pt-1 text-center"
    >
      <p aria-hidden={true} className="draft-greeting-brand">
        Awesome Agent <span>Workspace</span>
      </p>
      <h2
        ref={greetingContainerRef}
        className="draft-greeting-title"
        style={
          greetingFontSizePx === undefined
            ? undefined
            : ({
                "--draft-greeting-font-size": `${greetingFontSizePx}px`,
              } as CSSProperties)
        }
      >
        <span
          ref={greetingMeasureRef}
          aria-hidden={true}
          className="draft-greeting-measure"
        >
          {greeting}
        </span>
        {greeting}
      </h2>
    </div>
  );
}

const NO_EXTENSION_ENTRIES: readonly ProjectSlashEntry[] = [];

/** 空态常用入口 chips：渲染在居中输入区下方（ZCode 式空态的呈现顺序：
 * 问候 → 输入框 → chips）。文字类 chip 预填输入框，过目可改，再自己发送；
 * 扩展给的快捷动作直接执行（如工作流：有进行中的运行时去看它，否则去启动）。 */
function DraftPromptChips({
  quickAction,
  widthClass,
}: {
  readonly quickAction: { readonly label: string; readonly run: () => void } | null;
  readonly widthClass: string;
}) {
  const composer = useProjectComposer();
  const prompts: readonly { label: string; text?: string; run?: () => void }[] = [
    ...(quickAction ? [{ label: quickAction.label, run: quickAction.run }] : []),
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
        <ActionButton
        tone="secondary"
          key={prompt.label}
          type="button"
          style={{ animationDelay: `${index * 60}ms` }}
          onClick={() => {
            if (prompt.run) prompt.run();
            else if (prompt.text) composer?.prefill(prompt.text);
          }}
          className="chip-in lift press rounded-pill! border border-line-strong bg-surface px-3.5 py-1.5 text-ui-sm text-ink-mute shadow-elev-1 hover:border-ink-faint hover:text-ink"
        >
          {prompt.label}
        </ActionButton>
      ))}
    </div>
  );
}

function readVisibleMessageAnchor(scroll: HTMLElement) {
  const top = scroll.getBoundingClientRect().top;
  for (const item of scroll.querySelectorAll<HTMLElement>("[data-item-id]")) {
    const rect = item.getBoundingClientRect();
    if (rect.bottom > top && rect.height > 0) return { item, offset: top - rect.top };
  }
  return null;
}

export function SessionView({
  fileCandidates,
  ownsFindShortcut,
  skillCandidates,
  resolveSlashSkills,
  queryGit,
  openGitReview,
  watchActivity,
  extension,
  openDiagnostics,
  openArchiveSettings,
}: {
  readonly fileCandidates?: ConversationDocumentView["fileCandidates"];
  readonly ownsFindShortcut?: ConversationDocumentView["ownsFindShortcut"];
  readonly skillCandidates?: SkillsService["candidates"];
  readonly resolveSlashSkills?: SkillsService["resolveSlashSkills"];
  readonly queryGit?: GitService["query"];
  readonly openGitReview?: GitReviewNavigation["open"];
  readonly watchActivity?: ProjectWorkspace["subscribeWorkspaceActivity"];
  readonly extension?: ProjectExtension;
  readonly openDiagnostics?: () => void;
  readonly openArchiveSettings?: () => void;
}) {
  const navigation = useProjectNavigation();
  const page = useProjectPage();
  const projectView = useProjectView();
  const project = projectView?.project;
  const rightPanelSliding = useRightPanelSliding();
  const {
    sendPrompt,
    enqueuePrompt,
    steerPrompt,
    requestCancel,
    retryLastPrompt,
    clearTurnError,
  } = useSessionCommands();
  const foreground = useConversation();
  const composer = useProjectComposer();
  const foregroundSession = foreground?.session;
  const foregroundApproval = foreground?.approval;
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const items = useSessionValue((state) =>
    state.historyPreview?.items ?? state.timelineItems ?? state.items,
  );
  const findItems = useSessionValue((state) =>
    findOpen && findQuery.trim() ? state.historyPreview?.items ?? state.items : undefined,
  );
  const isAgentRunning = useSessionValue((state) => state.isAgentRunning);
  const turnState = useSessionValue((state) => state.turnState);
  const isAwaitingUser = useSessionValue((state) => state.isAwaitingUser);
  const {
    preferences,
    values: { messageStreamShowTodos: showPlans, messageStreamMode, chatWidth },
  } = useProjectPreferences();
  const activeSessionId = useSessionValue((state) => state.activeSessionId);
  const relatedProjects = useSessionValue((state) => state.relatedProjects);
  const fileCandidateProjects = useMemo(
    () =>
      relatedProjects?.paths.length
        ? [relatedProjects.primary, ...relatedProjects.paths]
        : undefined,
    [relatedProjects],
  );
  const agentKey = useSessionValue((state) => state.agentKey);
  const hasCumulativePromptUsage = useSessionValue(
    (state) => state.hasCumulativePromptUsage,
  );
  const openingSessionId = useSessionValue((state) => state.openingSessionId);
  // 挂起计数：有挂起的审批/提问时不再展示「会话为空」空态，
  // 否则与「会话中」标签及弹出的审批模态自相矛盾（04-approval 评审项）。
  const pendingCount = useApprovalValue((state) => state.pending.length);
  const isConnecting = useSessionValue((state) => state.isConnecting);
  const isApplyingModel = useSessionValue((state) => state.isApplyingModel);
  const isDraftPreparing = useSessionValue((state) => state.isDraftPreparing);
  const draftError = useSessionValue((state) => state.lastError);
  const recovery = useSessionValue((state) => state.recovery);
  const connectionFailure = useSessionValue((state) => state.connectionFailure);
  const agentCrashed = useSessionValue((state) => state.agentCrashed);
  const turnError = useSessionValue((state) => state.turnError);
  const activePath = useWorkspaceValue((state) => state.activePath);
  // 项目已关闭（activePath 落空）时的空态改为「重新打开项目」入口
  const openWorkspace = useWorkspaceCommands()?.openWorkspace;
  const contextPath = useProjectPageValue((state) => state.contextPath);
  const extensionAction = useRegisteredSnapshot(
    extension?.quickAction,
    (state) => state ?? null,
  );
  const extensionEntries = useRegisteredSnapshot(
    extension?.slashEntries,
    (state) => state ?? NO_EXTENSION_ENTRIES,
  );
  const quickAction =
    extensionAction && contextPath
      ? { label: extensionAction.label, run: () => extensionAction.run(contextPath) }
      : null;
  // ZCode 式空态居中：无消息且无挂起审批/提问时，问候与输入区作为一组
  // 垂直居中；首条消息落地（items.length > 0）即回落贴底布局——composer
  // 始终在 footer 槽位同一位置渲染，只改外层容器类，不重挂。
  const connectionPending = isConnecting || openingSessionId !== null;
  const introActive = useConnectionIntro(
    connectionPending && !isDraftPreparing,
    sendPrompt,
  );
  const showConnectionIntro =
    !isDraftPreparing &&
    introActive &&
    (connectionPending || (agentCrashed === null && turnError === null));
  // 交接中（ADR 039）：那句话已经发出、扩展还没接手，像平常发消息一样显示在信息流末尾。
  const handoff = useSessionValue((state) => state.handoff ?? null);
  const isCenteredEmpty =
    showConnectionIntro || (items.length === 0 && pendingCount === 0 && handoff === null);
  // chips 只跟随「可发首条消息」的空态：连接中与项目已关闭不显示
  const showDraftChips =
    isCenteredEmpty &&
    !connectionPending &&
    !showConnectionIntro &&
    !(activePath === null && contextPath !== null);
  // 内容宽度档：消息流 / 输入卡 / 停靠坞共用（对齐），就地三档循环
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
  const queryAnchorRef = useRef<{ id: string; scrollTop: number } | null>(null);
  const [jumpRevision, setJumpRevision] = useState(0);
  const [activeQueryId, setActiveQueryId] = useState<string | null>(null);
  // ---- 会话查找（Ctrl/Cmd+F）：浮层 + 匹配索引 + DOM 高亮（ZCode
  // TaskFindDialog 同款交互；索引/高亮见 conversationFindIndex/Highlight）----
  const [findActiveIndex, setFindActiveIndex] = useState(0);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const findIndex = useMemo(
    () => buildConversationFindIndex(findItems ?? [], findQuery),
    [findItems, findQuery],
  );
  const findMatchedItemIds = useMemo(
    () => [...new Set(findIndex.matches.map((match) => match.itemId))],
    [findIndex.matches],
  );
  const findActiveMatch =
    findIndex.matches[findActiveIndex] ??
    findIndex.matches[findIndex.matches.length - 1] ??
    null;

  function navigateFind(direction: 1 | -1): void {
    if (findIndex.matchCount === 0) {
      return;
    }
    const count = findIndex.matchCount;
    const nextIndex = (findActiveIndex + direction + count) % count;
    setFindActiveIndex(nextIndex);
  }

  // 折叠的过程会在激活命中后展开，等 DOM 更新再定位。
  const findActiveItemId = findActiveMatch?.itemId;
  useEffect(() => {
    if (findOpen && findActiveItemId && scrollRef.current) {
      scrollFindMatchIntoView(scrollRef.current, findActiveItemId);
    }
  }, [findOpen, findActiveItemId, findActiveIndex, messageStreamMode]);

  // Ctrl/Cmd+F 全局打开查找；Esc 关闭（capture 相位先于回合取消的 Esc
  // 处理器，查找开着时 Esc 归查找）
  useEffect(() => {
    function handleFindKeys(event: KeyboardEvent): void {
      if (ownsFindShortcut?.(event)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        event.stopPropagation();
        setFindOpen(true);
        return;
      }
      if (event.key === "Escape" && findOpen) {
        event.preventDefault();
        event.stopPropagation();
        setFindOpen(false);
      }
    }
    window.addEventListener("keydown", handleFindKeys, true);
    return () => {
      window.removeEventListener("keydown", handleFindKeys, true);
    };
  }, [ownsFindShortcut, findOpen]);

  // DOM 高亮：query 非空时注册（items / 激活下标变化即重建）
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !findOpen || findQuery.trim() === "") return;
    const normalizedQuery = normalizeConversationFindQuery(findQuery);
    applyFindHighlights({
      root,
      normalizedQuery,
      matchedItemIds: findMatchedItemIds,
      activeMatch:
        findActiveMatch !== null
          ? {
              itemId: findActiveMatch.itemId,
              matchIndex: findActiveMatch.matchIndex,
            }
          : null,
    });
    return () => {
      clearFindHighlights();
    };
  }, [findOpen, findQuery, findActiveIndex, findIndex, findMatchedItemIds, messageStreamMode]);
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
  const isWindowDisplayed = useWindowDisplayed();
  useLayoutEffect(() => {
    const setFollowing = foreground?.setPlaybackFollowing;
    if (!setFollowing) return;
    const onVisibility = () =>
      setFollowing(isFollowing && isWindowDisplayed && document.visibilityState !== "hidden");
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      setFollowing(false);
    };
  }, [foreground, isFollowing, isWindowDisplayed]);
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
  const panelScrollRef = useRef<{
    viewport: HTMLElement;
    width: number;
    scope: string;
    anchor: ReturnType<typeof readVisibleMessageAnchor>;
  } | null>(null);
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
  const [buildTurns] = useState(createConversationTurns);
  const visibleTurns = useMemo(
    () => buildTurns(items, visibleCount, isAgentRunning, turnState, showPlans, hasCumulativePromptUsage),
    [buildTurns, items, visibleCount, isAgentRunning, turnState, showPlans, hasCumulativePromptUsage],
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
  const queryRailInset = queries.length >= 2
    ? "@min-[864px]/conversation:pl-[max(28px,calc(var(--ui-icon-unit)*36_-_8px))]"
    : "";
  const syncActiveQuery = useCallback((): void => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const positions = Array.from(
      scroll.querySelectorAll<HTMLElement>("[data-query-id]"),
    ).map((node) => ({ id: node.dataset.queryId ?? "", top: node.offsetTop }));
    const anchor = queryAnchorRef.current;
    const anchored = navigationPausedRef.current && anchor
      ? positions.find(position => position.id === anchor.id)
      : undefined;
    if (anchor && anchored) {
      const top = Math.max(0, Math.min(anchored.top - 20, scroll.scrollHeight - scroll.clientHeight));
      if (top !== anchor.scrollTop) {
        // 用户显式跳转后，字号或可用宽度变化时按同一条提问重新定位。
        anchor.scrollTop = top;
        markProgrammaticScroll();
        scroll.scrollTop = top;
        lastObservedScrollTopRef.current = scroll.scrollTop;
      }
      setActiveQueryId(anchor.id);
      return;
    }
    setActiveQueryId(
      activeQueryAt(
        queries,
        positions,
        scroll.scrollTop,
        Math.max(0, items.length - visibleCount),
      ),
    );
  }, [queries, items.length, visibleCount, markProgrammaticScroll]);
  const scope = JSON.stringify([agentKey, activeSessionId, contextPath]);
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
    queryAnchorRef.current = null;
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
    queryAnchorRef.current = null;
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
      const top = Math.max(0, Math.min(node.offsetTop - 20, scroll.scrollHeight - scroll.clientHeight));
      queryAnchorRef.current = { id: jumpTarget, scrollTop: top };
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
      if ((foregroundApproval?.getState().pending.length ?? 0) > 0) {
        return;
      }
      if (page?.getState().overlayOpen) {
        return;
      }
      event.preventDefault();
      requestCancel();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isAgentRunning, requestCancel, foregroundApproval, page]);

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

  // 叶子正文独立提交，内容或视口尺寸变化时仍按原跟随状态贴底。
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const column = messageColumnRef.current;
    if (!element || !column || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const viewport = element.clientHeight;
      const height = element.scrollHeight;
      const layout = lastAnchorLayoutRef.current;
      if (viewport === layout?.viewport && height === layout.height) return;
      lastAnchorLayoutRef.current = { viewport, height };
      if (!followingRef.current || getActiveUserScrollIntent() === "awayFromBottom") return;
      markLayoutScrollGuard();
      markProgrammaticScroll();
      element.scrollTop = height;
      lastObservedScrollTopRef.current = element.scrollTop;
    });
    observer.observe(element);
    observer.observe(column);
    return () => observer.disconnect();
  }, [markLayoutScrollGuard, markProgrammaticScroll, getActiveUserScrollIntent]);

  // The right panel holds the old chat width until the slide ends. Anchor the
  // single width change before paint, using the current follow/reading state.
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    if (rightPanelSliding) {
      panelScrollRef.current = {
        viewport, scope, width: viewport.clientWidth,
        anchor: followingRef.current ? null : readVisibleMessageAnchor(viewport),
      };
      return;
    }
    const previous = panelScrollRef.current;
    panelScrollRef.current = null;
    if (!previous || previous.scope !== scope || previous.viewport !== viewport ||
      previous.width === viewport.clientWidth) return;
    markLayoutScrollGuard();
    const anchor = previous.anchor;
    if (followingRef.current) {
      markProgrammaticScroll();
      viewport.scrollTop = viewport.scrollHeight;
    } else if (anchor && viewport.contains(anchor.item)) {
      const rect = anchor.item.getBoundingClientRect();
      markProgrammaticScroll();
      viewport.scrollTop += rect.top - viewport.getBoundingClientRect().top +
        Math.min(anchor.offset, Math.max(0, rect.height - 1));
    }
    lastObservedScrollTopRef.current = viewport.scrollTop;
  }, [rightPanelSliding, scope, markLayoutScrollGuard, markProgrammaticScroll]);

  // 滚动区为两侧滚动条槽预留空间；停靠区同步实际槽宽，统一内容列基准。
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const footer = footerRef.current;
    if (!scroll || !footer) return;
    const align = () => {
      const inset = Math.max(0, scroll.offsetWidth - scroll.clientWidth) / 2;
      footer.style.paddingInline = `${inset}px`;
    };
    align();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(align);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, []);

  const { layerRef: sendMorphLayerRef, sendWithMorph } = useSendMorph(
    () => foregroundSession?.getState().items ?? [],
    scrollRef,
  );

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
    const panelScroll = panelScrollRef.current;
    if (panelScroll?.viewport === element) {
      panelScroll.anchor = followingRef.current ? null : readVisibleMessageAnchor(element);
    }
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
    queryAnchorRef.current = null;
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

  const runRecoveryCommand = (
    run: (service: ProjectService) => Promise<unknown>,
  ) => {
    if (!projectView?.isActive() || !foregroundSession) return;
    const { activeSessionId, agentKey } = foregroundSession.getState();
    void Promise.resolve()
      .then(() => {
        if (projectView.isActive()) return run(projectView.project);
      })
      .catch((error: unknown) => {
        if (projectView.isActive())
          projectView.project.conversation.reportCommandFailure(
            { workspacePath: activePath, sessionId: activeSessionId, agentKey },
            String(error),
          );
      });
  };

  return (
    <div className="flex h-full min-h-0">
      <section
        aria-label="会话视图"
        className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-base"
      >
        <div
          ref={sendMorphLayerRef}
          data-send-morph-layer=""
          className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
          aria-hidden="true"
          inert
          hidden
        />
        <ArchiveNotice openSettings={openArchiveSettings} />
        {isDraftPreparing ? (
          <div
            role={draftError ? "alert" : "status"}
            className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2 text-ui-sm text-ink-mute"
          >
            <span className={draftError ? "text-danger-ink" : ""}>
              {draftError ??
                "正在准备会话，可先编辑草稿，就绪后即可选择模型并发送。"}
            </span>
            {draftError && contextPath ? (
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                onClick={() => {
                  void project?.sessions.startNewSession(contextPath);
                }}
              >
                重试连接
              </ActionButton>
            ) : null}
          </div>
        ) : null}
        {recovery.state !== "idle" || connectionFailure ? (
          <div
            role="status"
            className="flex flex-wrap items-center gap-3 border-b border-line bg-raised px-4 py-2 text-sm"
          >
            <span
              className={
                recovery.state === "reconnecting"
                  ? "turn-status-shimmer"
                  : undefined
              }
            >
              {recovery.state === "reconnecting" ? (
                `正在恢复原会话（${recovery.attempt}/3）`
              ) : (
                <>原会话连接尚未恢复 · {recovery.reason || connectionFailure}</>
              )}
            </span>
            <ReconnectButton />
            {recovery.state === "reconnecting" ? (
              <ActionButton
                tone="secondary"
                type="button"
                className="min-h-8 px-3 text-sm"
                onClick={() => {
                  const { activeSessionId, agentKey } =
                    foregroundSession?.getState() ?? {};
                  if (activePath && activeSessionId && agentKey)
                    runRecoveryCommand((service) =>
                      service.sessions.stopRecovery({
                        workspacePath: activePath,
                        sessionId: activeSessionId,
                        agentKey,
                      }),
                    );
                }}
              >
                停止重试
              </ActionButton>
            ) : (
              <ActionButton
                tone="secondary"
                type="button"
                className="min-h-8 px-3 text-sm"
                onClick={() => {
                  if (activePath)
                    void project?.sessions.startNewSession(activePath);
                }}
              >
                新建会话继续
              </ActionButton>
            )}
          </div>
        ) : null}
        {agentCrashed !== null ? (
          <div
            role="alert"
            className="flex flex-none flex-wrap items-center gap-3 border-b border-line bg-danger-bg px-4 py-2.5 text-sm text-danger-ink"
          >
            <span className="font-medium">agent 已意外退出</span>
            <span className="text-xs opacity-80">{agentCrashed.reason}</span>
            <span className="flex-1" />
            <ActionButton
              tone="secondary"
              size="compact"
              type="button"
              onClick={() => {
                if (activePath !== null) {
                  const sessionId =
                    foregroundSession?.getState().activeSessionId;
                  runRecoveryCommand((service) =>
                    service.sessions.openSession(activePath, {
                      sessionId: sessionId ?? undefined,
                      listOnly: sessionId == null,
                    }),
                  );
                }
              }}
            >
              重启并恢复会话
            </ActionButton>
            {openDiagnostics && (
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                onClick={openDiagnostics}
              >
                打开诊断
              </ActionButton>
            )}
          </div>
        ) : null}
        {/* 消息流：窗口化渲染（最近 WINDOW_CHUNK 条，贴顶补载）+ 跟随
            状态机（贴底自动滚入；上翻解除并给回底按钮）；relative 承载
            回底按钮 */}
        <SessionStatusOverlay
          queryGit={queryGit}
          openGitReview={openGitReview}
          watchActivity={watchActivity}
          extension={extension}
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
              hidden={
                !isDraftPreparing && (connectionPending || showConnectionIntro)
              }
              aria-hidden={
                !isDraftPreparing && (connectionPending || showConnectionIntro)
              }
              className={isCenteredEmpty ? "mb-auto shrink-0" : "shrink-0"}
            >
              <div className={queryRailInset}>
                <div className="relative">
                  {!isFollowing && items.length > 0 ? (
                    <IconButton
                      type="button"
                      onClick={backToBottom}
                      aria-label="回到底部"
                      data-hint="回到底部"
                      className="absolute bottom-full left-1/2 z-30 mb-2 flex -translate-x-1/2 items-center justify-center rounded-pill border border-line-strong bg-surface text-ink shadow-sm transition-colors hover:bg-raised focus-visible:keyboard-focus-marker"
                    >
                      <ArrowDownIcon className="ui-icon-16" />
                    </IconButton>
                  ) : null}
                  {turnError !== null && !isAgentRunning ? (
                    <div className="px-5">
                      <div
                        role="alert"
                        className={`mx-auto mb-2 flex w-full flex-wrap items-center gap-3 rounded-control border border-line bg-surface px-4 py-2.5 text-sm text-danger-ink ${widthClass}`}
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
                          data-hint={turnError.message}
                        >
                          {turnError.message}
                        </span>
                        <ActionButton
                          tone="secondary"
                          size="compact"
                          type="button"
                          onClick={retryLastPrompt}
                        >
                          重试
                        </ActionButton>
                        <ActionButton
                          tone="secondary"
                          size="compact"
                          type="button"
                          onClick={() => {
                            const last = [
                              ...(foregroundSession?.getState().items ?? []),
                            ]
                              .reverse()
                              .find((item) => item.kind === "user");
                            if (last?.kind === "user")
                              composer?.prefill(
                                last.text,
                                last.attachments as
                                  readonly ContentBlock[] | undefined,
                              );
                          }}
                        >
                          取回输入框
                        </ActionButton>
                        {turnError.category === "auth" ? (
                          <ActionButton
                            tone="secondary"
                            size="compact"
                            type="button"
                            onClick={navigation?.openSettings}
                          >
                            打开设置
                          </ActionButton>
                        ) : null}
                        <IconButton iconSize="compact"
                          type="button"
                          aria-label="关闭错误提示"
                          onClick={clearTurnError}
                          className="rounded-control text-ink-faint hover:text-ink"
                        >
                          <XIcon className="ui-icon-12" />
                        </IconButton>
                      </div>
                    </div>
                  ) : null}
                  {/* 会话停靠坞：问答 > 队列——队列永远紧挨输入框；任务步骤在
            消息流内（PlanCard），不占停靠坞 */}
                  {/* data-composer-dock：SessionDock+ChatInput 的实测高包裹层
            （完整视图浮窗收起态按它裁剪）；普通块级包裹，不改布局、composer
            不重挂 */}
                  <div data-composer-dock>
                    <SessionDock>
                      {/* 结构化问答：不弹窗、不遮会话——回答所需上下文就在上方 */}
                      <QuestionDock />
                      <ElicitationDock />
                    </SessionDock>
                    {relatedProjects?.isApplying ? (
                      <div className="mx-4 mb-2">
                        <Callout tone="info" title="正在应用项目目录" />
                      </div>
                    ) : relatedProjects?.error ? (
                      <div className="mx-4 mb-2 space-y-1">
                        <Callout
                          tone="danger"
                          title="关联目录未生效，发送已暂停"
                        >
                          {relatedProjects.error}
                        </Callout>
                        <div className="flex flex-wrap gap-1">
                          <ActionButton
                            size="compact"
                            tone="secondary"
                            onClick={() => void relatedProjects.retry()}
                          >
                            重试
                          </ActionButton>
                          <ActionButton
                            size="compact"
                            tone="ghost"
                            onClick={() =>
                              void relatedProjects.usePrimaryOnly()
                            }
                          >
                            仅用主目录
                          </ActionButton>
                        </div>
                      </div>
                    ) : null}
                    <ChatInput
                      queue={<QueueDock />}
                      fileCandidates={fileCandidates}
                      fileCandidateProjects={fileCandidateProjects}
                      skillCandidates={skillCandidates}
                      resolveSlashSkills={resolveSlashSkills}
                      skillWorkspace={projectFolderPath(contextPath ?? activePath ?? "") || null}
                      extensionEntries={extensionEntries}
                      extensionGroup={extension?.slashGroup}
                      openDiagnostics={openDiagnostics}
                      isAgentRunning={isAgentRunning}
                      disabled={isConnecting && !isDraftPreparing}
                      sendDisabled={
                        isDraftPreparing ||
                        isConnecting ||
                        isApplyingModel ||
                        isRelatedScopeBlocked(relatedProjects)
                      }
                      onSend={sendPrompt}
                      onSendWithMotion={sendWithMorph}
                      onEnqueue={enqueuePrompt}
                      onSteer={steerPrompt}
                      onCancel={requestCancel}
                    />
                  </div>
                  {showDraftChips ? (
                    <div className="mt-3 px-4">
                      <DraftPromptChips
                        quickAction={quickAction}
                        widthClass={widthClass}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          }
          topLeft={
            <>
              {/* 宽度切换：钉在会话区左上角（外层定位容器），三档循环（标准 / 宽 / 全宽），档位持久化 */}
              <IconButton iconSize="compact"
                type="button"
                aria-label={`内容宽度：${
                  chatWidthOptions.find((option) => option.value === chatWidth)
                    ?.label ?? "标准"
                }`}
                data-hint={`内容宽度：${
                  chatWidthOptions.find((option) => option.value === chatWidth)
                    ?.label ?? "标准"
                }（点击切换为${
                  chatWidthOptions.find((option) => option.value === nextWidth)
                    ?.label ?? "标准"
                }）`}
                onClick={() => {
                  preferences?.setChatWidth(nextWidth);
                }}
                className="absolute left-3 top-2 z-10 rounded-control border border-line bg-surface/80 text-ink-faint backdrop-blur transition-colors hover:border-ink-faint hover:text-ink-soft"
              >
                {chatWidth === "wide" ? (
                  <WidthWideIcon className="ui-icon-14" />
                ) : chatWidth === "full" ? (
                  <WidthFullIcon className="ui-icon-14" />
                ) : (
                  <WidthStandardIcon className="ui-icon-14" />
                )}
              </IconButton>
              {/* 会话查找浮层（Ctrl/Cmd+F）：浮在消息流顶部居中（ZCode
               TaskFindDialog chat 放置同位）；查找状态在本组件持有 */}
              {findOpen ? (
                <FindBar
                  label="查找"
                  placeholder="搜索消息..."
                  query={findQuery}
                  matchCount={findIndex.matchCount}
                  activeIndex={resolveConversationFindActiveIndex(
                    findIndex.matchCount,
                    findActiveIndex,
                  )}
                  onQueryChange={(query) => {
                    setFindQuery(query);
                    setFindActiveIndex(0);
                  }}
                  onPrevious={() => navigateFind(-1)}
                  onNext={() => navigateFind(1)}
                  onClose={() => {
                    setFindOpen(false);
                    clearFindHighlights();
                  }}
                  inputRef={findInputRef}
                />
              ) : null}
            </>
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
            data-session-messages=""
            className="conversation-scroll relative h-full overflow-x-hidden overflow-y-auto px-4 py-5 [scrollbar-gutter:stable_both-edges]"
          >
            <div
              ref={messageColumnRef}
              className={`@container/conversation min-h-full [overflow-anchor:none] ${queryRailInset} ${showConnectionIntro ? "grid place-items-center" : ""}`}
            >
              <ScopedErrorBoundary
                scope="消息流"
                resetKey={activeSessionId ?? "none"}
              >
                {showConnectionIntro ? (
                  <div className="flex justify-center py-10">
                    <BrandLoading immersive />
                  </div>
                ) : items.length === 0 &&
                  activePath === null &&
                  contextPath !== null ? (
                  /* 项目已关闭（无 activePath）：给「重新打开项目」的可行出口，
                   替代指路不通的「连接 agent」文案 */
                  <div className="flex flex-col items-center gap-3 py-16 text-center">
                    <p className="text-sm text-ink-mute">项目已关闭</p>
                    <ActionButton
                      tone="primary"
                      type="button"
                      onClick={() => {
                        openWorkspace?.(contextPath);
                      }}
                      className="px-3 py-1.5 text-sm"
                    >
                      重新打开项目
                    </ActionButton>
                    <p className="text-xs text-ink-ghost">
                      将重新连接 agent 并恢复该项目的会话。
                    </p>
                  </div>
                ) : items.length === 0 && handoff === null ? (
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
                    agentKey={agentKey}
                    state={project?.conversation.expansion}
                  >
                    <ol
                      className={`mx-auto flex list-none flex-col gap-5 p-0 ${widthClass}`}
                    >
                      {mountedTurns.map((turn) => (
                        <li key={turn.id}>
                          <ConversationTurnView
                            turn={turn}
                            collapseHistory={messageStreamMode === "conclusion"}
                            revealHistory={
                              messageStreamMode === "conclusion" &&
                              findOpen &&
                              findActiveMatch !== null &&
                              turn.history.some((item) => item.id === findActiveMatch.itemId)
                            }
                            workGroupShimmerPaused={
                              turn.running &&
                              (turnState !== "running" || isAwaitingUser)
                            }
                            renderItem={renderSessionItem}
                          />
                        </li>
                      ))}
                      {handoff && (
                        <li>
                          <HandoffTurn handoff={handoff} />
                        </li>
                      )}
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
