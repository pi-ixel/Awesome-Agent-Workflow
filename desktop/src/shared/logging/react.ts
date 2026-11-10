import { createContext, useContext, useMemo } from "react";
import { createLogger, type LoggerFactory } from "./logger.ts";

export const LoggerContext = createContext<LoggerFactory>(createLogger);

export function useLogger(channel: string) {
  const factory = useContext(LoggerContext);
  return useMemo(() => factory(channel), [channel, factory]);
}
