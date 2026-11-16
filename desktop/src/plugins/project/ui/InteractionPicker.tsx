import { useEffect, useState } from "react";
import { CheckIcon } from "../../../shared/ui/icons.tsx";
import "./MessageStreamPicker.css";

const choices = [
  { value: "queue", label: "排队", description: "当前轮结束后按序发送" },
  { value: "steer", label: "引导", description: "停止当前轮，再发送补充消息" },
] as const;

export function InteractionPicker({
  value,
  onChange,
}: {
  readonly value: "queue" | "steer";
  readonly onChange: (value: "queue" | "steer") => void;
}) {
  const [phase, setPhase] = useState(0);
  const [reduced, setReduced] = useState(
    () =>
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const change = (event: MediaQueryListEvent) => setReduced(event.matches);
    media?.addEventListener("change", change);
    return () => media?.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (reduced) return;
    const timer = setInterval(
      () => setPhase((current) => (current + 1) % 4),
      1_200,
    );
    return () => clearInterval(timer);
  }, [reduced]);
  const step = reduced ? 3 : phase;
  return (
    <div
      role="group"
      aria-label="交互行为"
      className="grid grid-cols-2 gap-3 p-4"
    >
      {choices.map((choice) => (
        <div
          key={choice.value}
          className={`relative row-span-2 grid min-w-0 grid-rows-subgrid gap-y-3 rounded-xl border p-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-info ${value === choice.value ? "border-info/70 bg-info/5" : "border-line hover:bg-hover"}`}
        >
          <button
            type="button"
            aria-pressed={value === choice.value}
            onClick={() => onChange(choice.value)}
            className="flex items-center justify-between gap-2 px-1 text-left text-ui-base font-semibold text-ink focus-visible:outline-none after:absolute after:inset-0"
          >
            {choice.label}
            <CheckIcon
              aria-hidden="true"
              className={`size-4 shrink-0 text-info ${value === choice.value ? "" : "invisible"}`}
            />
          </button>
          <div className="space-y-3">
            <div
              aria-hidden="true"
              className="message-stream-preview min-w-0 overflow-hidden rounded-lg bg-base px-3 py-2.5"
            >
              <div
                className="message-stream-preview-content space-y-2 [zoom:0.85]"
                key={step}
              >
                <div
                  data-item-kind="user"
                  className="ml-auto w-fit max-w-full rounded-xl rounded-tr-xs border border-line bg-surface px-3 py-2 text-ui-caption text-ink"
                >
                  帮我检查项目
                </div>
                <p
                  data-item-kind="assistant"
                  className="text-ui-caption text-ink-mute"
                >
                  {step < 2
                    ? "正在检查文件…"
                    : choice.value === "steer"
                      ? "当前轮已停止"
                      : "检查完成"}
                </p>
                {step >= 1 && (
                  <div
                    data-item-kind="user"
                    className="ml-auto w-fit max-w-full rounded-xl rounded-tr-xs border border-line bg-surface px-3 py-2 text-ui-caption text-ink"
                  >
                    先看登录模块
                  </div>
                )}
                {step >= 2 && (
                  <p
                    data-item-kind="assistant"
                    className="text-ui-caption text-ink-mute"
                  >
                    {choice.value === "steer"
                      ? "等待后补发，引导优先"
                      : "从队列发送下一条"}
                  </p>
                )}
                {step === 3 && (
                  <p
                    data-item-kind="assistant"
                    className="text-ui-caption text-ink"
                  >
                    开始检查登录模块…
                  </p>
                )}
              </div>
            </div>
            <p className="text-ui-caption text-ink-mute">
              {choice.description}
              {choice.value === "steer"
                ? "；正在运行的命令可能被终止。"
                : "（默认）"}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
