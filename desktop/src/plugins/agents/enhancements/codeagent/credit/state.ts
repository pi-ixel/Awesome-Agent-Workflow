import { createStore } from "zustand/vanilla";
import type { HostService } from "../../../../host/service.ts";
import type {
  CodeAgentCreditResult,
  CodeAgentTokenResult,
} from "../../../../host/types.ts";

interface QuotaState {
  readonly creditResult: CodeAgentCreditResult | null;
  readonly tokenResult: CodeAgentTokenResult | null;
  readonly models: readonly {
    readonly value: string;
    readonly label: string;
  }[];
  readonly selectedModelId: string | undefined;
  readonly isCreditLoading: boolean;
  readonly isTokenLoading: boolean;
  refreshCredit(this: void): Promise<void>;
  refreshToken(this: void): Promise<void>;
  selectModel(this: void, modelId: string): void;
  reset(this: void): void;
}

export function monthlyCreditRatio(
  result: CodeAgentCreditResult | null,
): number | null {
  if (result?.status !== "ready" && result?.status !== "stale") return null;
  const row = result.snapshot.rows.find((row) => row.kind === "CPM");
  return row && row.total > 0
    ? Math.max(0, Math.min(1, 1 - row.used / row.total))
    : null;
}

export function createQuotaStore(
  host: Pick<HostService, "readCodeAgentCredit" | "readCodeAgentTokenQuota">,
) {
  let generation = 0;
  let creditPending: Promise<void> | undefined;
  const tokenPending = new Map<string, Promise<void>>();
  const initial = {
    creditResult: null,
    tokenResult: null,
    models: [],
    selectedModelId: undefined,
    isCreditLoading: false,
    isTokenLoading: false,
  };
  return createStore<QuotaState>((set, get) => ({
    ...initial,
    refreshCredit(): Promise<void> {
      if (creditPending) return creditPending;
      const current = generation;
      set({ isCreditLoading: true });
      creditPending = host
        .readCodeAgentCredit()
        .catch((): CodeAgentCreditResult => ({ status: "unavailable" }))
        .then((creditResult) => {
          if (current !== generation) return;
          set({
            creditResult,
            isCreditLoading: false,
            ...(creditResult.status === "signInRequired"
              ? { tokenResult: null, models: [], selectedModelId: undefined }
              : {}),
          });
        })
        .finally(() => {
          if (current === generation) creditPending = undefined;
        });
      return creditPending;
    },
    refreshToken(): Promise<void> {
      const { selectedModelId } = get();
      const key = selectedModelId ?? "";
      const pending = tokenPending.get(key);
      if (pending) return pending;
      const current = generation;
      set({ isTokenLoading: true });
      const request = host
        .readCodeAgentTokenQuota(selectedModelId)
        .catch((): CodeAgentTokenResult => {
          const previous = get().tokenResult;
          return get().selectedModelId === selectedModelId &&
            previous &&
            "snapshot" in previous
            ? { ...previous, status: "stale" }
            : { status: "unavailable" };
        })
        .then((tokenResult) => {
          if (
            current !== generation ||
            get().selectedModelId !== selectedModelId
          )
            return;
          set({
            tokenResult,
            isTokenLoading: false,
            ...("snapshot" in tokenResult
              ? { models: tokenResult.snapshot.models }
              : tokenResult.models
                ? { models: tokenResult.models }
                : {}),
            ...(tokenResult.status === "signInRequired"
              ? { creditResult: tokenResult, models: [] }
              : {}),
          });
        })
        .finally(() => {
          if (current === generation) tokenPending.delete(key);
        });
      tokenPending.set(key, request);
      return request;
    },
    selectModel(selectedModelId: string): void {
      if (selectedModelId !== get().selectedModelId)
        set({ selectedModelId, tokenResult: null });
    },
    reset(): void {
      generation++;
      creditPending = undefined;
      tokenPending.clear();
      set(initial);
    },
  }));
}
