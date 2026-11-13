/**
 * 小地图：流程图比视口长时，画布右上角的一张缩略图。按比例画出每张卡片的位置
 * （失败、要人处理、运行中用醒目色，已完成与未运行用淡色），框出当前看到的区域；
 * 点或拖动跳过去。放在滚动条左边，不和它重叠。
 */
import type { PointerEvent as ReactPointerEvent } from "react";
import type { Overview } from "./overview.ts";

/** 缩略图的最大宽度；太高放不下时按高度缩小。 */
const MAP_WIDTH = 48;
const MAP_MARGIN = 8;
const SIDE_PAD = 8;

export function Minimap({ overview, onJump }: { overview: Overview; onJump: (top: number, left: number) => void }) {
  // 横向只取卡片占的范围（画布居中，两侧是空白），缩略图才不会被压得很扁。
  const { marks } = overview;
  const x0 = marks.length ? Math.max(0, Math.min(...marks.map((m) => m.left)) - SIDE_PAD) : 0;
  const x1 = marks.length ? Math.min(overview.width, Math.max(...marks.map((m) => m.left + m.width)) + SIDE_PAD) : overview.width;
  const span = Math.max(1, x1 - x0);
  const maxHeight = Math.max(40, overview.viewHeight - MAP_MARGIN * 2);
  const scale = Math.min(MAP_WIDTH / span, maxHeight / overview.total);
  const px = (value: number) => Math.round(value * scale * 10) / 10;
  const jump = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const top = (event.clientY - rect.top) / scale - overview.viewHeight / 2;
    const left = (event.clientX - rect.left) / scale + x0 - overview.viewWidth / 2;
    onJump(Math.max(0, top), Math.max(0, left));
  };
  return <div
    className="workflow-minimap"
    aria-hidden="true"
    data-testid="workflow-minimap"
    style={{ top: MAP_MARGIN, right: overview.gutter + MAP_MARGIN, width: px(span), height: px(overview.total) }}
    onPointerDown={(event) => {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      jump(event);
    }}
    onPointerMove={(event) => {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) jump(event);
    }}
  >
    {overview.marks.map((mark, index) => <i key={index} className={`tone-${mark.tone}`} style={{ top: px(mark.top), left: px(mark.left - x0), width: Math.max(2, px(mark.width)), height: Math.max(2, px(mark.height)) }} />)}
    <span className="workflow-minimap-view" style={{ top: px(overview.viewTop), left: px(overview.viewLeft - x0), width: px(overview.viewWidth), height: px(overview.viewHeight) }} />
  </div>;
}
