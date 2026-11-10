import type { WorkbenchService } from "../../src/plugins/workbench/service.ts";
import { documentPanels, registerDocumentPaths } from "../../src/plugins/documents/ui/workbench.tsx";
import { createTestDocuments } from "./documents.ts";

export function installTestDocumentPanels(workbench: WorkbenchService) {
  const documents = createTestDocuments();
  registerDocumentPaths(workbench, documents);
  for (const panel of documentPanels(documents, workbench))
    workbench.register("panels", panel);
  return documents;
}
