import type { Context } from "cordis";
import { ActivityIcon } from "../../../shared/ui/icons.tsx";
import { createStorageSettings } from "./StorageSettings.tsx";

export const name = "diagnostics-workbench";
export const inject = ["diagnostics", "workbench"];

export function apply(ctx: Context, options?: { pickStorageDirectory: () => Promise<string | null> }): void {
  const { diagnostics, workbench } = ctx;
  const storage = createStorageSettings(
    diagnostics.reader,
    () => workbench.navigation.getState().openSettingsTab("storage"),
    options?.pickStorageDirectory,
  );
  ctx.effect(() => workbench.register("settings", {
    id: "storage", label: "存储", order: 20, Icon: ActivityIcon, View: storage.Settings,
  }));
  ctx.effect(() => workbench.register("overlays", {
    id: "storage-monitor", scope: "workspace", View: storage.Monitor,
  }));
  ctx.effect(() =>
    workbench.register("helpItems", {
      id: "diagnostics",
      label: "打开诊断",
      Icon: ActivityIcon,
      run: () => diagnostics.open(),
    }),
  );
}
