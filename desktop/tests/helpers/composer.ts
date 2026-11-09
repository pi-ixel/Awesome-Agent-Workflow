import { webviewStorage } from "../../src/plugins/host/storage.ts";
import { createProjectComposer } from "../../src/plugins/project/composer/service.ts";

export const testComposer = createProjectComposer(webviewStorage).service;
