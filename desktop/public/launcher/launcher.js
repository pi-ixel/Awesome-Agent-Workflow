/* global document, window */
const $ = (id) => document.getElementById(id);
const query = $("query");
let entries = [];
let selected = 0;
let buttons = [];
let expanded = false;
let showAll = false;
let refreshing = 0;
let busy = false;
// 设置页与快捷键草稿要跨"隐藏 → 再唤起"存活：失焦隐藏是这个小窗的常态，
// 之前每次唤起都 settings(false) 并把输入框重置回已保存值，用户正在改的
// 快捷键就这样被吞掉了。
let settingsOpen = false;
let acceleratorDirty = false;
const openTimeoutMs = 6000;
const icons = {
  workflow: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/><path d="M6.5 10v5a3 3 0 0 0 3 3H14M14 6h4v4"/>',
  library: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 17.5h7m-3.5-3.5v7"/>',
  tool: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16"/>',
};
function status(text) { $("message").hidden = !text; $("message").textContent = text?.replace(/^Error invoking remote method '[^']+': Error: /, ""); }
function choose(index) {
  selected = index;
  buttons.forEach((button, at) => button.setAttribute("aria-current", String(at === index)));
}
function markBusy(id, busy) {
  const button = id && buttons.find((item) => item.dataset.id === id);
  if (!button) return;
  if (busy) button.dataset.busy = "true";
  else delete button.dataset.busy;
  button.setAttribute("aria-busy", String(busy));
}
async function open(id) {
  if (busy) return;
  busy = true;
  markBusy(id, true);
  // 打开大工具时 IPC 会一直等宿主回话；超时兜底是为了让"看起来卡死"变成一句话。
  const timer = setTimeout(() => {
    busy = false;
    markBusy(id, false);
    status("打开超时，请重试。");
  }, openTimeoutMs);
  try { await window.launcher.open(id); }
  catch (error) { status(error.message); }
  finally { clearTimeout(timer); busy = false; markBusy(id, false); }
}
function tile(entry) {
  const li = document.createElement("li");
  const button = document.createElement("button");
  button.className = "item";
  button.title = entry.description;
  button.dataset.id = entry.id;
  const icon = document.createElement("span");
  icon.className = "item-mark";
  icon.dataset.icon = entry.icon;
  // 色板由 registry 按工具 id 算好下发，页面不再自己哈希——否则会和主窗算出两套颜色。
  if (entry.tone !== undefined) icon.dataset.tone = String(entry.tone);
  icon.setAttribute("aria-hidden", "true");
  if (entry.glyph) {
    const glyph = document.createElement("span");
    glyph.className = "item-glyph";
    glyph.textContent = entry.glyph;
    icon.append(glyph);
  } else icon.innerHTML = `<svg viewBox="0 0 24 24">${icons[entry.icon] ?? icons.tool}</svg>`;
  const label = document.createElement("span");
  label.className = "item-label";
  label.textContent = entry.name;
  button.append(icon, label);
  button.addEventListener("click", () => void open(entry.id));
  button.addEventListener("focus", () => choose(buttons.indexOf(button)));
  const pin = document.createElement("button");
  pin.className = "pin";
  pin.textContent = entry.pinned ? "★" : "☆";
  pin.setAttribute("aria-label", `${entry.pinned ? "取消固定" : "固定"} ${entry.name}`);
  pin.setAttribute("aria-pressed", String(entry.pinned));
  pin.title = entry.pinned ? "取消固定" : "固定到小窗";
  pin.addEventListener("click", async () => {
    try { await window.launcher.pin(entry.id, !entry.pinned); await refresh(false); }
    catch (error) { status(error.message); }
  });
  li.append(button, pin);
  return li;
}
const rowHeight = 90;   // .item 最小高 86 + 网格行距 4
const labelHeight = 26; // .section-label 高 + 下边距
function gridColumns() {
  const columns = window.getComputedStyle($("results")).gridTemplateColumns.split(" ").filter(Boolean).length;
  return Math.max(1, columns);
}
/** 最近使用显示几行：由窗口实际高度决定，1–3 行。 */
function visibleRows(columns, pinnedCount) {
  const height = $("content").clientHeight;
  if (!height) return 1; // 首帧或测试环境没有布局信息时退回单行
  const pinnedRows = pinnedCount ? Math.ceil(pinnedCount / columns) : 0;
  const reserved = labelHeight * 2 + pinnedRows * rowHeight + 16;
  return Math.max(1, Math.min(3, Math.floor((height - reserved) / rowHeight)));
}
function render() {
  const term = query.value.trim().toLowerCase();
  const searching = Boolean(term) || showAll;
  const matches = entries.filter((entry) => `${entry.name} ${entry.keywords.join(" ")}`.toLowerCase().includes(term));
  const recent = matches.filter((entry) => entry.recent > 0);
  const columns = gridColumns();
  const pinnedEntries = searching ? [] : entries.filter((entry) => entry.pinned).sort((a, b) => a.pinOrder - b.pinOrder);
  // 行数按可用高度算，而不是写死。之前固定只显示 1 行（=列数），于是窗口
  // 下方空着 1/3，同时又因为内容被切成两段而出现滚动条。
  const capacity = columns * visibleRows(columns, pinnedEntries.length);
  const shown = searching ? matches : expanded ? recent : recent.slice(0, capacity);
  $("caption").textContent = term ? `搜索结果 · ${matches.length}` : showAll ? `全部功能 · ${matches.length}` : "最近使用";
  $("results").setAttribute("aria-label", $("caption").textContent);
  $("results").replaceChildren(...shown.map(tile));
  $("expand").hidden = searching || recent.length <= capacity;
  $("expand").textContent = expanded ? "收起最近" : `查看全部最近 (${recent.length})`;
  $("pinned-section").hidden = searching;
  $("pinned").replaceChildren(...pinnedEntries.map(tile));
  $("pin-empty").hidden = entries.some((entry) => entry.pinned);
  $("empty").hidden = shown.length > 0;
  $("empty").textContent = searching ? "没有找到匹配的功能，试试其他关键词。" : "从已固定或全部功能打开，最近使用会出现在这里。";
  buttons = [...document.querySelectorAll(".item")];
  choose(0);
}
const shortcutHint = "点击输入框后直接按组合键（需含 Ctrl / Alt / Shift 之一），例如 Ctrl+Shift+Space。";
let savedShortcut = "Alt+Space";
function hint(text) { $("shortcut-hint").textContent = text || shortcutHint; }
/**
 * 修饰键单独按下时必须忽略。
 *
 * 用户想录 Alt+Space，先按下的是 Alt——这一下 `event.code` 是 `AltLeft`，
 * 既不可能成为主键，也不该报错。以前这里照常走校验，于是用户刚碰到 Alt
 * 就看到"这个键不能作为主键"，以为 Alt+Space 不被允许。
 */
const modifierKeys = new Set(["Alt", "AltGraph", "Control", "Shift", "Meta"]);
/**
 * Ctrl + 这些字母在各家应用里几乎都是固定含义。它们能被注册成全局热键
 * （实测 Ctrl+A 注册返回 true），代价是那些操作会从所有窗口里被抢走：
 * 用户在浏览器里按 Ctrl+A 得到的是唤起 AAW，而不是全选。不禁止，但要先说清楚。
 */
const editingKeys = {
  A: "全选", C: "复制", V: "粘贴", X: "剪切", Z: "撤销", Y: "重做",
  S: "保存", F: "查找", P: "打印", W: "关闭窗口", N: "新建", T: "新标签页",
};
function conflictHint(value) {
  const parts = value.split("+");
  const key = parts.pop();
  if (parts.length !== 1 || parts[0] !== "Control") return "";
  const action = editingKeys[key];
  if (!action) return "";
  return `${value.replace("Control", "Ctrl")} 在大多数应用里是「${action}」；设为全局唤起键后，那些地方会变成打开 AAW。想避开就再加一个 Shift 或 Alt。`;
}
/** 把 KeyboardEvent.code 映射成 Electron accelerator 的主键；返回空串表示不能当主键。 */
function acceleratorKey(code) {
  if (code === "Space") return "Space";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return "";
}
function shortcutFromEvent(event) {
  const key = acceleratorKey(event.code);
  if (!key) return { error: "这个键不能作为主键，请用字母、数字、空格或 F1–F24。" };
  const modifiers = [event.ctrlKey && "Control", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Command"].filter(Boolean);
  if (!modifiers.length) return { error: "需要至少一个修饰键：Ctrl、Alt 或 Shift。" };
  return { value: [...modifiers, key].join("+") };
}
/** 保存前的本地校验：不发 IPC 也能立刻告诉用户"这不像一个快捷键"。 */
function validShortcut(value) {
  const parts = String(value).split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  const key = parts.pop();
  return parts.every((part) => /^(ctrl|control|alt|shift|command|cmd|commandorcontrol)$/i.test(part))
    && /^(space|f(?:[1-9]|1[0-9]|2[0-4])|[a-z0-9])$/i.test(key);
}
function shortcutState(result) {
  savedShortcut = result.shortcut;
  $("shortcut").textContent = result.shortcutReady ? result.shortcut.replace("Control", "Ctrl").replaceAll("+", " + ") : "快捷键被占用 · 点击设置";
  // 正在编辑时不回写：refresh 每次唤起都会调到这里，覆盖就等于抹掉草稿。
  if (!acceleratorDirty) $("accelerator").value = result.shortcut;
}
async function refresh(reset = true) {
  const generation = ++refreshing;
  try {
    const result = await window.launcher.entries();
    if (generation !== refreshing) return;
    // 主题跟着主窗走（默认深色，warm 才切浅色）：主进程随列表一起下发，
    // 页面不再单发一次 IPC——那会再把 preferences.json 读一遍。
    if (result.theme === "warm" || result.theme === "dark") document.documentElement.dataset.theme = result.theme;
    entries = result.entries;
    shortcutState(result);
    // reset 只重置"浏览态"（搜索词、展开、全部功能），不重置设置页与草稿。
    if (reset) { query.value = ""; showAll = false; expanded = false; status(""); }
    render();
    if (settingsOpen) {
      // 唤起（或刷新）不把焦点塞进录制框：焦点在框里就等于"正在录"，全局热键
      // 会让开，用户反而没法用快捷键把这个面板收回去。录制由用户点一下框开始。
      if (document.activeElement === $("accelerator")) $("accelerator").blur();
    } else if (reset) query.focus();
  } catch (error) { status(error.message); }
}
function settings(visible) {
  settingsOpen = visible;
  $("settings").hidden = !visible;
  $("content").hidden = visible;
  query.disabled = visible;
  if (visible) {
    if (!acceleratorDirty) $("accelerator").value = savedShortcut;
    hint("");
    // 不自动聚焦：打开设置页不等于开始录制。用户点一下录制框才让出全局热键，
    // 这样"设置页开着"和"正在录"是两件事——后者才需要热键让位。
  } else {
    releaseGlobalShortcut(false);
    query.focus();
  }
}
/**
 * 录制期间把全局热键让出来。
 *
 * 不让的话，用户按下的第一下往往就是当前生效的那组键（最常见就是 Alt+Space）：
 * 全局热键抢先一步把窗口关掉，用户看到的是界面消失，而不是录进输入框。
 *
 * 让出的范围只跟录制框的焦点走，不是整个设置页——用户点开设置页只是想看看，
 * 或者把光标挪到别处时，仍然要能按快捷键把这个面板唤出/收回。窗口被隐藏时
 * 主进程会兜底恢复，渲染进程没发出去也不会把热键永久弄丢。
 */
function releaseGlobalShortcut(active) {
  try {
    const result = window.launcher.capture?.(active);
    // 通知失败不该冒成未处理的 rejection：热键由主进程在 hide 时兜底恢复。
    if (result?.catch) result.catch(() => {});
  } catch { /* 旧版 preload 没有这个方法，录制仍然可用 */ }
}
async function saveShortcut(value) {
  if (!validShortcut(value)) { hint("请先按下要用的组合键（需含 Ctrl / Alt / Shift 之一）。"); return; }
  try {
    const result = await window.launcher.shortcut(value);
    acceleratorDirty = false;
    shortcutState(result);
    hint("");
    status("快捷键已保存，即刻生效。");
  } catch (error) {
    // 失败时把输入框退回仍然生效的那组。留着新值只会让人以为已经改好了——
    // 之前就是这样：看起来存了 Ctrl+A，实际按下去没反应。
    acceleratorDirty = false;
    $("accelerator").value = savedShortcut;
    hint("");
    status(error.message);
  }
}
query.addEventListener("input", () => { showAll = false; status(""); render(); });
$("all").addEventListener("click", () => { showAll = true; render(); query.focus(); });
$("expand").addEventListener("click", () => { expanded = !expanded; render(); });
$("settings-open").addEventListener("click", () => settings($("settings").hidden));
$("shortcut").addEventListener("click", () => settings(true));
$("accelerator").addEventListener("input", () => { acceleratorDirty = true; });
// 让位只覆盖"正在录制"这一小段时间：选中录制框时全局热键失效，否则用户按下的
// 第一下就会被自己正在生效的快捷键收走，录不进去；点到别处（保存按钮、空白处）
// 立刻还回去，这样设置页开着也能用快捷键把面板唤出或收回。
$("accelerator").addEventListener("focus", () => releaseGlobalShortcut(true));
$("accelerator").addEventListener("blur", () => releaseGlobalShortcut(false));
// 快捷键用"按下组合键"捕获，而不是让用户默写字符串——之前拼错只能等保存后看报错。
$("accelerator").addEventListener("keydown", (event) => {
  if (!settingsOpen) return;
  if (event.key === "Escape") { acceleratorDirty = false; $("accelerator").value = savedShortcut; hint(""); return; }
  // 只按了修饰键：这是组合键的第一步，等主键按下来再判断。
  if (modifierKeys.has(event.key)) return;
  // Preserve focus navigation and form submission instead of trapping the
  // keyboard inside this read-only shortcut capture field.
  const navigation = !event.ctrlKey && !event.altKey && !event.metaKey;
  if (navigation && (event.key === "Tab" || event.key === "Enter" && !event.shiftKey)) return;
  event.preventDefault();
  const next = shortcutFromEvent(event);
  if (next.error) { hint(next.error); return; }
  $("accelerator").value = next.value;
  acceleratorDirty = true;
  hint(conflictHint(next.value));
});
$("settings-close").addEventListener("click", () => { settings(false); status(""); });
$("close").addEventListener("click", () => window.launcher.hide());
$("shortcut-form").addEventListener("submit", (event) => { event.preventDefault(); void saveShortcut($("accelerator").value); });
$("reset-shortcut").addEventListener("click", () => void saveShortcut("Alt+Space"));
document.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (event.key === "Escape") {
    if (!$("settings").hidden) { settings(false); status(""); }
    else if (query.value || showAll) { query.value = ""; showAll = false; render(); }
    else window.launcher.hide();
  }
  if (!buttons.length || event.target !== query) return;
  if (event.key.startsWith("Arrow")) {
    event.preventDefault();
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      choose((selected + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length);
    } else {
      const current = buttons[selected].getBoundingClientRect();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const candidates = buttons.map((button, index) => ({ index, rect: button.getBoundingClientRect() }))
        .filter(({ rect }) => direction * (rect.top - current.top) > 1)
        .sort((a, b) => Math.abs(a.rect.top - current.top) - Math.abs(b.rect.top - current.top)
          || Math.abs(a.rect.left - current.left) - Math.abs(b.rect.left - current.left));
      choose(candidates[0]?.index ?? (direction > 0 ? 0 : buttons.length - 1));
    }
    buttons[selected].scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter") { event.preventDefault(); void open(buttons[selected].dataset.id); }
});
window.addEventListener("resize", render);
window.launcher.onRefresh(() => void refresh());
// Alt+Space 是 Windows 的系统菜单键，页面的 keydown 收不到那一下 Space；
// 主进程接住之后把组合键回送过来，用户才能把快捷键改回默认那一组。
window.launcher.onShortcutPressed?.((value) => {
  if (!settingsOpen || typeof value !== "string") return;
  $("accelerator").value = value;
  acceleratorDirty = true;
  hint("");
});
void refresh();
