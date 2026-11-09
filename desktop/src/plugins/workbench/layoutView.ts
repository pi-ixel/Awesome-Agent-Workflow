import type { PanelTab, WorkbenchUiState, RightPanelState } from "../../contracts/workbenchLayout.ts";
import { useContext } from "react";
import type { WorkbenchLayout, WorkbenchSnapshot } from "../../contracts/workbench.ts";
import { emptyWorkbenchUi } from "./navigationStore.ts";
import { emptyRightPanelState } from "./rightPanelStore.ts";
import { useRegisteredSnapshot, WorkbenchContext } from "./react.ts";

export function useWorkbenchLayout(): WorkbenchLayout | undefined {
  return useContext(WorkbenchContext) ?? undefined;
}

export function readWorkbenchUi(
  layout: WorkbenchLayout | undefined,
): WorkbenchUiState {
  return layout?.navigation.getState() ?? emptyWorkbenchUi;
}

export function readRightPanel(
  layout: WorkbenchLayout | undefined,
): RightPanelState {
  return layout?.panels.getState() ?? emptyRightPanelState;
}

export function findPanelLauncher(
  tab: PanelTab,
  panels: WorkbenchSnapshot["panels"],
) {
  return panels.find(({ launcher }) => launcher?.tool === tab.kind)?.launcher;
}

export function useWorkbenchUiValue<T>(
  select: (state: WorkbenchUiState) => T,
): T {
  return useRegisteredSnapshot(useWorkbenchLayout()?.navigation, (state) =>
    select(state ?? emptyWorkbenchUi),
  );
}

export function useRightPanelValue<T>(
  select: (state: Pick<RightPanelState, "projects">) => T,
): T {
  return useRegisteredSnapshot(useWorkbenchLayout()?.panels, (state) =>
    select(state ?? emptyRightPanelState),
  );
}
