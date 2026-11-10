import type { ProjectPreferenceValues } from "./types.ts";

export const projectSidebarViewKey = "aaw-desktop/sidebar/view";

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
