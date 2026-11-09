/** ZCode 3c5b2276 sidePaneLayout：默认 45%，窗口变化时保留用户比例。 */
export const DEFAULT_PANEL_RATIO = 0.45;
export const PANEL_MIN_PX = 300;
export const CHAT_MIN_PX = 320;
export function resolvePanelLayout(
  available: number,
  ratio = DEFAULT_PANEL_RATIO,
) {
  const maximum = Math.max(PANEL_MIN_PX, available - CHAT_MIN_PX);
  const width = Math.round(
    Math.min(maximum, Math.max(PANEL_MIN_PX, available * ratio)),
  );
  return { width, maximum, overlay: available < PANEL_MIN_PX + CHAT_MIN_PX };
}
