import { fitVisualSvgs } from "../kit/runtime.ts";

/**
 * 讲解图分流：决定一段 ```visual 源码走哪条渲染路径。
 *
 * - inline：不含 Agent 自写脚本，片段直接挂进 Shadow DOM（零 iframe 开销，
 *   套件元素的 tabs / steps 交互照常可用）；
 * - frame：含 <script>、内联事件、javascript: 链接、表单，或用 SVG 动画
 *   改写链接地址，进沙箱 iframe；
 * - text：没有任何元素（Agent 没按套件写、自创了文本记法），按源码原样显示，
 *   不把多行文本挤成一段。
 *
 * 解析用 <template>：惰性文档里不加载资源、不执行脚本。
 */

export type VisualPlan =
  | { readonly mode: "inline"; readonly template: HTMLTemplateElement }
  | { readonly mode: "frame" }
  | { readonly mode: "text" };

const scriptLikeTags = new Set(["script", "form"]);
/** 内联路径直接丢弃的元素：会改动宿主文档或导航宿主窗口。 */
const droppedTags = new Set([
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "base",
  "meta",
  "link",
  "noscript",
  "title",
  "portal",
]);
const urlAttributes = new Set([
  "href",
  "src",
  "xlink:href",
  "action",
  "formaction",
]);

function isScriptUrl(value: string): boolean {
  return /^\s*(?:javascript|vbscript):/i.test(value);
}

/** SVG 动画元素：attributeName 指向链接地址时可绕过静态检查。 */
const svgAnimationTags = new Set(["set", "animate"]);

function animatesLink(element: Element): boolean {
  return (
    svgAnimationTags.has(element.localName) &&
    /href/i.test(element.getAttribute("attributeName") ?? "")
  );
}

function needsFrame(root: DocumentFragment): boolean {
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT,
  );
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const element = node as Element;
    if (scriptLikeTags.has(element.localName) || animatesLink(element))
      return true;
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) return true;
      if (urlAttributes.has(name) && isScriptUrl(attribute.value)) return true;
    }
    if (element.localName === "template") {
      if (needsFrame((element as HTMLTemplateElement).content)) return true;
    }
  }
  return false;
}

function dropUnsafe(root: DocumentFragment): void {
  for (const element of Array.from(root.querySelectorAll("*"))) {
    if (droppedTags.has(element.localName)) element.remove();
  }
}

/** 只带这些行内格式元素的源码仍是文本记法（如节点标签里夹 <br> 的 Mermaid）。 */
const inlineFormatTags = new Set([
  "br",
  "b",
  "i",
  "em",
  "strong",
  "code",
  "span",
  "sub",
  "sup",
]);

function isPlainText(root: DocumentFragment): boolean {
  return Array.from(root.querySelectorAll("*")).every((element) =>
    inlineFormatTags.has(element.localName),
  );
}

const planCache = new Map<string, VisualPlan>();
const PLAN_CACHE_LIMIT = 64;

/**
 * 同一源码只解析一次；inline 计划里的 template 只读，使用方克隆其内容。
 * 以源码本身为键（字符串比较），不会因哈希碰撞拿到别的图。
 */
export function planVisual(code: string): VisualPlan {
  const cached = planCache.get(code);
  if (cached !== undefined) {
    planCache.delete(code);
    planCache.set(code, cached);
    return cached;
  }
  const template = document.createElement("template");
  template.innerHTML = code;
  let plan: VisualPlan;
  if (isPlainText(template.content)) {
    plan = { mode: "text" };
  } else if (needsFrame(template.content)) {
    plan = { mode: "frame" };
  } else {
    dropUnsafe(template.content);
    fitVisualSvgs(template.content);
    plan = { mode: "inline", template };
  }
  planCache.set(code, plan);
  while (planCache.size > PLAN_CACHE_LIMIT) {
    const oldest = planCache.keys().next();
    if (oldest.done === true) break;
    planCache.delete(oldest.value);
  }
  return plan;
}

export function clearVisualPlans(): void {
  planCache.clear();
}
