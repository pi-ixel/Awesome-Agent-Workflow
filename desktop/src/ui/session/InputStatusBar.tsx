/**
 * 输入区状态行（runtimeStatusStore 的消费端）：把 iCode 推过来、此前被
 * 丢弃的会话能力信息放到用户视线落点。
 *
 * 布局分工（状态行的左右两簇）：
 * - 右簇（InputStatusRight）：上下文用量**圆环**（最近一次调用占当前模型
 *   窗口的百分比，悬停弹「上下文容量」浮框；ZCode 工具栏同款几何与配色）+
 *   模型标识（模型名优先，回落 profile id）——「现在用什么模型、窗口还剩
 *   多少」是发送前的最后一眼，放在发送钮一侧。
 *
 * 模型标识在有可用清单时升级为切换器（session/set_model）。
 *
 * TurnStatusRow 是对话流末尾的相位行（思考中 / 工具运行中 n / 生成中）：
 * 状态长在消息流里而不是输入框上——用户盯着的是对话，不是输入条。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useSessionStore } from "../../stores/sessionStore.ts";
import { useApprovalStore } from "../../stores/approvalStore.ts";
import { useRuntimeStatusStore } from "../../stores/runtimeStatusStore.ts";
import { MenuItemRow, StatusChipMenu } from "./StatusChipMenu.tsx";

/** 模型标识短格式：裸 hash 只留前 12 位（悬停见全量）。 */
function shortModelLabel(label: string): string {
  return /^[0-9a-f]{16,}$/i.test(label) ? label.slice(0, 12) : label;
}

/** 悬停明细的多行文本。 */
function hoverLines(lines: readonly string[]): string {
  return lines.filter((line) => line.length > 0).join("\n");
}

/** token 数的人读短格式（ZCode 浮框口径：177_000 → 17.7万，1_000_000 →
 *  100万，120_000_000 → 1.2亿；整数不带小数）。 */
function formatWanTokens(value: number): string {
  if (value >= 100_000_000) {
    const yi = value / 100_000_000;
    return `${Number.isInteger(yi) ? yi : yi.toFixed(1)}亿`;
  }
  if (value >= 10_000) {
    const wan = value / 10_000;
    return `${Number.isInteger(wan) ? wan : wan.toFixed(1)}万`;
  }
  return String(Math.round(value));
}

/** 百分比短格式（ZCode 口径：92.7% 一位小数，0% 整数）。 */
function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

/** 悬停浮框常量：宽 320（ZCode !w-80）、贴触发器上缘 2px、贴视口边距 8px。 */
const POPOVER_WIDTH_PX = 320;
const POPOVER_GAP_PX = 2;
const POPOVER_MARGIN_PX = 8;

/** 明细色阶（ZCode AJ 同式：主色对 surface 逐级 color-mix 淡出）。 */
const USAGE_CHART_COLORS = [
  "var(--color-info)",
  "color-mix(in oklab, var(--color-info) 78%, var(--color-surface))",
  "color-mix(in oklab, var(--color-info) 58%, var(--color-surface))",
  "color-mix(in oklab, var(--color-info) 42%, var(--color-surface))",
  "color-mix(in oklab, var(--color-info) 28%, var(--color-surface))",
  "color-mix(in oklab, var(--color-info) 16%, var(--color-surface))",
];

/** 圆环几何（ZCode 聊天工具栏 kJt 像素对齐）：14px 视口（viewBox 24）、
 *  半径 10、4px 描边（渲染后 ≈2.33px）、圆头进度弧 12 点起顺时针。 */
const RING_RADIUS = 10;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** 上下文用量圆环（ZCode 同款：无行内百分比，悬停弹「上下文容量」浮框；
 *  轨道 opacity 0.25 / 进度弧 0.7，颜色随文字 currentColor）。 */
