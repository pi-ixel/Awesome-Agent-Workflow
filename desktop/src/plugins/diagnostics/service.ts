import type { LoggerFactory } from "../../shared/logging/logger.ts";
import type { AcpRawWriter, DiagnosticsReader } from "./types.ts";

import type { StorageCategory } from "./capture/storageRegistry.ts";
export { settingsStorageCategory } from "./capture/storageRegistry.ts";
export type { StorageCategory, StorageItem } from "./capture/storageRegistry.ts";

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
  registerStorage(category: StorageCategory): () => void;
  open(): void;
  startupTheme(): "dark" | "warm";
}

export { createDiagnosticsLogSink } from "./config.ts";
