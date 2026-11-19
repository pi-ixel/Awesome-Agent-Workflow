import { IconButton } from "../../../../shared/ui/IconButton.tsx";
import { UiIcon } from "../../../../shared/ui/UiIcon.tsx";
import { HintSurface } from "../../../../shared/ui/controls/HintSurface.tsx";
import {
  useSessionValue,
  useRuntimeValue,
  useConversation,
} from "../../ui/bindings/conversationView.ts";
import {
  useAnnotationDraft,
  useAnnotationDraftService,
} from "../../ui/bindings/annotationDraftView.ts";
import { useProjectComposer } from "../../ui/bindings/composerView.ts";
import { useWorkspaceValue } from "../../ui/bindings/workspaceView.ts";
import { useRegisteredSnapshot } from "../../../../shared/state/useRegisteredSnapshot.ts";
import { useSessionCommands } from "./useSessionCommands.ts";
import type {
  SlashSkillCatalog,
  SlashSkillDescriptions,
  SkillsService,
} from "../../../skills/service.ts";
import { sessionAgentId } from "../../sessions/sessionDeletion.ts";
import {
  promptWithEditableSkills,
  readSkillReferences,
  skillPrompt,
  skillReferenceKey,
  withSkillReferences,
} from "../../composer/skillReferences.ts";
import type { SendOptions } from "../sessionStore.ts";
import type { ProjectSlashEntry } from "../../ui/extension.ts";
import { ImageAttachments } from "./ImageAttachments.tsx";
import { readImageFiles, imageLimitError } from "./imageFiles.ts";
import type { ImageDrafts, ImageDraftStorage } from "../../composer/types.ts";
import type { ContentBlock } from "../../../../contracts/acp/protocol.ts";
import { isSteerOutboxEntry } from "../queuedPrompt.ts";
import {
  decodeAnnotationMessage,
  encodeAnnotationMessage,
} from "../../composer/annotationMessage.ts";
import { AnnotationSummary } from "./AnnotationSummary.tsx";
import { BrowserElementSummary } from "./BrowserElementSummary.tsx";
import { SkillReferenceTokens } from "./SkillReferenceTokens.tsx";
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
 *   （clear / diagnostics / retry，选中即执行）、扩展入口（如工作流的 /sr /ar /dev
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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import type { ApprovalMode } from "../../types.ts";
import { useProjectPreferences } from "../../ui/preferencesView.tsx";
import { chatWidthClassOf } from "./chatWidth.ts";
import { MenuItemRow, StatusChipMenu } from "./StatusChipMenu.tsx";
import type { FileCandidates } from "./documentView.ts";
import { InputStatusRight } from "./InputStatusBar.tsx";
import {
  HandIcon,
  ShieldAlertIcon,
  SkillIcon,
} from "../../../../shared/ui/icons.tsx";
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
  clearDraft,
  clearSentDraft,
  draftScopeKey,
  legacyNewDraftScopeKey,
  readDraft,
  readDraftRecoveries,
  writeDraft,
} from "../../composer/draftStore.ts";
import {
  projectDraftImageMigration,
  rememberDraftImageSource,
} from "../../composer/projectDraftMigration.ts";

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
    <UiIcon
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="ui-icon-16"
    >
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </UiIcon>
  );
}

/** 停止：ZCode 式次级钮（variant=secondary）内的实心方块（SquareIcon size-4）。 */
function StopIcon() {
  return (
    <UiIcon viewBox="0 0 24 24" fill="currentColor" className="ui-icon-16">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </UiIcon>
  );
}

function ComposerActionHint({
  label,
  shortcut,
  children,
}: {
  readonly label: string;
  readonly shortcut: string;
  readonly children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <div
      className="relative shrink-0"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      {children}
      <HintSurface
        open={hovered || focused}
        className="pointer-events-none absolute bottom-full right-0 z-30 mb-0.5 flex items-center gap-2 whitespace-nowrap px-2.5 py-1 pr-1 text-ui-sm font-medium"
      >
        {label}
        <kbd className="inline-flex h-4 items-center rounded-sm bg-tooltip-tag px-1.5 font-mono text-ui-xs font-medium text-tooltip-tag-ink">
          {shortcut}
        </kbd>
      </HintSurface>
    </div>
  );
}

