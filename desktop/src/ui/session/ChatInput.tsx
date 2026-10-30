/**
 * 输入区（悬浮形态）：不贴边贴底的圆角卡片——外层 `0 16px 16px` 留白，
 * 内部 max-w-4xl 居中，surface 植面 + 圆角 16 + 投影。
 *
 * - 上行：多行文本（透明背景无边框），Enter 发送 / Shift+Enter 换行，
 *   中文输入法组词中的 Enter 不发送；固定初始高度、随内容自动增长
 *   （上限后内部滚动），不暴露原生 resize 手柄；
 * - ↑/↓ 输入历史：空输入或浏览态下按 ↑ 回溯已发送的 prompt（再按 ↓
 *   前进 / 回到编辑中的草稿）——终端同款手感；
 * - / 命令面板：行首 `/`（顿号 `、` 归一）弹命令面板——内置命令
 *   （clear / diagnostics / retry，选中即执行）、工作流入口（/sr /ar /dev
 *   打开 AAW 面板并定位向导表单）、skills（插入使用提示文本）；
 *   ↑/↓ 选择、Enter/Tab 选中、Esc 关闭；
 * - @ 提及：输入 `@` + 关键字弹多源候选（工作区文件见 aaw/fileListing
 *   + 会话已加载 skills），↑/↓ 选择、Enter/Tab 插入、Esc 关闭；
 *   文件插 `@相对路径` 纯文本、skill 插自然语言提示（agent 自行加载）；
 * - 预填通道：外部（再次发送 / 推荐入口）经 composerPrefill 把文本
 *   送进草稿并聚焦，不自动发送；
 * - 下行（border-t 分隔）：左侧「+」skills 菜单 + 审批模式与策略切换；右侧模型标识
 *   + 上下文用量圆环 + 发送 / 停止钮。轮次相位（思考中 / 工具运行中 /
 *   生成中）不在这里——它长在对话流末尾（SessionView 的 TurnStatusRow）。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { useSessionStore } from "../../stores/sessionStore.ts";
import { useWorkbenchUiStore } from "../../stores/workbenchUiStore.ts";
import { openSettingsOverlayTab } from "../SettingsPage.tsx";
import { useRuntimeStatusStore } from "../../stores/runtimeStatusStore.ts";
import {
  approvalModeOptions,
  chatWidthClassOf,
  useSettingsStore,
  type ApprovalMode,
} from "../../stores/settingsStore.ts";
import { MenuItemRow, StatusChipMenu } from "./StatusChipMenu.tsx";
import { useWorkspaceStore } from "../../stores/workspaceStore.ts";
import { listWorkspaceFiles } from "../../aaw/fileListing.ts";
import { InputStatusRight } from "./InputStatusBar.tsx";
import { onComposerPrefill } from "./composerPrefill.ts";
import { HandIcon, ShieldCheckIcon } from "../icons.tsx";
import {
  detectMentionTrigger,
  filterMentionOptions,
  type MentionOption,
} from "./mention.ts";
import {
  buildSlashItems,
  detectSlashTrigger,
  filterSlashItems,
  replaceSlashToken,
  type SlashItem,
} from "./slash.ts";
import {
  getPromptHistory,
  recordPrompt,
  setPromptHistoryScope,
} from "./promptHistory.ts";
import { draftScopeKey, readDraft, writeDraft } from "./draftStore.ts";
import { skillNamesFromSources } from "./skillCatalog.ts";

/** 自动增长的高度上限（px）：ZCode 编辑器 max-h-40=160px，超过后转入内部滚动。 */
const MAX_HEIGHT_PX = 160;

/** 审批模式徽标配色（ZCode 式无框浅植面）：手动（琥珀）/ 自动（蓝）/ 全放行（红，提示风险）。 */
const modeBadgeClasses: Readonly<Record<string, string>> = {
  manual: "bg-warn-bg/70 text-warn-ink",
  auto: "bg-info-bg/70 text-info-ink",
  bypass: "bg-danger-bg/70 text-danger-ink",
};

