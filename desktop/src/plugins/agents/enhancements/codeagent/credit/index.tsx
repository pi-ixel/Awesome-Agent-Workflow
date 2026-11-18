import type { Context } from "cordis";
import { useEffect, useId, useRef, useState } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  btnSecondary,
  btnSize,
  focusVisibleRing,
  Listbox,
} from "../../../../../shared/ui/controls.tsx";
import { SegmentedControl } from "../../../../../shared/ui/controls/SegmentedControl.tsx";
import { CreditIcon, QuotaContent, TokenContent } from "./QuotaContent.tsx";
import { createQuotaStore, monthlyCreditRatio } from "./state.ts";

export const name = "codeagent-credit";
export const inject = ["agents", "host", "workbench"];

const creditRefreshMs = 5 * 60_000;
const tokenRefreshMs = 15_000;
type QuotaTab = "credit" | "token";
const tabs = [
  { value: "credit", label: "Credit" },
  { value: "token", label: "Token" },
] as const;

export function apply(ctx: Context): void {
  const { agents, host, workbench } = ctx;
  const store = createQuotaStore(host);
  const { refreshCredit, refreshToken, selectModel, reset } = store.getState();

  function QuotaPanel({
    isActive,
    settings = false,
  }: {
    readonly isActive: boolean;
    readonly settings?: boolean;
  }) {
    const [tab, setTab] = useState<QuotaTab>("credit");
    const {
      creditResult,
      tokenResult,
      models,
      selectedModelId,
      isCreditLoading,
      isTokenLoading,
    } = useStore(
      store,
      useShallow((state) => ({
        creditResult: state.creditResult,
        tokenResult: state.tokenResult,
        models: state.models,
        selectedModelId: state.selectedModelId,
        isCreditLoading: state.isCreditLoading,
        isTokenLoading: state.isTokenLoading,
      })),
    );
    useEffect(() => {
      if (isActive && !document.hidden) void refreshCredit();
    }, [isActive]);
    useEffect(() => {
      if (!isActive || tab !== "token") return;
      const check = () => {
        if (!document.hidden) void refreshToken();
      };
      check();
      const timer = window.setInterval(check, tokenRefreshMs);
      document.addEventListener("visibilitychange", check);
      return () => {
        window.clearInterval(timer);
        document.removeEventListener("visibilitychange", check);
      };
    }, [isActive, tab, selectedModelId]);
    const modelId =
      tokenResult?.status === "ready" || tokenResult?.status === "stale"
        ? tokenResult.snapshot.modelId
        : (selectedModelId ?? models[0]?.value ?? null);
    const isLoading = tab === "credit" ? isCreditLoading : isTokenLoading;
    const switcher = (
      <SegmentedControl<QuotaTab>
        groupLabel="额度类型"
        tabs
        value={tab}
        options={tabs}
        onChange={setTab}
      />
    );
    return (
      <div className={settings ? "flex min-w-0 flex-col gap-5" : "space-y-4"}>
        <div className="flex items-center justify-between gap-3">
          {settings ? (
            <h2 className="text-ui-base font-semibold text-ink">
              配额
            </h2>
          ) : (
            switcher
          )}
          <button
            type="button"
            disabled={isLoading}
            className={
              settings
                ? `${btnSecondary} ${btnSize}`
                : `shrink-0 rounded-md px-2 py-1 text-ui-caption text-ink-mute hover:bg-hover hover:text-ink disabled:opacity-50 ${focusVisibleRing}`
            }
            onClick={() =>
              void (tab === "credit" ? refreshCredit() : refreshToken())
            }
          >
            刷新
          </button>
        </div>
        {settings && <div>{switcher}</div>}
        <div
          role="tabpanel"
          aria-label={tab === "credit" ? "Credit" : "Token"}
          className={
            settings
              ? "space-y-5 rounded-xl border border-line bg-surface p-4"
              : "space-y-4"
          }
        >
          {tab === "credit" ? (
            <QuotaContent result={creditResult} isLoading={isCreditLoading} />
          ) : (
            <>
              {models.length > 0 && (
                <Listbox
                  label="额度模型"
                  value={modelId}
                  options={models}
                  onChange={selectModel}
                  fullWidth
                  className="min-h-8 py-1.5 text-ui-sm"
                />
              )}
              <TokenContent result={tokenResult} isLoading={isTokenLoading} />
            </>
          )}
        </div>
      </div>
    );
  }

  function RailAction() {
    const id = useId();
    const [isOpen, setIsOpen] = useState(false);
    const trigger = useRef<HTMLButtonElement>(null);
    const panel = useRef<HTMLDivElement>(null);
    const creditResult = useStore(store, (state) => state.creditResult);
    const ratio = monthlyCreditRatio(creditResult);
    useEffect(() => {
      if (!isOpen) return;
      const position = () => {
        if (!trigger.current || !panel.current) return;
        const { right, bottom } = trigger.current.getBoundingClientRect();
        const left = Math.min(
          right + 8,
          window.innerWidth - panel.current.offsetWidth - 12,
        );
        panel.current.style.setProperty("left", `${Math.max(12, left)}px`);
        panel.current.style.setProperty(
          "bottom",
          `${Math.max(12, window.innerHeight - bottom)}px`,
        );
      };
      const dismiss = (event: KeyboardEvent) => {
        if (
          event.key !== "Escape" ||
          panel.current?.querySelector('[role="listbox"]')
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        panel.current?.hidePopover();
        trigger.current?.focus();
      };
      position();
      window.addEventListener("resize", position);
      window.addEventListener("keydown", dismiss, true);
      return () => {
        window.removeEventListener("resize", position);
        window.removeEventListener("keydown", dismiss, true);
      };
    }, [isOpen]);
    return (
      <>
        <button
          ref={trigger}
          type="button"
          aria-label="CodeAgent 额度"
          aria-expanded={isOpen}
          aria-controls={id}
          popoverTarget={id}
          data-hint="CodeAgent 额度"
          className={`grid min-h-9 min-w-9 shrink-0 place-items-center rounded-lg text-ink-mute transition-colors hover:bg-hover hover:text-ink ${focusVisibleRing}`}
        >
          <CreditIcon className="ui-icon-18" ratio={ratio} />
        </button>
        <div
          ref={panel}
          id={id}
          popover="auto"
          aria-label="CodeAgent 额度"
          onToggle={(event) => setIsOpen(event.newState === "open")}
          className="fixed inset-auto m-0 max-h-[calc(100dvh-2rem)] w-80 max-w-[calc(100dvw-4.5rem)] overflow-auto rounded-2xl border border-line bg-surface p-4 text-ink shadow-floating"
        >
          {isOpen && <QuotaPanel isActive />}
          <button
            type="button"
            className={`mt-4 w-full rounded-md border-t border-line pt-3 text-left text-ui-caption text-ink-mute hover:text-ink ${focusVisibleRing}`}
            onClick={() => {
              panel.current?.hidePopover();
              workbench.navigation.getState().openSettingsTab(name);
            }}
          >
            查看用量配额
          </button>
        </div>
      </>
    );
  }

  function Settings({ active }: { readonly active: boolean }) {
    return <QuotaPanel isActive={active} settings />;
  }

  ctx.effect(() => {
    let unregister: (() => void) | undefined;
    function sync() {
      const isActive =
        agents.configuration.getState().activeAgentId === "codeagent";
      if (isActive && !unregister) {
        const check = () => {
          if (!document.hidden) void refreshCredit();
        };
        const timer = window.setInterval(check, creditRefreshMs);
        document.addEventListener("visibilitychange", check);
        const rail = workbench.register("activityRailActions", {
          id: name,
          View: RailAction,
        });
        const settings = workbench.register("settings", {
          id: name,
          label: "配额",
          group: "data",
          order: 26,
          Icon: CreditIcon,
          View: Settings,
        });
        unregister = () => {
          rail();
          settings();
          window.clearInterval(timer);
          document.removeEventListener("visibilitychange", check);
        };
        check();
      } else if (!isActive && unregister) {
        unregister();
        unregister = undefined;
        reset();
      }
    }
    const unsubscribe = agents.configuration.subscribe(sync);
    sync();
    return () => {
      unregister?.();
      unsubscribe();
      reset();
    };
  });
}
