/**
 * 内存折线图：SVG 手绘（无图表库依赖），纵轴按样本区间自动缩放。
 *
 * 呈现约定（评审定稿）：
 * - 曲线 + 区间峰值圆点；下方一行「当前 X · 最近 N 分钟峰值 Y」；
 * - 纵轴上下界以小字标注在两端（自动缩放，不给固定阈值色带——
 *   内存的正常增长本来就是动态的，看趋势而不是看单点）；
 * - 样本不足两点时显示采样中占位。
 */
import type { MemorySample } from "../../../../contracts/diagnostics.ts";

function mbOf(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const WIDTH = 640;
const HEIGHT = 120;
const PAD = 8;

export function MemoryChart({
  samples = [],
}: { readonly samples?: readonly MemorySample[] } = {}) {
  if (samples.length < 2) {
    return (
      <p className="text-sm text-ink-faint">采样中…（刚启动，稍候即有曲线）</p>
    );
  }

  const bytes = samples.map((sample) => sample.bytes);
  const min = Math.min(...bytes);
  const max = Math.max(...bytes);
  const span = Math.max(max - min, max * 0.02, 1);
  const innerHeight = HEIGHT - PAD * 2;
  const xOf = (index: number): number =>
    PAD + (index / (samples.length - 1)) * (WIDTH - PAD * 2);
  const yOf = (value: number): number =>
    PAD + (1 - (value - min) / span) * innerHeight;
  const points = samples
    .map(
      (sample, index) =>
        `${xOf(index).toFixed(1)},${yOf(sample.bytes).toFixed(1)}`,
    )
    .join(" ");
  const peakIndex = bytes.indexOf(max);
  const current = samples[samples.length - 1]?.bytes ?? 0;
  const windowMinutes = Math.max(
    1,
    Math.round(
      ((samples[samples.length - 1]?.at ?? 0) - (samples[0]?.at ?? 0)) / 60000,
    ),
  );

  return (
    <figure aria-label="内存占用折线图" className="space-y-1">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        className="w-full rounded-lg border border-line bg-surface"
        preserveAspectRatio="none"
      >
        {/* 基线（区间下界）与上界的弱参考线 */}
        <line
          x1={PAD}
          y1={yOf(max)}
          x2={WIDTH - PAD}
          y2={yOf(max)}
          className="stroke-line"
          strokeWidth="1"
        />
        <line
          x1={PAD}
          y1={yOf(min)}
          x2={WIDTH - PAD}
          y2={yOf(min)}
          className="stroke-line"
          strokeWidth="1"
        />
        <polyline
          points={points}
          fill="none"
          className="stroke-info-line"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <circle
          cx={xOf(peakIndex)}
          cy={yOf(max)}
          r="3.5"
          className="fill-warn-ink"
        />
      </svg>
      <figcaption className="flex items-baseline justify-between text-xs text-ink-ghost">
        <span className="font-mono">
          当前 {mbOf(current)} · 最近 {windowMinutes} 分钟峰值 {mbOf(max)}
        </span>
        <span className="font-mono">
          {mbOf(min)} ~ {mbOf(max)}
        </span>
      </figcaption>
    </figure>
  );
}
