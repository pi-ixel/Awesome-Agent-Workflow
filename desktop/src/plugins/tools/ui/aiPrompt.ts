/**
 * 「开发工具」里给 AI 的那一半（旧的「开发模式」页签已删除）。
 *
 * 这个产品的真实流程是「用户把需求说给 AI → AI 写个工具 → 用户装进来」，
 * 但界面此前只给了一个裸 JSON 输入框——等于假设用户会手写清单，可他本来就
 * 是为了不写代码才来的。这里提供两块拼图：
 *
 * 1. `developerPrompt()`：一段可直接粘给 AI 的说明（清单 schema + 沙箱边界
 *    + 运行时接口 + 最小示例）。约束都从校验代码里抄下来，不写"大概"。
 * 2. `extractToolPackage()`：把 AI 的整段回复（常带解释文字和 ```json 围栏）
 *    里第一个 JSON 对象抠出来。AI 基本不会只吐纯 JSON，这一步是必需的。
 */
import type { ToolPackage } from "../types.ts";
import { ruleGuidance, ruleIds } from "../runtime/rules.ts";

const example = {
  schemaVersion: 1,
  id: "word-count",
  name: "字数统计",
  version: "1.0.0",
  icon: "字",
  html: `<main>
  <textarea id="text" rows="6" placeholder="粘贴文本"></textarea>
  <p><strong id="count">0</strong> 个字符</p>
</main>
<script>
  const area = document.getElementById("text");
  const out = document.getElementById("count");
  function count(input) { return { characters: [...input].length }; }
  area.addEventListener("input", () => { out.textContent = count(area.value).characters; });
  // 界面按钮与 AI 走同一个函数：这就是"人机共用一套动作"。
  window.aawActions = { count: async (input) => count(String(input?.text ?? "")) };
</script>`,
  actions: [
    { id: "count", description: "统计一段文本的字符数", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  ],
};

export function developerPrompt(): string {
  const rules = ruleIds.map((id) => `- ${id}（${ruleGuidance[id].level === "block" ? "必须遵守" : "建议"}）${ruleGuidance[id].rule}：${ruleGuidance[id].fix}`).join("\n");
  return `请为我写一个 AAW 个人工具。只输出一个 JSON 对象（可以放在 \`\`\`json 代码块里），不要输出 Markdown 说明。

## 清单字段
- schemaVersion：固定 1
- id：必填，小写字母/数字/点/短横，以字母或数字开头，最长 64，例如 "word-count"
- name：必填，面向用户的名字，最长 60 字
- version：必填，形如 1.0.0
- icon：可选，1–2 个字符（一个 emoji 或一个字），显示在卡片和小窗图标上
- html：必填，完整自包含 HTML（内联 <style> 与 <script>）
- actions：可选，最多 32 个，见下
- settingsSchema：可选，最多 32 项，见下
- permissions：可选，会联网就写 { "network": true }

## 运行环境（重要限制）
- 工具运行在沙箱窗口里：没有 Node、没有任意路径的文件读写、没有 Electron API。
- 不能引用外部 script/css/font 或图片外链——加载不到，用户会看到没样式的页面。图片只能用 data URL。
- 整个工具包（含 html）不超过 512 KB。
- 窗口宽度不固定（最小约 360px），布局用 max-width / 百分比，不要写死宽度。

## 能用的 window 接口（平台框架提供，不要自己造）

下行（宿主注入给工具）：
- window.aawSettings：只读对象，键就是 settingsSchema 里的 id。
- window.aawStore：await aawStore.set(k, v) / get(k) / delete(k) / keys()，按工具+用户隔离、上限 5 MB、跨重启保留。要留存的数据一律走它；localStorage 在内存分区里，重启即清空。aawStore.scope("shared") 是用户级共享区，多个工具可见同一份数据。
- window.aawFiles：await aawFiles.open({ accept, multiple, directory, binary }) 返回文件对象或 null（binary 给 bytes: ArrayBuffer，directory 给 entries）；await aawFiles.save(name, data) 弹保存框，data 可为字符串或 ArrayBuffer；aawFiles.onDrop(list => …) 接住拖入的文件，用 await aawFiles.read(token) 取内容。
- window.aawClipboard：await aawClipboard.readText() / writeText(text)（上限 1 MB）；await aawClipboard.readImage() 返回 { png: ArrayBuffer } 或 null；aawClipboard.writeImage(bytes) 写图片。
- window.aawSystem：await aawSystem.info() 给平台/架构/CPU/内存/家目录等只读字段；await aawSystem.disk() 给 { total, free }。没有进程列表与环境变量全集。
- window.aawSecrets：await aawSecrets.set(k, v) / get(k) / delete(k)，系统加密存储，不落明文。API Key 放这里。
- window.aawLifecycle：await aawLifecycle.notify(title, body) 弹通知；keepAlive({ reason }) 声明关窗后继续运行；schedule(seconds) 定时（≥60）配 onSchedule(cb)。常驻与定时必须在清单 background 里声明。
- window.aawContext：{ selection, origin } 加 probe()，需要时在清单写 "needsSelection": true。
- window.aawBus：await aawBus.emit(topic, payload) / aawBus.on(topic, cb)，工具间在线广播，不保留历史。

上行（工具赋值给宿主）：
- window.aawActions：{ [动作id]: async (input) => 结果 }，界面按钮必须调用同一个函数。

工具包里只放 manifest.json、index.html 与自己的源码：运行框架（tools-runtime/、Tauri 侧、AGENTS.md、README.md）由每台机器的宿主提供，**严禁**改、夹带或伪造；也不要在代码里判断宿主版本（R9）。

## actions（让 AI 也能调用）
- 每项形如 { "id": "...", "description": "一句话说明", "inputSchema": { JSON Schema 对象 } }
- 在 html 里把实现写成：window.aawActions = { [id]: async (input) => 结果 }
- 界面上的按钮必须调用同一个函数，不要另写一份逻辑。
- 动作必须在 8 秒内返回，结果必须是 512 KB 以内的可 JSON 序列化值。

## settingsSchema（让用户可配置）
- 每项形如 { "id": "...", "label": "...", "description": "可选", "type": "text|number|boolean|select", "default": ... }
- select 类型额外带 options: [{ "label": "...", "value": "..." }]

## 红线（校验会检查）
${rules}

## 要求
1. 界面用中文，单文件、无外部依赖，键盘可达。
2. 主流程一眼可用，不要放说明书式的长文案。
3. 至少暴露一个动作（这样我能在命令行和 AI 里复用）。
4. 空输入、超长输入、非法输入都要有明确提示，不能白屏。

## 示例（可照此结构）
\`\`\`json
${JSON.stringify(example, null, 2)}
\`\`\``;
}

/** 从 AI 的整段回复里抠出第一个 JSON 对象；返回格式化后的 JSON 文本。 */
export function extractToolPackage(text: string): { json: string } | { error: string } {
  const source = text.replace(/^\uFEFF/, "").trim();
  if (!source) return { error: "输入为空：把 AI 的回复整段粘进来再试。" };
  const fenced = /```(?:json|JSON)?\s*\n([\s\S]*?)```/.exec(source);
  const candidate = fenced?.[1]?.trim() ?? sliceObject(source);
  if (!candidate) return { error: "没找到 JSON 对象：确认 AI 的回复里包含 { … } 形式的工具包。" };
  try {
    const value: unknown = JSON.parse(candidate);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return { error: "这段 JSON 不是对象：工具包必须是一个 { … } 对象。" };
    return { json: JSON.stringify(value, null, 2) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { error: `这段内容不是有效 JSON：${detail}` };
  }
}

/** 没有代码块围栏时，从第一个 { 取到最后一个 }。 */
function sliceObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start === -1 || end <= start ? "" : text.slice(start, end + 1);
}

/** 供测试与文档使用：清单里真正会被安装的字段（其余字段在解析时被丢弃）。 */
export const toolPackageFields: readonly (keyof ToolPackage)[] = [
  "schemaVersion", "id", "name", "version", "icon", "html", "actions", "settingsSchema",
  "permissions", "author", "source", "sourceFiles",
];
