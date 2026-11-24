/**
 * 左侧「工作流」功能区的中间部分（ADR 038）：只管模板，不放发起。
 *
 * - **工作流库**（WorkflowLibrary）：侧栏选的分类（预置 / 我的）里的卡片；
 * - **工作流**（WorkflowDetailView）：流程图、源码、复制、导出、删除；
 * - **草稿**（DraftPage）：AI 修改的编译结果与改动对比，确认后保存。
 *
 * 不要求先选项目：工作流是应用级的。AI 编辑会话挂在当前项目下，打开时不抢
 * 前台，草稿页上「回到编辑会话」才切过去。
 */
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { DraftPage } from "./DraftPage.tsx";
import { AiComposeDialog } from "./AiComposeDialog.tsx";
import { WorkflowLibrary } from "./WorkflowLibrary.tsx";
import { WorkflowDetailView } from "./WorkflowDetailView.tsx";
import { draftPrompt } from "../editing/draftSessions.ts";
import { errorLine } from "../status/errorText.ts";
import { Breadcrumb } from "../../../shared/ui/Breadcrumb.tsx";
import type { WorkflowDraft, WorkflowDraftEditor, WorkflowFileTransfer, WorkflowService } from "../types.ts";
import type { ComposeTarget, TemplateNavigation, TemplateRoute } from "./templateNavigation.ts";
import "./workflowPanel.css";

