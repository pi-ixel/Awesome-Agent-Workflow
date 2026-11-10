/**
 * AAW 流程时间线（紧凑条 + 泳道画布两态）：
 *
 * - **常驻紧凑条**（默认态）：`SR-001 ▪▪▪▫▫ 3/11 · 当前 · 边界设计`——
 *   一行读完「走到哪了」（分段进度 = 每站一格的等比地铁图）；
 * - **展开泳道画布**：点「流程」滑出的浮层（不推挤内容）。**泳道结构**
 *   ——SR 主线一行，每条 AR 一行（`ar-clarify` 为 AR 边界切分，见
 *   laneModel），任务簇药丸挂在父 AR 行尾（簇内小灯 = 各任务实例）；
 *   git 分支曲线画出「一分为二」；列 = plan 拓扑节点（中文短名），
 *   所有泳道同列对齐；门禁站 = 菱形；
 * - **视窗**：画布可拖拽平移、滚轮缩放（50%–140%）、右下角拖高
 *   （220–560px）；泳道标签层固定（不随平移，同 viewBox 独立 SVG 层）；
 * - Esc / 点外部收起；偏好持久化（默认收起）；
 * - 灯色沿 ZCode 词汇表：done 绿 / running 琥珀脉动+光晕 / failed 红 /
 *   pending 空环；走过的轨段绿色低饱和。
 * 全部纯 SVG 无图库；动效只动 opacity/transform。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import type { WorkflowService } from "../../service.ts";
import type { createTimelineDrawer } from "./drawer.ts";

import { ChevronDownIcon, ChevronUpIcon } from "../../../../shared/ui/icons.tsx";
import { buildAawTimeline, type TimelineLamp } from "./aawTimelineModel.ts";
import { stationDisplayName } from "./stationNames.ts";
import {
  buildLaneBoard,
  type LaneBoardModel,
  type LaneCell,
  type WorkflowLane,
} from "./laneModel.ts";

/** 泳道画布几何常量（一切坐标由此推导）。 */
const LABEL_W = 116;
const COL_W = 138;
const LANE_H = 58;
const HEAD_H = 32;
const PAD_B = 14;
const LAMP_R = 6.5;

/** 灯色（SVG fill/stroke 直用 token，双主题自适应）。 */
function lampFill(state: TimelineLamp): string {
  switch (state) {
    case "done":
      return "var(--color-ok)";
    case "running":
      return "var(--color-warn)";
    case "failed":
      return "var(--color-danger)";
    case "superseded":
      return "var(--color-ink-ghost)";
    default:
      return "var(--color-surface)";
  }
}

interface BoardProps {
  readonly currentSr: string;
  /** 泳道模型（父组件已按 status+plan 派生，同一份驱动尺寸与绘制）。 */
  readonly board: LaneBoardModel | null;
  readonly viewportRef: React.RefObject<HTMLDivElement | null>;
}

