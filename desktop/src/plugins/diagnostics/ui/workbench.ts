import type { Context } from "cordis";
import { ActivityIcon } from "../../../shared/ui/icons.tsx";

export const name = "diagnostics-workbench";
export const inject = ["diagnostics", "workbench"];

export function apply(ctx: Context): void {
  const { diagnostics, workbench } = ctx;
  ctx.effect(() =>
    workbench.register("helpItems", {
      id: "diagnostics",
      label: "打开诊断",
      Icon: ActivityIcon,
      run: () => diagnostics.open(),
    }),
  );
}