export function WorkflowWorkspace({ service, navigation, transfer, editor }: {
  service: WorkflowService;
  navigation: TemplateNavigation;
  transfer?: WorkflowFileTransfer;
  editor?: WorkflowDraftEditor;
}) {
  const { tab, route, compose } = useStore(navigation);
  const [version, setVersion] = useState(0);
  const [names, setNames] = useState<Readonly<Record<string, string>>>({});
  const [drafts, setDrafts] = useState<readonly WorkflowDraft[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");
  const [pendingAi, setPendingAi] = useState<{
    readonly draftId: string;
    readonly request: string;
    readonly status: "starting" | "error";
    readonly error?: string;
  } | null>(null);
  const go = (next: TemplateRoute) => navigation.setState({ route: next });
  const setCompose = (next: ComposeTarget | null) => {
    setAiError("");
    navigation.setState({ compose: next });
  };
  const changed = () => setVersion((v) => v + 1);

  useEffect(() => service.subscribe((event) => {
    // 导入、复制、删除、信任脚本之后重新读取工作流库。
    if (event.type === "library-changed") changed();
  }), [service]);

  // 面包屑上的工作流名称。
  useEffect(() => {
    let live = true;
    service.workflows()
      .then((list) => { if (live) setNames(Object.fromEntries(list.map((item) => [item.id, item.meta?.name ?? item.id]))); })
      .catch(() => {});
    return () => { live = false; };
  }, [service, version]);

  useEffect(() => {
    if (!editor) return;
    let live = true;
    service.drafts().then((list) => { if (live) setDrafts(list); }).catch(() => {});
    return () => { live = false; };
  }, [service, editor, version, route]);

  const draftOf = (id: string) => drafts.find((draft) => draft.base === id);
  /** 让 AI 修改：这个工作流已有草稿就回到它，否则先问要怎么改。 */
  const requestEdit = (id: string, preset: boolean) => {
    const existing = preset ? undefined : draftOf(id);
    if (existing) { go({ kind: "draft", draftId: existing.draftId }); return; }
    setCompose({ kind: "edit", id, preset, name: names[id] ?? id });
  };
  const submitCompose = async (target: ComposeTarget, text: string) => {
    if (!editor) return;
    setAiBusy(true);
    setAiError("");
    try {
      const base = target.kind === "edit" ? (target.preset ? await service.copyWorkflow(target.id) : target.id) : undefined;
      const draft = await service.createDraft(base ? { base } : {});
      const title = target.kind === "edit" ? `编辑工作流：${target.name}` : "新建工作流";
      const promptKind = target.kind === "new" ? "new" : draft.changes > 0 ? "continue" : "edit";
      const alreadyLive = editor.has(draft.draftId) && editor.send(draft.draftId, text);
      if (!alreadyLive) {
        // 先立刻进入草稿页并展开 AI 抽屉，在会话流里展示加载态，避免弹窗长时间卡在「正在准备…」。
        setPendingAi({ draftId: draft.draftId, request: text, status: "starting" });
        changed();
        navigation.setState({ compose: null, route: { kind: "draft", draftId: draft.draftId }, tab: "mine" });
        void editor
          .start(draft, title, draftPrompt(promptKind, text))
          .then(() => {
            setPendingAi((curr) => (curr?.draftId === draft.draftId ? null : curr));
            changed();
          })
          .catch((cause) => {
            setPendingAi((curr) =>
              curr?.draftId === draft.draftId
                ? { draftId: draft.draftId, request: text, status: "error", error: errorLine(cause) }
                : curr,
            );
          });
      } else {
        changed();
        navigation.setState({ compose: null, route: { kind: "draft", draftId: draft.draftId }, tab: "mine" });
      }
    } catch (cause) {
      setAiError(errorLine(cause));
    } finally {
      setAiBusy(false);
    }
  };
  const discardDraft = async (draftId: string) => {
    setPendingAi((curr) => (curr?.draftId === draftId ? null : curr));
    await editor?.end(draftId);
    await service.discardDraft(draftId);
    changed();
  };
  const openWorkflow = (id: string) => go({ kind: "workflow", id });

  const crumbs = route.kind === "library" ? null : [
    { key: "library", label: "工作流库", onSelect: () => go({ kind: "library" }) },
    { key: route.kind, label: route.kind === "draft" ? "编辑草稿" : names[route.id] ?? "模板详情", current: true },
  ];

  return <section className="workflow-panel workflow-workspace" aria-label="工作流">
    {crumbs && <Breadcrumb className="workflow-crumbs" items={crumbs} />}
    {compose && <AiComposeDialog
      key={compose.kind === "edit" ? compose.id : "new"}
      title={compose.kind === "new" ? "用 AI 新建工作流" : `用 AI 修改「${compose.name}」`}
      placeholder={compose.kind === "new" ? "描述你想要的工作流，例如：先写设计、再评审，评审通过后由我确认，再开始实现" : "描述要怎么改，例如：在设计评审之后加一个人工确认"}
      busy={aiBusy}
      error={aiError}
      onSubmit={(text) => void submitCompose(compose, text)}
      onCancel={() => setCompose(null)}
    />}
    {route.kind === "library" && <div className="workflow-scroll">
      <WorkflowLibrary
        service={service}
        version={version}
        transfer={transfer}
        tab={tab}
        onOpenWorkflow={openWorkflow}
        drafts={editor ? drafts : undefined}
        onOpenDraft={(draftId) => go({ kind: "draft", draftId })}
        onDiscardDraft={discardDraft}
      />
    </div>}
    {route.kind === "draft" && <div className="workflow-draft-host">
      <DraftPage
        key={route.draftId}
        service={service}
        editor={editor}
        draftId={route.draftId}
        pendingAi={pendingAi?.draftId === route.draftId ? pendingAi : null}
        onSaved={(id) => {
          setPendingAi((curr) => (curr?.draftId === route.draftId ? null : curr));
          changed();
          openWorkflow(id);
        }}
        onDiscarded={() => {
          setPendingAi((curr) => (curr?.draftId === route.draftId ? null : curr));
          changed();
          go({ kind: "library" });
        }}
      />
    </div>}
    {route.kind === "workflow" && <div className="workflow-scroll">
      <WorkflowDetailView
        key={route.id}
        service={service}
        id={route.id}
        transfer={transfer}
        draft={draftOf(route.id)}
        onAiEdit={editor ? (preset) => requestEdit(route.id, preset) : undefined}
        onOpenDraft={(draftId) => go({ kind: "draft", draftId })}
        onCopied={(id) => { changed(); navigation.setState({ tab: "mine", route: { kind: "workflow", id } }); }}
        onDeleted={() => { changed(); go({ kind: "library" }); }}
      />
    </div>}
  </section>;
}
