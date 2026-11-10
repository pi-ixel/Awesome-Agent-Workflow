import { useSessionValue, useRuntimeValue, useConversation } from "../../ui/bindings/conversationView.ts";
import { useAnnotationDraft, useAnnotationDraftService } from "../../ui/bindings/annotationDraftView.ts";
import { useProjectComposer } from "../../ui/bindings/composerView.ts";
import { useWorkspaceValue } from "../../ui/bindings/workspaceView.ts";
import { useRegisteredSnapshot } from "../../../../shared/state/useRegisteredSnapshot.ts";
import { useSessionCommands } from "./useSessionCommands.ts";
import type { SkillsService } from "../../../skills/service.ts";
import type { WorkflowEntryCommand } from "../../../workflow/types.ts";
import { ImageAttachments } from "./ImageAttachments.tsx";
import { readImageFiles, imageLimitError } from "./imageFiles.ts";
import type { ImageDrafts, ImageDraftStorage } from "../../composer/types.ts";
import type { ContentBlock } from "../../../../contracts/acp/protocol.ts";
import {
  decodeAnnotationMessage,
  encodeAnnotationMessage,
} from "../../composer/annotationMessage.ts";
import { AnnotationSummary } from "./AnnotationSummary.tsx";
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
 * - @ 提及：输入 `@` + 关键字弹多源候选（工作区文件由 Documents 提供
 *   + 会话已加载 skills），↑/↓ 选择、Enter/Tab 插入、Esc 关闭；
 *   文件插 `@相对路径` 纯文本、skill 插自然语言提示（agent 自行加载）；
 * - 预填通道：外部（再次发送 / 推荐入口）经 Project 的 composer 服务把文本
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

import type { ApprovalMode } from "../../types.ts";
import { useProjectPreferences } from "../../ui/preferencesView.tsx";
import { chatWidthClassOf } from "./chatWidth.ts";
import { MenuItemRow, StatusChipMenu } from "./StatusChipMenu.tsx";
import type { FileCandidates } from "./documentView.ts";
import { InputStatusRight } from "./InputStatusBar.tsx";
import { HandIcon, ShieldAlertIcon } from "../../../../shared/ui/icons.tsx";
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
  draftScopeKey,
  legacyNewDraftScopeKey,
  readDraft,
  writeDraft,
} from "../../composer/draftStore.ts";
import { projectDraftImageMigration, rememberDraftImageSource } from "../../composer/projectDraftMigration.ts";

/** 自动增长的高度上限（px）：ZCode 编辑器 max-h-40=160px，超过后转入内部滚动。 */
const MAX_HEIGHT_PX = 160;

/** 审批默认模式的芯片短词（完整语义在菜单项里）。 */
const approvalModeOptions: readonly { value: ApprovalMode; label: string }[] = [
  { value: "ask", label: "每次询问（弹出审批对话框）" },
  { value: "auto-allow", label: "自动放行（默认允许工具调用）" },
];

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
  readonly fileCandidates?: FileCandidates;
  readonly skillCandidates?: SkillsService["candidates"];
  readonly workflowEntries?: readonly WorkflowEntryCommand[];
  readonly openDiagnostics?: () => void;
  readonly isAgentRunning: boolean;
  /** ACP 连接建立中：输入与发送一并禁用（无会话可发）。 */
  readonly disabled?: boolean;
  readonly sendDisabled?: boolean;
  readonly onSend: (
    text: string,
    attachments?: readonly ContentBlock[],
  ) => boolean | void;
  /** 运行中提交：消息加入队列（轮次结束后按序发出）。 */
  readonly onEnqueue: (
    text: string,
    attachments?: readonly ContentBlock[],
  ) => boolean | void;
  readonly onCancel: () => void;
}