/** 审批默认模式的芯片短词（完整语义在菜单项里）。 */
function policyLabelOf(mode: ApprovalMode): string {
  return mode === "auto-allow" ? "自动放行" : "每次询问";
}

/** arrow-up：发送主钮内的箭头。 */
function ArrowUpIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
      className="h-4 w-4"
    >
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </svg>
  );
}

/** 停止：ZCode 式次级钮（variant=secondary）内的实心方块（SquareIcon size-4）。 */
function StopIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden={true}
      className="h-4 w-4"
    >
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

/**
 * 发送/停止钮的悬停提示（ZCode ControlHintTooltip 等价物）：desktop 无
 * Radix/tw-animate，用纯 CSS group-hover/focus-within 挂在 `group/send`
 * 包裹层上。按 ZCode 无描述变体对齐：容器 px-2.5 py-1 pr-1（kbd 自带右距，
 * ControlHintTooltip.tsx:104-106）、sideOffset=2 → 距钮 2px（:64）、
 * TooltipContent 无阴影（tooltip.tsx:64）；kbd h-4 bg-tooltip-tag text-ui-xs
 * （ControlShortcutBadge.tsx:11）。
 */
function SendHintTooltip({
  label,
  shortcut,
}: {
  readonly label: string;
  readonly shortcut: string;
}) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute bottom-full right-0 z-30 mb-0.5 hidden items-center gap-2 whitespace-nowrap rounded-lg border border-line bg-tooltip px-2.5 py-1 pr-1 text-ui-sm font-medium text-tooltip-ink composer-pop group-focus-within/send:flex group-hover/send:flex"
    >
      {label}
      <kbd className="inline-flex h-4 items-center rounded-sm bg-tooltip-tag px-1.5 font-mono text-ui-xs font-medium text-tooltip-tag-ink">
        {shortcut}
      </kbd>
    </span>
  );
}

export interface ChatInputProps {
  readonly isAgentRunning: boolean;
  /** ACP 连接建立中：输入与发送一并禁用（无会话可发）。 */
  readonly disabled?: boolean;
  readonly onSend: (text: string) => void;
  /** 运行中提交：消息加入队列（轮次结束后按序发出）。 */
  readonly onEnqueue: (text: string) => void;
  readonly onCancel: () => void;
}

