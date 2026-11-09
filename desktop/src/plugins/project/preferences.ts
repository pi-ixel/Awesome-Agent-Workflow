import type { ConfigurationScope } from "../../contracts/configuration.ts";
import type {
  ProjectPreferences,
  ProjectPreferenceValues,
} from "../../contracts/project.ts";
import { createLogger } from "../../shared/diagnosticEvents/logger.ts";

const logger = createLogger("settings");

export const defaultProjectPreferences: ProjectPreferenceValues = {
  approvalMode: "ask",
  autoAnswerQuestions: false,
  chatWidth: "standard",
  messageStreamShowTodos: false,
  sessionAutoArchiveEnabled: false,
  sessionAutoArchiveOlderThanDays: 30,
};

export const projectPreferenceFields = Object.keys(defaultProjectPreferences);

export function normalizeArchiveDays(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(365, Math.max(1, Math.floor(value)))
    : defaultProjectPreferences.sessionAutoArchiveOlderThanDays;
}

function restore(scope: ConfigurationScope): ProjectPreferenceValues {
  try {
    const saved = scope.read();
    if (!saved) return defaultProjectPreferences;
    const width = saved.chatWidth;
    return {
      approvalMode: saved.approvalMode === "auto-allow" ? "auto-allow" : "ask",
      autoAnswerQuestions: saved.autoAnswerQuestions === true,
      chatWidth: width === "wide" || width === "full" ? width : "standard",
      messageStreamShowTodos: saved.messageStreamShowTodos === true,
      sessionAutoArchiveEnabled: saved.sessionAutoArchiveEnabled === true,
      sessionAutoArchiveOlderThanDays: normalizeArchiveDays(
        saved.sessionAutoArchiveOlderThanDays,
      ),
    };
  } catch (error) {
    logger.warn("读取项目偏好失败，使用默认值", { error: String(error) });
    return defaultProjectPreferences;
  }
}

export function createProjectPreferences(scope: ConfigurationScope) {
  type Listener = Parameters<ProjectPreferences["subscribe"]>[0];
  const listeners = new Set<Listener>();
  let state = restore(scope);
  let disposed = false;

  function update(patch: Partial<ProjectPreferenceValues>): void {
    if (disposed) return;
    const previous = state;
    const next = { ...state, ...patch };
    state = next;
    try {
      scope.update(patch);
    } catch (error) {
      logger.warn("写入项目偏好失败", { error: String(error) });
    }
    for (const listener of listeners) listener(next, previous);
  }

  return {
    getState: () => state,
    subscribe(listener) {
      if (!disposed) listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setApprovalMode: (approvalMode) => update({ approvalMode }),
    setAutoAnswerQuestions: (autoAnswerQuestions) =>
      update({ autoAnswerQuestions }),
    setChatWidth: (chatWidth) => update({ chatWidth }),
    setMessageStreamShowTodos: (messageStreamShowTodos) =>
      update({ messageStreamShowTodos }),
    setSessionAutoArchive: (
      sessionAutoArchiveEnabled,
      olderThanDays?: number,
    ) =>
      update({
        sessionAutoArchiveEnabled,
        ...(olderThanDays !== undefined
          ? {
              sessionAutoArchiveOlderThanDays:
                normalizeArchiveDays(olderThanDays),
            }
          : {}),
      }),
    reset: () => update(defaultProjectPreferences),
    dispose() {
      disposed = true;
      const previous = state;
      state = defaultProjectPreferences;
      for (const listener of listeners) listener(state, previous);
      listeners.clear();
    },
  } satisfies ProjectPreferences & { dispose(): void };
}
