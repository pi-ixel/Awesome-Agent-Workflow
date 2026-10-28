/**
 * 输入区状态行（runtimeStatusStore 的消费端）：把 iCode 推过来、此前被
 * 丢弃的会话能力信息放到用户视线落点。
 *
 * 布局分工（状态行的左右两簇）：
 * - 右簇（InputStatusRight）：上下文用量**圆环**（最近一次调用占当前模型
 *   窗口的百分比，环色按 70/90 阈值换档，悬停给 token 明细）+ 模型标识
 *   （模型名优先，回落 profile id）——「现在用什么模型、窗口还剩多少」
 *   是发送前的最后一眼，放在发送钮一侧。
 *
 * 模型标识在有可用清单时升级为切换器（session/set_model）。
 *
 * TurnStatusRow 是对话流末尾的相位行（思考中 / 工具运行中 n / 生成中）：
 * 状态长在消息流里而不是输入框上——用户盯着的是对话，不是输入条。
 */
import { Fragment } from "react";

import { useSessionStore } from "../../stores/sessionStore.ts";
import { useApprovalStore } from "../../stores/approvalStore.ts";
import {
  turnStatusLabel,
  useRuntimeStatusStore,
} from "../../stores/runtimeStatusStore.ts";
import {
  MenuItemRow,
  MenuSectionLabel,
  StatusChipMenu,
} from "./StatusChipMenu.tsx";

/** token 数的人读短格式（51_000 → 51k；1_280_000 → 1.3M）。 */
function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return String(value);
}

/** 模型标识短格式：裸 hash 只留前 12 位（悬停见全量）。 */
function shortModelLabel(label: string): string {
  return /^[0-9a-f]{16,}$/i.test(label) ? label.slice(0, 12) : label;
}

/** 悬停明细的多行文本。 */
function hoverLines(lines: readonly string[]): string {
  return lines.filter((line) => line.length > 0).join("\n");
}

/** 圆环几何：18px 视口、半径 7、2.5px 描边（周长 2πr ≈ 43.98）。 */
const RING_RADIUS = 7;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** 上下文用量圆环 + 百分比，悬停给窗口占用/会话累计/缓存明细。 */
export function ContextRing(): React.JSX.Element | null {
  const usage = useRuntimeStatusStore((state) => state.usage);
  const maxContextTokens = useRuntimeStatusStore(
    (state) => state.usage?.maxContextTokens ?? state.runtime.maxContextTokens,
  );
  if (usage === null || maxContextTokens === null || maxContextTokens <= 0) {
    return null;
  }
  const used = usage.totalTokens ?? 0;
  const pct = usage.pct ?? Math.round((used / maxContextTokens) * 100);
  const clamped = Math.min(100, Math.max(0, pct));
  const ringClass =
    clamped >= 90
      ? "stroke-danger-ink"
      : clamped >= 70
        ? "stroke-warn-ink"
        : "stroke-info-ink";
  const detail = hoverLines([
    `上下文窗口：${formatTokens(used)} / ${formatTokens(maxContextTokens)}（${pct}%）`,
    usage.inputTokens !== null
      ? `最近调用：输入 ${formatTokens(usage.inputTokens)} · 输出 ${formatTokens(usage.outputTokens ?? 0)}`
      : "",
    usage.totalSessionTokens !== null
      ? `会话累计：${formatTokens(usage.totalSessionTokens)}`
      : "",
    usage.cacheHitTokens !== null
      ? `缓存命中：${formatTokens(usage.cacheHitTokens)}`
      : "",
  ]);
  return (
    <span
      className="flex min-w-0 shrink-0 items-center gap-1"
      title={detail}
      data-status="context"
    >
      <svg
        viewBox="0 0 18 18"
        aria-hidden={true}
        className="size-[18px] shrink-0"
      >
        {/* 轨道 */}
        <circle
          cx="9"
          cy="9"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="2.5"
          className="stroke-line-strong"
        />
        {/* 进度弧：12 点起顺时针 */}
        <circle
          cx="9"
          cy="9"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={`${(RING_CIRCUMFERENCE * clamped) / 100} ${RING_CIRCUMFERENCE}`}
          transform="rotate(-90 9 9)"
          className={ringClass}
        />
      </svg>
      <span className="text-2xs tabular-nums text-ink-mute">
        {Math.floor(pct)}%
      </span>
    </span>
  );
}

