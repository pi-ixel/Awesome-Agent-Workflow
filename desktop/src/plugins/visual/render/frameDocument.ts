/**
 * 沙箱路径的 iframe 文档（srcdoc）。
 *
 * - 页内 CSP 禁止一切外部加载，只放行内联脚本与样式，图片允许 data / blob / https；
 * - 桥接脚本放在 <head>，先于 Agent 脚本挂好错误监听；负责上报高度、
 *   接收换肤、拦截一切链接激活（含 SVG 链接、图片热区、中键），只把
 *   http(s) 地址交给宿主用外部浏览器打开；
 * - 宿主给高度设了上限，超出时 iframe 内部滚动（防止 100vh 一类内容
 *   与 iframe 高度互相推高）。
 * - 套件运行时放在正文之后，升级时子节点已解析完毕。
 */
import { visualIconAliases, visualIcons } from "../kit/icons.ts";
import { fitVisualSvgs, installVisualKit } from "../kit/runtime.ts";
import { visualKitCss, visualTokenSources } from "../kit/styles.ts";

export const VISUAL_MESSAGE_KEY = "__aawVisual";

export type VisualFrameMessage =
  | { readonly type: "height"; readonly height: number }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "open"; readonly url: string };

export interface VisualTheme {
  readonly vars: Readonly<Record<string, string>>;
  readonly fontFamily: string;
  /** 宿主计算后的基准字号（随界面字号档变化）。 */
  readonly textSize: string;
  /** 与宿主一致，否则浏览器会给 iframe 画不透明底。 */
  readonly colorScheme: string;
}

const csp = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob: https:",
  "font-src data:",
  "media-src data: blob:",
].join("; ");

/** 从宿主元素解析套件变量的当前值（主题切换后重新读取）。 */
export function readVisualTheme(element: Element): VisualTheme {
  const style = getComputedStyle(element);
  const vars: Record<string, string> = {};
  for (const [name, source] of Object.entries(visualTokenSources)) {
    const value = style.getPropertyValue(source).trim();
    if (value !== "") vars[name] = value;
  }
  return {
    vars,
    fontFamily: style.fontFamily,
    textSize: style.fontSize,
    colorScheme: style.colorScheme || "normal",
  };
}

function themeCss(snapshot: VisualTheme): string {
  const declarations = Object.entries(snapshot.vars)
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  return `:root{${declarations}font-family:${snapshot.fontFamily};font-size:${snapshot.textSize};color-scheme:${snapshot.colorScheme};}`;
}

/** 脚本内嵌 JSON 时转义 <，避免提前闭合 script。 */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * 沙箱内的桥接脚本。高度在文档解析完后才开始汇报：srcdoc 分段解析时首次
 * 布局可能只有半截正文，过早汇报会让宿主高度瞬间塌陷。
 */
function bridgeScript(): string {
  const key = JSON.stringify(VISUAL_MESSAGE_KEY);
  return `(function(){
var K=${key};var root=document.documentElement;var last=-1;
function post(m){m[K]=1;try{parent.postMessage(m,"*");}catch(e){}}
function report(){var h=Math.ceil(root.getBoundingClientRect().height);if(h!==last){last=h;post({type:"height",height:h});}}
document.addEventListener("DOMContentLoaded",function(){new ResizeObserver(report).observe(root);});
addEventListener("load",report);
addEventListener("error",function(e){var m=String(e&&e.message||"脚本错误");if(/ResizeObserver loop/.test(m))return;post({type:"error",message:m});});
addEventListener("unhandledrejection",function(e){post({type:"error",message:String(e&&e.reason||"脚本错误")});});
addEventListener("message",function(e){var d=e.data;if(e.source!==parent||!d||!d[K]||d.type!=="theme")return;
var s=root.style;for(var n in d.vars)s.setProperty(n,d.vars[n]);if(d.fontFamily)s.fontFamily=d.fontFamily;if(d.textSize)s.fontSize=d.textSize;if(d.colorScheme)s.colorScheme=d.colorScheme;});
function onLink(e){var t=e.target;var a=t&&t.closest?t.closest("a,area"):null;if(!a)return;e.preventDefault();
if(e.type==="auxclick"&&e.button!==1)return;var h=(a.getAttribute("href")||a.getAttribute("xlink:href")||"").trim();
if(/^https?:/i.test(h))post({type:"open",url:h});}
document.addEventListener("click",onLink,true);document.addEventListener("auxclick",onLink,true);
})();`;
}

export function buildVisualFrameDocument(
  code: string,
  theme: VisualTheme,
): string {
  const kit = `(${fitVisualSvgs.toString()})(document.body);(${installVisualKit.toString()})(window,${scriptJson(visualIcons)},${scriptJson(visualIconAliases)});`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${themeCss(theme)}
html{overflow-x:hidden;overflow-y:auto;}
html,body{margin:0;background:transparent;}
body{overflow-x:auto;container-type:inline-size;}
${visualKitCss}</style>
<script>${bridgeScript()}</script>
</head><body class="v-root">
${code}
<script>${kit}</script>
</body></html>`;
}

export function isVisualFrameMessage(
  data: unknown,
): data is VisualFrameMessage {
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  if (record[VISUAL_MESSAGE_KEY] !== 1) return false;
  switch (record.type) {
    case "height":
      return typeof record.height === "number";
    case "error":
      return typeof record.message === "string";
    case "open":
      return typeof record.url === "string";
    default:
      return false;
  }
}
