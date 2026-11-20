/** 将根元素中的外观设置变更通知给需要主动重绘的渲染器。 */
export function observeAppearance(
  root: HTMLElement,
  onChange: (changes: { themeChanged: boolean; fontChanged: boolean }) => void,
) {
  if (typeof MutationObserver !== "function") return () => {};
  const readTheme = () => root.classList.contains("theme-warm");
  const readFont = () => root.style.getPropertyValue("--ui-font-size");
  let theme = readTheme();
  let font = readFont();
  const observer = new MutationObserver(() => {
    const nextTheme = readTheme();
    const nextFont = readFont();
    const changes = {
      themeChanged: nextTheme !== theme,
      fontChanged: nextFont !== font,
    };
    theme = nextTheme;
    font = nextFont;
    if (changes.themeChanged || changes.fontChanged) onChange(changes);
  });
  observer.observe(root, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  return () => observer.disconnect();
}
