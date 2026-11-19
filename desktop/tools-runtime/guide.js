/**
 * 指导文档窗口的行为：主题跟随主窗、目录高亮、关闭。
 *
 * 内容在构建期就渲染成静态 HTML（见 scripts/guide-render.mjs），这里只做
 * 一点点交互，尽量不引入失败面。
 */
/* global document, window, location, history, IntersectionObserver */
const theme = new URLSearchParams(location.search).get("theme");
if (theme === "warm") document.documentElement.dataset.theme = "warm";

document.getElementById("close")?.addEventListener("click", () => window.close());

const links = Array.from(document.querySelectorAll("#toc a"));
const sections = links
  .map((link) => document.querySelector(link.getAttribute("href")))
  .filter(Boolean);
if (sections.length) {
  // 用观察器而不是 scroll 事件：长文档滚动时不会每帧都算一次布局。
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const index = sections.indexOf(entry.target);
      links.forEach((link, at) => link.classList.toggle("is-active", at === index));
    }
  }, { root: document.getElementById("doc"), rootMargin: "-10% 0px -75% 0px", threshold: 0 });
  for (const section of sections) observer.observe(section);
  links[0]?.classList.add("is-active");
}

// 目录点击走原生锚点，这里只补一次平滑滚动（scroll-behavior 在窄窗口下不够稳）。
for (const link of links) {
  link.addEventListener("click", (event) => {
    const target = document.querySelector(link.getAttribute("href"));
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView({ block: "start" });
    history.replaceState(undefined, "", link.getAttribute("href"));
  });
}
