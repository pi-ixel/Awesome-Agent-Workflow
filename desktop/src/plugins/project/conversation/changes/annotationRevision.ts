import type { TurnFileChange } from "../../../../contracts/turnChanges/types.ts";
import { diffRevision } from "../../../../shared/annotations/revision.ts";

export function turnAnnotationRevision(file: TurnFileChange) {
  return diffRevision([
    file.kind,
    file.path,
    file.oldPath,
    file.before,
    file.after,
    file.fragments,
  ]);
}
