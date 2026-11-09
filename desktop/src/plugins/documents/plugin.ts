import type { Context } from "cordis";
import { createDocuments } from "./service.ts";

export const name = "documents";
export const inject = ["host", "configuration", "diagnostics"];

export function apply(ctx: Context): void {
  const documents = createDocuments(ctx.host.files);
  ctx.provide(name, documents);
  ctx.effect(() => () => documents.dispose(), "documents:resources");
}
