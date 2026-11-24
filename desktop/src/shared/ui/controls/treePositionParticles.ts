const durationMs = 740;
const particleLimit = 1800;
const rasterPixelLimit = 220_000;
const canvasPixelLimit = 1_200_000;

function smooth(start: number, end: number, value: number) {
  const progress = Math.max(0, Math.min(1, (value - start) / (end - start)));
  return progress * progress * (3 - 2 * progress);
}

function paintTree(
  context: CanvasRenderingContext2D,
  tree: HTMLElement,
  bounds: DOMRect,
) {
  const viewport = tree
    .querySelector("[role='tree']")
    ?.parentElement?.getBoundingClientRect();
  context.textBaseline = "middle";

  for (const element of tree.querySelectorAll<HTMLElement>(
    "input, h3, [role='treeitem']",
  )) {
    const isRow = element.getAttribute("role") === "treeitem";
    const box = element.getBoundingClientRect();
    const top = Math.max(
      bounds.top,
      isRow ? (viewport?.top ?? bounds.top) : bounds.top,
    );
    const bottom = Math.min(
      bounds.bottom,
      isRow ? (viewport?.bottom ?? bounds.bottom) : bounds.bottom,
    );
    if (box.bottom <= top || box.top >= bottom || !box.width || !box.height)
      continue;

    const label =
      element.querySelector<HTMLElement>("[data-file-entry-name]") ?? element;
    const labelBox = label.getBoundingClientRect();
    const style = getComputedStyle(label);
    const text =
      element instanceof HTMLInputElement
        ? element.value || element.placeholder
        : (label.textContent ?? "");
    const x = labelBox.left - bounds.left;
    const y = labelBox.top - bounds.top;

    context.save();
    context.beginPath();
    context.rect(0, top - bounds.top, bounds.width, bottom - top);
    context.clip();
    if (
      element.getAttribute("aria-selected") === "true" ||
      element instanceof HTMLInputElement
    ) {
      const elementStyle = getComputedStyle(element);
      context.fillStyle = elementStyle.backgroundColor;
      context.strokeStyle = elementStyle.borderTopColor;
      context.beginPath();
      context.roundRect(
        box.left - bounds.left,
        box.top - bounds.top,
        box.width,
        box.height,
        5,
      );
      context.fill();
      context.stroke();
    }
    const icon = isRow ? element.querySelector("svg") : null;
    if (icon) {
      const iconBox = icon.getBoundingClientRect();
      context.strokeStyle = getComputedStyle(icon).color;
      context.strokeRect(
        iconBox.left - bounds.left + 2,
        iconBox.top - bounds.top + 2,
        Math.max(0, iconBox.width - 4),
        Math.max(0, iconBox.height - 4),
      );
    }
    context.beginPath();
    context.rect(x, y, labelBox.width, labelBox.height);
    context.clip();
    context.fillStyle = style.color;
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    context.fillText(
      text,
      x + (Number.parseFloat(style.paddingLeft) || 0),
      y + labelBox.height / 2,
    );
    context.restore();
  }
}

function buildParticles(tree: HTMLElement, bounds: DOMRect) {
  const raster = document.createElement("canvas");
  const scale = Math.min(
    1,
    Math.sqrt(rasterPixelLimit / (bounds.width * bounds.height)),
  );
  raster.width = Math.ceil(bounds.width * scale);
  raster.height = Math.ceil(bounds.height * scale);
  const context = raster.getContext("2d", { willReadFrequently: true });
  if (!context) return [];

  // 只采样当前可见区域。实际树仍由原组件维护，动画无需复制树、加载目录或取消虚拟化。
  context.scale(scale, scale);
  paintTree(context, tree, bounds);
  const { width, height } = raster;
  const pixels = context.getImageData(0, 0, width, height).data;
  const spacing = Math.max(
    5,
    Math.ceil(Math.sqrt((bounds.width * bounds.height) / particleLimit)),
  );
  const particles = [];
  for (let y = spacing / 2; y < bounds.height; y += spacing) {
    for (let x = spacing / 2; x < bounds.width; x += spacing) {
      const offset =
        (Math.floor(y * scale) * width + Math.floor(x * scale)) * 4;
      const ink = (pixels[offset + 3] ?? 0) > 72;
      const chance = Math.random();
      if (!ink && chance < 0.17) continue;
      particles.push({
        x,
        y,
        ink,
        delay: Math.random() * 0.17,
        opacity: ink ? 0.8 : 0.27 + chance * 0.29,
        size: 1.2 + Math.random() * 2.25,
        drift: (Math.random() - 0.5) * 110,
        rise: (Math.random() - 0.5) * 82,
      });
    }
  }
  raster.width = raster.height = 1;
  // 同色粒子一起画，减少每一帧的 Canvas 状态切换。
  return particles.sort((left, right) => Number(left.ink) - Number(right.ink));
}

