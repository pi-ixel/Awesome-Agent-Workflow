import type { DocumentFileHost } from "../../src/contracts/documents.ts";
import { createDocuments } from "../../src/plugins/documents/service.ts";
import { createDocumentFileHost } from "../../src/plugins/host/documentFiles.ts";

export const documentFileHost = createDocumentFileHost(() => false);

export function createTestDocuments(host: DocumentFileHost = documentFileHost) {
  return createDocuments(host);
}