/** 泳道画布本体：SVG 双层（内容层可平移缩放，标签层固定）。 */
function LaneBoard({ board, viewportRef, currentSr }: BoardProps) {
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{
    sx: number;
    sy: number;
    bx: number;
    by: number;
  } | null>(null);

  const W = LABEL_W + (board?.columns.length ?? 0) * COL_W + 30;
  const H = HEAD_H + (board?.lanes.length ?? 0) * LANE_H + PAD_B;

  // 拖拽平移 / 滚轮缩放（挂 viewport 层，画布内任意位置可抓）
  useEffect(() => {
    const vp = viewportRef.current;
    if (vp === null) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) {
        return;
      }
      dragRef.current = {
        sx: event.clientX,
        sy: event.clientY,
        bx: pan.x,
        by: pan.y,
      };
      vp.classList.add("cursor-grabbing");
      vp.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent): void => {
      const drag = dragRef.current;
      if (drag === null) {
        return;
      }
      setPan({
        x: drag.bx + (event.clientX - drag.sx),
        y: drag.by + (event.clientY - drag.sy),
      });
    };
    const onPointerUp = (): void => {
      dragRef.current = null;
      vp.classList.remove("cursor-grabbing");
    };
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      setScale((current) =>
        Math.min(1.4, Math.max(0.5, current * (event.deltaY < 0 ? 1.1 : 0.9))),
      );
    };
    vp.addEventListener("pointerdown", onPointerDown);
    vp.addEventListener("pointermove", onPointerMove);
    vp.addEventListener("pointerup", onPointerUp);
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      vp.removeEventListener("pointerdown", onPointerDown);
      vp.removeEventListener("pointermove", onPointerMove);
      vp.removeEventListener("pointerup", onPointerUp);
      vp.removeEventListener("wheel", onWheel);
    };
  }, [pan.x, pan.y, viewportRef]);

  if (board === null || currentSr === null) {
    return null;
  }

  const colX = (c: number): number => LABEL_W + c * COL_W + COL_W / 2;
  const laneY = (l: number): number => HEAD_H + l * LANE_H + LANE_H / 2;

  // 需要列头 pill 的列：任一泳道在此列有 running/簇
  const activeCols = new Set<number>();
  for (const lane of board.lanes) {
    for (const cell of lane.cells) {
      if (cell.lamp === "running" || cell.cluster !== undefined) {
        activeCols.add(cell.col);
      }
    }
  }

  const ARC_R = 24;
  const fork = board.fork;

  return (
    <div className="relative h-full overflow-hidden">
      <div
        aria-hidden={true}
        className="pointer-events-none absolute inset-y-0 left-0 z-10 w-28 bg-[linear-gradient(90deg,var(--color-surface)_96%,transparent)]"
      />
      {/* 固定 1:1 尺寸（宽了留白居中，窄了拖拽平移）——站灯/字号不随视口缩放 */}
      <div className="relative mx-auto" style={{ width: W, height: H }}>
        <svg
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`泳道流程图：${board.lanes.length} 条泳道`}
        >
          {/* 内容层（参与平移缩放） */}
          <g transform={`translate(${pan.x} ${pan.y}) scale(${scale})`}>
            {/* 当前列头 pill（只点列头——整列高亮会在行间隙漏光且语义站不住） */}
            {[...activeCols].map((c) => {
              const pillX = colX(c) - COL_W / 2 + 4;
              const pillW = Math.min(COL_W - 8, W - 14 - pillX);
              return (
                <rect
                  key={`pill-${c}`}
                  x={pillX}
                  y={HEAD_H - 30}
                  width={pillW}
                  height={24}
                  rx={8}
                  fill="color-mix(in srgb, var(--color-warn) 7%, transparent)"
                />
              );
            })}
            {/* 泳道行卡（交替植面） */}
            {board.lanes.map((_, l) => (
              <rect
                key={`card-${l}`}
                x={10}
                y={laneY(l) - LANE_H / 2 + 5}
                width={W - 20}
                height={LANE_H - 10}
                rx={12}
                fill={
                  l % 2 === 0
                    ? "color-mix(in srgb, var(--color-raised) 40%, var(--color-surface))"
                    : "var(--color-surface)"
                }
                stroke="var(--color-line)"
                strokeWidth={1}
              />
            ))}
            {/* 列头（门禁列 = 文本 + 菱形小标组合居中） */}
            {board.columns.map((col, c) => {
              const isActive = activeCols.has(c);
              const textX = col.isGate ? colX(c) - 6 : colX(c);
              return (
                <g key={col.id}>
                  <text
                    x={textX}
                    y={HEAD_H - 12}
                    textAnchor="middle"
                    fontSize={11}
                    fontWeight={isActive ? 600 : 400}
                    fill={
                      isActive
                        ? "var(--color-ink-soft)"
                        : "var(--color-ink-faint)"
                    }
                  >
                    {col.label}
                  </text>
                  {col.isGate ? (
                    <rect
                      x={textX + (col.label.length * 11) / 2 + 8 - 3.5}
                      y={HEAD_H - 16 - 3.5}
                      width={7}
                      height={7}
                      rx={1}
                      transform={`rotate(45 ${textX + (col.label.length * 11) / 2 + 8} ${HEAD_H - 16})`}
                      fill="none"
                      stroke="var(--color-ink-faint)"
                      strokeWidth={1.2}
                    />
                  ) : null}
                </g>
              );
            })}
            {/* 分叉曲线（git 同款：水平出叉 → 圆弧下转 → 垂直 → 圆弧右转汇入） */}
            {fork !== null
              ? fork.toCols.map((toCol, i) => {
                  const fx = colX(fork.fromCol) + LAMP_R + 3;
                  const fy = laneY(0);
                  const tx2 = colX(toCol) - LAMP_R - 6;
                  const ty2 = laneY(i + 1);
                  const xDesc = fx + 26 + ARC_R;
                  return (
                    <path
                      key={`fork-${i}`}
                      d={[
                        `M ${fx} ${fy}`,
                        `L ${xDesc - ARC_R} ${fy}`,
                        `A ${ARC_R} ${ARC_R} 0 0 1 ${xDesc} ${fy + ARC_R}`,
                        `L ${xDesc} ${ty2 - ARC_R}`,
                        `A ${ARC_R} ${ARC_R} 0 0 0 ${xDesc + ARC_R} ${ty2}`,
                        `L ${tx2} ${ty2}`,
                      ].join(" ")}
                      fill="none"
                      stroke="color-mix(in srgb, var(--color-ok) 45%, var(--color-ink-mute))"
                      strokeWidth={1.6}
                      strokeLinecap="round"
                    />
                  );
                })
              : null}
            {fork !== null ? (
              <g>
                <rect
                  x={colX(fork.fromCol) + LAMP_R + 9}
                  y={laneY(0) - 24}
                  width={88}
                  height={17}
                  rx={8.5}
                  fill="var(--color-raised)"
                  stroke="var(--color-line-strong)"
                />
                <text
                  x={colX(fork.fromCol) + LAMP_R + 9 + 44}
                  y={laneY(0) - 12.5}
                  textAnchor="middle"
                  fontSize={9.5}
                  fill="var(--color-ink-mute)"
                >
                  拆出 {fork.toCols.length} 条 AR
                </text>
              </g>
            ) : null}
            {/* 幽灵延展：未拆分时拆分列之后的虚线段 + 提示（右侧列不再显得无主） */}
            {fork === null && board.ghost !== null ? (
              <g>
                <line
                  x1={colX(board.ghost.fromCol) + LAMP_R + 8}
                  y1={laneY(0)}
                  x2={colX(board.ghost.toCol) - LAMP_R - 8}
                  y2={laneY(0)}
                  stroke="var(--color-ink-ghost)"
                  strokeWidth={1.5}
                  strokeDasharray="3 6"
                  strokeLinecap="round"
                />
                <text
                  x={(colX(board.ghost.fromCol) + colX(board.ghost.toCol)) / 2}
                  y={laneY(0) - 12}
                  textAnchor="middle"
                  fontSize={9.5}
                  fill="var(--color-ink-ghost)"
                >
                  拆分后在此展开 AR 泳道
                </text>
              </g>
            ) : null}
            {/* 泳道：轨 + 灯/簇 */}
            {board.lanes.map((lane, l) => (
              <LaneRow key={lane.id} lane={lane} y={laneY(l)} colX={colX} />
            ))}
          </g>
          {/* 标签层（同 viewBox，不参与平移缩放——拖画布时标签固定） */}
        </svg>
        {/* 标签层：同 viewBox、1:1、不参与平移缩放、盖过渐隐遮罩 */}
        <svg
          className="pointer-events-none absolute inset-0 z-20"
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          aria-hidden={true}
        >
          {board.lanes.map((lane, l) => {
            const y = laneY(l);
            const isRunning = lane.dot === "running";
            const isFailed = lane.dot === "failed";
            const dotFill = isRunning
              ? "var(--color-warn)"
              : isFailed
                ? "var(--color-danger)"
                : "var(--color-ok)";
            const frac = lane.total > 0 ? lane.done / lane.total : 0;
            const bw = 54;
            const bx = 30;
            return (
              <g key={`label-${lane.id}`}>
                <circle
                  cx={18}
                  cy={y - 4}
                  r={3.5}
                  fill={dotFill}
                  className={isRunning ? "animate-pulse" : ""}
                />
                <text
                  x={30}
                  y={y - 3}
                  fontSize={13}
                  fontWeight={600}
                  fill="var(--color-ink-soft)"
                  dominantBaseline="middle"
                >
                  {lane.name}
                </text>
                <rect
                  x={bx}
                  y={y + 8}
                  width={bw}
                  height={3}
                  rx={1.5}
                  fill="var(--color-line-strong)"
                />
                <rect
                  x={bx}
                  y={y + 8}
                  width={Math.max(2, bw * frac)}
                  height={3}
                  rx={1.5}
                  fill={
                    frac >= 1 ? "var(--color-ok)" : "var(--color-ink-ghost)"
                  }
                />
                <text
                  x={bx + bw + 6}
                  y={y + 11}
                  fontSize={9}
                  fill="var(--color-ink-faint)"
                  fontFamily="ui-monospace, Consolas, monospace"
                >
                  {lane.done}/{lane.total}
                </text>
              </g>
            );
          })}
          <line
            x1={LABEL_W}
            y1={HEAD_H}
            x2={LABEL_W}
            y2={H - PAD_B}
            stroke="var(--color-line)"
            strokeWidth={1}
          />
        </svg>
      </div>
    </div>
  );
}

