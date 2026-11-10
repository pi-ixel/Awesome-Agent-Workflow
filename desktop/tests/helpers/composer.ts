import { webviewStorage } from "../../src/plugins/host/storage/storage.ts";
import { createProjectComposer } from "../../src/plugins/project/composer/service.ts";

export const testComposer = createProjectComposer(webviewStorage).service;
