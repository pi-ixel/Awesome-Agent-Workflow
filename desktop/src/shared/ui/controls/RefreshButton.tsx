import { useEffect, useRef, useState } from "react";
import { describeUnknownError } from "../../errors.ts";
import { CheckIcon, RefreshIcon, XIcon } from "../icons.tsx";
import { IconButton } from "../IconButton.tsx";
import { ActionButton } from "../controls.tsx";

/** Manual feedback only. Background invalidations never drive this animation. */
export function RefreshButton({
  onRefresh,
  label = "刷新",
  disabled = false,
  showLabel = false,
  role,
  className = showLabel
    ? ""
    : "rounded p-1 text-ink-mute transition-colors enabled:hover:bg-raised enabled:hover:text-ink",
  iconClassName = "ui-icon-14",
}: {
  onRefresh: () => Promise<unknown>;
  label?: string;
  disabled?: boolean;
  className?: string;
  iconClassName?: string;
  showLabel?: boolean;
  role?: "menuitem";
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
      failure = describeUnknownError(value) || "刷新未完成，请重试";
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
  const isBusy = phase === "busy";
  const buttonClass = `${className} ${isBusy ? "cursor-wait opacity-60" : ""}`;
  const buttonProps = {
    role,
    "aria-label": label,
    "aria-busy": isBusy,
    "aria-disabled": isBusy || undefined,
    "data-hint": feedback,
    disabled,
  };
  const handleClick = () => {
    void run();
  };
  const glyph =
    phase === "done" ? (
      <CheckIcon className={`${iconClassName} text-ok-ink`} />
    ) : phase === "error" ? (
      <XIcon className={`${iconClassName} text-danger-ink`} />
    ) : (
      <RefreshIcon
        className={`${iconClassName} ${isBusy ? "animate-spin motion-reduce:animate-none" : ""}`}
      />
    );
  return (
    <>
      {showLabel ? (
        <ActionButton
          tone="secondary"
          size="compact"
          {...buttonProps}
          className={`min-w-0 max-w-full whitespace-normal! ${buttonClass}`}
          onClick={handleClick}
        >
          {glyph}
          <span className="min-w-0 text-left [overflow-wrap:anywhere]">
            {feedback}
          </span>
        </ActionButton>
      ) : (
        <IconButton
          {...buttonProps}
          className={buttonClass}
          onClick={handleClick}
        >
          {glyph}
        </IconButton>
      )}
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