/** 泳道行：轨（首末物化列之间）+ 各列灯/簇。 */
function LaneRow({
  lane,
  y,
  colX,
}: {
  readonly lane: WorkflowLane;
  readonly y: number;
  readonly colX: (c: number) => number;
}) {
  const rails: React.JSX.Element[] = [];
  for (let i = 0; i < lane.cells.length - 1; i++) {
    const a = lane.cells[i] as LaneCell;
    const b = lane.cells[i + 1] as LaneCell;
    const traveled = a.lamp !== "pending" && b.lamp !== "pending";
    rails.push(
      <line
        key={`rail-${a.col}`}
        x1={colX(a.col) + lampOutset(a)}
        y1={y}
        x2={colX(b.col) - lampOutset(b)}
        y2={y}
        stroke={
          traveled
            ? "color-mix(in srgb, var(--color-ok) 40%, var(--color-line-strong))"
            : "var(--color-line-strong)"
        }
        strokeWidth={2}
        strokeLinecap="round"
      />,
    );
  }
  return (
    <g>
      {rails}
      {lane.cells.map((cell) => (
        <LaneCellView key={cell.col} cell={cell} x={colX(cell.col)} y={y} />
      ))}
    </g>
  );
}

function lampOutset(cell: LaneCell): number {
  return cell.cluster !== undefined ? 46 : LAMP_R + 3;
}

