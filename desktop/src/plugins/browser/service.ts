import type { HostService } from "../host/service.ts";

declare module "cordis" {
  interface Context {
    browser: BrowserService;
  }
}

export interface BrowserService {
  readonly host: HostService["browser"];
}
