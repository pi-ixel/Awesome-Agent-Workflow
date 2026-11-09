import { useEffect, useRef, useState } from "react";
import { panelError } from "../../panelError.ts";
import { CheckIcon, RefreshIcon, XIcon } from "../icons.tsx";

/** Manual feedback only. Background invalidations never drive this animation. */
export function RefreshButton({
  onRefresh,
  label = "刷新",
  disabled = false,
  className = "rounded p-1 text-ink-faint transition-colors hover:bg-raised hover:text-ink",
  iconClassName = "size-3.5",
  showLabel = false,
}: {
  onRefresh: () => Promise<unknown>;
  label?: string;
  disabled?: boolean;
  className?: string;
  iconClassName?: string;
  showLabel?: boolean;
}) {
  const [phase, setPhase] = useState<"idle" | "busy" | "done" | "error">(
    "idle",
  );
  const [error, setError] = useState("");
  const locked = useRef(false);
  const mounted = useRef(true);
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(reset.current);
    };
  }, []);
  const run = async () => {
    if (locked.current || disabled) return;
    locked.current = true;
    clearTimeout(reset.current);
    setError("");
    setPhase("busy");
    const started = Date.now();
    let failure = "";
    try {
      await onRefresh();
    } catch (value) {
      failure = panelError(value) || "刷新未完成，请重试";
    }
    // Fast local reads must still give a visible acknowledgement of the click.
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, 500 - (Date.now() - started))),
    );
    locked.current = false;
    if (!mounted.current) return;
    setError(failure);
    setPhase(failure ? "error" : "done");
    reset.current = setTimeout(() => setPhase("idle"), 1600);
  };
  const feedback =
    phase === "busy"
      ? "正在刷新…"
      : phase === "done"
        ? "刷新完成"
        : phase === "error"
          ? `刷新失败：${error}`
          : label;
  return (
    <>
      <button
        type="button"
        aria-label={label}
        aria-busy={phase === "busy"}
        title={feedback}
        disabled={disabled || phase === "busy"}
        className={className}
        onClick={() => void run()}
      >
        {phase === "done" ? (
          <CheckIcon className={`${iconClassName} text-ok-ink`} />
        ) : phase === "error" ? (
          <XIcon className={`${iconClassName} text-danger-ink`} />
        ) : (
          <RefreshIcon
            className={`${iconClassName} ${phase === "busy" ? "animate-spin" : ""}`}
          />
        )}
        {showLabel && <span>{phase === "idle" ? label : feedback}</span>}
      </button>
      <span
        className="sr-only"
        aria-live="polite"
        role={phase === "idle" ? undefined : "status"}
      >
        {phase === "idle" ? "" : feedback}
      </span>
    </>
  );
}
