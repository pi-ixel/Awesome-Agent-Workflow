import { useEffect, useRef, useState, type ReactNode } from "react";
import { XIcon } from "../../../../shared/ui/icons.tsx";

/** Shared presentation only: protocol adapters retain validation and response semantics. */
export function QuestionPanel({
  id,
  label = "问题",
  title,
  description,
  page,
  count,
  valid,
  stale,
  submitting,
  canSkip,
  interacted,
  onInteract,
  onBack,
  onSend,
  onSkip,
  onClose,
  onAuto,
  children,
}: {
  id: string;
  label?: string;
  title: string;
  description?: string;
  page: number;
  count: number;
  valid: boolean;
  stale?: boolean;
  submitting?: boolean;
  canSkip: boolean;
  interacted: boolean;
  onInteract: () => void;
  onBack: () => void;
  onSend: () => void;
  onSkip: () => void;
  onClose: () => void;
  onAuto?: () => void;
  children: ReactNode;
}) {
  const [seconds, setSeconds] = useState(60);
  const latestAuto = useRef(onAuto);
  useEffect(() => {
    latestAuto.current = onAuto;
  }, [onAuto]);
  const auto = !!onAuto && !interacted && !stale && !submitting;
  useEffect(() => {
    if (!auto) return;
    const until = Date.now() + 60_000;
    const timer = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      setSeconds(remaining);
      if (!remaining) {
        clearInterval(timer);
        latestAuto.current?.();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [auto, id]);
  return (
    <section
      aria-label="结构化问答"
      data-question-dock=""
      className="w-full overflow-hidden rounded-2xl border border-line bg-surface text-ui-base text-ink"
      onPointerDownCapture={onInteract}
      onFocusCapture={onInteract}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !submitting) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else if (
          event.key === "Enter" &&
          !event.nativeEvent.isComposing &&
          event.nativeEvent.keyCode !== 229 &&
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.metaKey &&
          ((event.target instanceof HTMLInputElement &&
            ["text", "number"].includes(event.target.type)) ||
            event.target instanceof HTMLTextAreaElement)
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (valid && !stale && !submitting && !event.repeat) onSend();
        }
      }}
    >
      <header className="flex items-center gap-2 px-4 pt-3 text-ui-caption text-ink-mute">
        <span>{label}</span>
        <span className="flex-1" />
        <span>
          第 {Math.min(page + 1, count)}／{count} 题
        </span>
        {auto && (
          <span data-auto-answer-countdown="">{seconds}s 后自动应答</span>
        )}
        <button
          type="button"
          disabled={submitting}
          aria-label={stale ? "丢弃草稿" : "关闭整组提问"}
          className="rounded p-1 hover:bg-hover"
          onClick={onClose}
        >
          <XIcon className="size-4" />
        </button>
      </header>
      <div className="max-h-72 overflow-y-auto px-4 py-2">
        {stale && (
          <p role="status" className="mb-2 text-ui-caption text-warn-ink">
            请求已失效，答案草稿已保留，等待重新连接后绑定。
          </p>
        )}
        {submitting && (
          <p role="status" className="mb-2 text-ui-caption text-ink-mute">
            正在发送回答…
          </p>
        )}
        <h3 className="mb-2 whitespace-pre-wrap font-medium">{title}</h3>
        {description && (
          <p className="mb-2 whitespace-pre-wrap text-ui-caption leading-5 text-ink-mute">
            {description}
          </p>
        )}
        <fieldset disabled={stale || submitting} className="min-w-0 space-y-2">
          {children}
        </fieldset>
      </div>
      <footer className="flex items-center gap-2 px-4 pb-3">
        {page > 0 && (
          <button
            type="button"
            className="rounded-full px-2 py-1 text-ui-caption text-ink-mute hover:bg-hover"
            disabled={submitting}
            onClick={onBack}
          >
            上一题
          </button>
        )}
        <span className="flex-1" />
        <button
          type="button"
          disabled={!canSkip || stale || submitting}
          data-hint={!canSkip ? "此题为必填，不能跳过" : "跳过当前题"}
          className="rounded-full border border-line px-3 py-1 text-ui-caption disabled:opacity-40 hover:bg-hover"
          onClick={onSkip}
        >
          跳过
        </button>
        <button
          type="button"
          disabled={!valid || stale || submitting}
          className="rounded-full bg-ink px-3 py-1 text-ui-caption font-medium text-base disabled:opacity-40 hover:bg-ink/85"
          onClick={onSend}
        >
          发送
        </button>
      </footer>
    </section>
  );
}

export function QuestionChoices({
  options,
  selected,
  multi,
  onToggle,
}: {
  options: readonly { value: string; label: string; description?: string }[];
  selected: readonly string[];
  multi?: boolean;
  onToggle: (value: string) => void;
}) {
  return (
    <div role={multi ? "group" : "radiogroup"} className="space-y-0.5">
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role={multi ? "checkbox" : "radio"}
          aria-checked={selected.includes(option.value)}
          onClick={() => onToggle(option.value)}
          className={`flex w-full items-start gap-2 rounded-lg px-2 py-1 text-left leading-5 hover:bg-hover ${selected.includes(option.value) ? "bg-selected" : ""}`}
        >
          <span
            aria-hidden="true"
            className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border border-line bg-raised text-ui-caption text-ink-mute"
          >
            {selected.includes(option.value) ? "✓" : index + 1}
          </span>
          <span className="min-w-0">
            <span className="block">{option.label}</span>
            {option.description && (
              <span className="mt-0.5 block text-ui-sm leading-5 text-ink-mute">
                {option.description}
              </span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}
