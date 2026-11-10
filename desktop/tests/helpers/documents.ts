import type { DocumentFileHost } from "../../src/plugins/host/types.ts";
import { createDocuments } from "../../src/plugins/documents/files/documents.ts";
import { createDocumentFileHost } from "../../src/plugins/host/filesystem/documentFiles.ts";

export const documentFileHost = createDocumentFileHost(() => false);

export function createTestDocuments(host: DocumentFileHost = documentFileHost) {
  return createDocuments(host);
}
