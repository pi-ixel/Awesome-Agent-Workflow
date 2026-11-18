import { IconButton } from "../../../shared/ui/IconButton.tsx";
/**
 * 画布左上角的缩放药丸：缩小 / 当前比例 / 放大 / 适应 / 1:1。
 *
 * 从前这四个按钮是裸 `<button>`，尺寸靠 `.workflow-canvas-tools button` 一条
 * CSS 临时写死；图形用的是 `−` `+` 两个 Unicode 字符（icons.tsx 抬头明令禁止）。
 * 现在按钮走公共控件（btnGhost 的形状与过渡），只有高度交给药丸容器统一规定。
 *
 * 只有一个消费方（GraphCanvas），按「有没有第二个消费方」的判据留在插件内，
 * 不上提 shared/ui。
 */
import { btnGhost } from "../../../shared/ui/controls.tsx";
import { FitIcon, MinimizeIcon, PlusIcon } from "../../../shared/ui/icons.tsx";
import { clampZoom } from "./zoom.ts";

export function CanvasToolbar({ zoom, onZoom, onFit }: {
  zoom: number;
  onZoom: (zoom: number) => void;
  /** 缩放到整张图放得下（GraphCanvas 算，页面不用管）。 */
  onFit: () => void;
}) {
  return <span className="workflow-zoom">
    <IconButton type="button" className={btnGhost} onClick={() => onZoom(clampZoom(zoom - 0.1))} aria-label="缩小" data-hint="缩小（Ctrl+滚轮）"><MinimizeIcon className="ui-icon-14" /></IconButton>
    <span className="pct">{Math.round(zoom * 100)}%</span>
    <IconButton type="button" className={btnGhost} onClick={() => onZoom(clampZoom(zoom + 0.1))} aria-label="放大" data-hint="放大（Ctrl+滚轮）"><PlusIcon className="ui-icon-14" /></IconButton>
    <i className="sep" aria-hidden="true" />
    <IconButton type="button" className={btnGhost} onClick={onFit} aria-label="适应" data-hint="缩放到整张流程图放得下"><FitIcon className="ui-icon-14" /></IconButton>
    <button type="button" className={btnGhost} onClick={() => onZoom(1)} aria-label="重置缩放" data-hint="1:1 原始比例" style={{ fontVariantNumeric: "tabular-nums" }}>1:1</button>
  </span>;
}
