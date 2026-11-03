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
import { useRuntimeStatusStore } from "../../stores/runtimeStatusStore.ts";
import { MenuItemRow, StatusChipMenu } from "./StatusChipMenu.tsx";

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
  // 占用数：chrys 源给 totalTokens（最近调用）；标准源给 totalSessionTokens
  //（会话累计占用口径）——都取最近可用值，绝不显示误导性的 0
  const used = usage.totalTokens ?? usage.totalSessionTokens ?? 0;
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
      {/* 百分比 12px 档（ZCode CodingPlanContextUsage.tsx:151：
          text-ui-sm tabular-nums） */}
      <span className="text-ui-sm tabular-nums text-ink-mute">
        {Math.floor(pct)}%
      </span>
    </span>
  );
}

/**
 * 模型标识 + 切换器：优先使用 ACP models 的当前 ID 与清单名称，
 * 不依赖 Agent 私有通知。没有当前 ID 时兼容旧 runtime/modelLabel。
 * 有清单时通过 session/set_model 切换，无清单时纯展示。
 */
export function ModelTag(): React.JSX.Element {
  const sessionModelLabel = useSessionStore((state) => state.modelLabel);
  const availableModels = useSessionStore((state) => state.availableModels);
  const currentModelId = useSessionStore((state) => state.currentModelId);
  const switchModel = useSessionStore((state) => state.switchModel);
  const runtime = useRuntimeStatusStore((state) => state.runtime);
  const label =
    (currentModelId !== null
      ? (availableModels.find((model) => model.modelId === currentModelId)
          ?.name ?? currentModelId)
      : null) ??
    runtime.modelName ??
    runtime.modelProfileId ??
    sessionModelLabel;
  const effectiveCurrentId =
    currentModelId ??
    (label !== null
      ? (availableModels.find(
          (model) => model.modelId === label || model.name === label,
        )?.modelId ?? null)
      : null);
  if (availableModels.length === 0) {
    return (
      <span
        className="flex min-w-0 items-center px-1 py-0.5 text-sm text-ink-mute"
        title={hoverLines([label ?? "", runtime.modelProvider ?? ""])}
      >
        <span className="truncate">
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
        <span className="max-w-40 truncate">
          {label === null ? "—" : shortModelLabel(label)}
        </span>
      }
    >
      <div className="max-h-52 overflow-y-auto py-1">
        {availableModels.map((model) => (
          <MenuItemRow
            key={model.modelId}
            title={<span className="block truncate">{model.name}</span>}
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
 * 对话流末尾的诊断行：只承载相位行不覆盖的异常态——执行状态未确认 /
 * 取消中 / 等待响应，以及排队计数。常规的「思考中/生成中」指示由流内的
 * 思考行与工具卡标题的流光承担（ZCode 结构：无独立相位行），轮次正常
 * 且无排队时本行退场。
 */
export function TurnStatusRow(): React.JSX.Element | null {
  const isAgentRunning = useSessionStore((state) => state.isAgentRunning);
  const turnState = useSessionStore((state) => state.turnState);
  const isWaitingForActivity = useSessionStore(
    (state) => state.isWaitingForActivity,
  );
  const queuedCount = useSessionStore((state) => state.queuedPrompts.length);
  // 等你回答/审批时轮次还开着（Promise 未 resolve），但相位不是
  // 「思考中/生成中」——是「在等你」，本行退场让位给问答面板
  const pendingCount = useApprovalStore((state) => state.pending.length);
  const hasNotice =
    turnState === "unknown" ||
    turnState === "cancelling" ||
    isWaitingForActivity;
  if (
    !isAgentRunning ||
    (!hasNotice && queuedCount === 0) ||
    (pendingCount > 0 && turnState !== "cancelling" && turnState !== "unknown")
  ) {
    return null;
  }
  return (
    <li
      aria-live="polite"
      data-turn-status=""
      className="flex items-center gap-2 px-1 py-1.5 text-xs"
    >
      {turnState === "unknown" ? (
        <span className="text-ink-faint">
          执行状态未确认，请检查连接；当前轮次仍被保留
        </span>
      ) : turnState === "cancelling" ? (
        <span className="text-ink-faint">
          {isWaitingForActivity ? "仍在等待取消确认…" : "正在取消，等待确认…"}
        </span>
      ) : isWaitingForActivity ? (
        <span className="text-ink-faint">暂未收到新进度，仍在等待响应…</span>
      ) : null}
      {queuedCount > 0 ? (
        <span className="text-ink-ghost">（{queuedCount} 条排队待发）</span>
      ) : null}
    </li>
  );
}