export function ChatInput({
  isAgentRunning,
  disabled = false,
  onSend,
  onEnqueue,
  onCancel,
}: ChatInputProps) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // 审批模式随会话事件更新（模型/上下文/skills/mcp 在 InputStatusCluster 自取）
  const approvalMode = useSessionStore((state) => state.approvalMode);
  const turnState = useSessionStore((state) => state.turnState);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  // 审批默认模式（ask / auto-allow）：客户端对权限请求的缺省应答策略，
  // 即时切换（与设置页同一字段）；「自动拒绝」已下线（误触后全拒，危险）
  const approvalPolicy = useSettingsStore((state) => state.approvalMode);
  const setApprovalPolicy = useSettingsStore((state) => state.setApprovalMode);
  // 输入卡宽度与消息流同档（对齐）
  const widthClass = chatWidthClassOf(
    useSettingsStore((state) => state.chatWidth),
  );
  const activePath = useWorkspaceStore((state) => state.activePath);

  // ---- 草稿 / 输入历史的持久化（见 draftStore / promptHistory 文件头）----
  // 历史 ↑/↓ 按工作区分档；草稿按（工作区 × 会话）分档：
  // 切走时先把当前草稿落回旧 scope，再载入新 scope 的存稿
  const draftKey =
    activePath === null ? null : draftScopeKey(activePath, activeSessionId);
  const draftKeyRef = useRef<string | null>(null);
  const draftTextRef = useRef("");
  // 草稿镜像（渲染外维护）：scope 切换 effect 落旧盘时取最新草稿。
  // 声明在切换 effect 之前——同一 commit 内先镜像后切换，读到的总是新值
  useEffect(() => {
    draftTextRef.current = draft;
  }, [draft]);
  // 写穿透：草稿一变即落盘（含预填通道送进来的文本）
  useEffect(() => {
    if (draftKeyRef.current !== null) {
      writeDraft(draftKeyRef.current, draft);
    }
  }, [draft]);
  useEffect(() => {
    setPromptHistoryScope(activePath);
  }, [activePath]);

  // @ 提及：触发态（query + 选中下标）+ 当前工作区的文件清单
  const [mention, setMention] = useState<{
    readonly query: string;
    readonly index: number;
  } | null>(null);
  // / 命令面板：行首触发，目录 = 内置命令 + 工作流入口 + skills
  const [slash, setSlash] = useState<{
    readonly query: string;
    readonly index: number;
  } | null>(null);
  // skills 候选数据源：wire 的 skillNames（权威）为空时从 skillSources
  // 目录枚举兜底（chrys 懒加载配置下 wire 名单为空）
  const runtimeSkillNames = useRuntimeStatusStore(
    (state) => state.runtime.skillNames,
  );
  const agentCommands = useRuntimeStatusStore(
    (state) => state.availableCommands,
  );
  const skillSources = useRuntimeStatusStore(
    (state) => state.runtime.skillSources,
  );
  // 兜底名录是纯内存推导（source 路径末段），渲染期直接算，无需状态
  const skillNames =
    runtimeSkillNames.length > 0
      ? runtimeSkillNames
      : skillNamesFromSources(skillSources);
  // 文件清单加载态：for = 已就绪的工作区路径（null = 还没加载过）
  const [filesState, setFilesState] = useState<{
    readonly for: string | null;
    readonly paths: readonly string[];
  }>({ for: null, paths: [] });
  const filesPendingForRef = useRef<string | null>(null);

  // 输入历史浏览（命令式索引，不进渲染态）
  const historyIndexRef = useRef<number | null>(null);
  const historyDraftRef = useRef("");

  // 草稿 scope 切换（工作区 × 会话变化）：旧 scope 先落盘，新 scope 载入存稿
  useEffect(() => {
    const previousKey = draftKeyRef.current;
    draftKeyRef.current = draftKey;
    if (draftKey === null || previousKey === draftKey) {
      return;
    }
    if (previousKey !== null) {
      writeDraft(previousKey, draftTextRef.current);
    }
    setDraft(readDraft(draftKey));
    historyIndexRef.current = null;
  }, [draftKey]);

  // 预填通道（事件总线）：外部送来的文本落进草稿并聚焦
  useEffect(() => {
    return onComposerPrefill((text) => {
      setDraft(text);
      requestAnimationFrame(() => {
        const element = textareaRef.current;
        if (element !== null) {
          element.focus();
          const end = element.value.length;
          element.setSelectionRange(end, end);
        }
      });
    });
  }, []);

  // 自动增长：先瞬时归零再按 scrollHeight 撑开，钳制在 MAX_HEIGHT_PX 内
  useEffect(() => {
    const element = textareaRef.current;
    if (element === null) {
      return;
    }
    element.style.height = "0px";
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [draft]);

  const mentionOptions = useMemo(() => {
    if (mention === null || filesState.for !== activePath) {
      return [];
    }
    return filterMentionOptions(filesState.paths, skillNames, mention.query);
  }, [mention, filesState, activePath, skillNames]);

  const slashOptions = useMemo(
    () =>
      slash === null
        ? []
        : filterSlashItems(
            buildSlashItems(skillNames, agentCommands),
            slash.query,
          ),
    [slash, skillNames, agentCommands],
  );

  /** 面板渲染行：分组变化处带一行组头（与前一项比较，无渲染中可变量）。 */
  const slashRows = useMemo(
    () =>
      slashOptions.map((item, index) => ({
        key: item.id,
        header:
          index === 0 || slashOptions[index - 1]?.group !== item.group
            ? item.group
            : null,
        item,
        index,
      })),
    [slashOptions],
  );

  // 键盘导航时选中项跟随滚动（长列表里 ↓ 到视口外时拉回可见）
  useEffect(() => {
    if (slash === null) {
      return;
    }
    document
      .querySelector('[aria-label="命令面板"] [aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [slash]);

  useEffect(() => {
    if (mention === null) {
      return;
    }
    document
      .querySelector('[aria-label="提及候选"] [aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [mention]);

  const mentionRows = useMemo(
    () =>
      mentionOptions.map((option, index) => ({
        key: `${option.kind}:${option.label}`,
        header:
          index === 0 || mentionOptions[index - 1]?.kind !== option.kind
            ? option.kind === "file"
              ? "文件"
              : "Skills"
            : null,
        option,
        index,
      })),
    [mentionOptions],
  );

  const ensureWorkspaceFiles = (): void => {
    if (
      activePath === null ||
      filesState.for === activePath ||
      filesPendingForRef.current === activePath
    ) {
      return;
    }
    filesPendingForRef.current = activePath;
    void listWorkspaceFiles(activePath).then((paths) => {
      filesPendingForRef.current = null;
      setFilesState({ for: activePath, paths });
    });
  };

  /** slash 动作执行（选中即做的 UI 行为，不进消息流）。 */
  const runSlashAction = (
    actionId: NonNullable<SlashItem["actionId"]>,
  ): void => {
    if (actionId === "clear") {
      useSessionStore.getState().clear();
    } else if (actionId === "diagnostics") {
      openSettingsOverlayTab("diagnostics");
    } else if (actionId === "retry") {
      useSessionStore.getState().retryLastPrompt();
    } else if (actionId === "wizard-sr") {
      useWorkbenchUiStore.getState().openAawWizard("sr");
    } else if (actionId === "wizard-ar") {
      useWorkbenchUiStore.getState().openAawWizard("ar");
    } else if (actionId === "wizard-dev") {
      useWorkbenchUiStore.getState().openAawWizard("dev");
    }
  };

  /** 选中 slash 条目：action 类移除 /token 并执行；insert 类替换为插入文本。 */
  const selectSlashItem = (item: SlashItem): void => {
    const element = textareaRef.current;
    const caret = element?.selectionStart ?? draft.length;
    const query = slash?.query ?? "";
    const replacement =
      item.kind === "insert" ? `${item.insertText ?? ""} ` : "";
    const result = replaceSlashToken(draft, caret, query, replacement);
    setDraft(result.text);
    setSlash(null);
    if (item.kind === "action" && item.actionId !== undefined) {
      runSlashAction(item.actionId);
    }
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (node !== null) {
        node.focus();
        node.setSelectionRange(result.caret, result.caret);
      }
    });
  };

  /** 选中 @ 候选：文件插 `@路径`，skill 插自然语言提示（agent 自行加载）。 */
  const insertMention = (option: MentionOption): void => {
    const element = textareaRef.current;
    const token = mention?.query ?? "";
    const caret = element?.selectionStart ?? draft.length;
    // @ 起点在 caret - token.length - 1；校验仍是 @（ IME/粘贴等边缘）
    const atIndex = caret - token.length - 1;
    const insert = option.insert;
    let nextText: string;
    let caretAfter: number;
    if (atIndex < 0 || draft[atIndex] !== "@") {
      nextText = `${draft}${draft.length > 0 ? " " : ""}${insert}`;
      caretAfter = nextText.length;
    } else {
      nextText = `${draft.slice(0, atIndex)}${insert}${draft.slice(caret)}`;
      caretAfter = atIndex + insert.length;
    }
    setDraft(nextText);
    setMention(null);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (node !== null) {
        node.focus();
        node.setSelectionRange(caretAfter, caretAfter);
      }
    });
  };

  const submit = (): void => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || disabled) {
      return;
    }
    recordPrompt(trimmed);
    historyIndexRef.current = null;
    if (isAgentRunning) {
      // 运行中提交 = 加入队列（轮次结束后按序发出）
      onEnqueue(trimmed);
    } else {
      onSend(trimmed);
    }
    // 发送/入队即清存稿（写穿透会因 setDraft("") 再补一次删键，这里先删是保序）
    if (draftKeyRef.current !== null) {
      writeDraft(draftKeyRef.current, "");
    }
    setDraft("");
    setMention(null);
    setSlash(null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // 输入法组词中的按键一律放行给 IME（导航键也不抢）
    if (event.nativeEvent.isComposing) {
      return;
    }
    // slash 命令面板开着的导航优先
    if (slash !== null) {
      if (slashOptions.length > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setSlash((current) =>
            current === null
              ? current
              : {
                  ...current,
                  index: Math.min(slashOptions.length - 1, current.index + 1),
                },
          );
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setSlash((current) =>
            current === null
              ? current
              : { ...current, index: Math.max(0, current.index - 1) },
          );
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          const item = slashOptions[slash.index] ?? slashOptions[0];
          if (item !== undefined) {
            selectSlashItem(item);
          }
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlash(null);
        return;
      }
    }
    // 提及面板开着的导航优先
    if (mention !== null) {
      if (mentionOptions.length > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setMention((current) =>
            current === null
              ? current
              : {
                  ...current,
                  index: Math.min(mentionOptions.length - 1, current.index + 1),
                },
          );
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setMention((current) =>
            current === null
              ? current
              : { ...current, index: Math.max(0, current.index - 1) },
          );
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          const option = mentionOptions[mention.index] ?? mentionOptions[0];
          if (option !== undefined) {
            insertMention(option);
          }
          return;
        }
      }
      if (event.key === "Escape") {
        // 关面板即消费掉 Esc：SessionView 的全局 Esc 停止按 defaultPrevented 让位
        event.preventDefault();
        setMention(null);
        return;
      }
    }
    // 输入历史：↑ 回溯（浏览态直接继续；起步要求空输入且光标在开头），
    // ↓ 前进 / 回到编辑中的草稿
    const caretAtStart = (event.currentTarget.selectionStart ?? 0) === 0;
    const history = getPromptHistory();
    if (
      event.key === "ArrowUp" &&
      history.length > 0 &&
      (historyIndexRef.current !== null || (caretAtStart && draft.length === 0))
    ) {
      event.preventDefault();
      if (historyIndexRef.current === null) {
        historyDraftRef.current = draft;
        historyIndexRef.current = history.length - 1;
      } else if (historyIndexRef.current > 0) {
        historyIndexRef.current -= 1;
      } else {
        return;
      }
      setDraft(history[historyIndexRef.current] ?? "");
      return;
    }
    if (event.key === "ArrowDown" && historyIndexRef.current !== null) {
      event.preventDefault();
      if (historyIndexRef.current < history.length - 1) {
        historyIndexRef.current += 1;
        setDraft(history[historyIndexRef.current] ?? "");
      } else {
        historyIndexRef.current = null;
        setDraft(historyDraftRef.current);
      }
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    event.preventDefault();
    submit();
  };

  const handleChange = (value: string, caret: number): void => {
    setDraft(value);
    const before = value.slice(0, caret);
    // 行首 / 命令面板（顿号归一）；与 @ 提及互斥
    const slashTrigger = detectSlashTrigger(before);
    if (slashTrigger !== null) {
      if (mention !== null) {
        setMention(null);
      }
      setSlash((current) =>
        current !== null && current.query === slashTrigger
          ? current
          : { query: slashTrigger, index: 0 },
      );
      return;
    }
    if (slash !== null) {
      setSlash(null);
    }
    const trigger = detectMentionTrigger(before);
    if (trigger === null) {
      if (mention !== null) {
        setMention(null);
      }
      return;
    }
    setMention((current) =>
      current !== null && current.query === trigger
        ? current
        : { query: trigger, index: 0 },
    );
    ensureWorkspaceFiles();
  };

  return (
    /* 悬浮留白：不贴边贴底（ZCode dock px-4 pb-4：左右 16px、底部 16px）；
       relative 承载提及面板（弹在整卡上方，盖住消息流底部而不被卡片的
       overflow-hidden 裁掉） */
    <div className="relative shrink-0" style={{ padding: "0 16px 16px" }}>
      {slash !== null ? (
        <div className="absolute inset-x-4 bottom-full mb-1 z-30">
          <div
            role="listbox"
            aria-label="命令面板"
            className={`mx-auto max-h-56 overflow-y-auto rounded-2xl border border-line bg-surface px-1 py-0.75 shadow-xs composer-pop ${widthClass}`}
          >
            {slashOptions.length === 0 ? (
              <p className="px-4 py-3 text-ui-base text-ink-subtlest">
                没有匹配的命令
              </p>
            ) : (
              slashRows.map(({ key, header, item, index }) => (
                <div key={key} className="py-px">
                  {header !== null ? (
                    <p className="flex h-8 items-center px-3 text-ui-base font-semibold uppercase tracking-wide text-ink-soft">
                      {header}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === slash.index}
                    // mousedown 先于焦点跳转：面板点击不丢输入焦点
                    onMouseDown={(event) => {
                      event.preventDefault();
                      selectSlashItem(item);
                    }}
                    className={`flex h-8 w-full items-center gap-3 rounded-xl px-3 text-left transition-colors ${
                      index === slash.index
                        ? "bg-selected text-ink"
                        : "text-ink-soft hover:bg-hover"
                    }`}
                  >
                    {/* label 上限 40% + 截断、描述 14px（ZCode
                        slashCommandPanelSections.tsx:34/:39） */}
                    <span className="max-w-[40%] shrink-0 truncate text-ui-base font-medium">
                      /{item.label}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-ui-base text-ink-subtlest">
                      {item.description}
                    </span>
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
      {mention !== null ? (
        <div className="absolute inset-x-4 bottom-full mb-1 z-30">
          <div
            role="listbox"
            aria-label="提及候选"
            className={`mx-auto max-h-56 overflow-y-auto rounded-2xl border border-line bg-surface px-1 py-0.75 shadow-xs composer-pop ${widthClass}`}
          >
            {mentionOptions.length === 0 ? (
              <p className="px-4 py-3 text-ui-base text-ink-subtlest">
                {filesState.for === activePath
                  ? "没有匹配的文件或 skill"
                  : "正在读取文件列表…"}
              </p>
            ) : (
              mentionRows.map(({ key, header, option, index }) => (
                <div key={key} className="py-px">
                  {header !== null ? (
                    <p className="flex h-8 items-center px-3 text-ui-base font-semibold uppercase tracking-wide text-ink-soft">
                      {header}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === mention.index}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      insertMention(option);
                    }}
                    className={`flex h-8 w-full items-center gap-3 rounded-xl px-3 text-left transition-colors ${
                      index === mention.index
                        ? "bg-selected text-ink"
                        : "text-ink-soft hover:bg-hover"
                    }`}
                  >
                    <span className="shrink-0 text-ink-mute">
                      {option.kind === "file" ? "@" : "✦"}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-ui-base font-medium">
                      {option.label}
                    </span>
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
      <div
        className={`composer-card mx-auto w-full overflow-hidden rounded-2xl border border-line bg-surface transition-[max-width] duration-150 ease-out ${widthClass}`}
      >
        {/* 上行：透明无边框的多行输入（ZCode 壳 p-3：文字距卡缘 12px） */}
        <div className="px-3 pb-0 pt-3">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => {
              handleChange(
                event.target.value,
                event.target.selectionStart ?? 0,
              );
            }}
            onKeyDown={handleKeyDown}
            aria-label="消息输入框"
            aria-autocomplete="list"
            aria-expanded={mention !== null}
            disabled={disabled}
            placeholder={
              isAgentRunning
                ? "agent 正在处理，输入内容 Enter 加入队列…"
                : "输入消息，Enter 发送，Shift+Enter 换行，/ 命令，@ 引用"
            }
            rows={1}
            className={`max-h-40 min-h-[2.5rem] w-full resize-none overflow-y-auto rounded bg-transparent text-ui-base leading-5 text-ink outline-none placeholder:text-ink-subtlest disabled:cursor-not-allowed disabled:opacity-60`}
          />
        </div>
        {/* 下行：左=skills/mcp + 审批模式 + 自动应答开关；右=模型 + 上下文圆环 + 发送/停止
            （ZCode 式：无分隔横线；工具栏行 items-end + 壳 p-3：与编辑器间距 12px、
            底距 12px，ChatPromptEditor.tsx:440-443） */}
        <div className="mt-3 flex items-end gap-1.5 px-3 pb-3">
          {approvalMode !== null ? (
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                modeBadgeClasses[approvalMode.id] ??
                "bg-raised/70 text-ink-mute"
              }`}
              title="审批模式"
            >
              {approvalMode.name}
            </span>
          ) : null}
          <StatusChipMenu
            title={`审批默认模式：客户端对权限请求的缺省应答（当前「${policyLabelOf(approvalPolicy)}」）`}
            menuLabel="审批默认模式"
            // 自动放行=放权给客户端自动应答，用琥珀警示色与每次询问区分
            tone={approvalPolicy === "auto-allow" ? "warn" : "neutral"}
            label={policyLabelOf(approvalPolicy)}
          >
            <div className="py-1">
              {approvalModeOptions.map((option) => (
                <MenuItemRow
                  key={option.value}
                  icon={
                    option.value === "auto-allow" ? (
                      <ShieldCheckIcon className="text-warn-ink" />
                    ) : (
                      <HandIcon />
                    )
                  }
                  title={
                    option.value === "auto-allow" ? "自动放行" : "每次询问"
                  }
                  description={
                    option.value === "auto-allow"
                      ? "默认允许工具调用，减少确认次数。"
                      : "改动文件前先向我确认。"
                  }
                  selected={option.value === approvalPolicy}
                  onClick={() => {
                    setApprovalPolicy(option.value);
                  }}
                />
              ))}
            </div>
          </StatusChipMenu>
          <span aria-hidden={true} className="flex-1" />
          <InputStatusRight />
          {/* 按钮形态（评审确认）：运行中「有草稿=发送（入队），无草稿=停止」；
              空闲时恒为发送。Esc 仍可全局停止（SessionView）。 */}
          {isAgentRunning && draft.trim().length === 0 ? (
            /* 停止：ZCode variant=secondary 次级钮（raised 即 zai secondary
               #363636 同档），非圆形危险钮；Esc 提示挂在自绘 tooltip 上 */
            <span className="group/send relative shrink-0">
              <button
                type="button"
                onClick={onCancel}
                disabled={turnState === "cancelling"}
                aria-label={turnState === "cancelling" ? "正在取消" : "停止"}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-raised text-ink transition-colors hover:bg-raised/80 disabled:pointer-events-none disabled:opacity-50"
              >
                <StopIcon />
              </button>
              <SendHintTooltip
                label={
                  turnState === "cancelling" ? "正在取消，等待确认" : "停止"
                }
                shortcut="Esc"
              />
            </span>
          ) : (
            /* 发送：rounded-lg 主钮（ZCode size-7 rounded-lg bg-brand
               text-foreground-inverse hover:bg-brand/80：zai-dark 白底黑箭头
               #ffffff/#000000，zai-light 黑底白字）；运行中即「加入队列」 */
            <span className="group/send relative shrink-0">
              <button
                type="button"
                onClick={submit}
                disabled={disabled || draft.trim().length === 0}
                aria-label={isAgentRunning ? "加入队列" : "发送"}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand text-foreground-inverse transition-colors hover:bg-brand/80 disabled:pointer-events-none disabled:opacity-50"
              >
                <ArrowUpIcon />
              </button>
              <SendHintTooltip
                label={
                  isAgentRunning ? "加入队列，当前轮结束后按序发出" : "发送"
                }
                shortcut="Enter"
              />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
