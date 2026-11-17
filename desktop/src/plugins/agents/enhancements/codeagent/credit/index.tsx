import type { Context } from "cordis";
import { useEffect, useId, useRef, useState } from "react";
import { createStore, useStore } from "zustand";
import type { CodeAgentCreditResult } from "../../../../host/types.ts";
import { focusVisibleRing } from "../../../../../shared/ui/controls.tsx";
import { CreditIcon, QuotaContent } from "./QuotaContent.tsx";

export const name = "codeagent-credit";
export const inject = ["agents", "host", "workbench"];

const refreshMs = 5 * 60_000;

export function apply(ctx: Context): void {
  const { agents, host, workbench } = ctx;
  const snapshot = createStore<{ result: CodeAgentCreditResult | null; loading: boolean }>(
    () => ({ result: null, loading: false }),
  );
  let generation = 0;
  let pending: Promise<void> | undefined;

  function refresh(): Promise<void> {
    if (pending) return pending;
    const current = generation;
    snapshot.setState({ loading: true });
    pending = host.readCodeAgentCredit().catch((): CodeAgentCreditResult => ({ status: "unavailable" }))
      .then((result) => {
        if (current === generation) snapshot.setState({ result, loading: false });
      }).finally(() => {
        if (current === generation) pending = undefined;
      });
    return pending;
  }

  function useRefresh(active: boolean): void {
    useEffect(() => {
      if (!active) return;
      const check = () => {
        if (!document.hidden) void refresh();
      };
      check();
      const timer = window.setInterval(check, refreshMs);
      document.addEventListener("visibilitychange", check);
      return () => {
        window.clearInterval(timer);
        document.removeEventListener("visibilitychange", check);
      };
    }, [active]);
  }

  function RailAction() {
    const id = useId();
    const [open, setOpen] = useState(false);
    const trigger = useRef<HTMLButtonElement>(null);
    const panel = useRef<HTMLDivElement>(null);
    const { result, loading } = useStore(snapshot);
    useRefresh(open);
    useEffect(() => {
      if (!open) return;
      const dismiss = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        panel.current?.hidePopover();
        trigger.current?.focus();
      };
      window.addEventListener("keydown", dismiss, true);
      return () => window.removeEventListener("keydown", dismiss, true);
    }, [open]);
    return (
      <>
        <button
          ref={trigger}
          type="button"
          aria-label="CodeAgent 额度"
          aria-expanded={open}
          aria-controls={id}
          popoverTarget={id}
          data-hint="CodeAgent 额度"
          className={`grid min-h-9 min-w-9 place-items-center rounded-lg text-ink-mute hover:bg-hover hover:text-ink ${focusVisibleRing}`}
          onClick={(event) => {
            const { right, bottom } = event.currentTarget.getBoundingClientRect();
            panel.current?.style.setProperty("left", `${right + 6}px`);
            panel.current?.style.setProperty("bottom", `${window.innerHeight - bottom}px`);
          }}
        >
          <CreditIcon className="ui-icon-18" />
        </button>
        <div
          ref={panel}
          id={id}
          popover="auto"
          aria-label="CodeAgent 额度"
          onToggle={(event) => setOpen(event.newState === "open")}
          className="fixed inset-auto m-0 max-h-[calc(100dvh-4rem)] w-72 max-w-[calc(100dvw-3.5rem)] overflow-auto rounded-xl border border-line bg-surface p-3 text-ink shadow-floating"
        >
          <p className="mb-3 text-ui-caption text-ink-mute">CodeAgent CLI 账户额度</p>
          {open && <QuotaContent result={result} loading={loading} compact />}
          <button
            type="button"
            className={`mt-3 w-full rounded-md border-t border-line px-1 py-2 text-left text-ui-sm hover:bg-hover ${focusVisibleRing}`}
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

  function Settings({ active }: { active: boolean }) {
    const { result, loading } = useStore(snapshot);
    useRefresh(active);
    return (
      <div className="max-w-2xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-ui-sm text-ink-mute">CodeAgent CLI 账户额度</p>
          <button
            type="button"
            disabled={loading}
            onClick={() => void refresh()}
            className={`rounded-lg border border-line px-3 py-1.5 text-ui-sm hover:bg-hover disabled:opacity-50 ${focusVisibleRing}`}
          >
            刷新
          </button>
        </div>
        <div className="rounded-xl border border-line bg-raised/40 p-4">
          <QuotaContent result={result} loading={loading} />
        </div>
      </div>
    );
  }

  ctx.effect(() => {
    let unregister: (() => void) | undefined;
    function sync() {
      const active = agents.configuration.getState().activeAgentId === "codeagent";
      if (active && !unregister) {
        const rail = workbench.register("activityRailActions", { id: name, View: RailAction });
        const settings = workbench.register("settings", {
          id: name,
          label: "CodeAgent 配额",
          order: 26,
          Icon: CreditIcon,
          View: Settings,
        });
        unregister = () => { rail(); settings(); };
      } else if (!active && unregister) {
        unregister();
        unregister = undefined;
        generation++;
        pending = undefined;
        snapshot.setState({ result: null, loading: false });
      }
    }
    const unsubscribe = agents.configuration.subscribe(sync);
    sync();
    return () => {
      generation++;
      unregister?.();
      unsubscribe();
    };
  });
}
