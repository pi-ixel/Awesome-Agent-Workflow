/**
 * 构建期入口：把指导文档正文交给 `scripts/build-tools-runtime.mjs` 渲染成
 * 静态页面。运行时不需要它——保留成独立文件是为了不让构建脚本去解析 TS。
 */
import { toolGuideMarkdown } from "./guide.ts";

export const markdown = toolGuideMarkdown();