/** 单元格：普通灯（圆/菱形）或任务簇药丸。 */
function LaneCellView({
  cell,
  x,
  y,
}: {
  readonly cell: LaneCell;
  readonly x: number;
  readonly y: number;
}) {
  if (cell.cluster !== undefined) {
    const pw = 30 + cell.cluster.length * 25;
    const ph = 24;
    return (
      <g>
        <rect
          x={x - pw / 2}
          y={y - ph / 2}
          width={pw}
          height={ph}
          rx={ph / 2}
          fill="var(--color-raised)"
          stroke="var(--color-line-strong)"
        />
        {cell.cluster.map((s, i) => (
          <circle
            key={i}
            cx={x - pw / 2 + 17 + i * 25}
            cy={y}
            r={4}
            fill={lampFill(s)}
            className={s === "running" ? "animate-pulse" : ""}
          />
        ))}
        <text
          x={x}
          y={y + ph / 2 + 10}
          textAnchor="middle"
          fontSize={9}
          fill="var(--color-ink-ghost)"
        >
          {cell.cluster
            .map((s, i) => (s === "running" ? `T${i + 1} ●` : `T${i + 1} ✓`))
            .join(" · ")}
        </text>
      </g>
    );
  }
  return (
    <LampGlyph
      x={x}
      y={y}
      state={cell.lamp}
      count={cell.count}
      isGate={cell.isGate}
    />
  );
}

