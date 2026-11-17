/**
 * 输入框草稿持久化：未发送草稿每项目一份，正式会话按 Agent × 项目 × 会话隔离，
 * 切走再切回、重启应用都能恢复；发送成功即清。
 *
 * 键：`aaw-desktop/draft/<encodeURIComponent(workspacePath)>/<sessionId|__new__>`——
 * 会话尚未建立（activeSessionId 为 null）时挂在工作区的 `__new__` 档位上，
 * 新会话首条消息发出前换会话也不丢草稿。
 *
 * 草稿直写，不做防抖。桌面端的写入状态由宿主存储统一报告。
 */
import { projectStorage } from "../lifecycle/persistence.ts";
export {
  NEW_SESSION_DRAFT_SCOPE,
  draftScopeKey,
  legacyNewDraftScopeKey,
} from "./scope.ts";

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
