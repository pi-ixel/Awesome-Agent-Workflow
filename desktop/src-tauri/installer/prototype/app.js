// Visual prototype only. No native bridge, downloads, file writes or installers.
const panel = document.querySelector("#panel");
const shell = document.querySelector(".window");
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
let scene = "install",
  timer,
  progress = 0,
  motion = !reduced.matches;
let installPath = "C:\\Users\\你\\AppData\\Local\\AAW Desktop";
let shortcut = true;
const primary = (label, action) =>
  `<button class="primary" data-action="${action}">${label}<span class="arrow" aria-hidden="true">↗</span></button>`;
function show(next) {
  clearInterval(timer);
  const updating = scene === "update";
  scene = next;
  shell.dataset.state = next;
  document
    .querySelectorAll("[data-scene]")
    .forEach((b) => b.setAttribute("aria-pressed", b.dataset.scene === next));
  let html;
  if (next === "install") {
    html = `<h2>安装 AAW Desktop</h2><label class="field-label" for="path">安装位置</label><input class="path" id="path" spellcheck="false" aria-label="安装位置"><details><summary>更多选项</summary><label><input id="shortcut" type="checkbox">创建桌面快捷方式</label></details>${primary("安装", "install")}`;
  } else if (next === "update" || next === "installing") {
    const updating = next === "update";
    progress = 0;
    html = `<h2>${updating ? "正在更新" : "正在安装"}</h2>${updating ? '<div class="version-route"><span>当前版本</span><b>→</b><span>新版本</span></div>' : ""}<div class="progress-heading"><span id="stage">正在检查安装环境</span><strong><span id="percent">0</span><small>%</small></strong></div><div class="track" role="progressbar" aria-label="演示安装进度" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"><div class="fill"></div></div><ol class="steps"><li class="active"><i>1</i>检查安装环境</li><li><i>2</i>${updating ? "更新应用文件" : "安装应用文件"}</li><li><i>3</i>准备工作区</li></ol><p class="fine">${updating ? "更新完成后，将自动打开 AAW Desktop。" : "安装期间请保持窗口开启。"}</p>`;
  } else if (next === "success") {
    html = `<div class="result-icon" aria-hidden="true">✓</div><h2>${updating ? "更新完成" : "安装完成"}</h2>${primary("打开 AAW Desktop", "launch")}<p class="fine" id="launch-note"></p>`;
  } else {
    html = `<div class="result-icon error" aria-hidden="true">!</div><h2>安装未完成</h2><p class="subtitle">请关闭 AAW Desktop 后重试。</p><div class="actions">${primary("重试", "retry")}<button class="secondary" data-action="logs">查看日志</button></div><pre class="log" hidden>演示日志 · 未执行实际安装\n[准备] 环境检查完成\n[安装] 示例错误：应用文件被占用\n[建议] 关闭应用后重试</pre>`;
  }
  panel.innerHTML = `<div class="panel-content">${html}</div>`;
  if (next === "install") {
    const input = document.querySelector("#path");
    input.value = installPath;
    input.addEventListener("input", () => (installPath = input.value));
    const box = document.querySelector("#shortcut");
    box.checked = shortcut;
    box.addEventListener("change", () => (shortcut = box.checked));
  }
  if (next === "update" || next === "installing")
    timer = setInterval(tick, 160);
}
function tick() {
  if (document.hidden) return;
  progress = Math.min(100, progress + 1);
  document.querySelector("#percent").textContent = progress;
  document.querySelector(".fill").style.width = `${progress}%`;
  document.querySelector(".track").setAttribute("aria-valuenow", progress);
  const phase = progress < 20 ? 0 : progress < 85 ? 1 : 2;
  const labels = [
    "正在检查安装环境",
    scene === "update" ? "正在更新应用文件" : "正在安装应用文件",
    "正在准备工作区",
  ];
  document.querySelector("#stage").textContent = labels[phase];
  document.querySelectorAll(".steps li").forEach((li, i) => {
    li.className = i < phase ? "done" : i === phase ? "active" : "";
    li.querySelector("i").textContent = i < phase ? "✓" : i + 1;
  });
  if (progress === 100) {
    clearInterval(timer);
    timer = setTimeout(() => show("success"), 500);
  }
}
document
  .querySelectorAll("[data-scene]")
  .forEach((b) => b.addEventListener("click", () => show(b.dataset.scene)));
panel.addEventListener("click", (e) => {
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (action === "install") {
    if (!installPath.trim()) {
      document.querySelector("#path").focus();
      return;
    }
    show("installing");
  }
  if (action === "retry") show("update");
  if (action === "logs") {
    const log = document.querySelector(".log");
    log.hidden = !log.hidden;
  }
  if (action === "launch")
    document.querySelector("#launch-note").textContent =
      "体验预览结束 · 原型不会启动或安装应用。";
});
const canvas = document.querySelector("#particles"),
  ctx = canvas.getContext("2d");
let width = 0,
  height = 0,
  last = 0,
  raf = 0;
const stars = Array.from({ length: 65 }, (_, i) => ({
  x: ((i * 73 + 11) % 101) / 101,
  y: ((i * 47 + 7) % 103) / 103,
  r: i % 4 === 0 ? 1.5 : 0.7,
  s: 0.006 + (i % 5) * 0.003,
}));
function resize() {
  const rect = canvas.getBoundingClientRect();
  width = rect.width;
  height = rect.height;
  const dpr = Math.min(devicePixelRatio, 2);
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw(0);
}
function draw(dt) {
  ctx.clearRect(0, 0, width, height);
  stars.forEach((star, i) => {
    star.y = (star.y - dt * star.s + 1) % 1;
    ctx.beginPath();
    ctx.fillStyle = i % 3 ? "#aaa4ff88" : "#9bdcffcc";
    ctx.arc(star.x * width, star.y * height, star.r, 0, Math.PI * 2);
    ctx.fill();
  });
}
function frame(time) {
  draw(last ? Math.min((time - last) / 1000, 0.05) : 0);
  last = time;
  raf = requestAnimationFrame(frame);
}
function syncMotion() {
  cancelAnimationFrame(raf);
  last = 0;
  document.body.classList.toggle("paused", !motion);
  const b = document.querySelector("#motion");
  b.textContent = motion ? "动效：开" : "动效：关";
  b.setAttribute("aria-pressed", motion);
  if (motion && !document.hidden) raf = requestAnimationFrame(frame);
}
document.querySelector("#motion").addEventListener("click", () => {
  motion = !motion;
  syncMotion();
});
document.addEventListener("visibilitychange", syncMotion);
reduced.addEventListener("change", () => {
  motion = !reduced.matches;
  syncMotion();
});
new ResizeObserver(resize).observe(canvas);
const initial = new URLSearchParams(location.search).get("scene");
show(
  ["install", "update", "success", "failure"].includes(initial)
    ? initial
    : "install",
);
syncMotion();
