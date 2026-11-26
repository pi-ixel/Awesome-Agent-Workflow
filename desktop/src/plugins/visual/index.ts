import type { Context } from "cordis";
import type {} from "./service.ts";
import type {} from "../host/service.ts";
import type {} from "../project/service.ts";
import { VISUAL_LANGUAGES } from "./config.ts";
import { clearVisualCaches } from "./render/caches.ts";
import { createVisualGuideTools } from "./session/guideTools.ts";

export const name = "visual";
export const inject = [];

export function apply(ctx: Context): void {
  ctx.provide(name, { languages: VISUAL_LANGUAGES });
  // 解析与高度缓存只在内存中；卸载时清空
  ctx.effect(() => clearVisualCaches, "visual:resources");
  // 写法经会话附加工具随 AAW 会话下发（仅桌面端）
  ctx.inject(["host", "project"], (scoped) => {
    const guide = scoped.host.visualGuide;
    if (!guide) return;
    scoped.effect(
      () =>
        scoped.project.sessions.registerSessionTools(
          createVisualGuideTools(guide),
        ),
      "visual:session-tools",
    );
  });
}

export async function installWorkbench(ctx: Context): Promise<void> {
  await ctx.plugin(await import("./ui/workbench.tsx"));
}
