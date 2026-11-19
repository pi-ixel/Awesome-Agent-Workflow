import type { AcpSessionPort } from "../../acpRuntime/types.ts";
import { AcpClosedError } from "../../acpRuntime/service.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import type { AnnotationDraftService } from "./annotationTypes.ts";
import { draftScopeKey } from "./draftStore.ts";
import type { createSessionStore } from "../conversation/sessionStore.ts";

interface SessionIdentity {
  readonly workspacePath: string;
  readonly disposed: boolean;
  readonly recovering?: boolean;
  readonly session: Pick<AcpSessionPort, "sessionId" | "models" | "modes">;
  readonly store: ReturnType<typeof createSessionStore>;
}

export function completeSessionIdentity(
  runtime: SessionIdentity,
  sessionId: string,
  options: {
    annotationDrafts?: AnnotationDraftService;
    restored?: boolean;
    publish: () => void;
  },
): void | Promise<void> {
  if (
    runtime.disposed ||
    runtime.recovering ||
    runtime.session.sessionId !== sessionId
  )
    throw new AcpClosedError("会话已失效，不能绑定历史或草稿");
  const state = runtime.store.getState();
  options.annotationDrafts?.migrate(
    draftScopeKey(runtime.workspacePath, null, state.agentKey),
    draftScopeKey(runtime.workspacePath, sessionId, state.agentKey),
  );
  state.setSessionModels(
    runtime.session.models?.availableModels ?? [],
    runtime.session.models?.currentModelId ?? null,
  );
  state.setSessionModes(
    runtime.session.modes?.availableModes ?? [],
    runtime.session.modes?.currentModeId,
  );
  const scope = `${pathKey(runtime.workspacePath)}#${sessionId}`;
  const target = state.setSessionLogTarget(scope);
  const publish = () => {
    if (runtime.disposed || runtime.recovering || runtime.session.sessionId !== sessionId)
      throw new AcpClosedError("会话已失效，不能绑定历史或草稿");
    void state.flushSessionLog();
    runtime.store.setState({ firstPromptPending: !options.restored });
    options.publish();
    state.openSession(sessionId);
  };
  const restoreAndPublish = () => {
    const restore = options.restored && state.items.length === 0 ? state.restoreSessionLog(scope) : undefined;
    if (restore) return restore.then(publish);
    publish();
  };
  if (target) return target.then(restoreAndPublish);
  return restoreAndPublish();
}

export function prepareDraftPromotion(
  runtime: SessionIdentity & {
    bindDraft(ensureSession: () => Promise<void>): void;
  },
  annotationDrafts: AnnotationDraftService,
  create: () => Promise<{ sessionId: string }>,
  isCurrent: () => boolean,
  publish: (sessionId: string) => void,
): void {
  const session = runtime.session;
  const assertBound = () => {
    if (runtime.disposed || runtime.recovering || runtime.session !== session)
      throw new AcpClosedError("旧连接已失效，保留新会话草稿");
  };
  runtime.bindDraft(async () => {
    assertBound();
    if (!isCurrent())
      throw new AcpClosedError(
        "Agent 已切换，请等待当前 Agent 连接就绪后再发送",
      );
    if (session.sessionId !== null) return;
    const created = await create();
    assertBound();
    if (!isCurrent()) throw new AcpClosedError("Agent 已切换，保留新会话草稿");
    const binding = completeSessionIdentity(runtime, created.sessionId, {
      annotationDrafts,
      publish: () => publish(created.sessionId),
    });
    if (binding) await binding;
  });
}
