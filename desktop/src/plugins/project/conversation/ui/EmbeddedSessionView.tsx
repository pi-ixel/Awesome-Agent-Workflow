/**
 * 轻量内置对话视图：供插件（如工作流草稿页）在自己的面板内嵌展示与操作一个独立会话。
 *
 * - 直接按 SessionTarget 绑定对应 SessionRuntime 的 Zustand store，不触碰全局前台会话；
 * - 复用 MarkdownView 与共享控件原语，不含项目顶栏、@ 引用、历史搜索等重功能；
 * - 会话关闭/释放时自动回收订阅，不留残留状态。
 */
import { useEffect, useRef, useState, type ComponentType } from "react";
import { useStore } from "zustand";
import type { SessionStore } from "../sessionStore.ts";
import type {
  AssistantMessageItem,
  SessionItem,
  SystemNoticeItem,
  ThoughtItem,
  ToolCallItem,
  UserMessageItem,
} from "../types.ts";
import type { EmbeddedSessionProps, SessionTarget } from "../../service.ts";
import { foldedText } from "../../../../shared/messageDisplay.ts";
import { MarkdownView } from "../../../../shared/ui/MarkdownView.tsx";
import { Disclosure } from "../../../../shared/ui/Disclosure.tsx";
import { Callout } from "../../../../shared/ui/Callout.tsx";
import { IconButton } from "../../../../shared/ui/IconButton.tsx";
import { Spinner } from "../../../../shared/ui/controls.tsx";
import { composerFieldClass } from "../../../../shared/ui/inputStyles.ts";
import {
  ArrowUpIcon,
  BrainIcon,
  CheckIcon,
  SquareIcon,
  WrenchIcon,
  XIcon,
} from "../../../../shared/ui/icons.tsx";
import { friendlyWorkflowTool } from "./OrdinaryToolCallCard.tsx";

export interface EmbeddedSessionHost {
  readonly findStore: (target: SessionTarget) => SessionStore | undefined;
  readonly send: (target: SessionTarget, text: string) => boolean;
  readonly cancel: (target: SessionTarget) => void;
}

function EmbeddedUserRow({ item }: { readonly item: UserMessageItem }) {
  const visible = item.display?.visible ?? item.text;
  const folded = item.display ? foldedText(item.text, item.display) : "";
  const foldLabel = item.display?.foldLabel ?? "附加说明";
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="max-w-[90%] rounded-popover border border-line bg-raised px-3 py-2 text-ui-sm whitespace-pre-wrap break-words text-ink">
        {visible}
      </div>
      {folded !== "" && (
        <Disclosure
          className="max-w-[90%] text-ink-mute"
          summary={<span className="text-ui-xs">{foldLabel}</span>}
        >
          <pre className="mt-1 max-h-48 overflow-auto rounded-control border border-line bg-surface p-2 text-ui-xs whitespace-pre-wrap break-words text-ink-mute">
            {folded}
          </pre>
        </Disclosure>
      )}
    </div>
  );
}

function EmbeddedAssistantRow({
  item,
}: {
  readonly item: AssistantMessageItem;
}) {
  if (!item.text.trim()) return null;
  return (
    <div className="min-w-0 text-ui-sm text-ink">
      <MarkdownView text={item.text} streaming={item.isStreaming} />
    </div>
  );
}

function EmbeddedThoughtRow({ item }: { readonly item: ThoughtItem }) {
  if (!item.text.trim()) return null;
  return (
    <Disclosure
      className="text-ink-mute"
      summary={
        <span className="inline-flex items-center gap-1.5 text-ui-xs">
          <BrainIcon className="ui-icon-14 shrink-0" aria-hidden={true} />
          <span>{item.isStreaming ? "正在思考…" : "思考过程"}</span>
        </span>
      }
    >
      <div className="mt-1 max-h-44 overflow-y-auto border-l border-line pl-2.5 text-ui-xs whitespace-pre-wrap break-words text-ink-mute">
        {item.text}
      </div>
    </Disclosure>
  );
}

function EmbeddedToolRow({ item }: { readonly item: ToolCallItem }) {
  const running = item.status === "pending" || item.status === "in_progress";
  const failed = item.status === "failed";
  const friendly = friendlyWorkflowTool(item, running);
  const label = friendly
    ? friendly.summary
      ? `${friendly.label} · ${friendly.summary}`
      : friendly.label
    : item.title?.trim() || item.toolName || "工具调用";
  return (
    <div className="flex items-center gap-1.5 rounded-control border border-line/70 bg-surface px-2.5 py-1.5 text-ui-xs text-ink-mute">
      {running ? (
        <Spinner className="ui-icon-14" />
      ) : failed ? (
        <XIcon className="ui-icon-14 shrink-0 text-danger" aria-hidden={true} />
      ) : (
        <CheckIcon
          className="ui-icon-14 shrink-0 text-ok"
          aria-hidden={true}
        />
      )}
      <WrenchIcon className="ui-icon-14 shrink-0 opacity-70" aria-hidden={true} />
      <span className="min-w-0 flex-1 truncate text-ink">{label}</span>
    </div>
  );
}

function EmbeddedNoticeRow({ item }: { readonly item: SystemNoticeItem }) {
  if (item.level === "error") {
    return <Callout tone="danger" title={item.text} />;
  }
  return (
    <p className="text-ui-xs text-ink-mute">{item.text}</p>
  );
}

