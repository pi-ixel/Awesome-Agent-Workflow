import type { PanelLayoutCompatibility } from "../workbench/types.ts";
import { isAbsolutePath } from "../../shared/panelPaths.ts";
import { readDiffReference } from "./review/diffReference.ts";

export const reviewRailStorageKey = "aaw-desktop/layout/git-review-rail-w";
export const reviewRailWidths = { initial: 256, min: 220, max: 560 } as const;

export const gitPanelCompatibility: PanelLayoutCompatibility = {
  tabs: [
    { kind: "git", singleton: true },
    {
      kind: "diff",
      validate: (fields) => {
        const reference = readDiffReference(fields);
        return reference !== undefined && isAbsolutePath(reference.path);
      },
    },
  ],
};