export interface ChatInputProps {
  readonly queue?: ReactNode;
  readonly fileCandidates?: FileCandidates;
  readonly skillCandidates?: SkillsService["candidates"];
  readonly resolveSlashSkills?: SkillsService["resolveSlashSkills"];
  readonly skillWorkspace?: string | null;
  /** 扩展给「/」菜单的条目与这组的标题。 */
  readonly extensionEntries?: readonly ProjectSlashEntry[];
  readonly extensionGroup?: string;
  readonly openDiagnostics?: () => void;
  readonly isAgentRunning: boolean;
  /** ACP 连接建立中：输入与发送一并禁用（无会话可发）。 */
  readonly disabled?: boolean;
  readonly sendDisabled?: boolean;
  readonly onSend: (
    text: string,
    attachments?: readonly ContentBlock[],
    options?: SendOptions,
  ) => boolean | void;
  /** 运行中提交：消息加入队列（轮次结束后按序发出）。 */
  readonly onEnqueue: (
    text: string,
    attachments?: readonly ContentBlock[],
    options?: SendOptions,
  ) => boolean | void;
  readonly onSteer?: (
    text: string,
    attachments?: readonly ContentBlock[],
    options?: SendOptions,
  ) => boolean;
  readonly onCancel: () => void;
}

export function ChatInput({
  queue,
  fileCandidates,
  skillCandidates,
  resolveSlashSkills,
  skillWorkspace,
  extensionEntries,
  extensionGroup,
  openDiagnostics,
  isAgentRunning,
  disabled = false,
  sendDisabled = false,
  onSend,
  onEnqueue,
  onSteer,
  onCancel,
}: ChatInputProps) {
  const [draft, setDraft] = useState("");
  const supportsSteer =
    useSessionValue((state) => state.supportsSteer) && !!onSteer;
  const steerAgentId = useSessionValue((state) => state.steerAgentId);
  const steerPhase = useSessionValue((state) => state.steerPhase);
  const awaitingUser = useSessionValue((state) => state.isAwaitingUser);
  const { clear, retryLastPrompt, removeQueuedPromptById, retryQueueSave } =
    useSessionCommands();
  const queuedPrompts = useSessionValue((state) => state.queuedPrompts);
  const activeSteerIds = useSessionValue((state) => state.activeSteerIds);
  const queueSaveError = useSessionValue((state) => state.queueSaveError);
  const isConnecting = useSessionValue((state) => state.isConnecting);
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
    void imageStorage
      .load()
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
    void imageStorage.save(imagesByScope).then(
      () => setImageSaveFailed(false),
      () => setImageSaveFailed(true),
    );
  }, [imagesByScope, imagesLoaded, imageStorage]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const skillRailRef = useRef<HTMLDivElement | null>(null);
  const [skillRailWidth, setSkillRailWidth] = useState(0);
  const turnState = useSessionValue((state) => state.turnState);
  const agentKey = useSessionValue((state) => state.agentKey);
  const sessionAgent = agentKey === undefined ? null : sessionAgentId(agentKey);
  const slashSkills = useMemo(
    () => (sessionAgent ? resolveSlashSkills?.(sessionAgent) : undefined),
    [resolveSlashSkills, sessionAgent],
  );
  const usesSkillReferences = slashSkills !== undefined;
  const { text: draftText, references: skillReferences } = useMemo(
    () => readSkillReferences(draft),
    [draft],
  );
  const hasSkillReferences = skillReferences.length > 0;
  // 引用浮在首行，文本域只缩进首行，后续行仍使用完整宽度。
  useLayoutEffect(() => {
    const rail = skillRailRef.current;
    if (!hasSkillReferences || !rail) return;
    const measure = () => setSkillRailWidth(rail.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    return () => observer.disconnect();
  }, [hasSkillReferences]);
  const activeSessionId = useSessionValue((state) => state.activeSessionId);
  // 审批默认模式（ask / auto-allow）：客户端对权限请求的缺省应答策略，
  // 即时切换（与设置页同一字段）；「自动拒绝」已下线（误触后全拒，危险）
  const {
    preferences,
    values: { approvalMode: approvalPolicy, chatWidth, interactionByAgent },
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
  const agentInteraction = steerAgentId
    ? interactionByAgent[steerAgentId]
    : undefined;
  const running = isAgentRunning || !!steerPhase;
  const steering =
    running && supportsSteer && agentInteraction?.mode === "steer";
  const steerDisabled =
    steering && (awaitingUser || (turnState !== "running" && !steerPhase));
  const images =
    imageStorage && imagesLoaded ? (imagesByScope[imageScope] ?? []) : [];
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
  const annotationError = useRegisteredSnapshot(
    annotationDrafts,
    (state) => state?.error ?? null,
  );
  const hasContent =
    draft.trim().length > 0 ||
    annotationDraft.annotations.length > 0 ||
    annotationDraft.browserElements.length > 0 ||
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
  // / 命令面板：行首触发，目录 = 内置命令 + 扩展入口 + skills
  const [slash, setSlash] = useState<{
    readonly query: string;
    readonly index: number;
  } | null>(null);
  const slashOpen = slash !== null;
  const listSlashCatalog = slashSkills?.listCatalog;
  const listSlashSkills = listSlashCatalog ?? slashSkills?.listDescriptions;
  const slashWorkspace =
    skillWorkspace === undefined ? activePath : skillWorkspace;
  const slashRequest = useMemo(
    () =>
      slashOpen && listSlashSkills
        ? { list: listSlashSkills, project: slashWorkspace }
        : null,
    [listSlashSkills, slashOpen, slashWorkspace],
  );
  const [slashResult, setSlashResult] = useState<{
    request: NonNullable<typeof slashRequest>;
    catalog: SlashSkillCatalog | SlashSkillDescriptions | null;
  }>();
  const loadedSkills =
    slashResult?.request === slashRequest ? slashResult.catalog : undefined;
  const slashCatalog =
    loadedSkills && "skills" in loadedSkills ? loadedSkills : undefined;
  const descriptions =
    loadedSkills && "descriptions" in loadedSkills
      ? loadedSkills.descriptions
      : undefined;
  const isCatalogPending =
    !!listSlashCatalog && !!slashRequest && !slashCatalog;
  useEffect(() => {
    if (!slashRequest) return;
    let current = true;
    void slashRequest.list(slashRequest.project).then(
      (catalog) => {
        if (current) setSlashResult({ request: slashRequest, catalog });
      },
      () => {
        if (current) setSlashResult({ request: slashRequest, catalog: null });
      },
    );
    return () => {
      current = false;
    };
  }, [slashRequest]);
  // Agent 适配器提供归一化的技能名称和调用方式。
  const runtimeSkillNames = useRuntimeValue(
    (state) => state.runtime.skillNames,
  );
  const agentCommands = useRuntimeValue((state) => state.availableCommands);
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
  const filesReady =
    files?.owner === fileCandidates && files?.project === activePath;
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
      clearDraft(previousKey);
      if (activeSessionId !== null)
        rememberDraftImageSource(draftKey, previousKey);
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
    if (!annotationDrafts || !imageStorage || !imagesLoaded || !draftKey)
      return;
    const migration = projectDraftImageMigration(draftKey, imagesRef.current);
    if (!migration) return;
    imagesRef.current = migration.images;
    setImagesByScope(migration.images);
    void imageStorage
      .save(migration.images)
      .then(() => annotationDrafts.finishLegacyDraft(draftKey, migration.from))
      .catch(() =>
        setAttachmentError("图片草稿迁移失败，旧附件已保留，请重试"),
      );
  }, [
    draftKey,
    imagesLoaded,
    activeSessionId,
    agentKey,
    annotationDrafts,
    imageStorage,
  ]);

  // Project 的预填通道：外部送来的文本落进草稿并聚焦
  useEffect(() => {
    return composer?.subscribePrefill((text, attachments, options) => {
      const attachmentScope = draftKeyRef.current ?? "unbound";
      if (
        options?.ifEmpty &&
        (draftTextRef.current.trim() ||
          !imagesLoaded ||
          (imagesRef.current[attachmentScope]?.length ?? 0) > 0 ||
          (annotationDrafts?.getState().drafts[attachmentScope]?.annotations
            .length ?? 0) > 0)
      )
        return false;
      const imagesToAdd = attachments
        .filter((block) => block.type === "image")
        .map((block, index) => ({ name: `图片 ${index + 1}`, block }));
      const combined = [
        ...(imagesRef.current[attachmentScope] ?? []),
        ...imagesToAdd,
      ];
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
        const draft = store.getState().drafts[scope];
        const existing = draft?.annotations ?? [];
        if (
          !store.put(scope, [
            ...existing,
            ...parsed.annotations.filter(
              (a) => !existing.some((b) => b.id === a.id),
            ),
          ])
        )
          return false;
        const existingElements = draft?.browserElements ?? [];
        if (
          !store.putBrowserElements(scope, [
            ...existingElements,
            ...parsed.browserElements.filter(
              (element) =>
                !existingElements.some(
                  (existing) => existing.referenceId === element.referenceId,
                ),
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
  }, [annotationDrafts, composer, imagesLoaded]);

  // An older client may have saved an outbox entry into the draft before leaving the queue.
  useEffect(() => {
    if (!draftKey || isConnecting || !queuedPrompts.length) return;
    const recovered = new Set(
      readDraftRecoveries(draftKey).map(({ id }) => id),
    );
    for (const item of queuedPrompts) {
      if (
        isSteerOutboxEntry(item) &&
        item.id &&
        recovered.has(item.id) &&
        !activeSteerIds?.includes(item.id)
      )
        removeQueuedPromptById(item.id);
    }
  }, [
    activeSteerIds,
    draftKey,
    isConnecting,
    queuedPrompts,
    removeQueuedPromptById,
  ]);

  // 自动增长：先瞬时归零再按 scrollHeight 撑开，钳制在 MAX_HEIGHT_PX 内
  useEffect(() => {
    const element = textareaRef.current;
    if (element === null) {
      return;
    }
    element.style.height = "0px";
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT_PX)}px`;
    if (skillRailRef.current) {
      skillRailRef.current.style.visibility =
        element.scrollTop > 0 ? "hidden" : "";
    }
  }, [draftText, hasSkillReferences, skillRailWidth]);

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
            buildSlashItems(
              isCatalogPending ? [] : skillNames,
              isCatalogPending ? [] : agentCommands,
              skillInvocations,
              extensionEntries,
              extensionGroup,
              slashCatalog,
              usesSkillReferences,
              descriptions,
            ).filter(
              (item) => item.actionId !== "diagnostics" || openDiagnostics,
            ),
            slash.query,
            !!listSlashCatalog,
          ),
    [
      slash,
      isCatalogPending,
      listSlashCatalog,
      slashCatalog,
      descriptions,
      usesSkillReferences,
      skillNames,
      agentCommands,
      skillInvocations,
      extensionEntries,
      extensionGroup,
      openDiagnostics,
    ],
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
    const caret = element?.selectionStart ?? draftText.length;
    const query = slash?.query ?? "";
    const replacement =
      item.kind === "insert" && !item.skillReference
        ? `${item.insertText ?? ""} `
        : "";
    const result = replaceSlashToken(draftText, caret, query, replacement);
    const reference = item.skillReference;
    const references =
      reference &&
      !skillReferences.some(
        (item) => skillReferenceKey(item) === skillReferenceKey(reference),
      )
        ? [...skillReferences, reference]
        : skillReferences;
    setDraft(withSkillReferences(result.text, references));
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
    const caret = element?.selectionStart ?? draftText.length;
    // @ 起点在 caret - token.length - 1；校验仍是 @（ IME/粘贴等边缘）
    const atIndex = caret - token.length - 1;
    const insert = option.insert;
    let nextText: string;
    let caretAfter: number;
    if (atIndex < 0 || draftText[atIndex] !== "@") {
      nextText = `${draftText}${draftText.length > 0 ? " " : ""}${insert}`;
      caretAfter = nextText.length;
    } else {
      nextText = `${draftText.slice(0, atIndex)}${insert}${draftText.slice(caret)}`;
      caretAfter = atIndex + insert.length;
    }
    setDraft(withSkillReferences(nextText, skillReferences));
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
    if (steerDisabled) return;
    const message = skillPrompt(draftText, skillReferences);
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
      message.text,
      annotationDraft.annotations,
      annotationDraft.browserElements,
    );
    const submittedScope = draftKeyRef.current;
    if (
      (annotationDraft.annotations.length ||
        annotationDraft.browserElements.length) &&
      (!submittedScope || !annotationDrafts?.submit(submittedScope, prompt))
    )
      return;
    const rejected = () => {
      annotationDrafts?.rejectSubmission(submittedScope, prompt);
    };
    let accepted: boolean | void;
    try {
      const dispatch = running ? (steering ? onSteer : onEnqueue) : onSend;
      const attachments = images.length
        ? images.map((image) => image.block)
        : undefined;
      accepted = message.skillReferences.length
        ? dispatch(prompt, attachments, {
            skillReferences: message.skillReferences,
          })
        : attachments
          ? dispatch(prompt, attachments)
          : dispatch(prompt);
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
      promptHistory?.record(
        promptWithEditableSkills(message.text, message.skillReferences),
      );
    }
    historyIndexRef.current = null;
    // 发送/入队即清存稿（写穿透会因 setDraft("") 再补一次删键，这里先删是保序）
    if (draftKeyRef.current !== null) {
      clearSentDraft(draftKeyRef.current);
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
    if (
      event.key === "Backspace" &&
      event.currentTarget.selectionStart === 0 &&
      event.currentTarget.selectionEnd === 0 &&
      skillReferences.length
    ) {
      event.preventDefault();
      setDraft(withSkillReferences(draftText, skillReferences.slice(0, -1)));
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
                  .map((item) =>
                    promptWithEditableSkills(
                      decodeAnnotationMessage(item.text)?.text ?? item.text,
                      item.skillReferences,
                    ),
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
    setDraft(withSkillReferences(value, skillReferences));
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
            className={`mx-auto max-h-56 overflow-y-auto rounded-2xl border border-line bg-surface px-1 py-0.75 shadow-floating selection-popup ${widthClass}`}
          >
            {isCatalogPending && (
              <p
                role="status"
                className="px-4 py-2 text-ui-caption text-ink-mute"
              >
                {loadedSkills === null
                  ? "技能目录读取失败，重新输入 / 可重试。"
                  : "正在读取技能目录…"}
              </p>
            )}
            {slashOptions.length === 0 && !isCatalogPending ? (
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
                    className={`flex min-h-8 w-full items-center gap-3 rounded-xl px-3 text-left transition-colors ${
                      index === slash.index
                        ? "bg-selected text-ink"
                        : "text-ink-soft hover:bg-hover"
                    }`}
                  >
                    {/* label 上限 40% + 截断、描述 14px（ZCode
                        slashCommandPanelSections.tsx:34/:39） */}
                    <span className="flex max-w-[40%] shrink-0 items-center gap-1.5 text-ui-base font-medium">
                      {item.skillReference ? (
                        <SkillIcon className="ui-icon-16 shrink-0" />
                      ) : item.Icon ? (
                        <item.Icon className="ui-icon-16 shrink-0" />
                      ) : null}
                      <span
                        className="truncate"
                        data-hint={item.skillReference?.path}
                      >
                        {item.skillReference || item.Icon ? item.label : `/${item.label}`}
                      </span>
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
            className={`mx-auto max-h-56 overflow-y-auto rounded-2xl border border-line bg-surface px-1 py-0.75 shadow-floating selection-popup ${widthClass}`}
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
                    className={`flex min-h-8 w-full items-center gap-3 rounded-xl px-3 text-left transition-colors ${
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
        className={`composer-card @container/composer mx-auto w-full overflow-hidden rounded-2xl border border-line bg-surface transition-[max-width] duration-150 ease-out [--composer-inline-inset:calc(var(--spacing)*4.5_+_var(--ui-icon-unit)*2)] ${widthClass}`}
      >
        {queue}
        {imageSaveFailed && (
          <div role="alert">
            图片草稿未保存，关闭后可能丢失。{" "}
            <button
              type="button"
              onClick={() => {
                void imageStorage?.save(imagesRef.current).then(
                  () => setImageSaveFailed(false),
                  () => setImageSaveFailed(true),
                );
              }}
            >
              重试保存
            </button>
          </div>
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
            draftKey ? (annotationDrafts?.put(draftKey, []) ?? false) : false
          }
          onChange={(a) => {
            if (draftKey)
              return (
                annotationDrafts?.put(
                  draftKey,
                  annotationDraft.annotations.map((item) =>
                    item.id === a.id ? a : item,
                  ),
                ) ?? false
              );
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
        <BrowserElementSummary
          elements={annotationDraft.browserElements}
          onRemove={(referenceId) =>
            draftKey
              ? (annotationDrafts?.putBrowserElements(
                  draftKey,
                  annotationDraft.browserElements.filter(
                    (element) => element.referenceId !== referenceId,
                  ),
                ) ?? false)
              : false
          }
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
        {queueSaveError ? (
          <div role="alert" className="px-3 pt-2 text-ui-caption text-warn-ink">
            {queueSaveError}{" "}
            <button type="button" onClick={retryQueueSave}>
              重试保存
            </button>
          </div>
        ) : null}
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
        {/* 左侧内距对齐审批按钮的盾牌描边，包含按钮内距和 SVG 留白。 */}
        <div
          className={`px-[var(--composer-inline-inset)] pb-0 pt-3 ${
            usesSkillReferences || hasSkillReferences ? "relative flex" : ""
          }`}
        >
          <SkillReferenceTokens
            references={skillReferences}
            railRef={skillRailRef}
          />
          <textarea
            ref={textareaRef}
            value={draftText}
            onChange={(event) => {
              handleChange(
                event.target.value,
                event.target.selectionStart ?? 0,
              );
            }}
            onKeyDown={handleKeyDown}
            onScroll={(event) => {
              if (skillRailRef.current) {
                skillRailRef.current.style.visibility =
                  event.currentTarget.scrollTop > 0 ? "hidden" : "";
              }
            }}
            aria-label="消息输入框"
            aria-autocomplete="list"
            aria-expanded={mention !== null}
            disabled={disabled}
            placeholder={
              isAgentRunning
                ? steering
                  ? "输入补充内容…"
                  : "agent 正在处理，输入内容 Enter 加入队列…"
                : "输入消息，Enter 发送，Shift+Enter 换行，/ 命令，@ 引用"
            }
            rows={1}
            style={
              hasSkillReferences && skillRailWidth > 0
                ? {
                    textIndent: `calc(${skillRailWidth}px + var(--spacing) * 2)`,
                  }
                : undefined
            }
            className={`max-h-40 min-h-[2.5rem] resize-none overflow-y-auto rounded bg-transparent text-ui-base leading-5 text-ink outline-none placeholder:text-ink-subtlest disabled:cursor-not-allowed disabled:opacity-60 ${usesSkillReferences || hasSkillReferences ? "min-w-0 flex-1" : "w-full"}`}
          />
        </div>
        {/* 下行：左=AAW 审批策略；右=模型 + 上下文圆环 + 发送/停止
            （ZCode 式：无分隔横线；工具栏行 items-end + 壳 p-3：与编辑器间距 12px、
            底距 12px，ChatPromptEditor.tsx:440-443） */}
        <div className="mt-3 flex items-end gap-1.5 ps-3 pe-[var(--composer-inline-inset)] pb-3">
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
                    <ShieldAlertIcon className="ui-icon-16" />
                  ) : (
                    <HandIcon className="ui-icon-16" strokeWidth={2} />
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
          {running && !hasContent ? (
            /* 停止：ZCode variant=secondary 次级钮（raised 即 zai secondary
               #363636 同档），非圆形危险钮；Esc 提示挂在自绘 tooltip 上 */
            <ComposerActionHint
              label={
                !steering && turnState === "cancelling"
                  ? "正在取消，等待确认"
                  : "停止"
              }
              shortcut="Esc"
            >
              <IconButton
                type="button"
                onClick={onCancel}
                disabled={!steering && turnState === "cancelling"}
                aria-label={
                  !steering && turnState === "cancelling" ? "正在取消" : "停止"
                }
                className="flex shrink-0 items-center justify-center rounded-lg bg-raised text-ink transition-colors hover:bg-raised/80 disabled:pointer-events-none disabled:opacity-50"
              >
                <StopIcon />
              </IconButton>
            </ComposerActionHint>
          ) : (
            /* 发送：rounded-lg 主钮（ZCode size-7 rounded-lg bg-brand
               text-foreground-inverse hover:bg-brand/80：zai-dark 白底黑箭头
               #ffffff/#000000，zai-light 黑底白字）；运行中即「加入队列」 */
            <ComposerActionHint
              label={
                running && !steering ? "加入队列，当前轮结束后按序发出" : "发送"
              }
              shortcut="Enter"
            >
              <IconButton
                type="button"
                onClick={() => submit()}
                disabled={
                  disabled ||
                  sendDisabled ||
                  steerDisabled ||
                  !hasContent ||
                  hasUnsupportedImages
                }
                aria-label={running && !steering ? "加入队列" : "发送"}
                className="flex shrink-0 items-center justify-center rounded-lg bg-brand text-foreground-inverse transition-colors hover:bg-brand/80 disabled:pointer-events-none disabled:opacity-50"
              >
                <ArrowUpIcon />
              </IconButton>
            </ComposerActionHint>
          )}
        </div>
      </div>
    </div>
  );
}
