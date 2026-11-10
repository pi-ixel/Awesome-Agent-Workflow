import type { AcpProtocolResources } from "./types.ts";

import type {} from "cordis";

declare module "cordis" {
  interface Context {
    acpRuntime: AcpRuntimeService;
  }
}

export interface AcpRuntimeService {
  readonly protocol: AcpProtocolResources;
  shutdown(options?: { force?: boolean }): Promise<void>;
}

export {
  AcpClosedError,
  AcpResponseError,
  AcpTimeoutError,
  AcpWriteError,
} from "../acpConnection/service.ts";
export { configModels, configModes } from "./protocol/configOptions.ts";
