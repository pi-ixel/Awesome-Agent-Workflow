import { pathKey } from "../../../shared/panelPaths.ts";
import type { HostStorage } from "../../host/types.ts";

interface SessionOwner { readonly agentId: string; readonly configuration: string }

function key(path: string, sessionId: string): string {
  return `aaw-workflow/session-owner/${encodeURIComponent(pathKey(path))}/${encodeURIComponent(sessionId)}`;
}

export async function configurationDigest(selectionKey: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(selectionKey));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readOwner(storage: HostStorage, storageKey: string): SessionOwner | null {
  const raw = storage.getItem(storageKey);
  if (raw === null) return null;
  try {
    const owner = JSON.parse(raw) as Partial<SessionOwner>;
    return typeof owner.agentId === "string" && owner.agentId !== "" &&
      typeof owner.configuration === "string" && /^[0-9a-f]{64}$/.test(owner.configuration)
      ? { agentId: owner.agentId, configuration: owner.configuration } : null;
  } catch { return null; }
}

function writeOwner(storage: HostStorage, storageKey: string, owner: SessionOwner): void {
  const existing = readOwner(storage, storageKey);
  if (existing && (existing.agentId !== owner.agentId || existing.configuration !== owner.configuration)) {
    throw new Error("WORKFLOW_SESSION_OWNER_CONFLICT");
  }
  storage.setItem(storageKey, JSON.stringify(owner));
}

export const readSessionOwner = (storage: HostStorage, path: string, sessionId: string) => readOwner(storage, key(path, sessionId));
export const writeSessionOwner = (storage: HostStorage, path: string, sessionId: string, owner: SessionOwner) => writeOwner(storage, key(path, sessionId), owner);
const runKey = (runId: string) => `aaw-workflow/run-owner/${encodeURIComponent(runId)}`;
export const readRunOwner = (storage: HostStorage, runId: string) => readOwner(storage, runKey(runId));
export const writeRunOwner = (storage: HostStorage, runId: string, owner: SessionOwner) => writeOwner(storage, runKey(runId), owner);
