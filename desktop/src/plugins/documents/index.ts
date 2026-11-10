import type { Context } from "cordis";
import { createDocuments } from "./files/documents.ts";

export const name = "documents";
export const inject = ["host", "configuration", "diagnostics"];

export async function installWorkbench(ctx: Context): Promise<void> {
  await ctx.plugin(await import("./ui/workbench.tsx"));
}
export function apply(ctx: Context): void {
  const { dispose, ...documents } = createDocuments(ctx.host.files, ctx.diagnostics.createLogger("documents"));
  ctx.provide(name, documents);
  ctx.effect(() => dispose, "documents:resources");
}
