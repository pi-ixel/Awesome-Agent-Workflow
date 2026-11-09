import type { AcpBaseService } from "./acpBase/service.ts";
import type { AcpService } from "./acp/service.ts";

declare module "cordis" {
  interface Context {
    acpBase: AcpBaseService;
    acp: AcpService;
  }
}
export {};
