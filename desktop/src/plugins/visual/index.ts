import type { Context } from "cordis";
import type {} from "./service.ts";
import type {} from "../host/service.ts";
import type {} from "../project/service.ts";
import type {} from "../mcp/service.ts";
import { VISUAL_LANGUAGES } from "./config.ts";
import { clearVisualCaches } from "./render/caches.ts";
import { createVisualGuideTools } from "./session/guideTools.ts";

export const name = "visual";
export const inject = [];

export function apply(ctx: Context): void {
  ctx.provide(name, { languages: VISUAL_LANGUAGES });
  // 解析与高度缓存只在内存中；卸载时清空
  ctx.effect(() => clearVisualCaches, "visual:resources");
  ctx.inject(["host", "mcp"], (scoped) => {
    if (scoped.host.visualGuide)
      scoped.effect(
        () =>
          scoped.mcp.registerBuiltin({
            id: "aaw-visual",
            name: "可视化讲解",
            description: "提供讲解图和交互演示的写法。",
            scope: "支持 HTTP MCP 的 Desktop 会话",
          }),
        "visual:mcp-catalog",
      );
  });
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
