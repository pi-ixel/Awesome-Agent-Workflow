import { invoke } from "@tauri-apps/api/core";
import { pathKey } from "../../../shared/panelPaths.ts";
import { clearLegacyRestore } from "../browser/legacyRestore.ts";

export interface RecoveryOwner {
  agentId: string;
  project: string;
  sessionId: string;
}
export interface MigrationReport {
  completed: RecoveryOwner[];
  moved: number;
  recovery: {
    owner: RecoveryOwner;
    phase: "webview" | "retained";
    uniqueSessionId: boolean;
  }[];
}
const retained = new Map<string, RecoveryOwner>();
const key = (owner: RecoveryOwner) =>
  JSON.stringify([owner.agentId, pathKey(owner.project), owner.sessionId]);
function stableAgent(value: string) {
  try {
    const config: unknown = JSON.parse(value);
    if (Array.isArray(config) && typeof config[0] === "string")
      return config[0];
  } catch {
    /* registered ID */
  }
  return value;
}
export function retainedSessions(agent: string) {
  return [...retained.values()].filter(
    (owner) => owner.agentId === stableAgent(agent),
  );
}
export async function finishSessionRecovery(
  owner: RecoveryOwner,
  action: "restored" | "absent",
) {
  await invoke("session_recovery_update", {
    owner,
    action,
  });
  retained.delete(key(owner));
}

function belongs(
  scope: string,
  owner: RecoveryOwner,
  uniqueSessionId: boolean,
): boolean {
  const target = pathKey(owner.project) + "#" + owner.sessionId;
  if (scope === target) return uniqueSessionId;
  try {
    const parts: unknown = JSON.parse(scope);
    if (
      Array.isArray(parts) &&
      typeof parts[0] === "string" &&
      stableAgent(parts[0]) === owner.agentId &&
      parts[1] === target
    )
      return true;
  } catch {
    /* composer scope */
  }
  const m =
    /^aaw-desktop\/(?:draft|prompt-history)\/(?:v[23]\/([^/]+)\/)?([^/]+)\/([^/]+)/.exec(
      scope,
    );
  return (
    !!m?.[2] &&
    !!m[3] &&
    (m[1]
      ? stableAgent(decodeURIComponent(m[1])) === owner.agentId
      : uniqueSessionId) &&
    pathKey(decodeURIComponent(m[2])) === pathKey(owner.project) &&
    decodeURIComponent(m[3]) === owner.sessionId
  );
}
function strip(
  drafts: Record<string, unknown>,
  matchesScope: (scope: string) => boolean,
) {
  return Object.fromEntries(
    Object.entries(drafts).filter(([scope]) => !matchesScope(scope)),
  );
}
function clearWebview(
  owner: RecoveryOwner,
  uniqueSessionId: boolean,
  matchesScope: (scope: string) => boolean,
) {
  if (uniqueSessionId) {
    localStorage.removeItem("aaw-desktop/session-title/" + owner.sessionId);
    clearLegacyRestore(owner.sessionId);
  }
  for (const k of Object.keys(localStorage)) {
    let matches: boolean;
    if (k.startsWith("aaw-desktop/session-title.v2/")) {
      const value: unknown = JSON.parse(
        decodeURIComponent(k.slice("aaw-desktop/session-title.v2/".length)),
      );
      matches =
        Array.isArray(value) &&
        typeof value[0] === "string" &&
        stableAgent(value[0]) === owner.agentId &&
        value[1] === owner.sessionId;
    } else {
      const prefix = [
        "aaw-desktop/session-log/",
        "aaw-desktop/prompt-queue.v1/",
      ].find((p) => k.startsWith(p));
      matches = matchesScope(
        prefix ? decodeURIComponent(k.slice(prefix.length)) : k,
      );
    }
    if (matches) localStorage.removeItem(k);
  }
  const images = "aaw-desktop/image-drafts.v1";
  const raw = localStorage.getItem(images);
  if (raw)
    localStorage.setItem(
      images,
      JSON.stringify(
        strip(JSON.parse(raw) as Record<string, unknown>, matchesScope),
      ),
    );
}
export async function prepareSessionRecovery(
  report: MigrationReport,
  clearImages: (belongs: (key: string) => boolean) => Promise<void>,
) {
  for (const record of report.recovery) {
    if (record.phase === "webview") {
      const matchesScope = (scope: string) =>
        belongs(scope, record.owner, record.uniqueSessionId);
      clearWebview(record.owner, record.uniqueSessionId, matchesScope);
      await clearImages(matchesScope);
      await invoke("session_recovery_update", {
        owner: record.owner,
        action: "webview",
      });
    }
    retained.set(key(record.owner), record.owner);
  }
}