function EmbeddedItemRow({ item }: { readonly item: SessionItem }) {
  switch (item.kind) {
    case "user":
      return <EmbeddedUserRow item={item} />;
    case "assistant":
      return <EmbeddedAssistantRow item={item} />;
    case "thought":
      return <EmbeddedThoughtRow item={item} />;
    case "tool":
      return <EmbeddedToolRow item={item} />;
    case "system":
      return <EmbeddedNoticeRow item={item} />;
    default:
      return null;
  }
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m} 分` : `${m} 分 ${s} 秒`;
}

function currentTurnStartedAt(items: readonly SessionItem[]): number | null {
  const starts: number[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "tool" || item.kind === "thought") {
      if (item.startedAt !== null) starts.push(item.startedAt);
    } else if (item.kind === "user") {
      if (item.createdAt) {
        const t = Date.parse(item.createdAt);
        if (!Number.isNaN(t)) starts.push(t);
      }
      break;
    }
  }
  return starts.length > 0 ? Math.min(...starts) : null;
}

function EmbeddedWorkingIndicator({
  startedAt,
}: {
  readonly startedAt: number | null;
}) {
  const [fallbackStart] = useState(() => Date.now());
  const origin = startedAt ?? fallbackStart;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - origin) / 1000));

  return (
    <div
      className="flex items-center gap-2 py-1 text-ui-xs text-ink-mute"
      role="status"
      aria-live="polite"
    >
      <Spinner className="ui-icon-14 shrink-0" />
      <span>{elapsed > 0 ? `工作中 ${formatElapsed(elapsed)}` : "正在思考与处理…"}</span>
    </div>
  );
}

function BoundEmbeddedSession({
  store,
  target,
  placeholder,
  emptyText,
  header,
  headerActions,
  send,
  cancel,
}: EmbeddedSessionProps & {
  readonly store: SessionStore;
  readonly send: EmbeddedSessionHost["send"];
  readonly cancel: EmbeddedSessionHost["cancel"];
}) {
  const items = useStore(store, (s) => s.items);
  const isRunning = useStore(store, (s) => s.isAgentRunning);
  const connectionFailure = useStore(store, (s) => s.connectionFailure);
  const turnStartedAt = isRunning ? currentTurnStartedAt(items) : null;
  const [draft, setDraft] = useState("");
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickBottomRef = useRef(true);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !stickBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [items, isRunning]);

  const submit = () => {
    const text = draft.trim();
    if (!text || isRunning) return;
    if (send(target, text)) {
      setDraft("");
      stickBottomRef.current = true;
    }
  };

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-base"
      aria-label="AI 编辑对话"
    >
      {(header || headerActions || isRunning) && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-2">
          <div className="min-w-0 flex-1">{header}</div>
          <div className="flex shrink-0 items-center gap-2">
            {isRunning && (
              <span className="inline-flex shrink-0 items-center gap-1.5 text-ui-xs text-ink-mute">
                <Spinner className="ui-icon-14" />
                <span>AI 正在编辑…</span>
              </span>
            )}
            {headerActions}
          </div>
        </div>
      )}
      <div
        ref={scrollerRef}
        className="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5 overflow-x-hidden overflow-y-auto px-3 py-3"
        onScroll={(event) => {
          const el = event.currentTarget;
          stickBottomRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {connectionFailure && (
          <Callout tone="danger" title={connectionFailure} />
        )}
        {items.length === 0 ? (
          isRunning ? (
            <EmbeddedWorkingIndicator startedAt={turnStartedAt} />
          ) : (
            <p className="text-ui-sm text-ink-mute">
              {emptyText ?? "在这里继续向 AI 提修改要求。"}
            </p>
          )
        ) : (
          <>
            {items.map((item) => (
              <EmbeddedItemRow key={item.id} item={item} />
            ))}
            {isRunning && <EmbeddedWorkingIndicator startedAt={turnStartedAt} />}
          </>
        )}
      </div>
      <div className="shrink-0 border-t border-line p-2.5">
        <div className="flex items-end gap-2 rounded-control border border-line bg-surface px-2.5 py-2 focus-within:border-line-strong">
          <textarea
            className={`${composerFieldClass} max-h-28 min-h-9 flex-1 resize-none text-ui-sm leading-5 outline-none focus:outline-none`}
            aria-label="向 AI 补充修改要求"
            rows={2}
            value={draft}
            placeholder={
              placeholder ?? "继续告诉 AI 怎么改（Enter 发送，Shift+Enter 换行）"
            }
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                submit();
              }
            }}
          />
          {isRunning ? (
            <IconButton
              iconSize="compact"
              className="shrink-0 rounded-control bg-raised text-ink hover:bg-surface-hover"
              aria-label="停止生成"
              data-hint="停止生成"
              onClick={() => cancel(target)}
            >
              <SquareIcon className="ui-icon-14" />
            </IconButton>
          ) : (
            <IconButton
              iconSize="compact"
              className="shrink-0 rounded-control bg-brand text-foreground-inverse hover:opacity-90 disabled:opacity-40"
              aria-label="发送"
              data-hint="发送"
              disabled={draft.trim() === ""}
              onClick={submit}
            >
              <ArrowUpIcon className="ui-icon-14" />
            </IconButton>
          )}
        </div>
      </div>
    </section>
  );
}

export function createEmbeddedSessionView(
  host: EmbeddedSessionHost,
): ComponentType<EmbeddedSessionProps> {
  return function EmbeddedSessionView(props: EmbeddedSessionProps) {
    const store = host.findStore(props.target);
    if (!store) {
      return (
        <section
          className="flex min-h-0 flex-1 flex-col items-center justify-center p-4 text-ui-sm text-ink-mute"
          aria-label="AI 编辑对话"
        >
          编辑会话已结束。
        </section>
      );
    }
    return (
      <BoundEmbeddedSession
        {...props}
        store={store}
        send={host.send}
        cancel={host.cancel}
      />
    );
  };
}
