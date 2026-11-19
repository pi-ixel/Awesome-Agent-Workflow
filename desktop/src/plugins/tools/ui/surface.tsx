import type { ReactNode } from "react";

/**
 * 工具面板的挂载外壳：只管显隐，**不参与布局**。
 *
 * 这里绝不能写成横排 flex（`flex` 默认 `flex-direction: row`）。`.aaw-tools`
 * 用了 `container-type: inline-size`（要在 360 / 740 两档换排版），而
 * inline-size 容器会抑制自身的固有宽度：作为横排 flex item 时 flex-basis
 * 退化成 0，父容器又不负责拉宽——整个面板被压成一条二三十像素的竖条，
 * 「工具中心」四个字一字一行（2026-11-19 用户上报的"很小的一个竖条"）。
 *
 * 单独渲染面板的夹具看不出这个问题（父级是 block），所以把外壳单独拎出来，
 * 让测试夹具和真实面板挂同一份代码，两边不会各写一份再跑偏。
 */
export function ToolsPanelSurface({ visible, children }: { visible: boolean; children: ReactNode }) {
  return (
    <section aria-label={visible ? "工具面板" : undefined} hidden={!visible} className="h-full min-h-0">
      {children}
    </section>
  );
}
