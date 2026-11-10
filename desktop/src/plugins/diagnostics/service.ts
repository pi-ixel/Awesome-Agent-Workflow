import type { LoggerFactory } from "../../shared/logging/logger.ts";
import type { AcpRawWriter, DiagnosticsReader } from "./types.ts";

import type {} from "cordis";

declare module "cordis" {
  interface Context {
    diagnostics: DiagnosticsService;
  }
}

export interface DiagnosticsService {
  readonly createLogger: LoggerFactory;
  readonly recordAcpRaw: AcpRawWriter;
  readonly reader: DiagnosticsReader;
  open(): void;
  startupTheme(): "dark" | "warm";
}
