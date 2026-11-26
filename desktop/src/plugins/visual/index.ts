import type { Context } from "cordis";
import type {} from "./service.ts";
import { VISUAL_LANGUAGES } from "./config.ts";
import { clearVisualCaches } from "./render/caches.ts";

export const name = "visual";
export const inject = [];

export function apply(ctx: Context): void {
  ctx.provide(name, { languages: VISUAL_LANGUAGES });
  // 解析与高度缓存只在内存中；卸载时清空
  ctx.effect(() => clearVisualCaches, "visual:resources");
}

export async function installWorkbench(ctx: Context): Promise<void> {
  await ctx.plugin(await import("./ui/workbench.tsx"));
}