export function ContextRing(): React.JSX.Element | null {
  const usage = useRuntimeStatusStore((state) => state.usage);
  const maxContextTokens = useRuntimeStatusStore(
    (state) => state.usage?.maxContextTokens ?? state.runtime.maxContextTokens,
  );
  const [open, setOpen] = useState(false);
  const [cardPos, setCardPos] = useState<{
    readonly left: number;
    readonly bottom: number;
  } | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  // 打开期间视口滚动/缩放会让 fixed 定位失准，直接收卡（HintTooltip 同策略）
  useEffect(() => {
    if (!open) {
      return;
    }
    const close = (): void => {
      setOpen(false);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);
  if (usage === null || maxContextTokens === null || maxContextTokens <= 0) {
    return null;
  }
  // 上下文口径与会话累计消耗严格分离。
  const used = usage.contextUsed;
  if (used === null) return null;
  const pct = Math.round((used / maxContextTokens) * 1000) / 10;
  const invalidUsage =
    !Number.isFinite(used) ||
    used < 0 ||
    !Number.isFinite(maxContextTokens) ||
    used > maxContextTokens;
  const clamped = invalidUsage ? 0 : Math.min(100, Math.max(0, pct));
  // 缓存命中率：会话口径优先（chrys 不推分类明细，浮框暂只这两块数据）
  const cacheRate =
    usage.cacheHitTokens !== null &&
    usage.inputTokens !== null &&
    usage.inputTokens > 0
      ? (usage.cacheHitTokens / usage.inputTokens) * 100
      : null;
  // 构成明细（消息/系统工具/MCP 工具/技能/系统提示词/其他）：chrys 的
  // _chrys/usage_update 尚不推送分类数据，接上后填充此数组即出明细区
  const breakdown: readonly {
    readonly label: string;
    readonly percent: number;
  }[] = [];
  const openCard = (): void => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (rect === undefined) {
      return;
    }
    // ZCode side=top sideOffset=2：贴触发器上方 2px；浮框右缘对齐触发器
    //（环贴着发送钮在行尾，居中会溢出视口），左缘夹进可视区
    const left = Math.max(
      POPOVER_MARGIN_PX,
      Math.min(
        rect.right - POPOVER_WIDTH_PX,
        window.innerWidth - POPOVER_WIDTH_PX - POPOVER_MARGIN_PX,
      ),
    );
    setCardPos({
      left,
      bottom: window.innerHeight - rect.top + POPOVER_GAP_PX,
    });
    setOpen(true);
  };
  return (
    <span
      ref={anchorRef}
      className="flex min-w-0 shrink-0 items-center text-ink-mute"
      data-status="context"
      onMouseEnter={openCard}
      onMouseLeave={() => {
        setOpen(false);
      }}
    >
      <svg viewBox="0 0 24 24" aria-hidden={true} className="size-3.5 shrink-0">
        {/* 轨道：currentColor @ 0.25（ZCode kJt 同款） */}
        <circle
          cx="12"
          cy="12"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="4"
          className="stroke-current opacity-25"
        />
        {/* 进度弧：currentColor @ 0.7，dashoffset = C×(1−占比) */}
        <circle
          cx="12"
          cy="12"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={`${RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - clamped / 100)}
          className="stroke-current opacity-70"
          style={{ transform: "rotate(-90deg)", transformOrigin: "center" }}
        />
      </svg>
      {open && cardPos !== null
        ? createPortal(
            <div
              role="dialog"
              aria-label="上下文容量"
              className="pointer-events-none fixed z-[60] w-80 overflow-hidden rounded-xl border border-line bg-surface shadow-md"
              style={{ left: cardPos.left, bottom: cardPos.bottom }}
            >
              <div className="w-full space-y-3 p-3">
                {/* 头部：标题 + 已用/总量（占比） */}
                <div className="space-y-2">
                  <div className="mb-3 flex min-w-0 items-center gap-3">
                    <span className="shrink-0 text-ui-base font-medium text-ink">
                      上下文容量
                    </span>
                    <span className="ml-auto shrink-0 text-right font-mono text-ui-sm text-ink-mute">
                      {formatWanTokens(used)}/
                      {formatWanTokens(maxContextTokens)}（
                      {invalidUsage ? "上报异常" : formatPercent(pct)}）
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-raised">
                    <div
                      className="h-full min-w-2 rounded-full bg-info"
                      style={{ width: `${clamped}%` }}
                    />
                  </div>
                </div>
                <p className="text-xs text-ink-mute">
                  {`来源：${usage.sourceLabel ?? "Agent 用量上报"}`}
                  {usage.totalSessionTokens !== null
                    ? ` · 会话累计 ${formatWanTokens(usage.totalSessionTokens)}`
                    : ""}
                </p>
                {/* 构成明细：色块 + 名称 + 占比（ZCode 同款行式） */}
                {breakdown.length > 0 ? (
                  <div className="grid gap-1.5" aria-label="上下文构成">
                    {breakdown.map((item, index) => (
                      <div
                        key={item.label}
                        className="flex min-w-0 items-center gap-2 text-ui-sm"
                      >
                        <span
                          aria-hidden={true}
                          className="size-2 shrink-0 rounded-sm border border-line"
                          style={{
                            backgroundColor:
                              USAGE_CHART_COLORS[
                                Math.min(index, USAGE_CHART_COLORS.length - 1)
                              ],
                          }}
                        />
                        <span className="min-w-0 truncate text-ink-mute">
                          {item.label}
                        </span>
                        <span className="ml-auto min-w-10 shrink-0 text-right font-mono text-ui-sm tabular-nums text-ink">
                          {formatPercent(item.percent)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {cacheRate !== null ? (
                  <div
                    className={`flex items-center justify-between gap-3 text-ui-sm ${
                      breakdown.length > 0 ? "border-t border-line pt-3" : ""
                    }`}
                  >
                    <span className="text-ink-mute">本次缓存命中率</span>
                    <span className="font-mono text-ui-sm text-ink">
                      {formatPercent(cacheRate)}
                    </span>
                  </div>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
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

/** 右簇：上下文圆环 + 模型（ZCode 工具栏同序：环在模型名前）。单一
 *  items-center 容器——外层工具栏行是 items-end，拆散成兄弟会被贴底
 *  对齐，环和模型文字就错位了。 */
export function InputStatusRight(): React.JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ContextRing />
      <ModelTag />
    </span>
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
