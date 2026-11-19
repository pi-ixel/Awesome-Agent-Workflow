import { useEffect, useState } from "react";
import type { SessionItem } from "../conversation/types.ts";
import { AssistantMessage } from "../conversation/ui/AssistantMessage.tsx";
import { ConversationTurnView } from "../conversation/ui/ConversationTurnView.tsx";
import { UserMessage } from "../conversation/ui/UserMessage.tsx";
import type { ConversationTurn } from "../conversation/ui/conversationTurns.ts";
import type { MessageStreamMode } from "../types.ts";
import { SettingsPreviewPicker } from "./SettingsPreviewPicker.tsx";
import "./MessageStreamPicker.css";

const options = [
  { value: "process", label: "过程与结论" },
  { value: "conclusion", label: "仅结论" },
] as const;

const workDurationMs = 2_400;
const progressDurationMs = 360;
const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
type Phase = "input" | "progress" | "work" | "settle" | "answer" | "reset";
const playback = {
  input: { next: "progress", durationMs: 900 },
  progress: { next: "work", durationMs: progressDurationMs },
  work: { next: "settle", durationMs: workDurationMs - progressDurationMs },
  settle: { next: "answer", durationMs: 260 },
  answer: { next: "reset", durationMs: 1_000 },
  reset: { next: "input", durationMs: 200 },
} as const;

const input: ConversationTurn = {
  id: "settings-preview",
  user: {
    kind: "user",
    id: "settings-preview-user",
    text: "怎么启动桌面开发模式？",
    createdAt: "",
  },
  history: [],
  running: false,
};

const progress: SessionItem = {
  kind: "assistant",
  id: "settings-preview-progress",
  text: "我先查看桌面应用的启动配置。",
  isStreaming: false,
  createdAt: "",
};

const thought: Extract<SessionItem, { kind: "thought" }> = {
  kind: "thought",
  id: "settings-preview-work",
  text: "检查桌面应用的启动脚本",
  isStreaming: false,
  startedAt: null,
  endedAt: null,
};

const settled: ConversationTurn = {
  ...input,
  history: [progress, { ...thought, startedAt: 0, endedAt: workDurationMs }],
  canCollapseHistory: true,
};

const answer: ConversationTurn = {
  ...settled,
  answer: {
    kind: "assistant",
    id: "settings-preview-answer",
    text: "在 `desktop` 目录运行 `npm run tauri -- dev`。",
    isStreaming: false,
    createdAt: "",
  },
};

const turns: Readonly<Record<Phase, ConversationTurn>> = {
  input,
  progress: { ...input, history: [progress], running: true },
  work: { ...input, history: [progress, thought], running: true },
  settle: settled,
  answer,
  reset: answer,
};

function renderPreviewItem(item: SessionItem) {
  if (item.kind === "user") return <UserMessage item={item} showActions={false} />;
  if (item.kind === "assistant") return <AssistantMessage item={item} showActions={false} />;
  return null;
}

export function MessageStreamPicker({
  value,
  onChange,
}: {
  readonly value: MessageStreamMode;
  readonly onChange: (mode: MessageStreamMode) => void;
}) {
  const [reduceMotion, setReduceMotion] = useState(
    () => window.matchMedia?.(reducedMotionQuery).matches ?? false,
  );
  const [{ phase, cycle }, setPlayback] = useState<{ phase: Phase; cycle: number }>({
    phase: reduceMotion ? "answer" : "input",
    cycle: 0,
  });

  useEffect(() => {
    const media = window.matchMedia?.(reducedMotionQuery);
    const onChange = (event: MediaQueryListEvent) => {
      setReduceMotion(event.matches);
      if (event.matches) setPlayback((current) => ({ ...current, phase: "answer" }));
    };
    media?.addEventListener("change", onChange);
    return () => media?.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (reduceMotion) return;
    const { next, durationMs } = playback[phase];
    const timer = setTimeout(
      () => setPlayback((current) => ({
        phase: next,
        cycle: next === "input" ? current.cycle + 1 : current.cycle,
      })),
      durationMs,
    );
    return () => clearTimeout(timer);
  }, [phase, reduceMotion]);

  return (
    <SettingsPreviewPicker
      label="信息流呈现方式"
      value={value}
      choices={options}
      onChange={onChange}
      renderPreview={(mode) => (
        <div className="message-stream-preview px-3 py-2.5">
          <div
            className="message-stream-preview-content [zoom:0.85]"
            data-resetting={phase === "reset" || undefined}
          >
            <ConversationTurnView
              key={cycle}
              turn={turns[phase]}
              collapseHistory={mode === "conclusion"}
              animateHistory={
                mode === "conclusion" &&
                (phase === "progress" || phase === "work" || phase === "settle")
              }
              renderItem={renderPreviewItem}
            />
          </div>
        </div>
      )}
    />
  );
}
