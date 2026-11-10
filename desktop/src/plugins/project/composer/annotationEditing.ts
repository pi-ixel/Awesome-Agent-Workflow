import { pathKey } from "../../../shared/panelPaths.ts";
import type { ProjectAnnotationEditor, ProjectService } from "../service.ts";
import type { AnnotationDraftTarget } from "../types.ts";
import { emptyAnnotationDraft, type AnnotationDraftService } from "./annotationTypes.ts";
import { draftScopeKey } from "./scope.ts";

export function createAnnotationEditing(
  drafts: AnnotationDraftService,
  workspace: ProjectService["projects"]["workspace"],
  session: ProjectService["conversation"]["foreground"]["session"],
  navigation: Pick<ProjectService["sessions"], "showConversation" | "startNewSession">,
) {
  let active = true;
  const targets = new Map<string, AnnotationDraftTarget>();
  const scopes = new WeakMap<AnnotationDraftTarget, string>();

  function targetFor(scope: string): AnnotationDraftTarget {
    const existing = targets.get(scope);
    if (existing) return existing;
    const target = Object.freeze({}) as AnnotationDraftTarget;
    targets.set(scope, target);
    scopes.set(target, scope);
    return target;
  }

  function contextFor(project: string) {
    const { activePath } = workspace.getState();
    const { openingSessionId, activeSessionId, agentKey, isBound } = session.getState();
    const sameProject = activePath !== null && pathKey(activePath) === pathKey(project);
    const sessionId = sameProject ? openingSessionId ?? activeSessionId : null;
    return {
      target: targetFor(draftScopeKey(sameProject ? activePath : project, sessionId, agentKey)),
      showExisting: sameProject && isBound,
      startNew: sessionId === null,
    };
  }

  const scopeOf = (target: AnnotationDraftTarget) => active ? scopes.get(target) : undefined;
  const annotationsFor = (scope: string) =>
    drafts.getState().drafts[scope]?.annotations ?? emptyAnnotationDraft.annotations;
  const noSubscription = () => {};
  const editor: ProjectAnnotationEditor = {
    current: (project) => active ? contextFor(project).target : undefined,
    subscribeTarget(listener) {
      if (!active) return noSubscription;
      const unlistenWorkspace = workspace.subscribe((state, previous) => {
        if (active && state.activePath !== previous.activePath) listener();
      });
      const unlistenSession = session.subscribe((state, previous) => {
        if (
          active &&
          (state.agentKey !== previous.agentKey ||
            (state.openingSessionId ?? state.activeSessionId) !==
              (previous.openingSessionId ?? previous.activeSessionId))
        ) listener();
      });
      return () => {
        unlistenWorkspace();
        unlistenSession();
      };
    },
    read(target) {
      const scope = scopeOf(target);
      return scope ? annotationsFor(scope) : emptyAnnotationDraft.annotations;
    },
    subscribeDrafts(listener) {
      if (!active) return noSubscription;
      return drafts.subscribe((state, previous) => {
        if (active && state.drafts !== previous.drafts) listener();
      });
    },
    ensure(target) {
      const scope = scopeOf(target);
      if (scope) drafts.ensure(scope);
    },
    upsert(target, annotation) {
      const scope = scopeOf(target);
      if (!scope) return "批注草稿已关闭";
      drafts.ensure(scope);
      const current = annotationsFor(scope);
      const updated = current.some(({ id }) => id === annotation.id)
        ? current.map((item) => item.id === annotation.id ? annotation : item)
        : [...current, annotation];
      return drafts.put(scope, updated) ? null : drafts.getState().error ?? "批注未保存";
    },
    remove(target, id) {
      const scope = scopeOf(target);
      if (!scope) return false;
      drafts.ensure(scope);
      return drafts.put(scope, annotationsFor(scope).filter((item) => item.id !== id));
    },
    followPromotion(target, listener) {
      const scope = scopeOf(target);
      if (!scope) return noSubscription;
      return drafts.subscribe((state, previous) => {
        const next = state.migrations[scope];
        if (active && next && next !== previous.migrations[scope]) listener(targetFor(next));
      });
    },
    async showAfterSave(project, target) {
      if (!active) return;
      const current = contextFor(project);
      if (current.target !== target) return;
      if (current.showExisting) navigation.showConversation(project);
      else if (current.startNew) return navigation.startNewSession(project);
    },
  };
  return {
    editor,
    dispose() {
      active = false;
      targets.clear();
    },
  };
}
