import type { ToolPackage } from "../types.ts";

export const sampleTool: ToolPackage = {
  schemaVersion: 1,
  id: "json-formatter",
  name: "JSON 格式化",
  version: "1.0.0",
  // 示例顺便演示可选字段 icon：卡片与小窗用它替代默认的工具图标。
  icon: "J",
  settingsSchema: [{ id: "indent", type: "number", label: "缩进空格数", description: "格式化 JSON 时每一级使用的空格数。", default: 2, min: 0, max: 8 }],
  actions: [{
    id: "format",
    description: "按管理页中设置的缩进格式化 JSON 文本",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  }],
  html: `<style>
  :root { color-scheme: light dark; color: CanvasText; background: Canvas; }
  body { font: 14px system-ui; max-width: 62rem; margin: 0 auto; padding: clamp(16px, 4vw, 32px); }
  form { display: grid; gap: 13px; }
  label { font-weight: 650; font-size: 1.05rem; }
  textarea { box-sizing: border-box; width: 100%; min-height: 16em; padding: 14px; border: 1px solid color-mix(in srgb, CanvasText 22%, Canvas); border-radius: 12px; color: CanvasText; background: color-mix(in srgb, CanvasText 6%, Canvas); font: 13px/1.65 ui-monospace, Consolas, monospace; }
  button { justify-self: start; border: 0; border-radius: 8px; background: #2957b8; color: white; font: inherit; font-weight: 600; padding: 8px 17px; cursor: pointer; }
  button:hover { background: #3568d1; }
  output { white-space: pre-wrap; min-height: 1.2em; }
</style>
<form>
  <label for="source">输入 JSON</label>
  <textarea id="source">{"hello":"AAW"}</textarea>
  <button type="button" id="format">格式化</button>
  <output id="status" aria-live="polite"></output>
</form>
<script>
  function format({ text }) {
    if (typeof text !== 'string') throw new Error('text 必须是字符串');
    return JSON.stringify(JSON.parse(text), null, window.aawSettings?.indent ?? 2);
  }
  window.aawActions = { format };
  const source = document.querySelector('#source');
  const status = document.querySelector('#status');
  document.querySelector('#format').addEventListener('click', () => {
    try {
      source.value = format({ text: source.value });
      status.textContent = '格式化完成';
    } catch {
      status.textContent = '输入不是有效的 JSON';
    }
  });
</script>`,
};
