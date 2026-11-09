import type { Context } from "cordis";

export const name = "diagnostics-workbench";
export const inject = ["diagnostics", "workbench"];

export function apply(ctx: Context): void {
  const { diagnostics, workbench } = ctx;
  ctx.effect(() =>
    workbench.register("actions", {
      id: "diagnostics.open",
      run: () => diagnostics.open(),
    }),
  );
}
