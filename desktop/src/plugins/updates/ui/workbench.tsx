import type { Context } from "cordis";
import type { WorkbenchContributions } from "../../workbench/types.ts";
import type { UpdatesService } from "../service.ts";
import { ArrowDownToLineIcon } from "../../../shared/ui/icons.tsx";
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
  const exit = {
    getExitWork: workbench.getExitWork.bind(workbench),
    hasExitWork: workbench.hasExitWork.bind(workbench),
    requestExit: workbench.requestExit.bind(workbench),
  };
  ctx.effect(() => workbench.register("settings", updateSettings(updates)));
  ctx.effect(() =>
    workbench.register("overlays", {
      id: "updates-dialog",
      scope: "window",
      View: () => <UpdateController updates={updates} workbench={exit} />,
    }),
  );
  ctx.effect(() =>
    workbench.register("headerIndicators", {
      id: "updates",
      View: ({ compact }) => <UpdateButton updates={updates} compact={compact} />,
    }),
  );
}