/** 灯形状：门禁菱形 / 普通圆；running 加光晕双环；多实例 ×N。 */
function LampGlyph({
  x,
  y,
  state,
  count,
  isGate,
}: {
  readonly x: number;
  readonly y: number;
  readonly state: TimelineLamp;
  readonly count: number;
  readonly isGate: boolean;
}) {
  if (state === "pending") {
    return (
      <circle
        cx={x}
        cy={y}
        r={LAMP_R}
        fill="var(--color-surface)"
        stroke="var(--color-line-strong)"
        strokeWidth={1.5}
      />
    );
  }
  if (isGate) {
    const s = LAMP_R + 2.5;
    return (
      <g>
        {state === "running" ? (
          <rect
            x={x - s - 3}
            y={y - s - 3}
            width={(s + 3) * 2}
            height={(s + 3) * 2}
            rx={4}
            transform={`rotate(45 ${x} ${y})`}
            fill="color-mix(in srgb, var(--color-warn) 14%, transparent)"
          />
        ) : null}
        <rect
          x={x - s}
          y={y - s}
          width={s * 2}
          height={s * 2}
          rx={3}
          transform={`rotate(45 ${x} ${y})`}
          fill={lampFill(state)}
        />
        {count > 1 ? (
          <text
            x={x}
            y={y + s + 10}
            textAnchor="middle"
            fontSize={9}
            fill="var(--color-ink-mute)"
          >
            ×{count}
          </text>
        ) : null}
      </g>
    );
  }
  return (
    <g>
      {state === "running" ? (
        <>
          <circle
            cx={x}
            cy={y}
            r={LAMP_R + 5}
            fill="color-mix(in srgb, var(--color-warn) 16%, transparent)"
          />
          <circle
            cx={x}
            cy={y}
            r={LAMP_R + 4}
            fill="none"
            stroke="var(--color-warn)"
            strokeOpacity={0.55}
            strokeWidth={2}
            className="animate-pulse"
          />
          <circle
            cx={x}
            cy={y}
            r={LAMP_R + 1}
            fill="none"
            stroke="var(--color-warn)"
            strokeOpacity={0.9}
            strokeWidth={1.2}
          />
        </>
      ) : state === "done" ? (
        <circle
          cx={x}
          cy={y}
          r={LAMP_R + 3}
          fill="color-mix(in srgb, var(--color-ok) 16%, transparent)"
        />
      ) : null}
      <circle
        cx={x}
        cy={y}
        r={LAMP_R}
        fill={lampFill(state)}
        className={state === "running" ? "animate-pulse" : ""}
      />
      {count > 1 ? (
        <text
          x={x}
          y={y + LAMP_R + 12}
          textAnchor="middle"
          fontSize={9}
          fill="var(--color-ink-mute)"
        >
          ×{count}
        </text>
      ) : null}
    </g>
  );
}

