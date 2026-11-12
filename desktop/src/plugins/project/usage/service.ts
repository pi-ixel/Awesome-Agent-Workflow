import { createStore } from "zustand/vanilla";
import { managedProjectStorage } from "../lifecycle/persistence.ts";
import type { ModelInfo } from "../../../contracts/acp/protocol.ts";
import type { StorageCategory } from "../../diagnostics/service.ts";
import {
  acknowledgeUsage,
  loadPendingUsage,
  savePendingUsage,
  type PendingUsage,
} from "./outbox.ts";

export interface UsageScope {
  workspace: string;
  agent: string;
  agentKey: string;
  accounting?: "turn" | "turn-delta";
  sessionId(): string | null | undefined;
  selectedModel?(): string | undefined;
}

export interface UsageStart {
  turn: string;
  startedAt: number;
  selectedModel: string | null;
}

interface UsageTurn extends Omit<UsageStart, "selectedModel"> {
  workspace: string;
  agent: string;
  agentKey: string;
  session: string;
  accounting: "session-total" | "turn" | "turn-delta";
  endedAt: number;
  model: string | null;
  modelSource: "actual" | "selected" | "unknown";
  status: "completed" | "cancelled" | "failed";
  input: number | null;
  output: number | null;
  total: number | null;
}

export interface UsageSnapshot {
  zone: string;
  enabledAt: number;
  today: string;
  workspaces: string[];
  days: [day: string, tokens: string, missing: number, turns?: number][];
  models: [
    day: string,
    model: string | null,
    tokens: string,
    estimated: number,
    name?: string | null,
    agent?: string,
  ][];
}

let origin = {
  zone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  enabledAt: Date.now(),
};
export const usageState = createStore(() => ({ revision: 0, error: "" }));
const pending = new Map<
  string,
  { entry: PendingUsage<UsageTurn>; staged: Promise<boolean> }
>();
const knownModels = new Map<string, string>();

export function rememberUsageModels(
  scope: UsageScope,
  models: readonly ModelInfo[],
) {
  const storage = managedProjectStorage();
  if (!storage?.available()) return;
  const names = models.flatMap(({ modelId, name }) =>
    name.trim() && name !== modelId ? [[modelId, name.trim()]] : [],
  );
  if (!names.length) return;
  const key = JSON.stringify([scope.agent, scope.agentKey]);
  const signature = JSON.stringify(names);
  if (knownModels.get(key) === signature) return;
  knownModels.set(key, signature);
  void storage
    .request("usage_model_names", {
      ...origin,
      agent: scope.agent,
      agentKey: scope.agentKey,
      models: names,
    })
    .then(
      () => {
        usageState.setState((state) => ({ revision: state.revision + 1 }));
      },
      () => {
        if (knownModels.get(key) === signature) knownModels.delete(key);
      },
    );
}

export async function initializeUsage() {
  const storage = managedProjectStorage();
  if (!storage?.available()) return;
  try {
    if (typeof indexedDB !== "undefined") {
      const stored = await loadPendingUsage<UsageTurn>();
      stored.sort((a, b) => a.turn.endedAt - b.turn.endedAt);
      for (const entry of stored) {
        if (entry.enabledAt < origin.enabledAt) {
          origin = { zone: entry.zone, enabledAt: entry.enabledAt };
        }
        if (!pending.has(entry.id))
          pending.set(entry.id, { entry, staged: Promise.resolve(true) });
      }
    }
    if (pending.size) {
      await retryUsage();
    } else {
      await storage.request("usage_initialize", origin);
      usageState.setState({ error: "" });
    }
  } catch (error) {
    usageState.setState({ error: String(error) });
  }
}

export function recordUsage(
  scope: UsageScope,
  start: UsageStart,
  result: {
    actualModel?: string;
    status: UsageTurn["status"];
    usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  },
) {
  const session = scope.sessionId();
  if (!managedProjectStorage()?.available() || !session) return;
  const { turn, startedAt, selectedModel } = start;
  const { actualModel, usage, status } = result;
  const valid = (count: number) => Number.isSafeInteger(count) && count >= 0;
  const known =
    usage &&
    valid(usage.inputTokens) &&
    valid(usage.outputTokens) &&
    Number.isSafeInteger(usage.inputTokens + usage.outputTokens);
  const record: UsageTurn = {
    workspace: scope.workspace,
    agent: scope.agent,
    agentKey: scope.agentKey,
    session,
    turn,
    accounting: scope.accounting ?? "turn",
    startedAt,
    endedAt: Date.now(),
    model: actualModel || selectedModel,
    modelSource: actualModel
      ? "actual"
      : selectedModel
        ? "selected"
        : "unknown",
    status,
    input: known ? usage.inputTokens : null,
    output: known ? usage.outputTokens : null,
    total: usage && valid(usage.totalTokens) ? usage.totalTokens : null,
  };
  const entry = {
    id: crypto.randomUUID(),
    ...origin,
    turn: record,
  };
  const staged =
    typeof indexedDB === "undefined"
      ? Promise.resolve(false)
      : savePendingUsage(entry).then(
          () => true,
          () => false,
        );
  pending.set(entry.id, { entry, staged });
  void retryUsage();
}

let flush: Promise<void> | undefined;
export function retryUsage(): Promise<void> {
  const storage = managedProjectStorage();
  if (!storage?.available()) return Promise.resolve();
  if (flush) return flush;
  if (!pending.size) return initializeUsage();
  flush = (async () => {
    let changed = false;
    try {
      while (pending.size) {
        const [key, { entry, staged }] = pending.entries().next().value!;
        const durable = await staged;
        await storage.request("usage_record", {
          zone: entry.zone,
          enabledAt: entry.enabledAt,
          turn: entry.turn,
        });
        if (durable) await acknowledgeUsage(key);
        pending.delete(key);
        changed = true;
      }
      usageState.setState({ error: "" });
    } catch (error) {
      usageState.setState({ error: String(error) });
    } finally {
      flush = undefined;
      if (changed)
        usageState.setState((state) => ({ revision: state.revision + 1 }));
    }
  })();
  return flush;
}

export async function queryUsage(
  workspace: string,
  agent: string,
  days: number,
) {
  const storage = managedProjectStorage();
  if (!storage?.available()) return null;
  return storage.request<UsageSnapshot>("usage_query", {
    ...origin,
    workspace: workspace || null,
    agent: agent || null,
    days,
  });
}

export async function usageBytes() {
  const storage = managedProjectStorage();
  return storage?.available()
    ? storage.request<number>("usage_storage_bytes")
    : 0;
}

export const usageStorageCategory: StorageCategory = {
  id: "usage.statistics",
  label: "使用统计",
  risk: "",
  exact: true,
  measure: usageBytes,
  list: async () => [
    { key: "statistics", bytes: await usageBytes(), revision: null },
  ],
  saveFailure: {
    message: () => usageState.getState().error || undefined,
    retry: retryUsage,
  },
};
