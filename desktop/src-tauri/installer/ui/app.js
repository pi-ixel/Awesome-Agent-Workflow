// Production installer UI. Every state and stage comes from the native host.
const invoke = (command, args) =>
  window.__TAURI_INTERNALS__.invoke(command, args);
const panel = document.querySelector("#panel");
let status,
  rendered = "",
  polling = false,
  started = false,
  lastShortcut = true;
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const primary = (text, action) =>
  `<button class="primary" data-action="${action}">${text}<span class="arrow" aria-hidden="true">↗</span></button>`;
function display(s) {
  document.querySelector("#close").disabled = s.busy;
  const key = s.phase;
  if (key !== rendered) {
    rendered = key;
    if (key === "ready")
      panel.innerHTML = `<h2>${s.update ? "更新" : "安装"} AAW Desktop</h2><label class="field-label" for="path">安装位置 <span>${escape(s.version)}</span></label><button id="path" class="path path-picker" data-action="directory" aria-label="选择安装位置" value="${escape(s.destination)}" ${s.update ? "disabled" : ""}><span>${escape(s.destination)}</span><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5h6l2 2h10v12H3Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg></button><details><summary>更多选项</summary><label><input id="shortcut" type="checkbox" checked>创建桌面快捷方式</label></details>${primary(s.update ? "更新" : "安装", "begin")}<p class="fine error-text" id="error"></p>`;
    if (key === "installing")
      panel.innerHTML = `<h2>${s.update ? "正在更新" : "正在安装"}</h2><div class="progress-heading"><span id="stage"></span><span>${escape(s.version)}</span></div><div class="track indeterminate" role="progressbar" aria-label="安装进行中"><div class="fill"></div></div><ol class="steps"><li id="step-prepare"><i>1</i>检查环境</li><li id="step-files"><i>2</i>安装文件</li><li id="step-register"><i>3</i>完成配置</li></ol><p class="fine">${s.update ? "完成后自动打开 AAW Desktop。" : "安装期间请保持窗口开启。"}</p>`;
    if (key === "success")
      panel.innerHTML = `<div class="result-icon" aria-hidden="true">✓</div><h2>准备就绪</h2>${primary("打开 AAW Desktop", "launch")}<p class="fine error-text" id="error"></p>`;
    if (key === "failure")
      panel.innerHTML = `<div class="result-icon error" aria-hidden="true">!</div><h2>安装未完成</h2><p class="subtitle">${escape(s.error)}</p><div class="actions">${primary("重试", "retry")}<button class="secondary" data-action="logs">查看日志</button></div><p class="fine error-text" id="error"></p>`;
  }
  if (s.busy) {
    const labels = {
      prepare: "正在检查安装环境",
      runtime: "正在准备 WebView2",
      files: "正在安装应用文件",
      register: "正在注册应用",
      shortcuts: "正在配置快捷方式",
      complete: "正在完成安装",
    };
    document.querySelector("#stage").textContent =
      labels[s.stage] || labels.prepare;
    const phase = ["prepare", "runtime"].includes(s.stage)
      ? 0
      : s.stage === "files"
        ? 1
        : 2;
    document.querySelectorAll(".steps li").forEach((li, i) => {
      li.className = i < phase ? "done" : i === phase ? "active" : "";
      li.querySelector("i").textContent = i < phase ? "✓" : i + 1;
    });
  }
}
async function begin(retry = false) {
  const button = panel.querySelector(".primary");
  if (button) button.disabled = true;
  try {
    if (!retry) lastShortcut = document.querySelector("#shortcut").checked;
    await invoke("installer_begin", {
      destination: retry
        ? status.destination
        : document.querySelector("#path").value,
      shortcut: lastShortcut,
    });
    await refresh();
  } catch (error) {
    const note = document.querySelector("#error");
    if (note) note.textContent = String(error);
  } finally {
    if (button) button.disabled = false;
  }
}
async function refresh() {
  if (polling) return;
  polling = true;
  try {
    status = await invoke("installer_status");
    display(status);
    if (status.update && status.phase === "ready" && !started) {
      started = true;
      polling = false;
      await begin();
      return;
    }
    if (status.update && status.phase === "success")
      await invoke("installer_close", { launch: false });
  } catch (error) {
    console.error(error);
    if (!status)
      panel.innerHTML =
        '<h2>无法打开安装界面</h2><p class="subtitle">请关闭窗口后重新运行安装包。</p>';
  } finally {
    polling = false;
  }
}
panel.addEventListener("click", async (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "begin") await begin();
  if (action === "retry") await begin(true);
  try {
    if (action === "directory") {
      const button = document.querySelector("#path");
      button.disabled = true;
      try {
        const selected = await invoke("installer_pick_directory", {
          current: button.value,
        });
        if (selected) {
          button.value = selected;
          button.querySelector("span").textContent = selected;
        }
      } finally {
        button.disabled = false;
      }
    }
    if (action === "logs") await invoke("installer_logs");
    if (action === "launch") await invoke("installer_close", { launch: true });
  } catch (error) {
    const note = document.querySelector("#error");
    if (note) note.textContent = String(error);
  }
});
document.querySelector("#titlebar").addEventListener("pointerdown", (event) => {
  if (event.button === 0 && !event.target.closest("button")) {
    event.preventDefault();
    void invoke("installer_window", { action: "drag" }).catch(console.error);
  }
});
document
  .querySelector("#minimize")
  .addEventListener(
    "click",
    () =>
      void invoke("installer_window", { action: "minimize" }).catch(
        console.error,
      ),
  );
document
  .querySelector("#close")
  .addEventListener(
    "click",
    () =>
      void invoke("installer_close", { launch: false }).catch(console.error),
  );
void refresh();
setInterval(() => void refresh(), 350);

const canvas = document.querySelector("#particles"),
  ctx = canvas.getContext("2d");
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
let width = 0,
  height = 0,
  last = 0,
  raf;
const stars = Array.from({ length: 65 }, (_, i) => ({
  x: ((i * 73 + 11) % 101) / 101,
  y: ((i * 47 + 7) % 103) / 103,
  r: i % 4 === 0 ? 1.5 : 0.7,
  s: 0.006 + (i % 5) * 0.003,
}));
function draw(dt) {
  ctx.clearRect(0, 0, width, height);
  stars.forEach((s, i) => {
    s.y = (s.y - dt * s.s + 1) % 1;
    ctx.beginPath();
    ctx.fillStyle = i % 3 ? "#aaa4ff88" : "#9bdcffcc";
    ctx.arc(s.x * width, s.y * height, s.r, 0, Math.PI * 2);
    ctx.fill();
  });
}
function frame(time) {
  draw(last ? Math.min((time - last) / 1000, 0.05) : 0);
  last = time;
  raf = requestAnimationFrame(frame);
}
function motion() {
  cancelAnimationFrame(raf);
  last = 0;
  document.body.classList.toggle("paused", reduced.matches);
  if (!document.hidden && !reduced.matches) raf = requestAnimationFrame(frame);
}
new ResizeObserver(() => {
  const rect = canvas.getBoundingClientRect();
  width = rect.width;
  height = rect.height;
  const dpr = Math.min(devicePixelRatio, 2);
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw(0);
}).observe(canvas);
document.addEventListener("visibilitychange", motion);
reduced.addEventListener("change", motion);
motion();
