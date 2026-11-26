/**
 * Markdown 代码块渲染扩展契约：插件按语言接管整个围栏代码块的渲染
 * （例如 ```visual 讲解图）。渲染器由工作台注册位收集，根组件经本上下文
 * 下发；只有打开 canUseCodeRenderers 的 MarkdownView（Agent 回答、文件
 * 预览）才使用，更新说明、工作流提示词等照常显示代码块。
 */
import { createContext, type ComponentType } from "react";

export interface MarkdownCodeRendererProps {
  /** 围栏内源码；流式期间是已到达的部分。 */
  readonly code: string;
  readonly language: string;
  /** 围栏已闭合（或消息不在流式输出）。未闭合时渲染器应显示占位。 */
  readonly isComplete: boolean;
  /**
   * 所在消息仍在流式输出。流式结束时 Markdown 会整体重建（流式分块 →
   * 静态渲染），挂载代价高或有状态的渲染（如 iframe）可等消息结束再创建。
   */
  readonly isStreaming: boolean;
}

export interface MarkdownCodeRenderer {
  readonly id: string;
  /** 小写语言标识，例如 ["visual"]。 */
  readonly languages: readonly string[];
  readonly View: ComponentType<MarkdownCodeRendererProps>;
}

export const MarkdownCodeRenderers = createContext<
  readonly MarkdownCodeRenderer[]
>([]);

export function findMarkdownCodeRenderer(
  renderers: readonly MarkdownCodeRenderer[],
  language: string,
): MarkdownCodeRenderer | undefined {
  if (renderers.length === 0 || language === "") return undefined;
  const normalized = language.trim().toLowerCase();
  return renderers.find((renderer) => renderer.languages.includes(normalized));
}