export function AawTimeline({ statusSource, drawer }: {
  readonly statusSource: WorkflowService["status"];
  readonly drawer: Pick<ReturnType<typeof createTimelineDrawer>, "state" | "toggle" | "close">;
}): React.JSX.Element | null {
  const currentSr = useStore(statusSource, (state) => state.currentSr);
  const status = useStore(statusSource, (state) => state.status);
  const plan = useStore(statusSource, (state) => state.plan);
  const isDrawerOpen = useStore(drawer.state);

  const timeline = status === null ? null : buildAawTimeline(status, plan);
  // 同一份泳道模型既画布也定尺寸；画布 1:1，抽屉高度 = 内容高 + 余量
  //（多泳道超出 560 时靠平移/滚轮看，或右下角拖高）
  const board = useMemo(
    () => (status === null ? null : buildLaneBoard(status, plan)),
    [status, plan],
  );
  const drawerH = Math.min(
    560,
    HEAD_H + (board?.lanes.length ?? 1) * LANE_H + PAD_B + 8,
  );
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 抽屉开着时：Esc 或点外部收起
  useEffect(() => {
    if (!isDrawerOpen) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape" && drawer.state.getState()) {
        // preventDefault 标记 Esc 已被抽屉消费（SessionView 的全局停止让位）
        event.preventDefault();
        drawer.close();
      }
    }
    function handlePointerDown(event: PointerEvent): void {
      const root = rootRef.current;
      if (root !== null && !root.contains(event.target as Node)) {
        drawer.close();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [isDrawerOpen, drawer]);

  if (
    currentSr === null ||
    timeline === null ||
    timeline.stations.length === 0
  ) {
    return null;
  }
  const progressText = `${timeline.doneCount}/${timeline.totalCount}`;
  const focus =
    timeline.focusIndex === null
      ? null
      : (timeline.stations[timeline.focusIndex] ?? null);

  return (
    <div ref={rootRef} className="relative z-20 shrink-0" data-aaw-timeline="">
      {/* 紧凑条：抽屉打开时让位成「SR + 收起」薄壳（进度全在抽屉里） */}
      <div className="flex items-center gap-3 border-b border-line bg-surface/70 px-4 py-1.5">
        <span className="shrink-0 font-mono text-2xs text-ink-faint">
          {currentSr}
        </span>
        {isDrawerOpen ? null : (
          <>
            <ProgressSegments stations={timeline.stations} />
            <span className="shrink-0 text-2xs text-ink-ghost">
              {progressText}
            </span>
            {focus !== null ? (
              <span className="min-w-0 truncate text-xs text-ink-mute">
                当前 ·{" "}
                <span className="text-ink-soft">
                  {stationDisplayName(focus.type)}
                </span>
              </span>
            ) : (
              <span className="min-w-0 truncate text-xs text-ink-faint">
                已走完
              </span>
            )}
          </>
        )}
        <span aria-hidden={true} className="flex-1" />
        <button
          type="button"
          onClick={drawer.toggle}
          aria-expanded={isDrawerOpen}
          aria-label={isDrawerOpen ? "收起流程全览" : "展开流程全览"}
          title={isDrawerOpen ? "收起流程全览（Esc）" : "展开流程全览"}
          className="flex shrink-0 items-center gap-1 rounded-md border border-line-strong px-2 py-1 text-2xs text-ink-mute transition-colors hover:bg-raised hover:text-ink"
        >
          {isDrawerOpen ? (
            <ChevronUpIcon className="h-3 w-3" />
          ) : (
            <ChevronDownIcon className="h-3 w-3" />
          )}
          流程
        </button>
      </div>

      {/* 泳道画布抽屉（高度 = 内容高；右下角可拖高） */}
      {isDrawerOpen ? (
        <div
          ref={viewportRef}
          className="aaw-panel-in absolute inset-x-0 top-full z-30 cursor-grab border-b border-line bg-surface shadow-elev-2"
          style={{
            height: drawerH,
            maxHeight: 560,
            resize: "vertical",
            overflow: "hidden",
          }}
        >
          <LaneBoard board={board} viewportRef={viewportRef} currentSr={currentSr} />
        </div>
      ) : null}
    </div>
  );
}

/** 紧凑条的分段进度：每站一格（等比缩小的地铁图）。 */
function ProgressSegments({
  stations,
}: {
  readonly stations: readonly {
    readonly lamp: TimelineLamp;
    readonly type: string;
  }[];
}) {
  return (
    <span className="flex shrink-0 items-center gap-0.5" aria-hidden={true}>
      {stations.map((station) => (
        <span
          key={station.type}
          title={station.type}
          className={`h-1.5 w-2.5 rounded-[2px] ${
            station.lamp === "done"
              ? "bg-ok"
              : station.lamp === "running"
                ? "animate-pulse bg-warn"
                : station.lamp === "failed"
                  ? "bg-danger"
                  : station.lamp === "superseded"
                    ? "bg-ink-ghost/50"
                    : "bg-line-strong/70"
          }`}
        />
      ))}
    </span>
  );
}
