export const sendMorphDuration = 640;

type MorphRect = Pick<DOMRectReadOnly, "left" | "top" | "width" | "height">;

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const mix = (from: number, to: number, amount: number) =>
  from + (to - from) * amount;

function ease(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  progress: number,
) {
  const x = clamp(progress);
  if (x === 0 || x === 1) return x;
  const cubic = (a: number, b: number, t: number) =>
    3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
  let t = x;
  for (let step = 0; step < 6; step += 1) {
    const error = cubic(x1, x2, t) - x;
    const slope =
      3 * (1 - t) ** 2 * x1 +
      6 * (1 - t) * t * (x2 - x1) +
      3 * t ** 2 * (1 - x2);
    if (Math.abs(error) < 1e-5 || Math.abs(slope) < 1e-6) break;
    t = clamp(t - error / slope);
  }
  return cubic(y1, y2, t);
}

/** 向上飞到消息行，再固定右边缘向左弹开。 */
export function sendMorphFrame(
  t: number,
  from: MorphRect,
  to: MorphRect,
  targetRadius: number,
) {
  const up = clamp(t / 0.44);
  const centerY = mix(
    from.top + from.height / 2,
    to.top + to.height / 2,
    ease(0.32, 0.06, 0.22, 1, up),
  );
  const right = mix(
    from.left + from.width,
    to.left + to.width,
    ease(0.35, 0, 0.25, 1, up),
  );
  const lift = Math.sin(up * Math.PI);
  const unfold = clamp((t - 0.4) / 0.6);
  const bounce =
    Math.sin(unfold * Math.PI * 1.45) * (1 - unfold) ** 1.55 * 0.2 * 0.65;
  const dropletWidth = Math.max(28, from.width - 4 * lift);
  const width = Math.max(
    28,
    mix(dropletWidth, to.width, ease(0.18, 1, 0.3, 1, unfold) + bounce),
  );
  const height = Math.max(
    28,
    mix(
      from.height + 14 * lift,
      to.height,
      ease(0.24, 0.9, 0.32, 1, (t - 0.36) / 0.54),
    ),
  );
  const text = ease(0.22, 1, 0.36, 1, (t - 0.56) / 0.36);
  const elevation = Math.sin(t * Math.PI);
  return {
    left: right - width,
    top: centerY - height / 2,
    width,
    height,
    radius: mix(
      Math.min(dropletWidth, from.height) / 2,
      targetRadius,
      ease(0.35, 0, 0.2, 1, (t - 0.42) / 0.52),
    ),
    rotation: -2.2 * Math.sin(unfold * Math.PI) * (1 - unfold) ** 0.9 * 0.65,
    icon: 1 - clamp(t / 0.12),
    text,
    elevation,
  };
}

const colorMix = (from: string, to: string, t: number) =>
  `color-mix(in srgb, ${from}, ${to} ${clamp(t) * 100}%)`;

export function sendMorphFill(t: number) {
  const start = "var(--color-conversation-send)";
  const end = "var(--color-conversation-user)";
  const peak = "var(--color-conversation-send-peak)";
  const glow = "var(--color-conversation-send-glow)";
  if (t === 0) return start;
  if (t === 1) return end;
  const peakAt = 0.44;
  const tailPeak = colorMix(start, glow, 0.72);
  if (t <= peakAt) {
    const blend = ease(0.35, 0, 0.25, 1, t / peakAt);
    return `linear-gradient(270deg, ${colorMix(start, glow, blend * 0.72)}, ${colorMix(start, peak, blend)} 48%, ${colorMix(start, peak, blend * 1.2)})`;
  }
  const blend = ease(0.25, 0.1, 0.25, 1, (t - peakAt) / (1 - peakAt));
  return `linear-gradient(270deg, ${colorMix(tailPeak, end, blend ** 0.85)}, ${colorMix(peak, end, blend)} 48%, ${colorMix(peak, end, blend * 1.12)})`;
}
