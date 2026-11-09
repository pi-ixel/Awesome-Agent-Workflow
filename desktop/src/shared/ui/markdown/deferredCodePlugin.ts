/**
 * 视口门控的 shiki 插件包装（首屏性能的关键一环）。
 *
 * 问题：会话首次加载时，150 条可见内容里的**所有**代码块在首帧同步
 * shiki tokenize（每个还要加载语法），代码块多的长会话就是几百毫秒到
 * 秒级的主线程阻塞。
 *
 * 方案：包装 @streamdown/code 插件——视口外的代码块 `highlight` 返回
 * null（Streamdown 契约支持的「未就绪」态，先渲染素色原始文本），块滚进
 * 视口（±200px）后才真正 tokenize 并经 callback 回传上色。首帧的 shiki
 * 工作量从「全部代码块」降到「首屏可见的几块」。
 *
 * 契约依据（streamdown HighlightedCodeBlockBody 源码）：highlight 返回
 * null 时组件保持原始文本 state，后续 callback 触发 setState 重渲染；
 * 语法/WASM 加载与已完成块的结果缓存由内层插件负责，本层只管「何时」。
 */
import {
  createCodePlugin,
  type CodeHighlighterPlugin,
  type HighlightOptions,
  type HighlightResult,
} from "@streamdown/code";

const innerPlugin = createCodePlugin({ themes: ["github-light", "github-dark"] });

/** 已标记可见（或已高亮过）的代码块哈希；一旦可见不回退素色。 */
const visibleHashes = new Set<string>();
/** 视口外块的排队高亮：可见后冲刷；语法未加载时经内层异步回调。 */
const queued = new Map<
  string,
  {
    options: HighlightOptions;
    callback?: (result: HighlightResult) => void;
  }[]
>();

/** FNV-1a 32 位 + 长度前缀：高亮用途下碰撞可忽略。 */
export function codeHashOf(code: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) {
    hash ^= code.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${code.length}:${(hash >>> 0).toString(36)}`;
}

export function isCodeVisible(hash: string): boolean {
  return visibleHashes.has(hash);
}

/** 标记可见并冲刷排队高亮。语法已加载时内层同步出结果，经微任务回传
 * （微任务在绘制前执行——首屏块由 CodeBlock 的 useLayoutEffect 在绘制前
 * 调用本函数，不会出现素色闪烁）。 */
export function markCodeVisibleAndFlush(hash: string): void {
  visibleHashes.add(hash);
  const entries = queued.get(hash);
  if (entries === undefined) {
    return;
  }
  queued.delete(hash);
  for (const entry of entries) {
    const result = innerPlugin.highlight(entry.options, entry.callback);
    if (result !== null) {
      // 语法已加载：同步结果按契约走 callback 路径（本层此前已返回 null）
      const tokens = result;
      const callback = entry.callback;
      queueMicrotask(() => callback?.(tokens));
    }
  }
}

const deferredPlugin: CodeHighlighterPlugin = {
  getSupportedLanguages: () => innerPlugin.getSupportedLanguages(),
  getThemes: () => innerPlugin.getThemes(),
  supportsLanguage: (language) => innerPlugin.supportsLanguage(language),
  name: "shiki",
  type: "code-highlighter",
  highlight(options, callback) {
    const hash = codeHashOf(options.code);
    if (visibleHashes.has(hash)) {
      return innerPlugin.highlight(options, callback);
    }
    const entries = queued.get(hash) ?? [];
    entries.push({ options, callback });
    queued.set(hash, entries);
    // Streamdown 契约：null = 未就绪，先渲染素色，等 callback
    return null;
  },
};

export const deferredCodePlugin = deferredPlugin;
