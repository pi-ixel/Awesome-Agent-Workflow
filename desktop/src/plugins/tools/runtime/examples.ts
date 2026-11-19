import type { ToolPackage } from "../types.ts";
import { sampleTool } from "../ui/sample.ts";

/**
 * 内置示例工具。
 *
 * 存在的理由很实际：工具中心的空状态只能讲清「工具能干嘛」，讲不清「装上
 * 之后长什么样」。这两个示例让人一秒钟看到紧凑列表、管理页的设置分组、动作
 * 列表和真实可开的窗口；也能被 AI 直接调用，用来验证运行时能力是否正常。
 *
 * 它们是**普通工具**，不是特权数据：走和导入 ZIP 一样的 install 路径，可以
 * 改设置、导出、卸载，卸载完空状态里还能再载入一次。不自动写入用户配置，
 * 是否装载由用户决定（空状态按钮）或开发者执行 `npm run tools:seed`。
 *
 * 这个文件是纯数据 + 类型注解，Node 22 可以直接 import（type stripping），
 * 所以 UI 与 seed 脚本共用同一份定义，不会出现「界面里的示例和数据里的不一样」。
 */
const quickNotes: ToolPackage = {
  schemaVersion: 1,
  id: "quick-notes",
  name: "随手记",
  version: "1.0.0",
  icon: "✎",
  author: "AAW 示例",
  settingsSchema: [
    { id: "auto-copy", type: "boolean", label: "记下后自动复制到剪切板", description: "新增一条时，顺手把内容写进系统剪切板。", default: true },
    { id: "order", type: "select", label: "列表顺序", description: "只影响展示，不改变存储顺序。", default: "newest", options: [
      { label: "最新的在前", value: "newest" },
      { label: "最早的在前", value: "oldest" },
    ] },
  ],
  actions: [
    { id: "add", description: "记下一条文本，可自动复制到剪切板", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { id: "list", description: "列出已经记下的所有内容", inputSchema: { type: "object", properties: {} } },
    { id: "copy-last", description: "把最近记下的一条复制到剪切板", inputSchema: { type: "object", properties: {} } },
  ],
  html: `<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: clamp(14px, 4vw, 28px); font: 14px/1.6 system-ui, "Segoe UI", sans-serif; color: CanvasText; background: Canvas; }
  .wrap { max-width: 42rem; margin: 0 auto; }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
  .mark { flex: none; display: grid; place-items: center; width: 40px; height: 40px; border-radius: 12px; font-size: 20px; background: color-mix(in srgb, CanvasText 10%, Canvas); }
  h1 { margin: 0; font-size: 18px; font-weight: 650; }
  header p { margin: 2px 0 0; font-size: 12px; opacity: .65; }
  .composer { display: grid; gap: 10px; padding: 14px; border: 1px solid color-mix(in srgb, CanvasText 16%, Canvas); border-radius: 14px; background: color-mix(in srgb, CanvasText 4%, Canvas); }
  textarea { width: 100%; min-height: 82px; resize: vertical; padding: 10px 12px; border: 1px solid color-mix(in srgb, CanvasText 20%, Canvas); border-radius: 10px; background: Canvas; color: CanvasText; font: inherit; font-size: 13px; }
  textarea:focus { outline: 2px solid #3a6fd8; outline-offset: 1px; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  button { border: 0; border-radius: 9px; padding: 8px 15px; font: inherit; font-size: 13px; cursor: pointer; }
  .primary { background: #3a6fd8; color: #fff; }
  .primary:hover { background: #4a7ce0; }
  .ghost { background: color-mix(in srgb, CanvasText 9%, Canvas); color: CanvasText; }
  .ghost:hover { background: color-mix(in srgb, CanvasText 15%, Canvas); }
  .hint { margin-left: auto; font-size: 11px; opacity: .6; }
  h2 { margin: 22px 0 10px; font-size: 12px; font-weight: 600; letter-spacing: .04em; opacity: .6; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  li { display: flex; gap: 10px; align-items: flex-start; padding: 11px 13px; border: 1px solid color-mix(in srgb, CanvasText 14%, Canvas); border-radius: 11px; background: color-mix(in srgb, CanvasText 3%, Canvas); }
  li time { flex: none; font: 11px/1.7 ui-monospace, Consolas, monospace; opacity: .55; }
  li p { flex: 1; min-width: 0; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }
  li button { flex: none; padding: 4px 9px; font-size: 11px; border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas); background: transparent; color: CanvasText; }
  li button:hover { background: color-mix(in srgb, CanvasText 10%, Canvas); }
  .empty { padding: 22px; text-align: center; border: 1px dashed color-mix(in srgb, CanvasText 22%, Canvas); border-radius: 12px; font-size: 12px; opacity: .65; }
  output { font-size: 11px; opacity: .7; }
</style>
<div class="wrap">
  <header>
    <span class="mark" aria-hidden="true">✎</span>
    <div><h1>随手记</h1><p>记一句就存一句，关掉窗口下次还在；能一键复制，也能让 AI 帮你记。</p></div>
  </header>
  <div class="composer">
    <textarea id="text" placeholder="写点什么…"></textarea>
    <div class="row">
      <button type="button" class="primary" id="add">记下来</button>
      <button type="button" class="ghost" id="copyLast">复制最近一条</button>
      <span class="hint">Ctrl + Enter 快速记下</span>
    </div>
    <output id="status" aria-live="polite"></output>
  </div>
  <h2>已记 · <span id="count">0</span></h2>
  <ul id="list"></ul>
  <div class="empty" id="empty">还没有记录。写下第一句吧。</div>
</div>
<script>
  const KEY = 'notes';
  const settings = window.aawSettings || {};
  const input = document.querySelector('#text');
  const status = document.querySelector('#status');
  const ul = document.querySelector('#list');
  const count = document.querySelector('#count');
  const empty = document.querySelector('#empty');
  async function readNotes() {
    const value = await aawStore.get(KEY);
    return Array.isArray(value) ? value : [];
  }
  async function add(action) {
    const text = typeof action === 'string' ? action : action && action.text;
    if (typeof text !== 'string' || !text.trim()) throw new Error('text 不能为空');
    const items = await readNotes();
    const note = { id: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 7), text: text.trim(), at: Date.now() };
    items.unshift(note);
    await aawStore.set(KEY, items.slice(0, 200));
    if (settings['auto-copy']) await aawClipboard.writeText(note.text);
    await render();
    return { id: note.id, text: note.text, total: items.length };
  }
  async function list() { return { items: await readNotes() }; }
  async function copyLast() {
    const items = await readNotes();
    if (!items.length) return { copied: false };
    await aawClipboard.writeText(items[0].text);
    return { copied: true, text: items[0].text };
  }
  window.aawActions = { add, list, 'copy-last': copyLast };
  async function render() {
    const items = await readNotes();
    const ordered = settings.order === 'oldest' ? items.slice().reverse() : items;
    ul.replaceChildren();
    for (const item of ordered) {
      const li = document.createElement('li');
      const time = document.createElement('time');
      time.textContent = new Date(item.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const p = document.createElement('p');
      p.textContent = item.text;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '复制';
      btn.addEventListener('click', async () => {
        await aawClipboard.writeText(item.text);
        status.textContent = '已复制这一条';
      });
      li.append(time, p, btn);
      ul.append(li);
    }
    count.textContent = String(items.length);
    ul.hidden = items.length === 0;
    empty.hidden = items.length > 0;
  }
  document.querySelector('#add').addEventListener('click', async () => {
    try {
      await add({ text: input.value });
      input.value = '';
      status.textContent = settings['auto-copy'] ? '已记下，并复制到剪切板' : '已记下';
    } catch (error) { status.textContent = error.message; }
  });
  document.querySelector('#copyLast').addEventListener('click', async () => {
    const result = await copyLast();
    status.textContent = result.copied ? '已复制最近一条' : '还没有记录';
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      document.querySelector('#add').click();
    }
  });
  render();
</script>`,
};

/** 顺序即空状态里展示的顺序：先看有设置/动作的文本处理，再看会留存的轻应用。 */
export const exampleTools: readonly ToolPackage[] = [sampleTool, quickNotes];