/**
 * 模型标识 + 切换器：有可用模型清单（会话建立时 chrys 下发）时点开即换
 * （session/set_model，chrys 随后回推 runtime 更新刷新标识）；无清单回落
 * 纯展示。选中态优先 currentModelId，未知时按显示名回配。
 */
export function ModelTag(): React.JSX.Element {
  const sessionModelLabel = useSessionStore((state) => state.modelLabel);
  const availableModels = useSessionStore((state) => state.availableModels);
  const currentModelId = useSessionStore((state) => state.currentModelId);
  const switchModel = useSessionStore((state) => state.switchModel);
  const runtime = useRuntimeStatusStore((state) => state.runtime);
  const label =
    runtime.modelName ?? runtime.modelProfileId ?? sessionModelLabel;
  const effectiveCurrentId =
    currentModelId ??
    (label !== null
      ? availableModels.find(
          (model) => model.modelId === label || model.name === label,
        )?.modelId ?? null
      : null);
  if (availableModels.length === 0) {
    return (
      <span
        className="flex min-w-0 items-center px-1 py-0.5 text-sm text-ink-mute"
        title={hoverLines([label ?? "", runtime.modelProvider ?? ""])}
      >
        <span className="truncate font-mono">
          {label === null ? "—" : shortModelLabel(label)}
        </span>
      </span>
    );
  }
  return (
    <StatusChipMenu
      title={`当前模型：${label ?? "—"}（点击切换，仅本会话生效）`}
      menuLabel="模型选择"
      label={
        <span className="max-w-40 truncate font-mono">
          {label === null ? "—" : shortModelLabel(label)}
        </span>
      }
    >
      <MenuSectionLabel text="模型（本会话）" />
      <div className="max-h-52 overflow-y-auto py-1">
        {availableModels.map((model) => (
          <MenuItemRow
            key={model.modelId}
            title={
              <span className="block truncate font-mono text-xs">
                {model.name}
              </span>
            }
            description={
              model.description !== null &&
              model.description !== undefined &&
              model.description.length > 0
                ? model.description
                : " "
            }
            selected={model.modelId === effectiveCurrentId}
            onClick={() => {
              switchModel(model.modelId);
            }}
          />
        ))}
      </div>
    </StatusChipMenu>
  );
}

/** 右簇：模型 + 上下文圆环（发送前的最后一眼，靠发送钮一侧）。 */
export function InputStatusRight(): React.JSX.Element {
  return (
    <Fragment>
      <ModelTag />
      <ContextRing />
    </Fragment>
  );
}

/**
 * 对话流末尾的轮次相位行：agent 运行中显示当前相位（思考中 / 工具运行
 * 中 n / 生成中），随事件流推进，轮次结束即消失。挂在消息列表末尾，
 * 自动滚动跟随。
 */
export function TurnStatusRow(): React.JSX.Element | null {
  const isAgentRunning = useSessionStore((state) => state.isAgentRunning);
  const turnState = useSessionStore((state) => state.turnState);
  const isWaitingForActivity = useSessionStore(
    (state) => state.isWaitingForActivity,
  );
  const queuedCount = useSessionStore((state) => state.queuedPrompts.length);
  const isTurnActive = useRuntimeStatusStore((state) => state.isTurnActive);
  // 等你回答/审批时轮次还开着（Promise 未 resolve），但相位不是
  // 「思考中/生成中」——是「在等你」，相位行退场让位给问答面板
  const pendingCount = useApprovalStore((state) => state.pending.length);
  const phase = useRuntimeStatusStore((state) =>
    state.isTurnActive ? turnStatusLabel(state) : null,
  );
  if (
    !isAgentRunning ||
    ((isTurnActive === false || phase === null) && turnState !== "unknown") ||
    (pendingCount > 0 && turnState !== "cancelling" && turnState !== "unknown")
  ) {
    return null;
  }
  return (
    <li
      aria-live="polite"
      data-turn-status=""
      className="flex items-center gap-2 px-1 py-1.5 text-xs text-ink-faint"
    >
      <span className="inline-block size-1.5 animate-pulse rounded-full bg-info" />
      {turnState === "unknown"
        ? "执行状态未确认，请检查连接；当前轮次仍被保留"
        : turnState === "cancelling"
          ? isWaitingForActivity
            ? "仍在等待取消确认…"
            : "正在取消，等待确认…"
          : isWaitingForActivity
            ? "暂未收到新进度，仍在等待响应…"
            : `${phase}…`}
      {queuedCount > 0 ? (
        <span className="text-ink-ghost">（{queuedCount} 条排队待发）</span>
      ) : null}
    </li>
  );
}
