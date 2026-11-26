import { isAbsolutePath, pathKey } from "../../../shared/panelPaths.ts";
import {
  managedProjectStorage,
  projectStorage,
} from "../lifecycle/persistence.ts";
import { draftScopeKey } from "../composer/scope.ts";

export interface RelatedProjects {
  readonly paths: readonly string[];
  readonly pending?: readonly string[];
  readonly historyPaths?: readonly string[];
}

export interface RelatedProjectsView extends RelatedProjects {
  readonly primary: string;
  readonly isApplying?: boolean;
  readonly error?: string;
  readonly retry: () => Promise<void>;
  readonly usePrimaryOnly: () => Promise<void>;
}

export function isRelatedScopeBlocked(
  scope: RelatedProjectsView | undefined,
): boolean {
  return !!(scope?.pending || scope?.isApplying || scope?.error);
}

function storageKey(
  project: string,
  agentKey: string,
  sessionId: string | null,
) {
  const draft = draftScopeKey(project, null, agentKey);
  return draft
    .replace("aaw-desktop/draft/", "aaw-desktop/session-projects/")
    .replace(/__new__$/, () =>
      sessionId === null ? "__new__" : encodeURIComponent(sessionId),
    );
}

function isPaths(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((path) => typeof path === "string" && isAbsolutePath(path))
  );
}

export function readRelatedProjects(
  project: string,
  agentKey: string,
  sessionId: string | null,
): RelatedProjects | undefined {
  const raw = projectStorage.getItem(storageKey(project, agentKey, sessionId));
  if (!raw) return undefined;
  const saved: unknown = JSON.parse(raw);
  if (
    !saved ||
    typeof saved !== "object" ||
    !("paths" in saved) ||
    !isPaths(saved.paths) ||
    ("pending" in saved && !isPaths(saved.pending)) ||
    ("historyPaths" in saved && !isPaths(saved.historyPaths))
  )
    throw new Error("关联项目记录无法读取");
  return {
    paths: saved.paths,
    pending:
      "pending" in saved ? (saved.pending as readonly string[]) : undefined,
    historyPaths:
      "historyPaths" in saved
        ? (saved.historyPaths as readonly string[])
        : undefined,
  };
}

export async function saveRelatedProjects(
  project: string,
  agentKey: string,
  sessionId: string | null,
  value: RelatedProjects,
) {
  projectStorage.setItem(
    storageKey(project, agentKey, sessionId),
    JSON.stringify(value),
  );
  const managed = managedProjectStorage();
  if (managed?.available()) {
    await managed.flush();
    const error = managed.conversationError?.();
    if (error) throw new Error(`关联项目未保存：${error}`);
  }
}

export function sameRelatedPaths(
  left: readonly string[],
  right: readonly string[],
) {
  return (
    left.length === right.length &&
    left.every((path, index) => pathKey(path) === pathKey(right[index] ?? ""))
  );
}