export function ChatInput({
  fileCandidates,
  skillCandidates,
  workflowEntries,
  openDiagnostics,
  isAgentRunning,
  disabled = false,
  sendDisabled = false,
  onSend,
  onEnqueue,
  onCancel,
}: ChatInputProps) {
  const [draft, setDraft] = useState("");
  const { clear, retryLastPrompt } = useSessionCommands();
  const foregroundSession = useConversation()?.session;
  const composer = useProjectComposer();
  const promptHistory = composer?.history;
  const imageStorage = composer?.imageDrafts;
  const supportsImages = useSessionValue((state) => state.supportsImages);
  const [imagesByScope, setImagesByScope] = useState<ImageDrafts>({});
  const [imageSaveFailed, setImageSaveFailed] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [loadingImage, setLoadingImage] = useState(false);
  const [loadedStorage, setLoadedStorage] = useState<ImageDraftStorage>();
  const imagesLoaded = !imageStorage || loadedStorage === imageStorage;
  const imagesRef = useRef<ImageDrafts>({});
  useEffect(() => {
    if (!imageStorage) return;
    const release = imageStorage.acquireEditor?.();
    let alive = true;
    imagesRef.current = {};
    void imageStorage.load()
      .then((saved) => {
        if (!alive) return;
        const combined = { ...saved };
        for (const [scope, pending] of Object.entries(imagesRef.current)) {
          combined[scope] = [...(saved[scope] ?? []), ...pending];
        }
        imagesRef.current = combined;
        setImagesByScope(combined);
        setLoadedStorage(imageStorage);
      })
      .catch(() => {
        if (alive) setAttachmentError("图片草稿读取失败，请重试");
      });
    return () => {
      alive = false;
      release?.();
    };
  }, [imageStorage]);
  useEffect(() => {
    if (!imageStorage || !imagesLoaded) return;
    imagesRef.current = imagesByScope;
    void imageStorage.save(imagesByScope).then(() => setImageSaveFailed(false), () => setImageSaveFailed(true));
  }, [imagesByScope, imagesLoaded, imageStorage]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const turnState = useSessionValue((state) => state.turnState);
  const agentKey = useSessionValue((state) => state.agentKey);
  const activeSessionId = useSessionValue((state) => state.activeSessionId);
  // 审批默认模式（ask / auto-allow）：客户端对权限请求的缺省应答策略，
  // 即时切换（与设置页同一字段）；「自动拒绝」已下线（误触后全拒，危险）
  const {
    preferences,
    values: { approvalMode: approvalPolicy, chatWidth },
  } = useProjectPreferences();
  // 输入卡宽度与消息流同档（对齐）
  const widthClass = chatWidthClassOf(chatWidth);
  const activePath = useWorkspaceValue((state) => state.activePath);

  // ---- 草稿 / 输入历史的持久化（见 draftStore / promptHistory 文件头）----
  // 历史 ↑/↓ 按（工作区 × 会话）分档；草稿按（工作区 × 会话）分档：
  // 切走时先把当前草稿落回旧 scope，再载入新 scope 的存稿
  const draftKey =
    activePath === null
      ? null
      : draftScopeKey(activePath, activeSessionId, agentKey);
  const imageScope = draftKey ?? "unbound";
  const images = imageStorage && imagesLoaded ? (imagesByScope[imageScope] ?? []) : [];
  const hasUnsupportedImages =
    images.length > 0 && !supportsImages && !sendDisabled;
  async function addImageFiles(files: File[]) {
    if (!supportsImages) {
      setAttachmentError("当前 Agent 不支持图片");
      return;
    }
    if (disabled || loadingImage || !imagesLoaded) return;
    const scope = imageScope;
    setLoadingImage(true);
    try {
      const added = await readImageFiles(files);
      const combined = [...(imagesRef.current[scope] ?? []), ...added];
      const error = imageLimitError(combined);
      if (error) throw new Error(error);
      const next = { ...imagesRef.current, [scope]: combined };
      imagesRef.current = next;
      setImagesByScope(next);
      setAttachmentError(null);
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : "图片读取失败",
      );
    } finally {
      setLoadingImage(false);
    }
  }
  const annotationDrafts = useAnnotationDraftService();
  const annotationDraft = useAnnotationDraft(annotationDrafts, draftKey);
  const annotationError = useRegisteredSnapshot(annotationDrafts, (state) => state?.error ?? null);
  const hasContent =
    draft.trim().length > 0 ||
    annotationDraft.annotations.length > 0 ||
    images.length > 0;
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
    promptHistory?.setScope(activePath, activeSessionId ?? "__new__", agentKey);
  }, [activePath, activeSessionId, agentKey, promptHistory]);

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
  // Agent 适配器提供归一化的技能名称和调用方式。
  const runtimeSkillNames = useRuntimeValue(
    (state) => state.runtime.skillNames,
  );
  const agentCommands = useRuntimeValue(
    (state) => state.availableCommands,
  );
  const skillInvocations = useRuntimeValue(
    (state) => state.runtime.skillInvocations,
  );
  const skillNames = useMemo(
    () => skillCandidates?.(runtimeSkillNames, skillInvocations) ?? [],
    [skillCandidates, runtimeSkillNames, skillInvocations],
  );
  const [files, setFiles] = useState<{
    readonly owner: FileCandidates;
    readonly project: string;
    readonly paths: readonly string[];
  }>();
  if (files && files.owner !== fileCandidates) setFiles(undefined);
  const filesReady = files?.owner === fileCandidates && files?.project === activePath;
  const mentioning = mention !== null;
  useEffect(() => {
    if (!mentioning || !fileCandidates || !activePath || filesReady) return;
    let current = true;
    void fileCandidates.listWorkspaceFiles(activePath).then((paths) => {
      if (current && fileCandidates.isActive())
        setFiles({ owner: fileCandidates, project: activePath, paths });
    });
    return () => {
      current = false;
    };
  }, [activePath, fileCandidates, filesReady, mentioning]);

  // 输入历史浏览（命令式索引，不进渲染态）
  const historyIndexRef = useRef<number | null>(null);
  const historyDraftRef = useRef("");

  // 草稿 scope 切换（工作区 × 会话变化）：旧 scope 先落盘，新 scope 载入存稿
  useEffect(() => {
    const previousKey = draftKeyRef.current;
    draftKeyRef.current = draftKey;
    if (draftKey === null) {
      return;
    }
    const legacyScope =
      activePath && activeSessionId === null && agentKey
        ? legacyNewDraftScopeKey(activePath, agentKey)
        : null;
    if (legacyScope && annotationDrafts) {
      // 热更新仍持有旧 scope 的当前输入优先，避免迁移时重复拼接。
      if (previousKey === legacyScope)
        writeDraft(draftKey, draftTextRef.current);
      annotationDrafts.prepareLegacyDraft(draftKey, legacyScope);
    }
    if (previousKey === draftKey) {
      if (!draftTextRef.current && readDraft(draftKey))
        setDraft(readDraft(draftKey));
      return;
    }
    if (
      previousKey !== null &&
      annotationDrafts?.consumeMigration(previousKey, draftKey)
    ) {
      const nextText =
        previousKey === legacyScope
          ? readDraft(draftKey)
          : [readDraft(draftKey), draftTextRef.current]
              .filter(Boolean)
              .join("\n\n");
      writeDraft(draftKey, nextText);
      writeDraft(previousKey, "");
      if (activeSessionId !== null) rememberDraftImageSource(draftKey, previousKey);
      setDraft(nextText);
    } else {
      if (previousKey !== null) writeDraft(previousKey, draftTextRef.current);
      setDraft(readDraft(draftKey));
    }
    if (draftKey.endsWith("/__new__"))
      annotationDrafts?.consumeMigration(draftKey, "");
    historyIndexRef.current = null;
  }, [draftKey, activePath, activeSessionId, agentKey, annotationDrafts]);

  useEffect(() => {
    if (!annotationDrafts || !imageStorage || !imagesLoaded || !draftKey) return;
    const migration = projectDraftImageMigration(draftKey, imagesRef.current);
    if (!migration) return;
    imagesRef.current = migration.images;
    setImagesByScope(migration.images);
    void imageStorage.save(migration.images)
      .then(() => annotationDrafts.finishLegacyDraft(draftKey, migration.from))
      .catch(() =>
        setAttachmentError("图片草稿迁移失败，旧附件已保留，请重试"),
      );
  }, [draftKey, imagesLoaded, activeSessionId, agentKey, annotationDrafts, imageStorage]);

  // Project 的预填通道：外部送来的文本落进草稿并聚焦
  useEffect(() => {
    return composer?.subscribePrefill((text, attachments) => {
      const attachmentScope = draftKeyRef.current ?? "unbound";
      const imagesToAdd = attachments
        .filter((block) => block.type === "image")
        .map((block, index) => ({ name: `图片 ${index + 1}`, block }));
      const combined = [...(imagesRef.current[attachmentScope] ?? []), ...imagesToAdd];
      if (imagesToAdd.length) {
        const error = imageLimitError(combined);
        if (error) {
          setAttachmentError(`${error}，请先整理当前附件再取回`);
          return false;
        }
      }
      const parsed = decodeAnnotationMessage(text);
      const scope = draftKeyRef.current;
      if (parsed && scope) {
        const store = annotationDrafts;
        if (!store) return false;
        store.ensure(scope);
        const existing =
          annotationDrafts?.getState().drafts[scope]?.annotations ?? [];
        if (
          !store.put(scope, [
            ...existing,
            ...parsed.annotations.filter(
              (a) => !existing.some((b) => b.id === a.id),
            ),
          ])
        )
          return false;
      }
      if (imagesToAdd.length) {
        const next = { ...imagesRef.current, [attachmentScope]: combined };
        imagesRef.current = next;
        setImagesByScope(next);
      }
      setDraft((current) =>
        [current, parsed?.text ?? text].filter(Boolean).join("\n\n"),
      );
      requestAnimationFrame(() => {
        const element = textareaRef.current;
        if (element !== null) {
          element.focus();
          const end = element.value.length;
          element.setSelectionRange(end, end);
        }
      });
      return true;
    });
  }, [annotationDrafts, composer]);

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
    if (mention === null) {
      return [];
    }
    return filterMentionOptions(
      filesReady ? (files?.paths ?? []) : [],
      skillNames,
      mention.query,
      skillInvocations,
    );
  }, [mention, files, filesReady, skillNames, skillInvocations]);

  const slashOptions = useMemo(
    () =>
      slash === null
        ? []
        : filterSlashItems(
            buildSlashItems(skillNames, agentCommands, skillInvocations, workflowEntries)
              .filter((item) => item.actionId !== "diagnostics" || openDiagnostics),
            slash.query,
          ),
    [slash, skillNames, agentCommands, skillInvocations, workflowEntries, openDiagnostics],
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

  /** slash 动作执行（选中即做的 UI 行为，不进消息流）。 */
  const runSlashAction = (
    actionId: NonNullable<SlashItem["actionId"]>,
  ): void => {
    if (actionId === "clear") {
      clear();
    } else if (actionId === "diagnostics") {
      openDiagnostics?.();
    } else if (actionId === "retry") {
      retryLastPrompt();
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
    if (item.kind === "action") {
      if (item.actionId) runSlashAction(item.actionId);
      else item.run?.();
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
    if (
      !hasContent ||
      disabled ||
      sendDisabled ||
      loadingImage ||
      !imagesLoaded
    ) {
      return;
    }
    if (imageLimitError(images)) {
      setAttachmentError(imageLimitError(images));
      return;
    }
    if (images.length && !supportsImages) {
      setAttachmentError(
        isAgentRunning
          ? "请等待当前轮次结束后发送图片"
          : "当前 Agent 未声明图片输入能力",
      );
      return;
    }
    const prompt = encodeAnnotationMessage(
      trimmed,
      annotationDraft.annotations,
    );
    const submittedScope = draftKeyRef.current;
    if (
      annotationDraft.annotations.length &&
      (!submittedScope ||
        !annotationDrafts?.submit(submittedScope, prompt))
    )
      return;
    const rejected = () => {
      annotationDrafts?.rejectSubmission(submittedScope, prompt);
    };
    let accepted: boolean | void;
    try {
      accepted = isAgentRunning
        ? images.length
          ? onEnqueue(
              prompt,
              images.map((image) => image.block),
            )
          : onEnqueue(prompt)
        : images.length
          ? onSend(
              prompt,
              images.map((image) => image.block),
            )
          : onSend(prompt);
    } catch {
      rejected();
      return;
    }
    if (accepted === false) {
      rejected();
      return;
    }
    const sentSessionId = foregroundSession?.getState().activeSessionId ?? null;
    promptHistory?.setScope(activePath, sentSessionId ?? "__new__", agentKey);
    if (sentSessionId !== null || activePath === null) {
      promptHistory?.record(decodeAnnotationMessage(prompt)?.text ?? prompt);
    }
    historyIndexRef.current = null;
    // 发送/入队即清存稿（写穿透会因 setDraft("") 再补一次删键，这里先删是保序）
    if (draftKeyRef.current !== null) {
      writeDraft(draftKeyRef.current, "");
    }
    setImagesByScope((current) => ({ ...current, [imageScope]: [] }));
    setAttachmentError(null);
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
    // 在按键时读取当前会话快照，历史回放完成后也立即可用。
    promptHistory?.setScope(activePath, activeSessionId ?? "__new__", agentKey);
    const history =
      (event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
      (activePath !== null && activeSessionId === null)
        ? []
        : (promptHistory?.get(
            activeSessionId === null
              ? []
              : (foregroundSession?.getState().items ?? [])
                  .filter((item) => item.kind === "user")
                  .map(
                    (item) =>
                      decodeAnnotationMessage(item.text)?.text ?? item.text,
                  ),
          ) ?? []);
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
                {filesReady || !fileCandidates || !activePath
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
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files);
          if (!files.length) return;
          event.preventDefault();
          void addImageFiles(files);
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            event.dataTransfer.dropEffect = supportsImages ? "copy" : "none";
          }
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          void addImageFiles(Array.from(event.dataTransfer.files));
        }}
        className={`composer-card mx-auto w-full overflow-hidden rounded-2xl border border-line bg-surface transition-[max-width] duration-150 ease-out ${widthClass}`}
      >
        {imageSaveFailed && (
          <div role="alert">图片草稿未保存，关闭后可能丢失。 <button type="button" onClick={() => {
            void imageStorage?.save(imagesRef.current).then(() => setImageSaveFailed(false), () => setImageSaveFailed(true));
          }}>重试保存</button></div>
        )}
        {annotationError && (
          <p role="alert" className="px-3 pt-2 text-ui-caption text-danger-ink">
            {annotationError}
          </p>
        )}
        <AnnotationSummary
          key={draftKey}
          annotations={annotationDraft.annotations}
          onClear={() =>
            draftKey
              ? (annotationDrafts?.put(draftKey, []) ?? false)
              : false
          }
          onChange={(a) => {
            if (draftKey)
              return annotationDrafts?.put(
                draftKey,
                annotationDraft.annotations.map((item) =>
                  item.id === a.id ? a : item,
                ),
              ) ?? false;
            return false;
          }}
          onRemove={(id) => {
            if (draftKey)
              annotationDrafts?.put(
                draftKey,
                annotationDraft.annotations.filter((a) => a.id !== id),
              );
          }}
        />
        {Object.entries(annotationDraft.submissions)
          .filter(([, entry]) => entry.state === "uncertain")
          .map(([id, entry]) => (
            <div
              key={id}
              className="flex items-center justify-between gap-2 px-3 py-1 text-ui-caption text-ink-mute"
            >
              <span>上次批注消息未确认完成，请先查看会话，避免重复执行</span>
              {entry.state === "uncertain" && (
                <button
                  type="button"
                  className="shrink-0 rounded px-2 py-1 hover:bg-hover"
                  onClick={() => {
                    if (!draftKey) return;
                    const restored = annotationDrafts?.recover(draftKey, id);
                    if (typeof restored === "string")
                      setDraft((current) =>
                        [current, restored].filter(Boolean).join("\n\n"),
                      );
                  }}
                >
                  取回输入框
                </button>
              )}
            </div>
          ))}
        <ImageAttachments
          images={images}
          onRemove={(index) =>
            setImagesByScope((current) => ({
              ...current,
              [imageScope]: (current[imageScope] ?? []).filter(
                (_, i) => i !== index,
              ),
            }))
          }
        />
        {loadingImage && (
          <p className="px-3 pt-2 text-ui-caption text-ink-mute">
            正在添加图片…
          </p>
        )}
        {(attachmentError || hasUnsupportedImages) && (
          <p role="alert" className="px-3 pt-2 text-ui-caption text-danger-ink">
            {attachmentError ??
              "当前 Agent 不支持图片，请移除图片或切换到支持图片的 Agent"}
          </p>
        )}
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
        {/* 下行：左=AAW 审批策略；右=模型 + 上下文圆环 + 发送/停止
            （ZCode 式：无分隔横线；工具栏行 items-end + 壳 p-3：与编辑器间距 12px、
            底距 12px，ChatPromptEditor.tsx:440-443） */}
        <div className="mt-3 flex items-end gap-1.5 px-3 pb-3">
          <StatusChipMenu
            title={`审批默认模式：客户端对权限请求的缺省应答（当前「${policyLabelOf(approvalPolicy)}」）`}
            menuLabel="审批默认模式"
            variant="permission"
            // 自动放行=放权给客户端自动应答，用琥珀警示色与每次询问区分
            tone={approvalPolicy === "auto-allow" ? "warn" : "neutral"}
            label={
              <>
                <span aria-hidden="true">
                  {approvalPolicy === "auto-allow" ? (
                    <ShieldAlertIcon className="size-4" />
                  ) : (
                    <HandIcon className="size-4" strokeWidth={2} />
                  )}
                </span>
                {policyLabelOf(approvalPolicy)}
              </>
            }
          >
            <div className="space-y-0.5">
              {approvalModeOptions.map((option) => (
                <MenuItemRow
                  key={option.value}
                  variant="permission"
                  tone={option.value === "auto-allow" ? "warn" : "neutral"}
                  icon={
                    option.value === "auto-allow" ? (
                      <ShieldAlertIcon />
                    ) : (
                      <HandIcon strokeWidth={2} />
                    )
                  }
                  title={
                    option.value === "auto-allow" ? "自动放行" : "每次询问"
                  }
                  description={
                    option.value === "auto-allow"
                      ? "自动批准可放行的请求，其余仍询问。"
                      : "收到权限请求时，由你确认。"
                  }
                  selected={option.value === approvalPolicy}
                  onClick={() => {
                    preferences?.setApprovalMode(option.value);
                  }}
                />
              ))}
            </div>
          </StatusChipMenu>
          <span aria-hidden={true} className="flex-1" />
          <InputStatusRight />
          {/* 按钮形态（评审确认）：运行中「有草稿=发送（入队），无草稿=停止」；
              空闲时恒为发送。Esc 仍可全局停止（SessionView）。 */}
          {isAgentRunning && !hasContent ? (
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
                disabled={
                  disabled ||
                  sendDisabled ||
                  !hasContent ||
                  hasUnsupportedImages
                }
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
