import type { PanelLayoutCompatibility } from "../workbench/types.ts";
import { isAbsolutePath } from "../../shared/panelPaths.ts";

export const DIRECTORY_READ_CONCURRENCY = 4;
export const QUOTE_LIMIT = 10_000;
export const COMMENT_LIMIT = 2_000;

function validLegacyPath(fields: Readonly<Record<string, unknown>>): boolean {
  return typeof fields.path === "string" && isAbsolutePath(fields.path);
}

export const documentPanelCompatibility: PanelLayoutCompatibility = {
  tabs: [
    { kind: "files", singleton: true },
    { kind: "directory", validate: validLegacyPath },
    {
      kind: "file",
      validate: (fields) => validLegacyPath(fields) && (
        fields.line === undefined ||
        (typeof fields.line === "number" && Number.isFinite(fields.line) && fields.line > 0)
      ),
    },
  ],
};
