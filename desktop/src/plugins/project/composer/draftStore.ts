/** 草稿按 Agent、项目和会话保存。未建立会话时使用该 Agent 在项目中的新会话档位。 */
import { projectStorage } from "../lifecycle/persistence.ts";
export {
  NEW_SESSION_DRAFT_SCOPE,
  draftScopeKey,
  legacyNewDraftScopeKey,
} from "./scope.ts";

const deletedDrafts = new Set<string>();

export function removeSessionDraft(key: string): void {
  projectStorage.removeItem?.(key);
  deletedDrafts.add(key);
}

const RECOVERED_DRAFT = "\0aaw-recovered-draft.v1\n";
type RecoveryStatus = "pending" | "unknown" | "quiet";
type DraftRecovery = { id: string; status: RecoveryStatus | "consumed" };
type DraftRecord = { text: string; recoveries: readonly DraftRecovery[] };

function readRecord(key: string): DraftRecord {
  try {
    const raw = projectStorage.getItem(key) ?? "";
    if (raw.startsWith(RECOVERED_DRAFT)) {
      const parsed = JSON.parse(raw.slice(RECOVERED_DRAFT.length)) as DraftRecord;
      if (typeof parsed.text === "string" && Array.isArray(parsed.recoveries))
        return parsed;
    }
    return { text: raw, recoveries: [] };
  } catch {
    return { text: "", recoveries: [] };
  }
}

/** 读取某 scope 的草稿（无记录 / 不可读返回空串）。 */
export function readDraft(key: string): string {
  return readRecord(key).text;
}

/** 写入草稿，同时保留已经自动追加过的消息 ID。 */
export function writeDraft(key: string, text: string): boolean {
  return writeRecord(key, { text, recoveries: readRecord(key).recoveries });
}

function writeRecord(key: string, record: DraftRecord): boolean {
  if (deletedDrafts.has(key)) return false;
  try {
    if (record.recoveries.length) {
      projectStorage.setItem(key, RECOVERED_DRAFT + JSON.stringify(record));
    } else if (record.text.length === 0) {
      projectStorage.removeItem?.(key);
    } else {
      projectStorage.setItem(key, record.text);
    }
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(key: string): void {
  writeRecord(key, { text: "", recoveries: [] });
}

export function clearSentDraft(key: string): void {
  const recoveries = readRecord(key).recoveries.map(({ id }) => ({ id, status: "consumed" as const }));
  writeRecord(key, { text: "", recoveries });
}

/** IDs already merged into a draft by older clients. */
export function readDraftRecoveries(key: string): readonly DraftRecovery[] {
  return readRecord(key).recoveries;
}
