import type { Context } from "cordis";
import type { WorkbenchContributions } from "../../contracts/workbench.ts";
import type { UpdatesService } from "../../contracts/updates.ts";
import { ArrowDownToLineIcon } from "../../shared/ui/icons.tsx";
import {
  UpdateButton,
  UpdateController,
  UpdateSettings,
} from "./DesktopUpdate.tsx";

function updateSettings(
  updates: UpdatesService,
): WorkbenchContributions["settings"] {
  return {
    id: "updates",
    label: "更新",
    order: 10,
    Icon: ArrowDownToLineIcon,
    View: () => <UpdateSettings updates={updates} />,
  };
}

export const name = "updates-workbench";
export const inject = ["updates", "workbench"];

export function apply(ctx: Context): void {
  const { updates, workbench } = ctx;
  const chromeEntries: readonly WorkbenchContributions["chrome"][] = [
    {
      id: "updates-dialog",
      View: () => <UpdateController updates={updates} workbench={workbench} />,
    },
    { id: "updates-button", View: () => <UpdateButton updates={updates} /> },
    {
      id: "updates-button-compact",
      View: () => <UpdateButton updates={updates} compact />,
    },
  ];
  ctx.effect(() => workbench.register("settings", updateSettings(updates)));
  for (const chrome of chromeEntries)
    ctx.effect(() => workbench.register("chrome", chrome));
}
