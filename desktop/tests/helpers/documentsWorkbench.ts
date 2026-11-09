import type { WorkbenchService } from "../../src/contracts/workbench.ts";
import { documentPanels } from "../../src/plugins/documents/workbench.tsx";
import { createTestDocuments } from "./documents.ts";

export function installTestDocumentPanels(workbench: WorkbenchService) {
  const documents = createTestDocuments();
  workbench.register("documents", { id: "documents", service: documents });
  for (const panel of documentPanels(documents))
    workbench.register("panels", panel);
  return documents;
}
