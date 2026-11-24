import { NavigationRow } from "../../../shared/ui/NavigationRow.tsx";
/**
 * 工作流可视化编辑与草稿页（在左侧「工作流」功能区里，ADR 036 / 038）：
 *
 * - 顶栏紧凑展示名称、状态与 1 行说明，点「编辑信息」按需展开名称/说明表单，不长期占位；
 * - 主舞台默认全高展示可交互流程图（收起右侧时占满 100% 宽度），「文件改动」退居次要 Tab；
 * - 右侧为按需切换/收起的抽屉（SplitPane）：
 *   - 点流程图节点或步骤胶囊 → 右侧展开满高「节点精修」面板（直编名称/原因/交付物/提示词）；
 *   - 点顶栏「AI 助手」→ 右侧展开内嵌 AI 对话（刷新后输入即静默续接，不暴露内部会话状态）；
 *   - 点 ✕ 随时收起右侧抽屉，专注看图或手动编辑。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { SegmentedControl } from "../../../shared/ui/controls/SegmentedControl.tsx";
import type {
  WorkflowCatalog,
  WorkflowCatalogNode,
  WorkflowDraftCheck,
  WorkflowDraftEditor,
  WorkflowService,
} from "../types.ts";
import { describeDiagnostic } from "../status/library.ts";
import { errorLine } from "../status/errorText.ts";
import { draftPrompt, NODE_PROMPT_TEMPLATE } from "../editing/draftSessions.ts";
import { FlowStages } from "./FlowStages.tsx";
import { SplitPane } from "./SplitPane.tsx";
import { diffLines, withContext } from "./textDiff.ts";
import { nodeOutcomes } from "./nodeDetail.ts";
import {
  ActionButton,
  Badge,
  Listbox,
  Spinner,
} from "../../../shared/ui/controls.tsx";
import { Disclosure } from "../../../shared/ui/Disclosure.tsx";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
import { MarkdownView } from "../../../shared/ui/MarkdownView.tsx";
import {
  ArrowUpIcon,
  BotIcon,
  CheckIcon,
  FileIcon,
  PencilIcon,
  PlusIcon,
  SparklesIcon,
  TerminalIcon,
  TrashIcon,
  XIcon,
} from "../../../shared/ui/icons.tsx";

import { Callout } from "../../../shared/ui/Callout.tsx";
import { ModalShell } from "../../../shared/ui/ModalShell.tsx";
import {
  settingsInputClass,
  settingsTextareaClass,
} from "../../../shared/ui/SettingsPageParts.tsx";
import { composerFieldClass } from "../../../shared/ui/inputStyles.ts";

const POLL_MS = 3000;
type Tab = "graph" | "changes";
type DrawerMode = "none" | "node" | "ai";
type PromptViewMode = "edit" | "preview";

interface MetaDraftForm {
  readonly name: string;
  readonly description: string;
}

interface NodeDraftForm {
  readonly id: string;
  readonly label: string;
  readonly why: string;
  readonly delivers: string;
  readonly prompt: string;
}

interface KnowledgeModalState {
  readonly mode: "edit" | "create";
  readonly name: string;
  readonly content: string;
  readonly view: PromptViewMode;
}

function normalizeKnowledgeName(raw: string): string {
  const trimmed = raw.trim().replace(/^knowledge\//, "");
  if (trimmed === "") return "";
  return trimmed.includes(".") ? trimmed : `${trimmed}.md`;
}

function isValidKnowledgeName(name: string): boolean {
  return (
    name !== "" &&
    name.length <= 120 &&
    !name.startsWith("/") &&
    !name.includes("\\") &&
    !name.includes(":") &&
    name
      .split("/")
      .every(
        (part) =>
          part !== "" &&
          part !== "." &&
          part !== ".." &&
          !part.startsWith("."),
      )
  );
}

function nodeFormFrom(node: WorkflowCatalogNode): NodeDraftForm {
  return {
    id: node.id,
    label: node.label ?? "",
    why: node.purpose ?? "",
    delivers: node.delivers ?? "",
    prompt: node.prompt ?? "",
  };
}

export interface PendingAiStart {
  readonly draftId: string;
  readonly request: string;
  readonly startedAt: number;
  readonly status: "starting" | "error";
  readonly error?: string;
}

export function DraftPage({
  service,
  editor,
  draftId,
  pendingAi,
  onSaved,
  onDiscarded,
}: {
  service: WorkflowService;
  editor?: WorkflowDraftEditor;
  draftId: string;
  pendingAi?: PendingAiStart | null;
  onSaved: (id: string) => void;
  onDiscarded: () => void;
}) {
  const [check, setCheck] = useState<WorkflowDraftCheck | null>(null);
  const [lastKnownName, setLastKnownName] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [savingPatch, setSavingPatch] = useState(false);
  const [patchNotice, setPatchNotice] = useState("");
  const [request, setRequest] = useState("");
  const [tab, setTab] = useState<Tab>("graph");
  const [file, setFile] = useState("");
  const [entry, setEntry] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [editingMeta, setEditingMeta] = useState(false);
  const [promptView, setPromptView] = useState<PromptViewMode>("edit");
  // 刚从「用 AI 新建/修改」进来且会话在跑或正在连接时默认展开 AI 抽屉；重开草稿手动看图时默认收起，让画布占满。
  const [drawer, setDrawer] = useState<DrawerMode>(() =>
    editor?.has(draftId) || pendingAi ? "ai" : "none",
  );
  const [startingNow, setStartingNow] = useState(() => Date.now());
  const aiStarting = pendingAi?.status === "starting";
  useEffect(() => {
    if (!aiStarting) return;
    const id = window.setInterval(() => {
      setStartingNow(Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, [aiStarting]);
  const startingElapsed =
    aiStarting && pendingAi
      ? Math.max(0, Math.floor((startingNow - pendingAi.startedAt) / 1000))
      : 0;
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const discardButton = useRef<HTMLButtonElement>(null);
  const [, setSessionVersion] = useState(0);

  const [metaDraft, setMetaDraft] = useState<MetaDraftForm | null>(null);
  const [nodeDraft, setNodeDraft] = useState<NodeDraftForm | null>(null);
  const [knowledgeModal, setKnowledgeModal] =
    useState<KnowledgeModalState | null>(null);

  // 定时重新编译：AI 改文件时界面同步更新。
  useEffect(() => {
    let live = true;
    const load = () =>
      service
        .checkDraft(draftId)
        .then((next) => {
          if (!live) return;
          setCheck(next);
          if (next.meta?.name) setLastKnownName(next.meta.name);
          setError("");
        })
        .catch((cause: unknown) => {
          if (live) setError(errorLine(cause));
        });
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [service, draftId]);

  const entries = useMemo(() => Object.keys(check?.catalogs ?? {}), [check]);
  const shownEntry = entries.includes(entry) ? entry : (entries[0] ?? "");
  const catalog: WorkflowCatalog | null = check?.catalogs[shownEntry] ?? null;
  const nodes = useMemo(() => catalog?.nodes ?? [], [catalog]);
  const activeNode: WorkflowCatalogNode | null = useMemo(() => {
    if (nodes.length === 0) return null;
    return nodes.find((n) => n.id === selectedNodeId) ?? nodes[0] ?? null;
  }, [nodes, selectedNodeId]);

  // 保存成功轻提示自动消失，不撑开或挤压主画布。
  useEffect(() => {
    if (!patchNotice) return;
    const timer = setTimeout(() => setPatchNotice(""), 2400);
    return () => clearTimeout(timer);
  }, [patchNotice]);

  if (check === null) {
    return error !== "" ? (
      <Callout tone="danger" className="workflow-callout" title={error} />
    ) : (
      <div className="workflow-empty">正在读取草稿…</div>
    );
  }

  const base = check.draft.base ?? null;
  const name =
    check.meta?.name ?? lastKnownName ?? check.draft.base ?? "新工作流";
  const errors = check.diagnostics.filter((d) => d.severity === "error");
  const warnings = check.diagnostics.filter((d) => d.severity === "warning");
  const hasSession = editor?.has(draftId) ?? false;
  const changed = check.changes.find((c) => c.path === file) ?? check.changes[0];
  const canSave = check.ok && check.changes.length > 0;
  const canPatch = typeof service.patchDraft === "function";

  const serverMeta: MetaDraftForm = {
    name: check.meta?.name ?? "",
    description: check.meta?.description ?? "",
  };
  const currentMeta = metaDraft ?? serverMeta;
  const metaDirty =
    metaDraft !== null &&
    (metaDraft.name !== serverMeta.name ||
      metaDraft.description !== serverMeta.description);

  const serverNode = activeNode ? nodeFormFrom(activeNode) : null;
  const currentNode =
    serverNode && nodeDraft && nodeDraft.id === serverNode.id
      ? nodeDraft
      : serverNode;
  const nodeDirty =
    serverNode !== null &&
    currentNode !== null &&
    (currentNode.label !== serverNode.label ||
      currentNode.why !== serverNode.why ||
      currentNode.delivers !== serverNode.delivers ||
      currentNode.prompt !== serverNode.prompt);

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(errorLine(cause));
    } finally {
      setBusy(false);
    }
  };

  const applyMetaPatch = () => {
    if (!service.patchDraft || !metaDirty) return;
    setSavingPatch(true);
    setError("");
    setPatchNotice("");
    void service
      .patchDraft(draftId, {
        name: currentMeta.name,
        description: currentMeta.description,
      })
      .then((next) => {
        setCheck(next);
        if (next.meta?.name) setLastKnownName(next.meta.name);
        setMetaDraft(null);
        setEditingMeta(false);
        setPatchNotice("已更新工作流信息");
      })
      .catch((cause: unknown) => setError(errorLine(cause)))
      .finally(() => setSavingPatch(false));
  };

  const applyNodePatch = () => {
    if (!service.patchDraft || !currentNode || !nodeDirty) return;
    setSavingPatch(true);
    setError("");
    setPatchNotice("");
    void service
      .patchDraft(draftId, {
        node: {
          id: currentNode.id,
          label: currentNode.label,
          why: currentNode.why,
          delivers: currentNode.delivers,
          prompt: currentNode.prompt,
        },
      })
      .then((next) => {
        setCheck(next);
        setNodeDraft(null);
        setPatchNotice(`已更新节点「${currentNode.label || currentNode.id}」`);
      })
      .catch((cause: unknown) => setError(errorLine(cause)))
      .finally(() => setSavingPatch(false));
  };

  const openNodeDrawer = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    setNodeDraft(null);
    setDrawer("node");
  };

  const knowledgeFiles = new Map<string, string>();
  for (const f of check.files ?? []) {
    if (f.path.startsWith("knowledge/")) {
      knowledgeFiles.set(f.path.slice("knowledge/".length), f.text);
    }
  }
  const attachedKnowledge = activeNode?.knowledge ?? [];
  const availableKnowledge = [...knowledgeFiles.keys()].filter(
    (k) => !attachedKnowledge.includes(k),
  );

  const otherNodesUsingKnowledge = (fileName: string): number => {
    const seen = new Set<string>();
    for (const cat of Object.values(check.catalogs)) {
      for (const n of cat.nodes) {
        if (n.id !== activeNode?.id && (n.knowledge ?? []).includes(fileName)) {
          seen.add(n.id);
        }
      }
    }
    return seen.size;
  };

  const openKnowledgeEditor = (fileName: string) => {
    setKnowledgeModal({
      mode: "edit",
      name: fileName,
      content: knowledgeFiles.get(fileName) ?? "",
      view: canPatch ? "edit" : "preview",
    });
  };

  const openAddKnowledge = () => {
    setKnowledgeModal({
      mode: "create",
      name: "",
      content: "# 规范说明\n\n- ",
      view: "edit",
    });
  };

  const attachKnowledgeToNode = (fileName: string) => {
    if (!service.patchDraft || !activeNode || savingPatch) return;
    if (attachedKnowledge.includes(fileName)) return;
    setSavingPatch(true);
    setError("");
    setPatchNotice("");
    void service
      .patchDraft(draftId, {
        node: {
          id: activeNode.id,
          knowledge: [...attachedKnowledge, fileName],
        },
      })
      .then((next) => {
        setCheck(next);
        setKnowledgeModal(null);
        setPatchNotice(`已关联知识「${fileName}」`);
      })
      .catch((cause: unknown) => setError(errorLine(cause)))
      .finally(() => setSavingPatch(false));
  };

  const detachKnowledgeFromNode = (fileName: string) => {
    if (!service.patchDraft || !activeNode || savingPatch) return;
    setSavingPatch(true);
    setError("");
    setPatchNotice("");
    void service
      .patchDraft(draftId, {
        node: {
          id: activeNode.id,
          knowledge: attachedKnowledge.filter((k) => k !== fileName),
        },
      })
      .then((next) => {
        setCheck(next);
        setPatchNotice(`已从当前节点移除「${fileName}」`);
      })
      .catch((cause: unknown) => setError(errorLine(cause)))
      .finally(() => setSavingPatch(false));
  };

  const saveKnowledgeModal = () => {
    if (!service.patchDraft || !knowledgeModal || savingPatch) return;
    const normalized =
      knowledgeModal.mode === "create"
        ? normalizeKnowledgeName(knowledgeModal.name)
        : knowledgeModal.name;
    if (!isValidKnowledgeName(normalized)) {
      setError("知识文件名不合法，请使用如 design-rules.md 的相对文件名。");
      return;
    }
    setSavingPatch(true);
    setError("");
    setPatchNotice("");
    const attach =
      knowledgeModal.mode === "create" &&
      activeNode &&
      !attachedKnowledge.includes(normalized)
        ? {
            id: activeNode.id,
            knowledge: [...attachedKnowledge, normalized],
          }
        : undefined;
    void service
      .patchDraft(draftId, {
        knowledgeFile: { name: normalized, content: knowledgeModal.content },
        ...(attach ? { node: attach } : {}),
      })
      .then((next) => {
        setCheck(next);
        setKnowledgeModal(null);
        setPatchNotice(
          knowledgeModal.mode === "create"
            ? `已新建并关联「${normalized}」`
            : `已保存知识「${normalized}」`,
        );
      })
      .catch((cause: unknown) => setError(errorLine(cause)))
      .finally(() => setSavingPatch(false));
  };

  const deleteKnowledgeFile = (fileName: string) => {
    if (!service.patchDraft || savingPatch) return;
    if (otherNodesUsingKnowledge(fileName) > 0) return;
    setSavingPatch(true);
    setError("");
    setPatchNotice("");
    const detach =
      activeNode && attachedKnowledge.includes(fileName)
        ? {
            id: activeNode.id,
            knowledge: attachedKnowledge.filter((k) => k !== fileName),
          }
        : undefined;
    void service
      .patchDraft(draftId, {
        knowledgeFile: { name: fileName, content: null },
        ...(detach ? { node: detach } : {}),
      })
      .then((next) => {
        setCheck(next);
        setKnowledgeModal(null);
        setPatchNotice(`已删除知识「${fileName}」`);
      })
      .catch((cause: unknown) => setError(errorLine(cause)))
      .finally(() => setSavingPatch(false));
  };

  const submitAssistantMessage = (text: string) => {
    const trimmed = text.trim();
    if (!editor || trimmed === "" || busy) return;
    setDrawer("ai");
    if (hasSession && editor.send(draftId, trimmed)) {
      setRequest("");
      return;
    }
    void act(async () => {
      const kind =
        check.changes.length > 0 ? "continue" : base === null ? "new" : "edit";
      await editor.start(
        check.draft,
        `编辑工作流：${name}`,
        draftPrompt(kind, trimmed),
      );
      setRequest("");
      setSessionVersion((v) => v + 1);
    });
  };

  const askFixWarnings = () => {
    if (!editor || warnings.length === 0) return;
    const list = warnings.map((d) => `- ${describeDiagnostic(d)}`).join("\n");
    submitAssistantMessage(
      `请根据以下工作流检查提醒修正定义，使检查达到 0 条提醒：\n${list}`,
    );
  };

  const labelOf = (site: string) =>
    nodes.find((n) => n.id === site)?.label ?? site;
  const activeOutcomes =
    activeNode && catalog?.structure
      ? nodeOutcomes(catalog.structure, activeNode.id, undefined, labelOf)
      : [];

  const assistantTitle = (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-ui-sm font-medium text-ink">
      <SparklesIcon
        className="ui-icon-14 shrink-0 text-accent-ink"
        aria-hidden={true}
      />
      <span className="truncate">用 AI 修改工作流</span>
    </span>
  );

  const assistantClose = (
    <IconButton
      iconSize="compact"
      aria-label="收起 AI 修改面板"
      data-hint="收起"
      onClick={() => setDrawer("none")}
    >
      <XIcon className="ui-icon-14" />
    </IconButton>
  );

  const liveEmbeddedChat = hasSession
    ? (editor?.renderSession?.(draftId, {
        header: assistantTitle,
        headerActions: assistantClose,
        placeholder: "描述你想调整的地方（Enter 发送，Shift+Enter 换行）",
      }) ?? null)
    : null;

  const isStartingAi = busy || pendingAi?.status === "starting";

  const aiDrawerPane = editor ? (
    <div className="workflow-draft-chat">
      {liveEmbeddedChat ?? (
        <section
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-base"
          aria-label="AI 编辑对话"
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-2">
            <div className="min-w-0 flex-1">{assistantTitle}</div>
            <div className="flex shrink-0 items-center gap-2">
              {isStartingAi && (
                <span className="inline-flex shrink-0 items-center gap-1.5 text-ui-xs text-ink-mute">
                  <Spinner className="ui-icon-14" />
                  <span>正在连接 AI…</span>
                </span>
              )}
              {assistantClose}
            </div>
          </div>
          {pendingAi ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
              <div className="ml-6 rounded-popover bg-tint px-3 py-2 text-ui-sm leading-relaxed whitespace-pre-wrap text-ink">
                {pendingAi.request}
              </div>
              {pendingAi.status === "starting" ? (
                <div
                  className="flex items-center gap-2 px-1 py-1 text-ui-xs text-ink-mute"
                  role="status"
                  aria-live="polite"
                >
                  <Spinner className="ui-icon-14 shrink-0" />
                  <span>
                    {startingElapsed > 0
                      ? `正在准备 AI 编辑会话（${startingElapsed} 秒）…`
                      : "正在准备 AI 编辑会话…"}
                  </span>
                </div>
              ) : (
                <Callout
                  tone="danger"
                  title={pendingAi.error || "连接 AI 编辑会话失败"}
                />
              )}
            </div>
          ) : (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col justify-center gap-2 overflow-y-auto px-4 py-6 text-ui-sm text-ink-mute">
              <p className="m-0 text-ink">想怎么调整这份工作流？</p>
              <p className="m-0 text-ui-xs leading-relaxed text-ink-mute">
                直接描述你的想法（例如增减步骤、修改分支条件或让 AI 重写某个节点的提示词），AI 会直接更新左侧草稿与流程图。
              </p>
            </div>
          )}
          <div className="shrink-0 border-t border-line p-2.5">
            <div className="flex items-end gap-2 rounded-control border border-line bg-surface px-2.5 py-2 focus-within:border-line-strong">
              <textarea
                className={`${composerFieldClass} max-h-28 min-h-9 flex-1 resize-none text-ui-sm leading-5 outline-none focus:outline-none`}
                aria-label="向 AI 补充修改要求"
                rows={2}
                value={request}
                readOnly={isStartingAi}
                placeholder={
                  base === null
                    ? "描述你想调整的地方（Enter 发送，Shift+Enter 换行）"
                    : "例如：在评审步骤后加一个人工确认（Enter 发送）"
                }
                onChange={(event) => setRequest(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    submitAssistantMessage(request);
                  }
                }}
              />
              <IconButton
                iconSize="compact"
                className="shrink-0 rounded-control bg-brand text-foreground-inverse hover:opacity-90 disabled:opacity-40"
                aria-label="发送"
                data-hint="发送"
                disabled={isStartingAi || request.trim() === ""}
                onClick={() => submitAssistantMessage(request)}
              >
                {isStartingAi ? (
                  <Spinner className="ui-icon-14" />
                ) : (
                  <ArrowUpIcon className="ui-icon-14" />
                )}
              </IconButton>
            </div>
          </div>
        </section>
      )}
    </div>
  ) : null;

  const nodeDrawerPane =
    activeNode && currentNode ? (
      <aside
        className="workflow-draft-node-drawer"
        aria-label="节点内容与提示词"
      >
        <header className="workflow-draft-drawer-head">
          <div className="flex min-w-0 items-center gap-2">
            {activeNode.kind === "python" ? (
              <TerminalIcon
                className="ui-icon-14 shrink-0 text-ink-mute"
                aria-hidden={true}
              />
            ) : (
              <BotIcon
                className="ui-icon-14 shrink-0 text-ink-mute"
                aria-hidden={true}
              />
            )}
            <b className="truncate text-ui-sm text-ink">
              {currentNode.label || activeNode.label}
            </b>
            <Badge tone="neutral">
              {activeNode.kind === "python" ? "脚本" : "Agent"}
            </Badge>
          </div>
          <IconButton
            iconSize="compact"
            aria-label="关闭节点编辑"
            data-hint="关闭"
            onClick={() => setDrawer("none")}
          >
            <XIcon className="ui-icon-14" />
          </IconButton>
        </header>

        <div
          key={activeNode.id}
          className="workflow-draft-drawer-body"
          onKeyDown={(event) => {
            if (
              (event.ctrlKey || event.metaKey) &&
              event.key.toLowerCase() === "s" &&
              nodeDirty &&
              canPatch
            ) {
              event.preventDefault();
              applyNodePatch();
            }
          }}
        >
          <div className="workflow-draft-fields">
            <label className="workflow-draft-field">
              <span>节点名称</span>
              <input
                type="text"
                className={settingsInputClass}
                value={currentNode.label}
                readOnly={!canPatch}
                onChange={(e) =>
                  setNodeDraft({ ...currentNode, label: e.target.value })
                }
              />
            </label>
            <label className="workflow-draft-field">
              <span>为什么有这一步</span>
              <textarea
                className={`${settingsTextareaClass} workflow-draft-compact-area`}
                rows={2}
                value={currentNode.why}
                readOnly={!canPatch}
                placeholder="这一步的目标与存在原因"
                onChange={(e) =>
                  setNodeDraft({ ...currentNode, why: e.target.value })
                }
              />
            </label>
            <label className="workflow-draft-field">
              <span>这一步交出什么</span>
              <textarea
                className={`${settingsTextareaClass} workflow-draft-compact-area`}
                rows={2}
                value={currentNode.delivers}
                readOnly={!canPatch}
                placeholder="最终产出物与验收标准"
                onChange={(e) =>
                  setNodeDraft({ ...currentNode, delivers: e.target.value })
                }
              />
            </label>
            {activeOutcomes.length > 0 && (
              <div className="workflow-draft-node-meta">
                <Disclosure
                  defaultOpen={false}
                  summary={
                    <span className="text-ui-xs font-medium text-ink-soft">
                      结果流向（{activeOutcomes.length} 条）
                    </span>
                  }
                >
                  <ul className="workflow-draft-outcomes">
                    {activeOutcomes.map((outcome, index) => (
                      <li key={index}>
                        {outcome.when
                          ? `如果${outcome.when} → ${outcome.result}`
                          : `完成后 → ${outcome.result}`}
                      </li>
                    ))}
                  </ul>
                  {editor && (
                    <div className="workflow-draft-outcomes-foot">
                      <span className="text-ui-xs text-ink-mute">
                        分支条件与跳转可交由 AI 调整
                      </span>
                      <ActionButton
                        type="button"
                        tone="secondary"
                        size="compact"
                        className="inline-flex items-center gap-1"
                        onClick={() => {
                          if (!hasSession) {
                            setRequest(
                              `请帮我调整「${activeNode.label}」节点的结果流向：`,
                            );
                          }
                          setDrawer("ai");
                        }}
                      >
                        <SparklesIcon
                          className="ui-icon-12"
                          aria-hidden={true}
                        />
                        <span>用 AI 调整流向</span>
                      </ActionButton>
                    </div>
                  )}
                </Disclosure>
              </div>
            )}
            {(attachedKnowledge.length > 0 ||
              (activeNode.kind === "agent" && canPatch)) && (
              <div className="workflow-draft-knowledge-row">
                <span className="workflow-draft-node-sub-title">关联知识</span>
                <div className="workflow-draft-knowledge-list">
                  {attachedKnowledge.map((k) => (
                    <span key={k} className="workflow-draft-knowledge-chip">
                      <ActionButton
                        type="button"
                        tone="ghost"
                        size="compact"
                        className="workflow-draft-knowledge-open"
                        data-hint="点击查看或编辑知识文档"
                        onClick={() => openKnowledgeEditor(k)}
                      >
                        <FileIcon className="ui-icon-12" aria-hidden={true} />
                        <span>{k}</span>
                      </ActionButton>
                      {canPatch && (
                        <IconButton
                          iconSize="compact"
                          className="workflow-draft-knowledge-remove"
                          aria-label={`移除关联知识 ${k}`}
                          data-hint="从当前节点移除"
                          disabled={savingPatch}
                          onClick={() => detachKnowledgeFromNode(k)}
                        >
                          <XIcon className="ui-icon-12" aria-hidden={true} />
                        </IconButton>
                      )}
                    </span>
                  ))}
                  {activeNode.kind === "agent" && canPatch && (
                    <ActionButton
                      type="button"
                      tone="secondary"
                      size="compact"
                      className="inline-flex items-center gap-1"
                      disabled={savingPatch}
                      onClick={openAddKnowledge}
                    >
                      <PlusIcon className="ui-icon-12" aria-hidden={true} />
                      <span>添加知识</span>
                    </ActionButton>
                  )}
                </div>
              </div>
            )}
            {activeNode.kind === "agent" && (
              <div className="workflow-draft-field is-grow">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-2">
                    <span>节点提示词（Prompt）</span>
                    <span className="text-ui-xs tabular-nums text-ink-subtlest">
                      {currentNode.prompt.length} 字
                    </span>
                  </span>
                  <div className="flex items-center gap-1.5">
                    {canPatch && currentNode.prompt.trim() === "" && (
                      <ActionButton
                        type="button"
                        tone="secondary"
                        size="compact"
                        onClick={() => {
                          setNodeDraft({
                            ...currentNode,
                            prompt: NODE_PROMPT_TEMPLATE,
                          });
                          setPromptView("edit");
                        }}
                      >
                        插入标准格式
                      </ActionButton>
                    )}
                    <SegmentedControl<PromptViewMode>
                      groupLabel="提示词视图"
                      value={promptView}
                      onChange={setPromptView}
                      options={[
                        { value: "edit", label: "编辑" },
                        { value: "preview", label: "预览" },
                      ]}
                    />
                  </div>
                </div>
                {promptView === "edit" ? (
                  <textarea
                    className={`${settingsTextareaClass} workflow-draft-prompt-area`}
                    aria-label="节点提示词（Prompt）"
                    value={currentNode.prompt}
                    readOnly={!canPatch}
                    placeholder="按标准 Markdown 骨架编写（支持 ### 背景知识 / 输入与参考 / 核心原则 / 做什么 / 边界与约束 / 输出格式 / 验收与留证）"
                    onChange={(e) =>
                      setNodeDraft({ ...currentNode, prompt: e.target.value })
                    }
                  />
                ) : (
                  <div className="workflow-draft-prompt-preview">
                    {currentNode.prompt.trim() !== "" ? (
                      <MarkdownView text={currentNode.prompt} />
                    ) : (
                      <p className="m-0 text-ui-xs text-ink-mute">
                        还没有编写提示词，切回「编辑」或点击「插入标准格式」开始。
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {nodeDirty && canPatch && (
          <footer className="workflow-draft-drawer-foot">
            <ActionButton
              type="button"
              tone="secondary"
              size="compact"
              disabled={savingPatch}
              onClick={() => setNodeDraft(null)}
            >
              还原
            </ActionButton>
            <ActionButton
              type="button"
              tone="primary"
              size="compact"
              disabled={savingPatch || currentNode.label.trim() === ""}
              onClick={applyNodePatch}
            >
              {savingPatch ? "保存中…" : "保存节点修改"}
            </ActionButton>
          </footer>
        )}
      </aside>
    ) : null;

  const aside =
    drawer === "ai" ? aiDrawerPane : drawer === "node" ? nodeDrawerPane : null;

  const mainContent = (
    <div className="workflow-draft-stage">
      {/* 紧凑顶栏：名称 + 说明预览 + 编辑信息 + AI 助手开关 + 保存/放弃 */}
      <header className="workflow-detail-head workflow-draft-head">
        <div className="workflow-detail-title">
          <b>
            {base === null ? "新建" : "修改"}：{name}
          </b>
          <Badge tone={check.ok ? "ok" : "danger"}>
            {check.ok ? "编译通过" : `${errors.length} 处错误`}
          </Badge>
          {patchNotice !== "" && (
            <span className="workflow-draft-saved-pill" role="status">
              <CheckIcon className="ui-icon-12" aria-hidden={true} />
              <span>{patchNotice}</span>
            </span>
          )}
          {check.meta && canPatch && (
            <IconButton
              iconSize="compact"
              aria-label="编辑工作流信息"
              aria-expanded={editingMeta}
              data-hint="编辑名称与说明"
              onClick={() => setEditingMeta((v) => !v)}
            >
              <PencilIcon className="ui-icon-14" />
            </IconButton>
          )}
        </div>
        <div className="workflow-detail-actions">
          {editor && (
            <ActionButton
              type="button"
              tone="secondary"
              size="compact"
              className={`inline-flex items-center gap-1.5${drawer === "ai" ? " is-active-toggle" : ""}`}
              aria-pressed={drawer === "ai"}
              onClick={() =>
                setDrawer((current) => (current === "ai" ? "none" : "ai"))
              }
            >
              <SparklesIcon className="ui-icon-14" aria-hidden={true} />
              <span>用 AI 修改</span>
            </ActionButton>
          )}
          <ActionButton
            type="button"
            tone="primary"
            size="compact"
            disabled={busy || savingPatch || !canSave}
            data-hint={
              !check.ok ? "编译通过后才能保存" : canSave ? "" : "还没有改动"
            }
            onClick={() =>
              void act(async () => {
                await editor?.end(draftId);
                onSaved(await service.saveDraft(draftId));
              })
            }
          >
            保存
          </ActionButton>
          <ActionButton
            ref={discardButton}
            type="button"
            tone="secondary"
            size="compact"
            onClick={() => setConfirmDiscard(true)}
          >
            放弃
          </ActionButton>
        </div>
        <p className="workflow-detail-desc truncate">
          {check.meta?.description?.trim() ||
            "点流程图节点即可精修提示词，点「用 AI 修改」随时让 AI 调整整体流程。"}
        </p>
      </header>

      {/* 工作流名称与整体说明编辑弹窗 */}
      {editingMeta && check.meta && (
        <ModalShell
          placement="container"
          size="form"
          label="编辑工作流信息"
          onDismiss={() => {
            if (!savingPatch) {
              setMetaDraft(null);
              setEditingMeta(false);
            }
          }}
        >
          <div className="flex flex-col gap-4 p-5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="m-0 text-ui-base font-semibold text-ink">
                编辑工作流信息
              </h3>
              <IconButton
                iconSize="compact"
                aria-label="关闭"
                disabled={savingPatch}
                onClick={() => {
                  setMetaDraft(null);
                  setEditingMeta(false);
                }}
              >
                <XIcon className="ui-icon-14" />
              </IconButton>
            </div>
            <div className="workflow-draft-fields">
              <label className="workflow-draft-field">
                <span>名称</span>
                <input
                  type="text"
                  className={settingsInputClass}
                  value={currentMeta.name}
                  readOnly={!canPatch}
                  autoFocus
                  placeholder="给这个工作流起一个好辨认的名字"
                  onChange={(e) =>
                    setMetaDraft({ ...currentMeta, name: e.target.value })
                  }
                />
              </label>
              <label className="workflow-draft-field">
                <span>整体说明</span>
                <textarea
                  className={settingsTextareaClass}
                  rows={4}
                  value={currentMeta.description}
                  readOnly={!canPatch}
                  placeholder="说明这个工作流解决什么问题、包含哪些阶段"
                  onChange={(e) =>
                    setMetaDraft({
                      ...currentMeta,
                      description: e.target.value,
                    })
                  }
                />
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <ActionButton
                type="button"
                tone="secondary"
                size="compact"
                disabled={savingPatch}
                onClick={() => {
                  setMetaDraft(null);
                  setEditingMeta(false);
                }}
              >
                取消
              </ActionButton>
              <ActionButton
                type="button"
                tone="primary"
                size="compact"
                disabled={
                  savingPatch || !metaDirty || currentMeta.name.trim() === ""
                }
                onClick={applyMetaPatch}
              >
                {savingPatch ? "保存中…" : "保存信息"}
              </ActionButton>
            </div>
          </div>
        </ModalShell>
      )}

      {/* 关联知识查看 / 编辑 / 新建弹窗 */}
      {knowledgeModal &&
        (() => {
          const isCreate = knowledgeModal.mode === "create";
          const normalizedName = isCreate
            ? normalizeKnowledgeName(knowledgeModal.name)
            : knowledgeModal.name;
          const serverText = isCreate
            ? ""
            : (knowledgeFiles.get(knowledgeModal.name) ?? "");
          const dirty = isCreate
            ? isValidKnowledgeName(normalizedName)
            : knowledgeModal.content !== serverText;
          const otherRefs = isCreate
            ? 0
            : otherNodesUsingKnowledge(knowledgeModal.name);
          return (
            <ModalShell
              placement="container"
              size="form"
              label={
                isCreate ? "添加关联知识" : `关联知识：${knowledgeModal.name}`
              }
              onDismiss={() => {
                if (!savingPatch) setKnowledgeModal(null);
              }}
            >
              <div
                className="flex min-h-0 flex-1 flex-col gap-4 p-5"
                onKeyDown={(event) => {
                  if (
                    (event.ctrlKey || event.metaKey) &&
                    event.key.toLowerCase() === "s" &&
                    dirty &&
                    canPatch
                  ) {
                    event.preventDefault();
                    saveKnowledgeModal();
                  }
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <FileIcon
                      className="ui-icon-16 shrink-0 text-ink-mute"
                      aria-hidden={true}
                    />
                    <h3 className="m-0 truncate text-ui-base font-semibold text-ink">
                      {isCreate ? "添加关联知识" : knowledgeModal.name}
                    </h3>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <SegmentedControl<PromptViewMode>
                      groupLabel="知识文档视图"
                      value={knowledgeModal.view}
                      onChange={(view) =>
                        setKnowledgeModal({ ...knowledgeModal, view })
                      }
                      options={[
                        { value: "edit", label: "编辑" },
                        { value: "preview", label: "预览" },
                      ]}
                    />
                    <IconButton
                      iconSize="compact"
                      aria-label="关闭"
                      disabled={savingPatch}
                      onClick={() => setKnowledgeModal(null)}
                    >
                      <XIcon className="ui-icon-14" />
                    </IconButton>
                  </div>
                </div>

                {isCreate && availableKnowledge.length > 0 && (
                  <div className="workflow-draft-knowledge-existing">
                    <span className="text-ui-xs font-medium text-ink-mute">
                      关联草稿中已有的知识文档
                    </span>
                    <div className="workflow-draft-knowledge-list">
                      {availableKnowledge.map((fileName) => (
                        <ActionButton
                          key={fileName}
                          type="button"
                          tone="secondary"
                          size="compact"
                          className="inline-flex items-center gap-1"
                          disabled={savingPatch}
                          onClick={() => attachKnowledgeToNode(fileName)}
                        >
                          <PlusIcon
                            className="ui-icon-12"
                            aria-hidden={true}
                          />
                          <span>{fileName}</span>
                        </ActionButton>
                      ))}
                    </div>
                  </div>
                )}

                <div className="workflow-draft-fields">
                  {isCreate && (
                    <label className="workflow-draft-field">
                      <span>新建知识文件名</span>
                      <input
                        type="text"
                        className={settingsInputClass}
                        value={knowledgeModal.name}
                        autoFocus
                        placeholder="例如：design-rules.md（会自动保存到 knowledge/ 目录）"
                        onChange={(e) =>
                          setKnowledgeModal({
                            ...knowledgeModal,
                            name: e.target.value,
                          })
                        }
                      />
                    </label>
                  )}
                  <div className="workflow-draft-field is-grow">
                    <div className="flex items-center justify-between gap-2">
                      <span>知识内容（Markdown）</span>
                      <span className="text-ui-xs tabular-nums text-ink-subtlest">
                        {knowledgeModal.content.length} 字
                      </span>
                    </div>
                    {knowledgeModal.view === "edit" ? (
                      <textarea
                        className={`${settingsTextareaClass} min-h-[340px] max-h-[52vh] flex-1 resize-y leading-relaxed`}
                        aria-label="关联知识内容"
                        rows={14}
                        value={knowledgeModal.content}
                        readOnly={!canPatch}
                        autoFocus={!isCreate}
                        placeholder="编写该节点执行时可参考的领域知识、规范清单或范例…"
                        onChange={(e) =>
                          setKnowledgeModal({
                            ...knowledgeModal,
                            content: e.target.value,
                          })
                        }
                      />
                    ) : (
                      <div className="workflow-draft-knowledge-preview">
                        {knowledgeModal.content.trim() !== "" ? (
                          <MarkdownView text={knowledgeModal.content} />
                        ) : (
                          <p className="m-0 text-ui-xs text-ink-mute">
                            知识文档内容为空。
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2 pt-1">
                  <div>
                    {!isCreate && canPatch && (
                      <ActionButton
                        type="button"
                        tone="danger"
                        size="compact"
                        className="inline-flex items-center gap-1"
                        disabled={savingPatch || otherRefs > 0}
                        data-hint={
                          otherRefs > 0
                            ? `还有 ${otherRefs} 个其他节点关联了这份知识，请先取消关联`
                            : "删除此知识文件并从当前节点移除"
                        }
                        onClick={() => deleteKnowledgeFile(knowledgeModal.name)}
                      >
                        <TrashIcon className="ui-icon-12" aria-hidden={true} />
                        <span>删除知识文件</span>
                      </ActionButton>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <ActionButton
                      type="button"
                      tone="secondary"
                      size="compact"
                      disabled={savingPatch}
                      onClick={() => setKnowledgeModal(null)}
                    >
                      {canPatch ? "取消" : "关闭"}
                    </ActionButton>
                    {canPatch && (
                      <ActionButton
                        type="button"
                        tone="primary"
                        size="compact"
                        disabled={savingPatch || !dirty}
                        onClick={saveKnowledgeModal}
                      >
                        {savingPatch
                          ? "保存中…"
                          : isCreate
                            ? "新建并关联"
                            : "保存知识"}
                      </ActionButton>
                    )}
                  </div>
                </div>
              </div>
            </ModalShell>
          );
        })()}

      {/* 放弃草稿二次确认弹窗：避免在窄顶栏内联展开导致排版崩坏 */}
      {confirmDiscard && (
        <ModalShell
          placement="container"
          size="default"
          label="确认放弃草稿"
          onDismiss={() => {
            if (!busy) {
              setConfirmDiscard(false);
              discardButton.current?.focus();
            }
          }}
        >
          <div className="flex flex-col gap-4 p-5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="m-0 text-ui-base font-semibold text-ink">
                确认放弃这份草稿？
              </h3>
              <IconButton
                iconSize="compact"
                aria-label="关闭"
                disabled={busy}
                onClick={() => {
                  setConfirmDiscard(false);
                  discardButton.current?.focus();
                }}
              >
                <XIcon className="ui-icon-14" />
              </IconButton>
            </div>
            <p className="m-0 text-ui-sm leading-relaxed text-ink-mute">
              放弃后，草稿中尚未保存的全部改动都会被删除，无法恢复。
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <ActionButton
                type="button"
                tone="secondary"
                size="compact"
                disabled={busy}
                onClick={() => {
                  setConfirmDiscard(false);
                  discardButton.current?.focus();
                }}
              >
                取消
              </ActionButton>
              <ActionButton
                type="button"
                tone="danger"
                size="compact"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await editor?.end(draftId);
                    await service.discardDraft(draftId);
                    onDiscarded();
                  })
                }
              >
                {busy ? "正在放弃…" : "确认放弃"}
              </ActionButton>
            </div>
          </div>
        </ModalShell>
      )}

      {error !== "" && (
        <Callout
          tone="danger"
          className="workflow-callout"
          title={error}
          onDismiss={() => setError("")}
        />
      )}
      {errors.length > 0 && (
        <Callout
          tone="danger"
          className="workflow-callout"
          label="编译报错"
          title={`定义有 ${errors.length} 处错误，修正后才能保存`}
        >
          <Disclosure
            defaultOpen={errors.length <= 2}
            summary={<span>查看 {errors.length} 处错误详情</span>}
          >
            <ul className="workflow-callout-list">
              {errors.map((d, index) => (
                <li key={index}>{describeDiagnostic(d)}</li>
              ))}
            </ul>
          </Disclosure>
          {hasSession && (
            <p className="workflow-muted">
              AI 会用 check_workflow 工具自己检查并修正，这里同步显示结果。
            </p>
          )}
        </Callout>
      )}
      {warnings.length > 0 && (
        <Callout
          tone="info"
          role="note"
          className="workflow-callout"
          title={`检查提醒（${warnings.length} 条）`}
          actions={
            editor ? (
              <ActionButton
                type="button"
                tone="secondary"
                size="compact"
                disabled={busy}
                onClick={askFixWarnings}
              >
                让 AI 修正提醒
              </ActionButton>
            ) : undefined
          }
        >
          <Disclosure
            defaultOpen={false}
            summary={<span>展开查看提醒详情</span>}
          >
            <ul className="workflow-callout-list">
              {warnings.map((d, index) => (
                <li key={index}>{describeDiagnostic(d)}</li>
              ))}
            </ul>
          </Disclosure>
        </Callout>
      )}

      {/* 画布工具栏：Tab + 起点切换 */}
      <div className="workflow-draft-toolbar">
        <SegmentedControl<Tab>
          tabs
          groupLabel="草稿"
          value={tab}
          onChange={setTab}
          options={[
            { value: "graph", label: "流程图" },
            { value: "changes", label: `文件改动 · ${check.changes.length}` },
          ]}
        />
        {tab === "graph" && entries.length > 1 && (
          <div className="workflow-entry-picker">
            <span>起点</span>
            <Listbox
              label="起点"
              value={shownEntry}
              options={entries.map((id) => ({
                value: id,
                label:
                  check.meta?.entries.find((item) => item.id === id)?.label ??
                  id,
              }))}
              onChange={setEntry}
            />
          </div>
        )}
      </div>

      {/* 主舞台：全高流程图画布 或 文件改动 */}
      {tab === "graph" && (
        <div className="workflow-draft-canvas-stage">
          {catalog?.structure && catalog.entry ? (
            <FlowStages
              key={`${catalog.id}:${catalog.revision}`}
              label="工作流流程图"
              entry={catalog.entry}
              structure={catalog.structure}
              nodes={catalog.nodes}
              stages={catalog.stages}
              snapshot={null}
              selected={drawer === "node" ? (activeNode?.id ?? "") : ""}
              onSelect={(site) => openNodeDrawer(site)}
            />
          ) : (
            <div className="workflow-empty">
              {check.ok
                ? hasSession
                  ? "AI 正在生成工作流结构，完成后流程图会自动显示在这里。"
                  : "这个起点还没有可显示的流程结构。"
                : "编译通过后将自动显示流程图。"}
            </div>
          )}
        </div>
      )}

      {tab === "changes" && (
        <div className="workflow-draft-changes-stage">
          {check.changes.length === 0 ? (
            <p className="workflow-muted workflow-pad">
              {base === null
                ? hasSession
                  ? "AI 正在编写工作流，改动会实时显示在这里。"
                  : "还没有文件改动。"
                : "还没有改动。"}
            </p>
          ) : (
            <div className="workflow-source-body">
              <ul className="workflow-source-files" aria-label="改动的文件">
                {check.changes.map((c) => (
                  <li key={c.path}>
                    <NavigationRow
                      layout="tree"
                      aria-pressed={c.path === changed?.path}
                      onClick={() => setFile(c.path)}
                      data-hint={c.path}
                    >
                      <span className="truncate">
                        {c.status === "added"
                          ? "＋ "
                          : c.status === "removed"
                            ? "－ "
                            : "～ "}
                        {c.path}
                      </span>
                    </NavigationRow>
                  </li>
                ))}
              </ul>
              {changed && (
                <pre
                  className="workflow-diff"
                  aria-label={`差异 ${changed.path}`}
                >
                  {withContext(
                    diffLines(changed.before ?? "", changed.after ?? ""),
                  ).map((line, index) =>
                    line === null ? (
                      <span key={index} className="diff-gap">
                        ⋯
                      </span>
                    ) : (
                      <span key={index} className={`diff-${line.kind}`}>
                        {line.kind === "add"
                          ? "+ "
                          : line.kind === "remove"
                            ? "- "
                            : "  "}
                        {line.text}
                        {"\n"}
                      </span>
                    ),
                  )}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );

  return <SplitPane aside={aside}>{mainContent}</SplitPane>;
}