export function playTreeParticles(
  row: HTMLDivElement,
  tree: HTMLDivElement,
  preview: HTMLDivElement,
  canvas: HTMLCanvasElement,
  position: "left" | "right",
) {
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const forcedColors = window.matchMedia?.("(forced-colors: active)");
  if (!reduced || reduced.matches || forcedColors?.matches || document.hidden)
    return;

  const region = row.getBoundingClientRect();
  const target = tree.getBoundingClientRect();
  const previewBounds = preview.getBoundingClientRect();
  if (target.width < 1 || target.height < 1 || !region.width || !region.height)
    return;

  const isRight = position === "right";
  const treeOffset = isRight
    ? region.left - target.left
    : region.right - target.right;
  const previewOffset = isRight
    ? region.right - previewBounds.right
    : region.left - previewBounds.left;
  if (Math.abs(treeOffset) < 1) return;

  const context = canvas.getContext("2d");
  if (!context) return;
  const particles = buildParticles(tree, target);
  if (!particles.length) return;
  const { color: inkColor } = getComputedStyle(tree);
  const { color: accentColor } = getComputedStyle(canvas);
  const scale = Math.min(
    window.devicePixelRatio || 1,
    2,
    Math.sqrt(canvasPixelLimit / (region.width * region.height)),
  );
  canvas.width = Math.ceil(region.width * scale);
  canvas.height = Math.ceil(region.height * scale);
  canvas.hidden = false;
  context.scale(scale, scale);
  tree.style.zIndex = "1";
  const listeners = new AbortController();
  const options = { capture: true, signal: listeners.signal };
  window.addEventListener("resize", finish, options);
  document.addEventListener("visibilitychange", finish, options);
  reduced.addEventListener("change", finish, options);
  forcedColors?.addEventListener("change", finish, options);
  row.addEventListener("pointerdown", finish, options);
  row.addEventListener("wheel", finish, { ...options, passive: true });
  row.addEventListener("keydown", finish, options);

  let frame = 0;
  const start = performance.now();
  const originX = target.left - region.left + treeOffset;
  const originY = target.top - region.top;
  const direction = isRight ? 1 : -1;
  const driftLimit = Math.min(1, Math.abs(treeOffset) / 250);

  function finish() {
    if (listeners.signal.aborted) return;
    listeners.abort();
    cancelAnimationFrame(frame);
    tree.style.removeProperty("opacity");
    tree.style.removeProperty("transform");
    tree.style.removeProperty("z-index");
    preview.style.removeProperty("transform");
    canvas.hidden = true;
    canvas.width = canvas.height = 1;
  }

  const render = (now: number) => {
    const time = Math.max(0, (now - start) / durationMs);
    if (time >= 1) {
      finish();
      return;
    }
    const dissolved = smooth(0, 0.21, time);
    const assembled = smooth(0.75, 0.98, time);
    // 首尾使用同一个真实的文件树。淡出后才把原树放到目标位置，恢复时保留滚动和焦点。
    tree.style.opacity = String(1 - dissolved + assembled);
    tree.style.transform = `translateX(${dissolved < 1 ? treeOffset : 0}px)`;
    preview.style.transform = `translateX(${previewOffset * (1 - smooth(0.11, 0.88, time))}px)`;
    context.clearRect(0, 0, region.width, region.height);
    const visibility = dissolved * (1 - assembled);
    let hasInk = false;
    context.fillStyle = accentColor;
    for (const particle of particles) {
      if (particle.ink && !hasInk) {
        hasInk = true;
        context.fillStyle = inkColor;
      }
      const progress = smooth(particle.delay, 0.83 + particle.delay, time);
      const spread = Math.sin(Math.PI * progress);
      const shape = 1 - 0.62 * spread;
      const x =
        originX +
        (particle.x - target.width / 2) * shape +
        target.width / 2 -
        treeOffset * progress +
        particle.drift * spread * direction * driftLimit;
      const y =
        originY +
        (particle.y - target.height / 2) * shape +
        target.height / 2 +
        (particle.rise - 13) * spread;
      const size = particle.size * (1 + spread * 0.15);
      context.globalAlpha = visibility * particle.opacity;
      context.fillRect(x - size / 2, y - size / 2, size, size);
    }
    frame = requestAnimationFrame(render);
  };
  render(start);
  return finish;
}
